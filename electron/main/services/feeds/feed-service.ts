import type { FeedFetchInput, FeedFetchResponse } from "../../../shared/services/feed-contract";
import { ConfigRepository } from "../../config/config-repository";
import { ServiceRuntime } from "../service-runtime";
import { retryWithPolicy } from "../retry-policy";
import { ServiceError, normalizeServiceError } from "../service-error";
import { SafeHttpClient } from "./rss-client";
import { parseFeedXml } from "./rss-parser";

function sourceAt(config: Record<string, unknown>, index: number): Record<string, unknown> {
  const sources = (config.news as { sources?: unknown })?.sources;
  if (!Number.isSafeInteger(index) || index < 0 || !Array.isArray(sources) || !sources[index] || typeof sources[index] !== "object") throw new ServiceError("BAD_REQUEST", "feed source was not found", { serviceId: "feed", retryable: false });
  return sources[index] as Record<string, unknown>;
}

function bounded(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, Math.floor(parsed))) : fallback;
}

export class FeedService {
  readonly runtime = new ServiceRuntime("feed");
  constructor(private readonly configRepository: ConfigRepository, private readonly http = new SafeHttpClient()) {}
  cancel(requestId: string): boolean { return this.runtime.registry.cancel(requestId, "cancelled"); }

  async fetch(input: FeedFetchInput): Promise<FeedFetchResponse> {
    const loaded = await this.configRepository.getPublic();
    const source = sourceAt(loaded.config, input.sourceIndex);
    if (source.enabled === false) throw new ServiceError("BAD_REQUEST", "feed source is disabled", { serviceId: "feed", retryable: false });
    if (source.type !== "rss") throw new ServiceError("BAD_REQUEST", "feed source type is unsupported", { serviceId: "feed", retryable: false });
    const url = typeof source.url === "string" ? source.url : "";
    if (!url) throw new ServiceError("BAD_REQUEST", "feed source URL is missing", { serviceId: "feed", retryable: false });
    const generation = input.generation ?? this.runtime.generation;
    if (generation !== this.runtime.generation) throw new ServiceError("CANCELLED", "request generation is stale", { serviceId: "feed", retryable: false });
    const serviceId = `feed:${typeof source.name === "string" ? source.name : input.sourceIndex}`;
    const handle = this.runtime.registry.create({ serviceId, generation, ownerId: input.ownerId ?? "console", requestId: input.requestId, timeoutMs: bounded(source.timeoutMs, 30_000, 1_000, 120_000) });
    const retries = bounded(source.retries, 1, 0, 3);
    try {
      const response = await retryWithPolicy(() => this.http.request(url, { signal: handle.context.signal, acceptedContentTypes: ["xml", "rss", "atom", "text/plain"], maxBytes: bounded(source.maxResponseBytes, 1_000_000, 1_024, 5_000_000) }), { maxAttempts: 1 + retries, baseDelayMs: 500, maxDelayMs: 5_000 }, handle.context);
      const items = parseFeedXml(response.body, typeof source.name === "string" ? source.name : `feed-${input.sourceIndex}`, input.sourceIndex);
      if (handle.context.signal.aborted || generation !== this.runtime.generation) throw new ServiceError("CANCELLED", "request generation is stale", { serviceId, retryable: false });
      handle.complete(items);
      this.runtime.health.report({ type: "changed", serviceId, status: "healthy", at: Date.now() });
      return { items, requestId: handle.context.requestId };
    } catch (error) {
      const normalized = normalizeServiceError(error, handle.context);
      handle.fail(normalized);
      this.runtime.health.report({ type: "changed", serviceId, status: normalized.retryable ? "degraded" : "unavailable", at: Date.now(), error: normalized.toJSON() });
      throw normalized;
    }
  }
  dispose(): void { this.runtime.dispose(); }
}
