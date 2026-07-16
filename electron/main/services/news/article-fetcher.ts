// ArticleFetcher (issue #188): SafeHttpClient経由でHTML本文を安全に取得し、canonical URLと
// 本文候補を抽出する。ここではnetwork/抽出の純粋な合成だけを行い、retry/health/cacheは
// news-source-service.ts (呼び出し側) が持つ。

import { ServiceError } from "../service-error";
import type { RequestContext } from "../../../shared/services/service-contract";
import { SafeHttpClient } from "../feeds/rss-client";
import { extractCanonicalUrl } from "./canonical-url";
import { extractArticleText } from "./article-extractor";
import { isHostAllowed } from "./source-policy";
import type { SanitizedArticle } from "../../../shared/services/news-source-contract";

const USER_AGENT = "dociai-news-fetcher/1";
const ACCEPTED_CONTENT_TYPES = ["text/html", "application/xhtml+xml", "text/xml", "application/xml", "text/plain"];
const MAX_REDIRECTS = 5;

export type ArticleFetchOptions = { allowedHosts?: string[]; maxBytes?: number };

export async function fetchArticle(url: string, http: SafeHttpClient, context: RequestContext, options: ArticleFetchOptions = {}): Promise<SanitizedArticle> {
  if (!isHostAllowed(url, options.allowedHosts)) {
    throw new ServiceError("BAD_REQUEST", "article source host is not allowed", { serviceId: "news-article", retryable: false });
  }
  const response = await http.request(url, {
    signal: context.signal,
    headers: { "User-Agent": USER_AGENT },
    acceptedContentTypes: ACCEPTED_CONTENT_TYPES,
    maxBytes: options.maxBytes ?? 2_000_000,
    maxRedirects: MAX_REDIRECTS,
    allowedHosts: options.allowedHosts,
  });
  const canonicalUrl = extractCanonicalUrl(response.body, response.url);
  const extracted = extractArticleText(response.body);
  if (!extracted) throw new ServiceError("EMPTY", "article body could not be extracted", { serviceId: "news-article", retryable: false });
  return { canonicalUrl, contentText: extracted.text };
}
