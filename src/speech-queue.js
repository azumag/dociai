// 音声読み上げキュー (issue #8, #17)
// 2つのバックエンドを持つ:
//   - webspeech: 従来の Web Speech API (ブラウザ内蔵)
//   - voicevox : VOICEVOX engine (ローカル/リモート)。長文はチャンクに分けて順次再生する。
// 状態: waiting -> speaking -> done | skipped | failed

import { VoiceVoxClient, VoiceVoxError, chunkText } from "./voicevox.js";

let seq = 0;

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

export class SpeechQueue {
  constructor({ onUpdate = () => {}, log = () => {}, voicevox = null } = {}) {
    this.items = [];
    this.current = null;
    this.paused = false;
    this.cancelling = false;
    this.onUpdate = onUpdate;
    this.log = log;
    this.voicevox = voicevox ?? null; // VoiceVoxClient | null
    this.supported = typeof window !== "undefined" && "speechSynthesis" in window;
    if (this.supported) {
      speechSynthesis.getVoices();
      speechSynthesis.addEventListener?.("voiceschanged", () => speechSynthesis.getVoices());
    }
  }

  enqueue({ personaId, personaName, text, voice = {} }) {
    const item = {
      id: `s${++seq}`,
      personaId,
      personaName,
      text: String(text),
      voice,
      state: "waiting",
      error: null,
      chunkIndex: 0,
      chunkCount: 0,
    };
    this.items.push(item);
    if (this.items.length > 50) this.items.splice(0, this.items.length - 50);
    this.#setState(item, "waiting");
    this.#pump();
    return item;
  }

  stop() {
    this.paused = true;
    this.#cancelCurrent();
    this.log("読み上げを停止しました (キュー保留)");
    this.onUpdate(this.items, this);
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.log("読み上げを再開しました");
    this.onUpdate(this.items, this);
    this.#pump();
  }

  skip() {
    if (this.current) this.#cancelCurrent();
  }

  clear() {
    for (const item of this.items) {
      if (item.state === "waiting") this.#setState(item, "skipped");
    }
    this.#cancelCurrent();
    this.log("音声キューを全消去しました");
    this.onUpdate(this.items, this);
  }

  waitingCount() {
    return this.items.filter((i) => i.state === "waiting").length;
  }

