// Twitch公式クローズドキャプション送出 (issue #282)。
//
// 経路: 外部Chromeタブ (Web Speech API ja-JP + Chrome内蔵Translator API ja->en)
//   -> loopback WebSocket -> Main process (このファイルの契約で検証)
//   -> OBS WebSocket 5.x `SendStreamCaption` -> OBS配信出力 -> Twitch公式CC。
//
// 既存のTranslationService (electron/shared/services/translation-contract.ts) とは完全に別系統。
// あちらは「視聴者の英仏コメント -> 日本語」をローカルONNX (m2m100_418M) で翻訳するもので、
// こちらは「配信者の日本語音声 -> 英語字幕」をChrome内蔵APIで翻訳する。量子化ONNXモデルは
// 一切ロードしない (issue #282 受け入れ条件)。
//
// このファイルはMain / Preload / Renderer / Chromeワーカーページの4者が共有する「形」だけを持つ。
// 実際の受理判定はelectron/main/services/captions/caption-policy.ts、送出判定は
// obs-caption-output-service.tsが行う。

// Chromeワーカーページのプロトコル版。ページとMainのどちらか片方だけが更新された状態
// (packaged appの更新後にブラウザが古いページをキャッシュしている等) を検出して接続を拒否する。
export const CAPTION_WORKER_PROTOCOL_VERSION = 1;

// Renderer側 (操作卓の「英語CC」パネル) へstatusを配信するapp eventの型名。
// IPC channel名 (`captions:status`) とは別物なので、取り違えないよう別名にしてある。
export const CAPTION_STATUS_EVENT_TYPE = "captions:status-changed";

// 上限。いずれも「送出前に弾く」ためのものであり、Twitch/CEA-608側の実表示可能文字数とは別物
// (実表示の分割規則はcaptions.maxCaptionCharsで運用者が設定する — issue #282 Phase 0で実機確定)。
export const MAX_CAPTION_TEXT_CHARS = 500;
export const MAX_RECOGNIZED_TEXT_CHARS = 500;
export const MAX_WORKER_MESSAGE_BYTES = 8 * 1024;
export const CAPTION_SESSION_TOKEN_BYTES = 32;

// Chromeワーカー -> Main。
// `ageMs` は「認識がfinalになってから、workerがこのメッセージを送るまで」の経過時間 (worker自身の
// 相対時刻)。絶対時刻(epoch)を送らないのは、ブラウザとMainのwall clockがずれていると
// maxAgeMs判定がそのまま壊れるため — Main側は受信時刻を基準に自分の待ち時間だけを足す。
export type CaptionWorkerMessage =
  | { type: "hello"; protocolVersion: number; token: string; userAgent?: string }
  | { type: "state"; state: CaptionWorkerState; detail?: string }
  | { type: "caption"; sequence: number; isFinal: boolean; recognized: string; text: string; ageMs: number };

// Main -> Chromeワーカー。
export type CaptionHostMessage =
  | { type: "welcome"; protocolVersion: number; generation: number }
  | { type: "ack"; sequence: number; accepted: boolean; reason?: CaptionRejectReason }
  | { type: "stop"; reason: "operator" | "shutdown" };

// Chrome側が自己申告する状態。Main側のhealth (CaptionHealthState) の材料のひとつでしかなく、
// これ単独でTwitchへの送出可否は決まらない。
export type CaptionWorkerState =
  | "idle"
  | "microphone_permission_required"
  | "recognition_starting"
  | "recognizing"
  | "recognition_stopped"
  | "translator_unavailable"
  | "translator_downloading"
  | "translator_ready"
  | "error";

// 字幕1件を落とした理由。ack でChrome側のデバッグ表示にも返す。本文は含めない。
export type CaptionRejectReason =
  | "disabled"
  | "not-final"
  | "empty"
  | "too-long"
  | "control-characters"
  | "source-language-leak"
  | "duplicate"
  | "expired"
  | "stale-generation"
  | "queue-overflow";

// issueの「health状態候補」そのもの。UIはこの1値だけを見れば良いようにする
// (複数の下位状態が同時に該当する場合の優先順位はcaption-session.tsが決める)。
export type CaptionHealthState =
  | "disabled"
  | "chrome_not_found"
  | "worker_disconnected"
  | "microphone_permission_required"
  | "recognition_starting"
  | "recognizing"
  | "translator_downloading"
  | "translator_ready"
  | "obs_disconnected"
  | "obs_not_streaming"
  | "mic_muted"
  | "sending"
  | "error";

// Rendererへ渡すstatus。session token・OBSパスワード・URLは一切含めない (issue #282
// セキュリティ要件)。`lastRecognized`/`lastCaption` は操作卓のプレビュー表示専用で、
// captions.logCaptions が false の間はディスクにもログにも出さない。
export type CaptionStatus = {
  enabled: boolean;
  running: boolean;
  health: CaptionHealthState;
  generation: number;
  worker: { connected: boolean; state: CaptionWorkerState; chromeFound: boolean };
  obs: { connected: boolean; streaming: boolean; micMuted: boolean; captionSupported: boolean };
  counters: { accepted: number; rejected: number; sent: number; failed: number };
  lastRecognized: string;
  lastCaption: string;
  lastError?: { code: string; message: string };
};

export type CaptionTestInput = { text: string };
