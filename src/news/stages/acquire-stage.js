// acquire stage (issue #187) — feed/article候補の取得。
// Phase 1では legacy adapter の fetchAll (RSS/Atom/mock取得 + refine) をそのまま呼ぶだけ。
// issue #188 (記事本文・source metadata・license取得) がこのstageの実装を差し替える。

export function createAcquireStage({ fetchAll }) {
  return {
    id: "acquire",
    async run(_input, context) {
      return fetchAll(context);
    },
  };
}