  #cancelCurrent() {
    if (!this.current) return;
    this.cancelling = true;
    // voicevox: 再生中の <audio> を止める。Web Speech: speechSynthesis.cancel()。
    const item = this.current;
    if (item._audio) {
      try { item._audio.pause(); } catch {}
      item._audio.currentTime = NaN;
    }
    if (this.supported) {
      try { speechSynthesis.cancel(); } catch {}
    }
  }

  #pump() {
    if (this.current || this.paused) return;
    const item = this.items.find((i) => i.state === "waiting");
    if (!item) return;

    if (item.voice?.enabled === false) {
      item.error = "音声OFFのペルソナのため読み上げなし";
      this.#setState(item, "done");
      this.#pump();
      return;
    }

    this.current = item;
    this.#setState(item, "speaking");

    const engine = item.voice?.engine || (this.voicevox ? "voicevox" : "webspeech");
    if (engine === "voicevox" && this.voicevox) {
      this.#speakVoiceVox(item).catch((e) => {
        item.error = `VOICEVOX 読み上げ失敗: ${e.message}`;
        this.#finish(item, "failed");
      });
      return;
    }

    if (!this.supported) {
      item.error = "このブラウザはWeb Speech APIに未対応です";
      this.#setState(item, "failed");
      this.#pump();
      return;
    }
    this.#speakWebSpeech(item);
  }

  // VOICEVOX: テキストをチャンクに分けて合成し、<audio> で順次再生する。
  // 1チャンクでも失敗したらアイテム全体を failed にする (soviet_now の fallback 設計相当)。
  async #speakVoiceVox(item) {
    const v = item.voice ?? {};
    const maxChars = Number(v.maxChars) > 0 ? Number(v.maxChars) : 200;
    const chunks = chunkText(item.text, maxChars);
    item.chunkCount = chunks.length;
    item.chunkIndex = 0;
    if (!chunks.length) {
      this.#finish(item, "done");
      return;
    }

    const audio = new Audio();
    item._audio = audio;
    const blobs = [];
    audio.addEventListener("ended", () => {
      item.chunkIndex += 1;
      if (this.cancelling) {
        this.#finish(item, "skipped");
        return;
      }
      if (item.chunkIndex >= chunks.length) {
        this.#finish(item, "done");
        return;
      }
      this.#playChunk(item, audio, blobs[item.chunkIndex]);
    });
    audio.addEventListener("error", () => {
      if (this.cancelling) this.#finish(item, "skipped");
      else this.#finish(item, "failed");
    });

    // 事前に全チャンク合成する (再生と並走させると engine の推論が途切れない)。
    // 合成中は item.state は speaking のままだが chunkIndex を進めて進捗を示す。
    try {
      for (let i = 0; i < chunks.length; i++) {
        if (this.cancelling) {
          this.#finish(item, "skipped");
          return;
        }
        const blob = await this.voicevox.synth(chunks[i], {
          speaker: v.speaker,
          pitch: v.pitch,
          speed: v.speed ?? v.rate,
          intonation: v.intonation,
          volume: v.volume,
        });
        const url = URL.createObjectURL(blob);
        blobs.push(url);
        item.chunkIndex = i + 1;
        this.onUpdate(this.items, this);
      }
    } catch (e) {
      for (const url of blobs) URL.revokeObjectURL(url);
      item._audio = null;
      throw e instanceof VoiceVoxError ? e : new VoiceVoxError(e.message, "server");
    }

    if (this.cancelling) {
      for (const url of blobs) URL.revokeObjectURL(url);
      this.#finish(item, "skipped");
      return;
    }
    item.chunkIndex = 0;
    this.#playChunk(item, audio, blobs[0]);
    // 再生終了後に Blob URL を解放するため保持
    item._blobUrls = blobs;
  }

  #playChunk(item, audio, url) {
    if (!url) {
      this.#finish(item, "failed");
      return;
    }
    audio.src = url;
    audio.play().catch((e) => {
      item.error = `再生失敗: ${e.message ?? e}`;
      this.#finish(item, "failed");
    });
  }

  #speakWebSpeech(item) {
    const u = new SpeechSynthesisUtterance(item.text);
    u.rate = clamp(item.voice?.rate ?? 1.0, 0.5, 2);
    u.pitch = clamp(item.voice?.pitch ?? 1.0, 0, 2);
    const voice = this.#pickVoice(item.voice?.name);
    if (voice) u.voice = voice;
    u.lang = voice?.lang ?? "ja-JP";

    u.onend = () => this.#finish(item, "done");
    u.onerror = (e) => {
      if (this.cancelling || e.error === "canceled" || e.error === "interrupted") {
        this.#finish(item, "skipped");
      } else {
        item.error = `読み上げ失敗: ${e.error ?? "不明なエラー"}`;
        this.#finish(item, "failed");
      }
    };
    speechSynthesis.speak(u);
  }

  #finish(item, state) {
    if (this.current !== item) return;
    this.current = null;
    if (this.cancelling && state === "done") state = "skipped";
    this.cancelling = false;
    if (item._blobUrls) {
      for (const url of item._blobUrls) {
        try { URL.revokeObjectURL(url); } catch {}
      }
      item._blobUrls = null;
    }
    if (item._audio) {
      try { item._audio.pause(); } catch {}
      item._audio = null;
    }
    this.#setState(item, state);
    // Chromeはcancel直後のspeakを取りこぼすことがあるため少し置いて次へ
    setTimeout(() => this.#pump(), 250);
  }

  #pickVoice(name) {
    if (!this.supported) return null;
    const voices = speechSynthesis.getVoices();
    if (name && name !== "default") {
      const hit = voices.find((v) => v.name === name) ?? voices.find((v) => v.name.includes(name));
      if (hit) return hit;
      this.log(`音声 "${name}" が見つからないため日本語デフォルトを使います`);
    }
    return voices.find((v) => v.lang?.startsWith("ja")) ?? null;
  }

  #setState(item, state) {
    item.state = state;
    const label = { waiting: "待機中", speaking: "読み上げ中", done: "完了", skipped: "スキップ", failed: "失敗" }[state];
    const chunkInfo = item.chunkCount > 1 ? ` [${Math.min(item.chunkIndex + 1, item.chunkCount)}/${item.chunkCount}]` : "";
    this.log(`音声[${item.personaName}] ${label}${chunkInfo}${item.error ? ` (${item.error})` : ""}: ${item.text.slice(0, 40)}`);
    this.onUpdate(this.items, this);
  }
}
