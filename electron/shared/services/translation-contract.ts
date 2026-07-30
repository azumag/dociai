// コメント読み上げの英語・フランス語→日本語ローカル翻訳 (issue #257 Phase 2, #261)。
// Main process上のTranslationServiceが公開するIPC入出力契約。翻訳runtime自体は
// transformers.js + ONNX (Xenova/m2m100_418M, issue #259でベンチマーク済み) で完結し、
// 外部AI・翻訳APIへコメント本文を送信しない。
// モデルの導入・削除・checksum検証・ライセンス表示はPhase 3 (#262) の対象 — このファイルは
// 「翻訳を1件実行する」契約だけを扱う。

export type TranslationSourceLanguage = "en" | "fr";
export type TranslationTargetLanguage = "ja";

export const MAX_TRANSLATE_INPUT_CHARS = 1000;

export type TranslateInput = {
  text: string;
  sourceLanguage: TranslationSourceLanguage;
  targetLanguage: TranslationTargetLanguage;
  requestId?: string;
  ownerId?: string;
  generation?: number;
};

export type TranslateResult = {
  text: string;
  sourceLanguage: TranslationSourceLanguage;
  targetLanguage: TranslationTargetLanguage;
  requestId: string;
  durationMs: number;
  modelId: string;
};

export type TranslationRuntimeState = "idle" | "loading" | "ready" | "error";

export type TranslationStatus = {
  state: TranslationRuntimeState;
  modelId: string;
  lastError?: { message: string };
};
