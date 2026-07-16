// quality stage (issue #187) — 生成文の品質検査 + rewrite要否判定。
// Phase 1には検査ロジックがまだなく (issue #192で parser/sanitize/grounding検査を追加)、常に
// 合格を返す no-op。NewsPipelineCoordinatorのrewriteループ自体はここで既に配線済みなので、
// #192は{ passed: false, reasons }を返すだけでrewriteを有効化できる。

export function createQualityStage() {
  return {
    id: "quality",
    async run(_input, _context) {
      return { passed: true, reasons: [] };
    },
  };
}
