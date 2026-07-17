// research stage (issue #187) — headline-onlyニュースの根拠調査。
//
// createResearchStage(): Phase 1の既定実装。常にnullを返す no-op。
// createNewsPipelineCoordinator()が今も既定でこちらを使う (理由はgenerate-stage.jsの
// 同名コメント参照)。
//
// createGroundingResearchStage(): issue #190の新実装。ResearchCoordinator
// (src/news/research/research-coordinator.js) + article/news-search/wikipedia/llm
// providerを配線し、modePolicy.researchに応じた複数ソース調査結果 (NewsResearchBundle)
// を返す。既に完成・テスト済みだが、coordinatorの既定への昇格は#193/#194のrollout判断に
// 委ねる。stage差し替え (`stages: { research: createGroundingResearchStage({...}) }`) で
// 今すぐ試すことはできる。

import { createResearchCoordinator } from "../research/research-coordinator.js";
import { createArticleProvider } from "../research/providers/article-provider.js";
import { createNewsSearchProvider } from "../research/providers/news-search-provider.js";
import { createWikipediaProvider } from "../research/providers/wikipedia-provider.js";
import { createLlmResearchProvider } from "../research/providers/llm-research-provider.js";
import { getNewsSourceCapabilities } from "../source-capabilities.js";

export function createResearchStage() {
  return {
    id: "research",
    async run(_input, _context) {
      return null;
    },
  };
}

export function createGroundingResearchStage({ webResearcher = null, cache = null, providers, getCapabilities = getNewsSourceCapabilities, clock = () => Date.now() } = {}) {
  const coordinator = createResearchCoordinator({
    providers: providers ?? [createArticleProvider(), createNewsSearchProvider(), createWikipediaProvider(), createLlmResearchProvider({ webResearcher })],
    cache,
    clock,
  });
  return {
    id: "research",
    async run({ item, modePolicy }, context) {
      return coordinator.research({ candidate: item, mode: modePolicy?.mode, modePolicy }, context, getCapabilities());
    },
  };
}
