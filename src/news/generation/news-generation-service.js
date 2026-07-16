// NewsGenerationService (issue #191)
// NewsPromptBuilderで組み立てたmessagesをAIConnector.chat()へ渡す。provider固有分岐は
// 一切持たず、既存AIConnector契約 (chat(messages, opts) -> {text, finishReason}) だけを使う。
// auth/bad_requestは無差別fallbackしない。timeout/network/rate_limit/serverのみ、
// configで解決されたconnector ID列に沿ってfallbackする。

import { buildNewsPrompt } from "./news-prompt-builder.js";

const FALLBACK_KINDS = new Set(["timeout", "network", "rate_limit", "server"]);

export function createNewsGenerationService({ getConnector, promptBuilder = buildNewsPrompt }) {
  return {
    async generate({ candidate, research, persona, policy, recentTopics, currentTime, rewriteFeedback, connectorId, fallbackConnectorIds = [], requestId, context = {} }) {
      const { messages, debugText } = promptBuilder({ candidate, research, persona, policy, recentTopics, currentTime, rewriteFeedback });
      const chain = [connectorId, ...fallbackConnectorIds];
      const fallbackPath = [];
      let lastError = null;

      for (const id of chain) {
        const connector = getConnector(id);
        if (!connector?.chat) {
          lastError = Object.assign(new Error(`connector "${id}" is not available`), { kind: "unavailable" });
          fallbackPath.push({ connectorId: id, status: "unavailable" });
          continue;
        }
        try {
          const result = await connector.chat(messages, { signal: context.signal, requestId, generation: context.generation });
          fallbackPath.push({ connectorId: id, status: "ok" });
          return { text: result.text, debugText, finishReason: result.finishReason, connectorId: id, fallbackPath };
        } catch (error) {
          fallbackPath.push({ connectorId: id, status: "failed", kind: error?.kind ?? "unknown" });
          lastError = error;
          if (!FALLBACK_KINDS.has(String(error?.kind ?? "").toLowerCase())) throw error;
        }
      }
      throw lastError ?? new Error("ニュース生成に使えるconnectorがありません");
    },
  };
}
