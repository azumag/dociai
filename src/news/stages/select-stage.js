// select stage (issue #187) — 取得済み候補をItemProcessingStoreへ登録し、今回読める分を選ぶ。
// Phase 1では旧NewsReader.run()と同じ「ensure -> candidates() -> maxItemsでslice」のまま。
// issue #189 (永続重複排除・spam判定・鮮度/source diversity選定) がこのstageを差し替える。

export function createSelectStage({ store, clock }) {
  return {
    id: "select",
    async run({ items, generation, maxItems }, _context) {
      const now = clock();
      for (const item of items) store.ensure({ ...item, key: item.processingKey }, generation, now);
      const candidateKeys = new Set(store.candidates(generation, now).map((record) => record.key));
      const picks = items.filter((item) => candidateKeys.has(item.processingKey)).slice(0, maxItems);
      return { picks, eligibleCount: candidateKeys.size };
    },
  };
}
