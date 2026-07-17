// NewsSearchProvider (issue #190): Google News検索RSS経由で関連publisher候補を取得する。
// Electron Main限定 (SafeHttpClientのhost allowlist) — Browserではsupports()がfalseになり、
// 機械的providerチェーンはarticle providerだけへdegradeする。

import { queryNewsSearchThroughElectron, cancelElectronNewsSearchRequest, hasElectronNewsSearchService } from "../../../platform/electron-services.js";
import { createProviderResult } from "../research-provider.js";

export function createNewsSearchProvider() {
  return {
    id: "news-search",
    supports(input, capabilities = {}) {
      return Boolean(capabilities.newsSearch ?? hasElectronNewsSearchService()) && (input.queries?.length ?? 0) > 0;
    },
    async research(input, context) {
      const query = input.queries?.[0];
      if (!query) return null;
      const requestId = `${context?.requestId ?? "news"}:search:${query}`;
      const cancel = () => { void cancelElectronNewsSearchRequest(requestId); };
      context?.signal?.addEventListener("abort", cancel, { once: true });
      let result;
      try {
        result = await queryNewsSearchThroughElectron({ query, language: input.language ?? "ja", requestId, generation: context?.generation });
      } finally {
        context?.signal?.removeEventListener("abort", cancel);
      }
      if (!result?.ok) throw new Error(result?.error?.message ?? "ニュース検索に失敗しました");
      const results = (result.value.results ?? []).slice(0, input.maxSources ?? 5);
      if (!results.length) return null;
      return createProviderResult("news-search", {
        facts: results.map((entry) => ({ text: entry.snippet, sourceUrl: entry.link, sourceName: entry.sourceName, confidence: "medium", kind: "fact" })).filter((f) => f.text),
        sources: results.map((entry) => ({ url: entry.link, sourceName: entry.sourceName, publishedAt: entry.publishedAt })),
      });
    },
  };
}
