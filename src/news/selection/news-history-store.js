// NewsHistoryStore契約 (issue #189)。
// Browser: bounded memory adapter (memory-news-history-store.js)。
// Electron: userData配下のrepository adapter (issue #188/#189フォローアップで追加予定)。
// どちらも同じ最小APIだけを実装する:
//
//   recordDelivered({ candidateId, titleKey, topicKey, urlHash, sourceId }, now)
//   recordSpam({ candidateId, titleKey, topicKey, sourceId }, now)
//   recordFailedPermanent({ candidateId, titleKey, topicKey, sourceId }, now)
//   hasDeliveredTitle(titleKey) -> boolean
//   hasDeliveredUrl(urlHash) -> boolean
//   hasRecentTopic(topicKey, now, withinMs) -> boolean
//   hasRecentSpam(titleKey, now, withinMs) -> boolean
//   recentSourceIds(limit) -> string[] (新しい順)
//   clear() / clearSource(sourceId) / list()
//
// 本文・prompt・AI出力全文は保存しない — titleKey/topicKey/urlHash/sourceId/timestamp/outcome
// だけを保持する。「selected」だけの中間状態は記録しない: recordDelivered()はcommit
// (ItemProcessingStore.markRead成功後) にだけ呼ばれる契約なので、処理中クラッシュは
// 自動的に再候補になる。

export const NEWS_HISTORY_DEFAULTS = Object.freeze({
  maxEntries: 500,
  ttlDays: 30,
  sourceWindow: 20,
  topicCooldownHours: 24,
});
