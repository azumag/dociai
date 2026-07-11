import { chunkText } from "../../voicevox.js";
import { SpeechBackend, speechResult } from "../speech-backend.js";

export class VoiceVoxBackend extends SpeechBackend {
  constructor(client, { AudioImpl = globalThis.Audio, urlApi = globalThis.URL, onHealth = () => {} } = {}) {
    super("voicevox", { supportsPrepare: true });
    this.client = client;
    this.AudioImpl = AudioImpl;
    this.urlApi = urlApi;
    this.onHealth = onHealth;
    this.execution = null;
  }
  available() { return !!this.client && !!this.AudioImpl && !!this.urlApi; }
  async play(item, context = {}) {
    if (!this.available()) return speechResult("failed", { error: "VOICEVOX backendが利用できません" });
    this.cancel();
    const controller = new AbortController();
    const abort = () => controller.abort();
    context.signal?.addEventListener("abort", abort, { once: true });
    const audio = new this.AudioImpl();
    const execution = { id: context.executionId, controller, audio, urls: new Set(), listeners: [] };
    this.execution = execution;
    try {
      const chunks = chunkText(item.text, Number(item.voice?.maxChars) || 200);
      item.chunkCount = chunks.length;
      item.chunkIndex = 0;
      if (!chunks.length) return speechResult("done");
      const synth = async (text) => {
        let blob;
        const attempts = 1 + Math.max(0, Number(this.client.retries) || 0);
        for (let attempt = 1; attempt <= attempts; attempt++) {
          try {
            blob = await this.client.synth(text, {
              speaker: item.voice?.speaker,
              pitch: item.voice?.pitch,
              speed: item.voice?.speed ?? item.voice?.rate,
              intonation: item.voice?.intonation,
              volume: item.voice?.volume,
              signal: controller.signal,
            });
            break;
          } catch (error) {
            if (error?.kind !== "timeout" || attempt === attempts) throw error;
          }
        }
        const url = this.urlApi.createObjectURL(blob);
        if (this.execution === execution) execution.urls.add(url);
        else this.urlApi.revokeObjectURL(url);
        return url;
      };
      let prepared = synth(chunks[0]);
      for (let index = 0; index < chunks.length; index++) {
        item.chunkIndex = index;
        const url = await prepared;
        if (this.execution !== execution || controller.signal.aborted) return speechResult("cancelled");
        prepared = index + 1 < chunks.length ? synth(chunks[index + 1]) : null;
        await this.#playAudio(execution, url);
      }
      this.onHealth({ backend: this.id, status: "ok" });
      return speechResult("done");
    } catch (error) {
      const cancelled = controller.signal.aborted || error?.kind === "cancelled" || error?.name === "AbortError";
      this.onHealth({ backend: this.id, status: cancelled ? "cancelled" : "error", error: error.message });
      return cancelled ? speechResult("cancelled") : speechResult("failed", { error: error.message });
    } finally {
      context.signal?.removeEventListener("abort", abort);
      this.#cleanup(execution);
    }
  }
  cancel(executionId = null) {
    const execution = this.execution;
    if (!execution || (executionId && execution.id !== executionId)) return false;
    execution.controller.abort();
    try { execution.audio.pause(); } catch {}
    this.#cleanup(execution);
    return true;
  }
  #playAudio(execution, url) {
    return new Promise((resolve, reject) => {
      const ended = () => { remove(); resolve(); };
      const error = () => { remove(); reject(new Error("VOICEVOX audio playback failed")); };
      const remove = () => {
        execution.audio.removeEventListener("ended", ended);
        execution.audio.removeEventListener("error", error);
        execution.listeners = execution.listeners.filter((entry) => entry.remove !== remove);
      };
      execution.listeners.push({ remove, cancel: () => { remove(); resolve(); } });
      execution.audio.addEventListener("ended", ended);
      execution.audio.addEventListener("error", error);
      execution.audio.src = url;
      Promise.resolve(execution.audio.play()).catch(error);
    });
  }
  #cleanup(execution) {
    if (this.execution === execution) this.execution = null;
    for (const listener of [...execution.listeners]) listener.cancel();
    try { execution.audio.pause(); } catch {}
    execution.audio.src = "";
    for (const url of execution.urls) this.urlApi.revokeObjectURL(url);
    execution.urls.clear();
  }
}
