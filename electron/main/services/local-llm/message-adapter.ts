// Converts the shared "既存ChatMessage[]" shape (electron/shared/local-llm/contract.ts's
// LocalLlmChatMessage — the same shape as electron/shared/services/ai-contract.ts's AiMessage)
// into what node-llama-cpp's LlamaChatSession actually accepts: a `systemPrompt` string, a seed
// `chatHistory` (everything except the final turn), and the final user-turn text to actually call
// `session.prompt(...)` with.
//
// Statelessness (issue TODO: "LlamaChatSessionは履歴を内部保持するため、stateless chat(messages)に
// 対するリクエスト毎の履歴リセット（または毎回session生成）をmessage-adapterの責務として定める"):
// this module is pure and produces a fresh {systemPrompt, history, prompt} triple from the FULL
// message array on every call — it never holds a session or any state of its own. model-runtime.ts
// is the one that acts on this: it keeps ONE persistent LlamaChatSession for the loaded model's
// whole lifetime, but calls `session.setChatHistory(...)` with this module's freshly-adapted
// history before every single prompt() (the "リクエスト毎の履歴リセット" branch of that TODO), so
// generation stays stateless-per-request while the underlying model/context/session stay resident.
import { classifyMessageContent } from "../../../shared/local-llm/schemas";
import type { LocalLlmChatMessage } from "../../../shared/local-llm/contract";
import type { LlamaChatHistoryItemLike } from "./native-loader";

export type AdaptedChat = { systemPrompt: string; history: LlamaChatHistoryItemLike[]; prompt: string };
export type AdaptMessagesResult = { ok: true; value: AdaptedChat } | { ok: false; reason: string; capability?: string };

/** "unknown content partを黙って文字列化しない" / "image contentは初期実装でUNSUPPORTED_CAPABILITY"
 * — delegates the actual classification to schemas.ts's classifyMessageContent (the single place
 * that decides text vs. unsupported-capability vs. invalid) so load-time validation and
 * generation-time adaptation can never disagree about what a given message's content means. */
function extractText(content: unknown): { ok: true; text: string } | { ok: false; reason: string; capability?: string } {
  const classified = classifyMessageContent(content);
  if (classified.kind === "text") return { ok: true, text: classified.text };
  if (classified.kind === "unsupported-capability") return { ok: false, reason: `unsupported content capability: ${classified.capability}`, capability: classified.capability };
  return { ok: false, reason: "message content is not a recognized shape" };
}

/** "system messageは順序維持で1つのsystem promptへ統合" */
function mergeSystemPrompts(texts: string[]): string {
  return texts.filter((text) => text.length > 0).join("\n\n");
}

/**
 * "user/assistant交互でない入力も明示的に処理" — this adapter does NOT require strict user/assistant
 * alternation in the input: every non-system message becomes its own ChatHistoryItem in order
 * (including consecutive same-role runs), which node-llama-cpp's chat wrapper renders positionally
 * rather than requiring strict alternation. The one hard requirement (explicit, not silent) is that
 * the LAST message determining what the model should respond to must be role "user" — anything
 * else (last message is "assistant", "system", or there are no non-system messages at all) is
 * rejected with a clear reason rather than guessed at.
 */
export function adaptMessages(messages: LocalLlmChatMessage[]): AdaptMessagesResult {
  const systemTexts: string[] = [];
  const turns: { role: "user" | "assistant"; text: string }[] = [];

  for (const message of messages) {
    const extracted = extractText(message.content);
    if (!extracted.ok) return { ok: false, reason: extracted.reason, capability: extracted.capability };
    if (message.role === "system") {
      systemTexts.push(extracted.text);
      continue;
    }
    turns.push({ role: message.role, text: extracted.text });
  }

  if (turns.length === 0) return { ok: false, reason: "at least one user message is required" };
  const last = turns[turns.length - 1];
  if (last.role !== "user") return { ok: false, reason: "the last message must have role \"user\"" };

  const systemPrompt = mergeSystemPrompts(systemTexts);
  const priorTurns = turns.slice(0, -1);
  const history: LlamaChatHistoryItemLike[] = [
    { type: "system", text: systemPrompt },
    ...priorTurns.map((turn): LlamaChatHistoryItemLike => (turn.role === "user" ? { type: "user", text: turn.text } : { type: "model", response: [turn.text] })),
  ];

  return { ok: true, value: { systemPrompt, history, prompt: last.text } };
}
