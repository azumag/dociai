// issue #188: 記事本文・source metadata・licenseの契約。Rendererはこの型だけを介して
// Main processのNewsSourceServiceとやり取りする。Renderer側は任意URLへ直接fetchしない。

export type NewsSourceConfig = {
  id: string;
  name: string;
  type: "rss" | "google-news" | "mock";
  url?: string;
  enabled?: boolean;
  language?: string;
  articleFetch?: "never" | "auto" | "required";
  allowedHosts?: string[];
  license?: { name: string; url?: string; attributionRequired?: boolean };
  timeoutMs?: number;
  retries?: number;
  maxResponseBytes?: number;
};

export type NewsLicense = { name: string; url?: string; attributionRequired: boolean };

export type ContentOrigin = "feed-content" | "feed-summary" | "article" | "none";

export type AcquiredNewsItem = {
  sourceId: string;
  sourceName: string;
  title: string;
  feedUrl?: string;
  originalUrl?: string;
  canonicalUrl?: string;
  publishedAt?: string;
  author?: string;
  language?: string;
  summary?: string;
  contentText?: string;
  contentOrigin: ContentOrigin;
  license?: NewsLicense;
};

export type SanitizedArticle = {
  canonicalUrl: string;
  contentText: string;
  title?: string;
  author?: string;
  language?: string;
  publishedAt?: string;
};

export type ArticleFetchInput = { sourceIndex: number; url: string; requestId?: string; generation?: number; ownerId?: string };
export type ArticleFetchResponse = { article: SanitizedArticle; requestId: string };

// Browser版はarticle fetch/Google News解決/永続cacheのいずれも提供できない。Electron版は
// 全機能を提供する。issue #188「Browser degradation」。
export type NewsSourceCapabilities = {
  feedFetch: boolean;
  articleFetch: boolean;
  googleNewsResolve: boolean;
  persistentCache: boolean;
};
