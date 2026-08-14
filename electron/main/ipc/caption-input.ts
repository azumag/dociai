// captions:test IPC入力の検証 (issue #282)。
// register.ts本体から分離しているのは translation-input.ts と同じ理由 — register.tsは`electron`
// (ipcMain) を直接importしており、素のNodeプロセスから読み込むテスト
// (scripts/test/caption-ipc-validation.test.mjs) がそれを解決できないため。
import { PublicIpcError } from "../../shared/errors";
import { expectRecord, expectString } from "../../shared/validation";
import { MAX_CAPTION_TEXT_CHARS } from "../../shared/services/caption-contract";
import type { CaptionTestInput } from "../../shared/services/caption-contract";

export function parseCaptionTestInput(value: unknown): CaptionTestInput {
  const payload = expectRecord(value, "テスト字幕");
  const text = expectString(payload.text, "text", MAX_CAPTION_TEXT_CHARS);
  // Rendererから任意のOBS接続先・パスワード・実行ファイルを渡せないよう、textだけを受け取り
  // 他のキーは黙って捨てるのではなく明示的に拒否する。
  const extraKeys = Object.keys(payload).filter((key) => key !== "text");
  if (extraKeys.length) throw new PublicIpcError("INVALID_INPUT", "テスト字幕はtextのみ指定できます");
  return { text };
}
