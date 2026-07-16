// Browser/既定用のbounded memory NewsHistoryStore (issue #189)。
// 契約は news-history-store.js を参照。件数上限とTTLの両方で有界にする。

import { NEWS_HISTORY_DEFAULTS } from "./news-history-store.js";

export class MemoryNewsHistoryStore {
  constructor({ maxEntries = NEWS_HISTORY_DEFAULTS.maxEntries, ttlDays = NEWS_HISTORY_DEFAULTS.ttlDays, clock = () => Date.now() } = {}) {
    this.maxEntries = Math.max(1, Math.floor(Number(maxEntries) || 1));
    this.ttlMs = Math.max(1, Number(ttlDays) || 1) * 24 * 60 * 60 * 1000;
    this.clock = clock;
    this.records = []; // newest-first
  }

  recordDelivered({ candidateId, titleKey, topicKey = null, urlHash = null, sourceId }, now = this.clock()) {
    this.#push({ candidateId, titleKey, topicKey, urlHash, sourceId, selectedAt: now, deliveredAt: now, outcome: "delivered" });
  }

  recordSpam({ candidateId, titleKey, topicKey = null, sourceId }, now = this.clock()) {
    this.#push({ candidateId, titleKey, topicKey, urlHash: null, sourceId, selectedAt: now, deliveredAt: null, outcome: "spam" });
  }

  recordFailedPermanent({ candidateId, titleKey, topicKey = null, sourceId }, now = this.clock()) {
    this.#push({ candidateId, titleKey, topicKey, urlHash: null, sourceId, selectedAt: now, deliveredAt: null, outcome: "failed_permanent" });
  }

  hasDeliveredTitle(titleKey) {
    if (!titleKey) return false;
    this.#prune();
    return this.records.some((r) => r.outcome === "delivered" && r.titleKey === titleKey);
  }

  hasDeliveredUrl(urlHash) {
    if (!urlHash) return false;
    this.#prune();
    return this.records.some((r) => r.outcome === "delivered" && r.urlHash === urlHash);
  }

  hasRecentTopic(topicKey, now = this.clock(), withinMs = NEWS_HISTORY_DEFAULTS.topicCooldownHours * 60 * 60 * 1000) {
    if (!topicKey) return false;
    this.#prune();
    return this.records.some((r) => r.outcome === "delivered" && r.topicKey === topicKey && now - r.selectedAt <= withinMs);
  }

  hasRecentSpam(titleKey, now = this.clock(), withinMs = NEWS_HISTORY_DEFAULTS.topicCooldownHours * 60 * 60 * 1000) {
    if (!titleKey) return false;
    this.#prune();
    return this.records.some((r) => r.outcome === "spam" && r.titleKey === titleKey && now - r.selectedAt <= withinMs);
  }

  recentSourceIds(limit = NEWS_HISTORY_DEFAULTS.sourceWindow) {
    this.#prune();
    return this.records.filter((r) => r.outcome === "delivered").slice(0, limit).map((r) => r.sourceId);
  }

  clear() {
    this.records = [];
  }

  clearSource(sourceId) {
    this.records = this.records.filter((r) => r.sourceId !== sourceId);
  }

  list() {
    this.#prune();
    return [...this.records];
  }

  #push(record) {
    this.records.unshift(record);
    this.#prune();
  }

  #prune(now = this.clock()) {
    this.records = this.records.filter((r) => now - r.selectedAt <= this.ttlMs);
    if (this.records.length > this.maxEntries) this.records.length = this.maxEntries;
  }
}
