// generate stage (issue #187/#191) — 読み上げ文生成。
//
// createGenerateStage(): Phase 1の既定実装。legacy adapterのgenerate() (ContextBuilder +
// AIConnector.chat + 空文字/出力上限検査) をそのまま呼ぶ。NewsPipelineCoordinatorの
// createNewsPipelineCoordinator()が今も既定でこちらを使う — 既存のtopic/current/simple
// characterization testを壊さないため (issue #187 Phase 1の「挙動を変えない」契約)。
//
// createNewsPromptGenerateStage(): issue #191の新実装。汎用ContextBuilderの「2文以内、
// 80文字程度」ルールから独立したニュース専用prompt (src/news/generation/*) +
// connector fallback chainを使う。既に完成・テスト済みだが、既存mock/characterization
// fixtureの全面的な書き換えを要するため、coordinatorの既定へ昇格させるのは段階導入
// (issue #193/#194のfeature flag/rollout) の役目として意図的に見送っている。stage差し替え
// (`stages: { generate: createNewsPromptGenerateStage({...}) }`) で今すぐ試すことはできる。

import { createNewsGenerationService } from "../generation/news-generation-service.js";
import { buildOutputLimitWarning, isOutputLimitFinishReason } from "../../ai-finish-reason.js";

export function createGenerateStage({ adapter }) {
  return {
    id: "generate",
    async run({ item, persona, connector, research, requestId }, context) {
      return adapter.generate({ item, persona, connector, research, requestId, context });
    },
  };
}

export function createNewsPromptGenerateStage({ getConnector, fallbackConnectorIds = [], log = () => {}, generationService = createNewsGenerationService({ getConnector }) }) {
  return {
    id: "generate",
    async run({ item, persona, research, modePolicy, requestId, feedback }, context) {
      const result = await generationService.generate({
        candidate: item,
        research,
        persona,
        policy: modePolicy,
        recentTopics: [],
        currentTime: new Date(context.startedAt ?? Date.now()).toISOString(),
        rewriteFeedback: feedback ?? [],
        connectorId: persona.connector,
        fallbackConnectorIds,
        requestId,
        context,
      });
      if (!String(result.text ?? "").trim()) throw Object.assign(new Error("ニュース生成結果が空です"), { kind: "empty" });
      if (isOutputLimitFinishReason(result.finishReason)) log(buildOutputLimitWarning(result.finishReason, result.connectorId ?? persona.connector), "warn");
      return { text: result.text, debugText: result.debugText, finishReason: result.finishReason, connectorId: result.connectorId, fallbackPath: result.fallbackPath };
    },
  };
}
