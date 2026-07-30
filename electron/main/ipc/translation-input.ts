// translation:translate IPC入力の検証 (issue #257 Phase 2/5, #261/#264)。
// register.ts本体から分離しているのは、register.tsが`electron`パッケージを直接importしており
// (ipcMain)、素のNodeプロセスから読み込むテスト (scripts/test/translation-ipc-validation.test.mjs)
// がそれを解決できないため — この純粋な検証ロジックだけをここへ切り出すことで、
// electronを一切importしない単体テストが可能になる。register.tsの他のチャンネルが使う
// requestMetadata()もここに置き、register.ts側は再エクスポートに頼らず直接importする。
import { PublicIpcError } from "../../shared/errors";
import { expectRecord, expectString } from "../../shared/validation";
import { MAX_TRANSLATE_INPUT_CHARS } from "../../shared/services/translation-contract";
import type { TranslateInput } from "../../shared/services/translation-contract";

export type RequestMetadata = { requestId?: string; generation?: number; ownerId?: string };

export function requestMetadata(payload: Record<string, unknown>): RequestMetadata {
  return {
    ...(typeof payload.requestId === "string" ? { requestId: payload.requestId } : {}),
    ...(typeof payload.generation === "number" && Number.isSafeInteger(payload.generation) ? { generation: payload.generation } : {}),
    ...(typeof payload.ownerId === "string" ? { ownerId: payload.ownerId } : {}),
  };
}

export function parseTranslateInput(value: unknown): TranslateInput {
  const payload = expectRecord(value, "translation request");
  const text = expectString(payload.text, "text", MAX_TRANSLATE_INPUT_CHARS);
  if (payload.sourceLanguage !== "en" && payload.sourceLanguage !== "fr") throw new PublicIpcError("INVALID_INPUT", "sourceLanguageはen/frのいずれかで指定してください");
  if (payload.targetLanguage !== "ja") throw new PublicIpcError("INVALID_INPUT", "targetLanguageはjaのみ対応しています");
  return { text, sourceLanguage: payload.sourceLanguage, targetLanguage: payload.targetLanguage, ...requestMetadata(payload) };
}
