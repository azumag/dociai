// quality stage (issue #187/#192) — 生成文の品質検査 + rewrite要否判定。
//
// createQualityStage(): Phase 1の既定実装。検査ロジックを持たず常に合格を返す no-op。
// createNewsPipelineCoordinator()が今も既定でこちらを使う (理由はgenerate-stage.jsの
// 同名コメント参照)。
//
// createNewsQualityGateStage(): issue #192の新実装。parser/sanitize/repetition/language/
// tone/mode/grounding検査 + rewrite回数の集計を行う (src/news/quality/*)。
// createNewsPromptGenerateStage (generate-stage.js) とセットで使うと、生成された
// marker付きraw textを解析・sanitizeした本文だけがNewsPipelineCoordinatorから
// delivery stageへ渡る。coordinatorの既定への昇格は#193/#194のrollout判断に委ねる。

import { runNewsQualityGate } from "../quality/news-quality-gate.js";

export function createQualityStage() {
  return {
    id: "quality",
    async run(_input, _context) {
      return { passed: true, reasons: [] };
    },
  };
}

export function createNewsQualityGateStage({ minChars, maxChars, bannedPhrases } = {}) {
  return {
    id: "quality",
    async run({ text, modePolicy, research }, _context) {
      const validSourceIds = research?.sources ? new Set(research.sources.map((source) => source.id ?? source.sourceId)) : null;
      const report = runNewsQualityGate({
        rawText: text,
        policy: modePolicy,
        research,
        validSourceIds,
        minChars: minChars ?? modePolicy?.targetChars?.min,
        maxChars: maxChars ?? modePolicy?.targetChars?.max,
        bannedPhrases,
      });
      const reasons = report.failures.filter((f) => f.severity === "rewrite");
      return { passed: report.passed, reasons, metrics: report.metrics, parsed: report.parsed, failures: report.failures };
    },
  };
}
