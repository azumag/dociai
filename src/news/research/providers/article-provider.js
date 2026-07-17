// ArticleProvider (issue #190): 追加のnetwork呼び出しをせず、選定済みcandidateが既に持つ
// 記事本文 (#188のarticle fetch結果、無ければfeed summary) を単一sourceの根拠として使う。
// topic modeの既定research ("article") はこのproviderだけで完結する。

import { createProviderResult } from "../research-provider.js";

export function createArticleProvider() {
  return {
    id: "article",
    supports(input) {
      const candidate = input.candidate ?? {};
      return Boolean((candidate.contentText && candidate.contentText.trim()) || (candidate.description && candidate.description.trim()));
    },
    async research(input) {
      const candidate = input.candidate ?? {};
      const text = (candidate.contentText || candidate.description || "").slice(0, input.maxCharsPerSource ?? 1500);
      if (!text.trim()) return null;
      const sourceUrl = candidate.canonicalUrl || candidate.link || null;
      return createProviderResult("article", {
        facts: [{ text, sourceUrl, sourceName: candidate.sourceName, confidence: candidate.contentText ? "high" : "medium", kind: "fact" }],
        sources: sourceUrl ? [{ url: sourceUrl, sourceName: candidate.sourceName, publishedAt: candidate.publishedAt ?? null, isPrimary: false }] : [],
      });
    },
  };
}
