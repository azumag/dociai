import type { SecretStore } from "../../../shared/secret-contract";
import type { TopicCompleteInput, TopicFetchInput, TopicFetchResponse, TopicItem } from "../../../shared/services/topic-contract";
import { ConfigRepository } from "../../config/config-repository";
import { ServiceRuntime } from "../service-runtime";
import { retryWithPolicy } from "../retry-policy";
import { ServiceError, normalizeServiceError } from "../service-error";
import { TodoistClient } from "./todoist-client";

function sourceAt(config: Record<string, unknown>, index: number): Record<string, unknown> {
  const sources = (config.topics as { sources?: unknown })?.sources;
  if (!Number.isSafeInteger(index) || index < 0 || !Array.isArray(sources) || !sources[index] || typeof sources[index] !== "object") throw new ServiceError("BAD_REQUEST", "topic source was not found", { serviceId: "todoist", retryable: false });
  return sources[index] as Record<string, unknown>;
}

function bounded(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, Math.floor(parsed))) : fallback;
}

function date(value: unknown): string | null { const timestamp = Date.parse(typeof value === "string" ? value : ""); return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString(); }

export class TopicService {
  readonly runtime = new ServiceRuntime("todoist");
  constructor(private readonly configRepository: ConfigRepository, private readonly secretStore: SecretStore, private readonly client = new TodoistClient()) {}
  cancel(requestId: string): boolean { return this.runtime.registry.cancel(requestId, "cancelled"); }

  async fetchTopics(input: TopicFetchInput): Promise<TopicFetchResponse> {
    return this.withSource(input, async (source, signal) => {
      const token = await this.token(source, input.sourceIndex);
      const tasks = await this.client.fetchTasks(source, token, signal);
      const items: TopicItem[] = tasks.map((task) => ({
        title: typeof task.content === "string" ? task.content : "",
        description: typeof task.description === "string" ? task.description : "",
        publishedAt: date(task.created_at ?? task.createdAt),
        guid: `todoist:${String(task.id ?? "")}`,
        sourceName: typeof source.name === "string" ? source.name : `topic-${input.sourceIndex}`,
        sourceIndex: input.sourceIndex,
        taskId: String(task.id ?? ""),
        kind: "topic" as const,
      })).filter((item) => item.title && item.taskId);
      return { items };
    });
  }

  async completeTask(input: TopicCompleteInput): Promise<{ completed: true; requestId: string }> {
    const result = await this.withSource(input, async (source, signal) => {
      const token = await this.token(source, input.sourceIndex);
      await this.client.completeTask(source, token, input.taskId, signal);
      return { completed: true as const };
    });
    return { ...result, requestId: result.requestId };
  }

  async withSource<T extends { requestId?: string; generation?: number; ownerId?: string; sourceIndex: number }, R>(input: T, operation: (source: Record<string, unknown>, signal: AbortSignal) => Promise<R>): Promise<R & { requestId: string }> {
    const loaded = await this.configRepository.getPublic();
    const source = sourceAt(loaded.config, input.sourceIndex);
    if (source.enabled === false || source.type !== "todoist") throw new ServiceError("BAD_REQUEST", "topic source is unavailable", { serviceId: "todoist", retryable: false });
    const generation = input.generation ?? this.runtime.generation;
    if (generation !== this.runtime.generation) throw new ServiceError("CANCELLED", "request generation is stale", { serviceId: "todoist", retryable: false });
    const serviceId = `todoist:${typeof source.name === "string" ? source.name : input.sourceIndex}`;
    const handle = this.runtime.registry.create({ serviceId, generation, ownerId: input.ownerId ?? "console", requestId: input.requestId, timeoutMs: bounded(source.timeoutMs, 30_000, 1_000, 120_000) });
    try {
      const value = await retryWithPolicy(() => operation(source, handle.context.signal), { maxAttempts: 1 + bounded(source.retries, 1, 0, 3), baseDelayMs: 500, maxDelayMs: 5_000 }, handle.context);
      if (handle.context.signal.aborted || generation !== this.runtime.generation) throw new ServiceError("CANCELLED", "request generation is stale", { serviceId, retryable: false });
      handle.complete(value);
      this.runtime.health.report({ type: "changed", serviceId, status: "healthy", at: Date.now() });
      return { ...value, requestId: handle.context.requestId };
    } catch (error) {
      const normalized = normalizeServiceError(error, handle.context);
      handle.fail(normalized);
      this.runtime.health.report({ type: "changed", serviceId, status: normalized.retryable ? "degraded" : "unavailable", at: Date.now(), error: normalized.toJSON() });
      throw normalized;
    }
  }

  async token(source: Record<string, unknown>, sourceIndex: number): Promise<string> {
    const key = typeof source.tokenSecretRef === "string" ? source.tokenSecretRef : `topics.sources.${sourceIndex}.token`;
    const token = await this.secretStore.getForService(key as never);
    if (!token) throw new ServiceError("AUTH", "Todoist token is not configured", { serviceId: "todoist", retryable: false });
    return token;
  }
  dispose(): void { this.runtime.dispose(); }
}
