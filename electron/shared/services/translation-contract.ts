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

// issue #267: a real `require("onnxruntime-node")` (via electron/main/native/onnxruntime-node-shim.cjs),
// separate from TranslationStatus above. Unlike TranslationStatus (a passive read of
// TranslationRuntime's own lazily-populated state), this permanently dlopens the native binary
// into the Main process the moment it's called — there is no unload path. It exists only for
// scripts/release/smoke-packaged.mjs and scripts/release/probe-native.mjs's automated CI proof
// that the bundled binary actually loads; no renderer production code calls it (see the IPC
// handler registration for the full rationale).
export type NativeRuntimeProbeResult = { ok: true; version: string } | { ok: false; reason: string };

// issue: translation-worker.cjs (worker_thread版) が起動して応答するかだけを検証するprobe結果
// (NativeRuntimeProbeResultのworker版)。モデルは一切ロードしない — worker fileの解決・bundleの
// ロード・worker_threadの起動がpackaged buildでも通ることをCI (smoke-packaged.mjs) が確認する
// ための専用パスであり、通常の翻訳フローは使わない。pingだけではonnxruntime-node-shimは評価
// されない (実翻訳経路はtest:electron:translationが担う)。
export type TranslationWorkerProbeResult = { ok: true; state: TranslationRuntimeState; modelId: string } | { ok: false; reason: string };
