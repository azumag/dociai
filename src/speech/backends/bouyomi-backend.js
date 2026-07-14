import { SpeechBackend, speechResult } from "../speech-backend.js";

// 棒読みちゃんの /Talk はテキストを投入した瞬間に応答が返る fire-and-forget API で、
// 実際の音声再生完了はHTTP連携からは通知されない。そのままだと、他のbackend (再生完了を
// 通知するVOICEVOX/WebSpeech) と混在させたとき、棒読みちゃんがまだ話している間に
// 次のアイテムの再生が始まり、コメント読み上げとAI読み上げの音声が被ってしまう。
// ここでは文字数と読み上げ速度から発話時間を見積もり、その分だけ完了報告を遅らせることで
// SpeechScheduler側の `current` を実際の発話時間中は保持したままにする (概算であり保証ではない)。
// speed は棒読みちゃんの speed パラメータ (50-200、既定/未指定は -1 or undefined) であり、
// webspeech の rate (0.5-2 程度) とはスケールが異なるため rate へフォールバックしてはいけない。
export const DEFAULT_BOUYOMI_CHARS_PER_SECOND = 6; // speed=100 (棒読みちゃん既定) 相当のおおよその発話速度。voice/エンジンにより実際の速さは変わるため bouyomi.charsPerSecond で調整できる
const MIN_SPEAK_MS = 400;
const MAX_SPEAK_MS = 60_000;

export function estimateBouyomiSpeakMs(text, speed, charsPerSecond = DEFAULT_BOUYOMI_CHARS_PER_SECOND) {
  const baseCharsPerSecond = Number(charsPerSecond) > 0 ? Number(charsPerSecond) : DEFAULT_BOUYOMI_CHARS_PER_SECOND;
  const rate = Number(speed) > 0 ? Number(speed) / 100 : 1;
  const ms = (String(text ?? "").length / (baseCharsPerSecond * rate)) * 1000;
  return Math.min(MAX_SPEAK_MS, Math.max(MIN_SPEAK_MS, Math.round(ms)));
}

function waitOrAbort(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

export class BouyomiBackend extends SpeechBackend {
  constructor(client, { onHealth = () => {}, wait = waitOrAbort, charsPerSecond = DEFAULT_BOUYOMI_CHARS_PER_SECOND } = {}) {
    super("bouyomi", { reportsPlaybackCompletion: false, supportsClear: true });
    this.client = client;
    this.onHealth = onHealth;
    this.wait = wait;
    this.charsPerSecond = charsPerSecond;
    this.controller = null;
  }
  available() { return !!this.client; }
  async play(item, context = {}) {
    if (!this.available()) return speechResult("failed", { error: "棒読みちゃんbackendが未設定です" });
    this.cancel();
    const controller = new AbortController();
    this.controller = { id: context.executionId, controller };
    const abort = () => controller.abort();
    context.signal?.addEventListener("abort", abort, { once: true });
    try {
      await this.client.talk(item.text, { ...item.voice, signal: controller.signal });
      if (this.controller?.id !== context.executionId) return speechResult("cancelled");
      await this.wait(estimateBouyomiSpeakMs(item.text, item.voice?.speed, this.charsPerSecond), controller.signal);
      if (this.controller?.id !== context.executionId || controller.signal.aborted) return speechResult("cancelled");
      this.onHealth({ backend: this.id, status: "ok" });
      return speechResult("submitted", { warning: "棒読みちゃんへの受付完了（再生完了時刻は文字数からの推定です）" });
    } catch (error) {
      const cancelled = controller.signal.aborted || error?.kind === "cancelled";
      this.onHealth({ backend: this.id, status: cancelled ? "cancelled" : "error", error: error.message });
      return cancelled ? speechResult("cancelled") : speechResult("failed", { error: error.message });
    } finally {
      context.signal?.removeEventListener("abort", abort);
      if (this.controller?.id === context.executionId) this.controller = null;
    }
  }
  cancel(executionId = null) {
    if (!this.controller || (executionId && this.controller.id !== executionId)) return false;
    this.controller.controller.abort();
    this.controller = null;
    return true;
  }
  async clear() { return this.client.clear(); }
}
