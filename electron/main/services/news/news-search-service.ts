// NewsSearchService (issue #190) — Google Newsの検索RSSを安全に取得する。
// 既存のRSS parser (electron/main/services/feeds/rss-parser.ts) をそのまま再利用し、
// SafeHttpClientのhost allowlistでnews.google.comだけへ限定する。

import type { NewsSearchInput, NewsSearchResponse, NewsSearchResult } from "../../../shared/services/news-research-contract";
import { ServiceRuntime } from "../service-runtime";
import { retryWithPolicy } from "../retry-policy";
import { ServiceError, normalizeServiceError } from "../service-error";
import { SafeHttpClient } from "../feeds/rss-client";
import { parseFeedXml } from "../feeds/rss-parser";

const ALLOWED_HOSTS = ["news.google.com"];
const MAX_RESULTS = 5;

function buildSearchUrl(query: string, language: string): string {
  const params = new URLSearchParams({ q: query, hl: language, gl: language === "ja" ? "JP" : "US", ceid: `${language === "ja" ? "JP" : "US"}:${language}` });
  return `https://news.google.com/rss/search?${params.toString()}`;
}

export class NewsSearchService {
  readonly runtime = new ServiceRuntime("news-search");
  constructor(private readonly http = new SafeHttpClient()) {}

  cancel(requestId: string): boolean {
    return this.runtime.registry.cancel(requestId, "cancelled");
  }

  async search(input: NewsSearchInput): Promise<NewsSearchResponse> {
    const query = String(input.query ?? "").trim().slice(0, 300);
    if (!query) throw new ServiceError("BAD_REQUEST", "search query is required", { serviceId: "news-search", retryable: false });
    const language = input.language === "en" ? "en" : "ja";
    const generation = input.generation ?? this.runtime.generation;
    if (generation !== this.runtime.generation) throw new ServiceError("CANCELLED", "request generation is stale", { serviceId: "news-search", retryable: false });

    const serviceId = "news-search:google-news";
    const handle = this.runtime.registry.create({ serviceId, generation, ownerId: input.ownerId ?? "console", requestId: input.requestId, timeoutMs: 15_000 });
    try {
      const response = await retryWithPolicy(
        () => this.http.request(buildSearchUrl(query, language), { signal: handle.context.signal, acceptedContentTypes: ["xml", "rss", "atom"], maxBytes: 1_000_000, maxRedirects: 5, allowedHosts: ALLOWED_HOSTS }),
        { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 5_000 },
        handle.context,
      );
      const items = parseFeedXml(response.body, "Google News", 0);
      if (handle.context.signal.aborted || generation !== this.runtime.generation) throw new ServiceError("CANCELLED", "request generation is stale", { serviceId, retryable: false });
      const results: NewsSearchResult[] = items.slice(0, MAX_RESULTS).map((item) => ({
        title: item.title,
        link: item.link,
        snippet: item.description,
        sourceName: item.sourceName,
        publishedAt: item.publishedAt,
      }));
      handle.complete(results);
      this.runtime.health.report({ type: "changed", serviceId, status: "healthy", at: Date.now() });
      return { results, requestId: handle.context.requestId };
    } catch (error) {
      const normalized = normalizeServiceError(error, handle.context);
      handle.fail(normalized);
      this.runtime.health.report({ type: "changed", serviceId, status: normalized.retryable ? "degraded" : "unavailable", at: Date.now(), error: normalized.toJSON() });
      throw normalized;
    }
  }

  dispose(): void {
    this.runtime.dispose();
  }
}
