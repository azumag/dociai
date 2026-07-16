// NewsPromptBuilder (issue #191)
// ニュース生成を汎用ContextBuilderの「2文以内、80文字程度」ルールから分離した専用prompt。
// ContextBuilderと同じ { messages, debugText } 形状を返し、AIConnector.chat(messages)へ
// そのまま渡せるようにする。

import { buildPersonaSystemBlock } from "./persona-policy.js";
import { buildSpokenTextRulesBlock } from "./spoken-text-policy.js";
import { buildOutputFormatInstructions } from "./news-output-contract.js";
import { formatCandidateBlock, formatResearchBlock } from "./templates/common.js";
import { buildTopicInstructions } from "./templates/topic.js";
import { buildCurrentInstructions } from "./templates/current.js";
import { buildSimpleInstructions } from "./templates/simple.js";
import { buildRewriteAddendum } from "./templates/rewrite.js";

const MODE_INSTRUCTION_BUILDERS = { topic: buildTopicInstructions, current: buildCurrentInstructions, simple: buildSimpleInstructions };

const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 };

// token budgetの代わりに文字数で決定的に縮約する (issue #191「文字数だけでなく利用可能なら
// tokenizerを使う」の暫定実装。connector/model capabilitiesとの連携は#190/#191フォローアップ)。
// low confidenceのfactから削り、viewpoint/backgroundの順に削る。title/unresolved/最後の
// factは最後まで保持する。
export function shrinkResearchToFit(research, maxChars) {
  if (!research) return research;
  const draft = { ...research, facts: [...(research.facts ?? [])], background: [...(research.background ?? [])], viewpoints: [...(research.viewpoints ?? [])] };
  while (formatResearchBlock(draft).length > maxChars) {
    const lowConfidenceIndex = draft.facts.findIndex((fact) => (CONFIDENCE_RANK[fact.confidence] ?? 1) === 0);
    if (lowConfidenceIndex >= 0) draft.facts.splice(lowConfidenceIndex, 1);
    else if (draft.viewpoints.length) draft.viewpoints.pop();
    else if (draft.background.length) draft.background.pop();
    else if (draft.facts.length > 1) draft.facts.pop();
    else break; // これ以上削ると根拠が消えるため打ち切る
  }
  return draft;
}

export function buildNewsPrompt({ candidate, research = null, persona, policy, recentTopics = [], currentTime = null, rewriteFeedback = [], maxResearchChars = 3000 }) {
  const modeBuilder = MODE_INSTRUCTION_BUILDERS[policy?.mode] ?? buildTopicInstructions;
  const shrunkResearch = shrinkResearchToFit(research, maxResearchChars);

  const system = [buildPersonaSystemBlock(persona), buildSpokenTextRulesBlock()].filter(Boolean).join("\n\n").trim();

  const userParts = [
    formatCandidateBlock(candidate, { currentTime }),
    formatResearchBlock(shrunkResearch),
    recentTopics.length ? `# 直近で読み上げた話題 (同じ切り口を繰り返さない)\n${recentTopics.join("\n")}` : null,
    buildRewriteAddendum(rewriteFeedback) || null,
    `# 依頼\n${modeBuilder(policy)}`,
    buildOutputFormatInstructions(),
  ].filter(Boolean);

  const user = userParts.join("\n\n");
  const messages = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  const debugText = `--- system ---\n${system}\n\n--- user ---\n${user}`;
  return { messages, debugText };
}
