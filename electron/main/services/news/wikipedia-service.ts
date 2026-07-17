// WikipediaService (issue #190) — Wikipediaの検索+要約を1回のHTTP呼び出しで取得する。
// generator=searchでtitleとextractを同時に得られるMediaWiki APIを使い、SafeHttpClientの
// host allowlistでja.wikipedia.org/en.wikipedia.orgだけへ限定する。

import type { WikipediaSearchInput, WikipediaSearchResponse } from "../../../shared/services/news-research-contract";
import { ServiceRuntime } from "../service-runtime";
import { retryWithPolicy } from "../retry-policy";
import { ServiceError, normalizeServiceError } from "../service-error";
import { SafeHttpClient } from "../feeds/rss-client";

const HOSTS: Record<string, string> = { ja: "ja.wikipedia.org", en: "en.wikipedia.org" };

function buildSearchUrl(host: string, query: string): string {
  const params = new URLSearchParams({
    action: "query",
    generator: "search",
    gsrsearch: query,
    gsrlimit: "1",
    prop: "extracts|info",
    exintro: "true",
    explaintext: "true",
    exchars: "1200",
    inprop: "url",
    format: "json",
    formatversion: "2",
  });
  return `https://${host}/w/api.php?${params.toString()}`;
}

type WikipediaApiResponse = { query?: { pages?: Array<{ title?: string; extract?: string; fullurl?: string }> } };

export class WikipediaService {
  readonly runtime = new ServiceRuntime("wikipedia");
  constructor(private readonly http = new SafeHttpClient()) {}

  cancel(requestId: string): boolean {
    return this.runtime.registry.cancel(requestId, "cancelled");
  }

  async search(input: WikipediaSearchInput): Promise<WikipediaSearchResponse> {
    const query = String(input.query ?? "").trim().slice(0, 300);
    if (!query) throw new ServiceError("BAD_REQUEST", "search query is required", { serviceId: "wikipedia", retryable: false });
    const language = input.language === "en" ? "en" : "ja";
    const host = HOSTS[language];
    const generation = input.generation ?? this.runtime.generation;
    if (generation !== this.runtime.generation) throw new ServiceError("CANCELLED", "request generation is stale", { serviceId: "wikipedia", retryable: false });

    const serviceId = `wikipedia:${language}`;
    const handle = this.runtime.registry.create({ serviceId, generation, ownerId: input.ownerId ?? "console", requestId: input.requestId, timeoutMs: 15_000 });
    try {
      const response = await retryWithPolicy(
        () => this.http.request(buildSearchUrl(host, query), { signal: handle.context.signal, acceptedContentTypes: ["json"], maxBytes: 1_000_000, maxRedirects: 5, allowedHosts: [host] }),
        { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 5_000 },
        handle.context,
      );
      let parsed: WikipediaApiResponse;
      try { parsed = JSON.parse(response.body) as WikipediaApiResponse; }
      catch { throw new ServiceError("BAD_REQUEST", "Wikipedia response was not valid JSON", { serviceId, retryable: false }); }
      if (handle.context.signal.aborted || generation !== this.runtime.generation) throw new ServiceError("CANCELLED", "request generation is stale", { serviceId, retryable: false });
      const page = parsed.query?.pages?.[0];
      const summary = page?.extract ? { title: page.title ?? query, extract: page.extract, url: page.fullurl ?? null } : null;
      handle.complete(summary);
      this.runtime.health.report({ type: "changed", serviceId, status: "healthy", at: Date.now() });
      return { summary, requestId: handle.context.requestId };
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
