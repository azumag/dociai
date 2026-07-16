// select stage (issue #187/#189) — 取得済み候補をItemProcessingStoreへ登録し、永続重複排除・
// spam判定・鮮度/source diversityで今回読む候補を選ぶ。
//
// dedupe/spam判定はsrc/news/selection/*、historyは既定でMemoryNewsHistoryStore (Electron
// 永続repositoryは#188/#189フォローアップ)。

import { filterCandidates } from "../selection/dedupe-candidates.js";
import { createSelectionPolicy } from "../selection/selection-policy.js";
import { createSpamGate } from "../selection/spam-gate.js";
import { MemoryNewsHistoryStore } from "../selection/memory-news-history-store.js";
import { NEWS_HISTORY_DEFAULTS } from "../selection/news-history-store.js";

export function createSelectStage({
  store,
  clock,
  historyStore = new MemoryNewsHistoryStore({ clock }),
  spamGate = createSpamGate(),
  selectionPolicy = createSelectionPolicy(),
  topicCooldownMs = NEWS_HISTORY_DEFAULTS.topicCooldownHours * 60 * 60 * 1000,
  sourceSuffixPatterns,
}) {
  return {
    id: "select",
    historyStore,
    async run({ items, generation, maxItems }, _context) {
      const now = clock();
      for (const item of items) store.ensure({ ...item, key: item.processingKey }, generation, now);
      const candidateKeys = new Set(store.candidates(generation, now).map((record) => record.key));

      const { eligible, stats } = await filterCandidates({ items, candidateKeys, historyStore, spamGate, now, topicCooldownMs, sourceSuffixPatterns });
      const { picks: scoredPicks, warnings } = selectionPolicy.select(eligible, { maxItems, historyStore, now });
      const picks = scoredPicks.map((p) => p.item);
      // このstageが(sourceSuffixPatterns込みで)導出したidentity keysをcoordinatorへ渡す。
      // ここで捨てて呼び出し側にderiveIdentityKeys(item)を再計算させると、
      // sourceSuffixPatterns設定時にcommit時のkeyとずれ、永続dedupeが静かに効かなくなる。
      const keysByProcessingKey = new Map(scoredPicks.map((p) => [p.item.processingKey, p.keys]));

      return { picks, eligibleCount: eligible.length, stats, warnings, keysByProcessingKey };
    },
  };
}
