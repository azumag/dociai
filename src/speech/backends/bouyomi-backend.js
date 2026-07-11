import { SpeechBackend, speechResult } from "../speech-backend.js";

export class BouyomiBackend extends SpeechBackend {
  constructor(client, { onHealth = () => {} } = {}) {
    super("bouyomi", { reportsPlaybackCompletion: false, supportsClear: true });
    this.client = client;
    this.onHealth = onHealth;
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
      this.onHealth({ backend: this.id, status: "ok" });
      return speechResult("submitted", { warning: "棒読みちゃんへの受付完了（再生完了は取得できません）" });
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
