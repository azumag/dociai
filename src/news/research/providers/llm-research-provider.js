// LlmResearchProvider (issue #190): 既存 src/app/web-researcher.js (WebResearcher, connector.
// search()経由のMiniMax Web検索等) をニュース調査へ再利用する。専用のtool-capability検出は
// 新設せず、WebResearcher自身の`enabled`ゲートをそのままsupports()判定に使う — 呼び出し側
// (ResponseCoordinator/TopicReader) と同じ、既にテスト済みの契約を再利用するため。
//
// LLM agentが使えない/失敗しても、ここでの例外はresearch-coordinator側でcatchされ、機械的
// providerだけで研究を継続する (issue #186 不変条件)。

import { createProviderResult } from "../research-provider.js";

export function createLlmResearchProvider({ webResearcher }) {
  return {
    id: "llm",
    supports() {
      return Boolean(webResearcher?.enabled);
    },
    async research(input, context) {
      const query = input.queries?.[0] ?? input.candidate?.title;
      if (!query) return null;
      const response = await webResearcher.research({ task: query, signal: context?.signal, requestId: context?.requestId, generation: context?.generation });
      const results = response?.results ?? [];
      if (!results.length) return null;
      return createProviderResult("llm", {
        facts: results.map((entry) => ({
          text: String(entry.snippet ?? "").slice(0, input.maxCharsPerSource ?? 800),
          sourceUrl: entry.link ?? null,
          sourceName: entry.title ?? null,
          confidence: "medium",
          kind: "fact",
        })).filter((fact) => fact.text),
        sources: results.filter((entry) => entry.link).map((entry) => ({ url: entry.link, sourceName: entry.title, publishedAt: entry.date ?? null })),
      });
    },
  };
}
