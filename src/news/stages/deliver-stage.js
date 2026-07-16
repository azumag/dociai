// deliver stage (issue #187) — SpeechQueueへの投入。
// このstageだけが音声queueへ触れる (issue #186の不変条件「delivery stage以外は音声queueへ
// 触らない」)。Phase 1では legacy adapter の deliver() (enqueue + drop警告ログ) をそのまま呼ぶ。

export function createDeliverStage({ adapter }) {
  return {
    id: "deliver",
    async run({ persona, item, text }, _context) {
      return adapter.deliver({ persona, item, text });
    },
  };
}
