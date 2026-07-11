import { BouyomiBackend } from "./bouyomi-backend.js";
import { VoiceVoxBackend } from "./voicevox-backend.js";
import { WebSpeechBackend } from "./web-speech-backend.js";

export class BackendRegistry {
  constructor({ voicevox = null, bouyomi = null, strictOrdering = false, onWarning = () => {}, onHealth = () => {}, webSpeech = {} } = {}) {
    this.strictOrdering = strictOrdering;
    this.onWarning = onWarning;
    this.backends = new Map([
      ["webspeech", new WebSpeechBackend({ ...webSpeech, onHealth })],
      ["voicevox", new VoiceVoxBackend(voicevox, { onHealth })],
      ["bouyomi", new BouyomiBackend(bouyomi, { onHealth })],
    ]);
    this.seen = new Set();
    this.warnedMixedOrdering = false;
    this.warnings = [];
  }
  resolve(id = "webspeech") {
    const backend = this.backends.get(id);
    if (!backend?.available()) return this.backends.get("webspeech");
    this.#track(id);
    return backend;
  }
  validateMix(ids) {
    const unique = new Set(ids);
    if (unique.has("bouyomi") && unique.size > 1) {
      const message = "棒読みちゃんと再生完了を報告するbackendの混在順序は保証できません";
      if (this.strictOrdering) throw new Error(message);
      if (!this.warnedMixedOrdering) { this.warnings.push(message); this.onWarning(message); }
      this.warnedMixedOrdering = true;
      return message;
    }
    return null;
  }
  cancel(executionId = null) { for (const backend of this.backends.values()) backend.cancel(executionId); }
  async clear() { const backend = this.backends.get("bouyomi"); return backend.available() ? backend.clear() : null; }
  dispose() { for (const backend of this.backends.values()) backend.dispose(); this.seen.clear(); this.warnedMixedOrdering = false; this.warnings = []; }
  #track(id) { this.seen.add(id); this.validateMix(this.seen); }
}
