// 英語CCのhealth状態の決定 (issue #282)。
//
// 「Chrome未接続」「OBS未配信」「マイクミュート」等は同時に成立しうるので、UIが1つのチップで
// 表示できるよう優先順位を1箇所で決める。純粋関数なので素のNodeでそのままテストできる。
//
// 優先順位の考え方: 運用者が次に取るべき操作が変わる順。上流 (Chrome側) が繋がっていない限り
// OBS側の状態を出しても打つ手が無いので、上流から順に落としていく。
import type { CaptionHealthState, CaptionWorkerState } from "../../../shared/services/caption-contract";

export type CaptionHealthInput = {
  enabled: boolean;
  running: boolean;
  chromeFound: boolean;
  workerConnected: boolean;
  workerState: CaptionWorkerState;
  obsConnected: boolean;
  obsCaptionSupported: boolean;
  obsStreaming: boolean;
  micMuted: boolean;
  // 直近に実際にSendStreamCaptionが成功したか (UIの「送出 ON」表示用)。
  sendingRecently: boolean;
  hasError: boolean;
};

export function resolveCaptionHealth(input: CaptionHealthInput): CaptionHealthState {
  if (!input.enabled || !input.running) return "disabled";
  if (input.hasError) return "error";
  if (!input.chromeFound) return "chrome_not_found";
  if (!input.workerConnected) return "worker_disconnected";
  if (input.workerState === "microphone_permission_required") return "microphone_permission_required";
  if (input.workerState === "translator_downloading") return "translator_downloading";
  if (input.workerState === "recognition_starting") return "recognition_starting";
  if (input.workerState === "error" || input.workerState === "translator_unavailable") return "error";
  // Chromeタブは繋がっているが認識が動いていない (開始前・停止後)。OBS側の状態より先に出す —
  // 運用者が次に取るべき操作はChromeタブでの「開始」であって、OBSの確認ではないため。
  if (input.workerState === "idle" || input.workerState === "recognition_stopped") return "recognition_stopped";
  // ここから下流 (OBS側)。字幕を作れてはいるが送り先が整っていない状態。
  if (!input.obsConnected || !input.obsCaptionSupported) return "obs_disconnected";
  if (!input.obsStreaming) return "obs_not_streaming";
  if (input.micMuted) return "mic_muted";
  if (input.sendingRecently) return "sending";
  if (input.workerState === "recognizing") return "recognizing";
  if (input.workerState === "translator_ready") return "translator_ready";
  return "recognizing";
}
