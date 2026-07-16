// NewsSourceService (issue #188) — IPC向けの記事取得service。FeedServiceと同じ骨格
// (ServiceRuntime + retryWithPolicy + ServiceError/normalizeServiceError + health報告) に
// memory cacheを足したもの。既存 electron/main/services/feeds/ (RSS transport/parser) とは
// 統合せず、別serviceのまま隣接させる。

import type { ArticleFetchInput, ArticleFetchResponse, NewsSourceConfig } from "../../../shared/services/news-source-contract";
import { ConfigRepository } from "../../config/config-repository";
import { ServiceRuntime } from "../service-runtime";
import { retryWithPolicy } from "../retry-policy";
import { ServiceError, normalizeServiceError } from "../service-error";
import { SafeHttpClient } from "../feeds/rss-client";
import { fetchArticle } from "./article-fetcher";
import { NewsSourceCache } from "./source-cache";

function sourceAt(config: Record<string, unknown>, index: number): NewsSourceConfig {
  const sources = (config.news as { sources?: unknown })?.sources;
  if (!Number.isSafeInteger(index) || index < 0 || !Array.isArray(sources) || !sources[index] || typeof sources[index] !== "object") {
    throw new ServiceError("BAD_REQUEST", "news source was not found", { serviceId: "news-article", retryable: false });
  }
  return sources[index] as NewsSourceConfig;
}

function bounded(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, Math.floor(parsed))) : fallback;
}

export class NewsSourceService {
  readonly runtime = new ServiceRuntime("news-article");
  constructor(
    private readonly configRepository: ConfigRepository,
    private readonly http = new SafeHttpClient(),
    private readonly cache = new NewsSourceCache(),
  ) {}

  cancel(requestId: string): boolean {
    return this.runtime.registry.cancel(requestId, "cancelled");
  }

  async fetchArticle(input: ArticleFetchInput): Promise<ArticleFetchResponse> {
    if (!input.url) throw new ServiceError("BAD_REQUEST", "article URL is required", { serviceId: "news-article", retryable: false });
    const loaded = await this.configRepository.getPublic();
    const source = sourceAt(loaded.config, input.sourceIndex);
    const generation = input.generation ?? this.runtime.generation;
    if (generation !== this.runtime.generation) throw new ServiceError("CANCELLED", "request generation is stale", { serviceId: "news-article", retryable: false });

    const cacheKey = input.url;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      if (cached.value) return { article: cached.value, requestId: input.requestId ?? cacheKey };
      throw new ServiceError("UNAVAILABLE", "article source recently failed (negative cache)", { serviceId: "news-article", retryable: true });
    }

    const serviceId = `news-article:${source.name ?? input.sourceIndex}`;
    const handle = this.runtime.registry.create({ serviceId, generation, ownerId: input.ownerId ?? "console", requestId: input.requestId, timeoutMs: bounded(source.timeoutMs, 20_000, 1_000, 60_000) });
    const retries = bounded(source.retries, 1, 0, 3);
    try {
      const article = await retryWithPolicy(
        () => fetchArticle(input.url, this.http, handle.context, { allowedHosts: source.allowedHosts, maxBytes: bounded(source.maxResponseBytes, 2_000_000, 1_024, 5_000_000) }),
        { maxAttempts: 1 + retries, baseDelayMs: 500, maxDelayMs: 5_000 },
        handle.context,
      );
      if (handle.context.signal.aborted || generation !== this.runtime.generation) throw new ServiceError("CANCELLED", "request generation is stale", { serviceId, retryable: false });
      handle.complete(article);
      this.cache.set(cacheKey, article);
      this.runtime.health.report({ type: "changed", serviceId, status: "healthy", at: Date.now() });
      return { article, requestId: handle.context.requestId };
    } catch (error) {
      const normalized = normalizeServiceError(error, handle.context);
      handle.fail(normalized);
      this.cache.setNegative(cacheKey);
      this.runtime.health.report({ type: "changed", serviceId, status: normalized.retryable ? "degraded" : "unavailable", at: Date.now(), error: normalized.toJSON() });
      throw normalized;
    }
  }

  dispose(): void {
    this.runtime.dispose();
  }
}
