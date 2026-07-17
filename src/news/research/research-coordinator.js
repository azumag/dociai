// ResearchCoordinator (issue #190)
// modePolicy.researchに応じてproviderを選び、1 providerの失敗が他を止めないようにしながら
// 順番に呼び、結果をsource-mergerでNewsResearchBundleへ統合する。全provider失敗/未対応の
// 場合はnull (research不十分の明示) を返す — generate stage (#191) はnullを「調査結果なし」
// として安全に扱える。

import { isCancellation } from "../../runtime/request-registry.js";
import { buildQueries } from "./query-builder.js";
import { mergeProviderResults } from "./source-merger.js";
import { buildResearchCacheKey } from "./research-cache.js";

// research: "none" -> provider無し、"article" -> article providerだけ、
// "multi_source" -> 全provider (article -> news-search -> wikipedia -> llm)。
function selectProviders(providers, researchMode) {
  if (researchMode === "none") return [];
  if (researchMode === "article") return providers.filter((p) => p.id === "article");
  return providers;
}

export function createResearchCoordinator({ providers, cache = null, clock = () => Date.now() }) {
  return {
    async research({ candidate, mode, modePolicy, maxSources = 5, maxCharsPerSource = 1500, language = "ja" }, context = {}, capabilities = {}) {
      const researchMode = modePolicy?.research ?? "none";
      const applicable = selectProviders(providers, researchMode);
      if (!applicable.length) return null;

      const queries = buildQueries(candidate.title);
      const input = { candidate, mode, maxSources, maxCharsPerSource, language, queries };

      const cacheKey = cache && queries[0] ? buildResearchCacheKey({ query: queries[0], mode, now: clock() }) : null;
      if (cacheKey) {
        const cached = cache.get(cacheKey);
        if (cached) return cached;
      }

      const results = [];
      const fallbackPath = [];
      for (const provider of applicable) {
        if (!provider.supports(input, capabilities)) {
          fallbackPath.push(`${provider.id}:unsupported`);
          continue;
        }
        try {
          const result = await provider.research(input, context);
          if (result) {
            results.push(result);
            fallbackPath.push(`${provider.id}:ok`);
          } else {
            fallbackPath.push(`${provider.id}:empty`);
          }
        } catch (error) {
          if (isCancellation(error)) throw error;
          // 1 providerの失敗で研究全体を止めない (issue #186/#190の不変条件)。
          fallbackPath.push(`${provider.id}:failed`);
        }
      }

      if (!results.length) return null;
      const merged = mergeProviderResults(candidate.processingKey ?? candidate.guid ?? null, candidate.title, results);
      const bundle = { ...merged, generatedAt: new Date(clock()).toISOString(), fallbackPath };
      if (cacheKey) cache.set(cacheKey, bundle);
      return bundle;
    },
  };
}
