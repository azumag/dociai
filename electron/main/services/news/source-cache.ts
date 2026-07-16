// NewsSourceCache (issue #188)。memory cacheを先行実装する。TTL既定30分、error responseは
// 短いnegative cache (既定3分)。raw HTMLは保存せず、抽出済みSanitizedArticleだけを保持する。
//
// ETag/Last-Modified conditional requestは follow-up とする — SafeHttpClient
// (electron/main/services/feeds/rss-client.ts) がconditional request/304応答を扱えるように
// なってから、このcacheへetag/lastModifiedフィールドを足す。

import type { SanitizedArticle } from "../../../shared/services/news-source-contract";

export type NewsSourceCacheEntry = { key: string; fetchedAt: number; expiresAt: number; value: SanitizedArticle | null };

export class NewsSourceCache {
  #entries = new Map<string, NewsSourceCacheEntry>();
  constructor(
    private readonly ttlMs = 30 * 60 * 1000,
    private readonly negativeTtlMs = 3 * 60 * 1000,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  get(key: string): NewsSourceCacheEntry | null {
    const entry = this.#entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.clock()) {
      this.#entries.delete(key);
      return null;
    }
    return entry;
  }

  set(key: string, value: SanitizedArticle): void {
    this.#entries.set(key, { key, fetchedAt: this.clock(), expiresAt: this.clock() + this.ttlMs, value });
  }

  setNegative(key: string): void {
    this.#entries.set(key, { key, fetchedAt: this.clock(), expiresAt: this.clock() + this.negativeTtlMs, value: null });
  }

  clear(): void {
    this.#entries.clear();
  }
}
