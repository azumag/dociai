import { SpeechBackend, speechResult } from "../speech-backend.js";

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export class WebSpeechBackend extends SpeechBackend {
  constructor({ synthesis = globalThis.speechSynthesis, Utterance = globalThis.SpeechSynthesisUtterance, onHealth = () => {} } = {}) {
    super("webspeech");
    this.synthesis = synthesis;
    this.Utterance = Utterance;
    this.onHealth = onHealth;
    this.execution = null;
  }
  available() { return !!this.synthesis && !!this.Utterance; }
  play(item, context = {}) {
    if (!this.available()) return Promise.resolve(speechResult("failed", { error: "この環境はWeb Speech APIに未対応です" }));
    this.cancel();
    const executionId = context.executionId;
    const utterance = new this.Utterance(item.text);
    utterance.rate = clamp(Number(item.voice?.rate ?? 1), 0.5, 2);
    utterance.pitch = clamp(Number(item.voice?.pitch ?? 1), 0, 2);
    const voices = this.synthesis.getVoices?.() ?? [];
    const requested = item.voice?.name;
    utterance.voice = requested && requested !== "default" ? voices.find((voice) => voice.name === requested || voice.name.includes(requested)) ?? null : voices.find((voice) => voice.lang?.startsWith("ja")) ?? null;
    utterance.lang = utterance.voice?.lang ?? "ja-JP";
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled || this.execution?.id !== executionId) return;
        settled = true;
        context.signal?.removeEventListener("abort", abort);
        this.execution = null;
        this.onHealth({ backend: this.id, status: result.state === "failed" ? "error" : "ok", error: result.error ?? null });
        resolve(result);
      };
      const abort = () => { try { this.synthesis.cancel(); } catch {} finish(speechResult("cancelled")); };
      this.execution = { id: executionId, finish };
      utterance.onend = () => finish(speechResult("done"));
      utterance.onerror = (event) => finish(["canceled", "interrupted"].includes(event.error) ? speechResult("cancelled") : speechResult("failed", { error: String(event.error ?? "不明なエラー") }));
      context.signal?.addEventListener("abort", abort, { once: true });
      this.synthesis.speak(utterance);
    });
  }
  cancel(executionId = null) {
    const execution = this.execution;
    if (!execution || (executionId && execution.id !== executionId)) return false;
    try { this.synthesis?.cancel(); } catch {}
    execution.finish(speechResult("cancelled"));
    return true;
  }
}
