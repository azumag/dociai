import type { AiWebSearchResponse, AiWebSearchResult } from "../../../../shared/services/ai-contract";
import { ServiceError, errorFromHttpStatus } from "../../service-error";

const allowedHosts = new Set(["api.minimax.io", "api.minimaxi.com"]);

function searchEndpoint(baseUrl: string, serviceId: string): string {
  let parsed: URL;
  try { parsed = new URL(baseUrl); } catch { throw new ServiceError("BAD_REQUEST", "MiniMax base URL is invalid", { serviceId, retryable: false }); }
  if (parsed.protocol !== "https:" || !allowedHosts.has(parsed.hostname)) {
    throw new ServiceError("BAD_REQUEST", "Web検索には公式MiniMax API hostを指定してください", { serviceId, retryable: false });
  }
  return new URL("/v1/coding_plan/search", parsed.origin).toString();
}

function normalizeResult(value: unknown): AiWebSearchResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  const title = typeof entry.title === "string" ? entry.title.trim() : "";
  const link = typeof entry.link === "string" ? entry.link.trim() : "";
  if (!title || !/^https?:\/\//i.test(link)) return null;
  return {
    title: title.slice(0, 300),
    link: link.slice(0, 2048),
    snippet: (typeof entry.snippet === "string" ? entry.snippet : "").trim().slice(0, 2000),
    ...(typeof entry.date === "string" && entry.date.trim() ? { date: entry.date.trim().slice(0, 100) } : {}),
  };
}

export async function miniMaxWebSearch(fetchFn: typeof fetch, config: { id: string; baseUrl: string; apiKey: string }, query: string, signal: AbortSignal): Promise<Omit<AiWebSearchResponse, "requestId">> {
  let response: Response;
  try {
    response = await fetchFn(searchEndpoint(config.baseUrl, config.id), {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}`, "MM-API-Source": "dociai" },
      body: JSON.stringify({ q: query }),
    });
  } catch (error) {
    if (signal.aborted && signal.reason instanceof ServiceError) throw signal.reason;
    if (signal.aborted) throw new ServiceError("CANCELLED", "request cancelled", { serviceId: config.id, retryable: false });
    throw error instanceof Error && error.name === "AbortError"
      ? new ServiceError("CANCELLED", "request cancelled", { serviceId: config.id, retryable: false })
      : new ServiceError("NETWORK", "MiniMax search connection failed", { serviceId: config.id });
  }
  if (!response.ok) throw errorFromHttpStatus(response.status, { serviceId: config.id });
  let data: Record<string, unknown>;
  try { data = await response.json() as Record<string, unknown>; }
  catch { throw new ServiceError("EMPTY", "MiniMax search response was invalid", { serviceId: config.id, retryable: false }); }
  const baseResp = data.base_resp && typeof data.base_resp === "object" ? data.base_resp as Record<string, unknown> : {};
  if (baseResp.status_code !== undefined && baseResp.status_code !== 0) {
    const code = baseResp.status_code === 1004 ? "AUTH" : "BAD_REQUEST";
    throw new ServiceError(code, `MiniMax search failed (${String(baseResp.status_code)})`, { serviceId: config.id, retryable: false });
  }
  const results = (Array.isArray(data.organic) ? data.organic : []).map(normalizeResult).filter((entry): entry is AiWebSearchResult => Boolean(entry)).slice(0, 20);
  const relatedQueries = (Array.isArray(data.related_searches) ? data.related_searches : [])
    .map((entry) => entry && typeof entry === "object" && !Array.isArray(entry) && typeof (entry as Record<string, unknown>).query === "string" ? String((entry as Record<string, unknown>).query).trim() : "")
    .filter(Boolean).slice(0, 10);
  return { results, relatedQueries };
}
