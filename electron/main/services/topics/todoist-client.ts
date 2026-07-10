import { ServiceError } from "../service-error";
import { SafeHttpClient } from "../feeds/rss-client";

type TodoistTask = { id?: unknown; content?: unknown; description?: unknown; project_id?: unknown; created_at?: unknown; createdAt?: unknown };

function baseUrl(value: unknown): string {
  const raw = typeof value === "string" && value.trim() ? value.trim() : "https://api.todoist.com/api/v1";
  try {
    const parsed = new URL(raw);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error("unsupported protocol");
    return parsed.toString().replace(/\/$/, "");
  } catch { throw new ServiceError("BAD_REQUEST", "Todoist base URL is invalid", { serviceId: "todoist", retryable: false }); }
}

export class TodoistClient {
  constructor(private readonly http = new SafeHttpClient()) {}
  async fetchTasks(source: Record<string, unknown>, token: string, signal: AbortSignal): Promise<TodoistTask[]> {
    const projectId = typeof source.projectId === "string" || typeof source.projectId === "number" ? String(source.projectId) : "";
    if (!projectId) throw new ServiceError("BAD_REQUEST", "Todoist project ID is missing", { serviceId: "todoist", retryable: false });
    const base = baseUrl(source.baseUrl);
    const rows: TodoistTask[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const url = new URL(`${base}/tasks`);
      url.searchParams.set("project_id", projectId);
      if (cursor) url.searchParams.set("cursor", cursor);
      const response = await this.http.request(url.toString(), { signal, headers: { Authorization: `Bearer ${token}` }, acceptedContentTypes: ["application/json", "text/json"], maxBytes: 1_000_000 });
      let body: unknown;
      try { body = JSON.parse(response.body); } catch { throw new ServiceError("BAD_REQUEST", "Todoist response is invalid", { serviceId: "todoist", retryable: false }); }
      const pageRows = Array.isArray(body) ? body : (body && typeof body === "object" && Array.isArray((body as { results?: unknown }).results) ? (body as { results: TodoistTask[] }).results : []);
      rows.push(...pageRows);
      const fromHeader = response.headers.get("x-next-cursor");
      const fromBody = body && typeof body === "object" && !Array.isArray(body) && typeof (body as { next_cursor?: unknown }).next_cursor === "string" ? (body as { next_cursor: string }).next_cursor : null;
      cursor = fromHeader || fromBody;
      if (!cursor) break;
    }
    return rows.filter((task) => String(task.project_id ?? projectId) === projectId);
  }

  async completeTask(source: Record<string, unknown>, token: string, taskId: string, signal: AbortSignal): Promise<void> {
    if (!taskId || taskId.length > 256) throw new ServiceError("BAD_REQUEST", "Todoist task ID is invalid", { serviceId: "todoist", retryable: false });
    const response = await this.http.request(`${baseUrl(source.baseUrl)}/tasks/${encodeURIComponent(taskId)}/close`, { method: "POST", signal, headers: { Authorization: `Bearer ${token}` }, acceptedContentTypes: ["application/json", "text/plain", ""], maxBytes: 64_000 });
    if (response.status < 200 || response.status >= 300) throw new ServiceError("UNKNOWN", "Todoist task completion failed", { serviceId: "todoist" });
  }
}
