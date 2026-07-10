// 音声読み上げキュー (issue #8, #17, #30)
// 3つのバックエンドを持つ:
//   - webspeech: 従来の Web Speech API (ブラウザ内蔵)
//   - voicevox : VOICEVOX engine (ローカル/リモート)。長文はチャンクに分けて順次再生する。
//   - bouyomi  : 棒読みちゃん HTTP API。送信後の再生順は棒読みちゃん側のキューが管理する。
// 状態: waiting -> speaking -> done | skipped | failed

import { VoiceVoxClient, VoiceVoxError, chunkText } from "./voicevox.js";

let seq = 0;

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

export class SpeechQueue {
  constructor({ onUpdate = () => {}, log = () => {}, voicevox = null, bouyomi = null } = {}) {
    this.items = [];
    this.current = null;
    this.paused = false;
    this.cancelling = false;
    this._holdingItem = null;
    this.onUpdate = onUpdate;
    this.log = log;
    this.voicevox = voicevox ?? null; // VoiceVoxClient | null
    this.bouyomi = bouyomi ?? null; // BouyomiClient | null
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
    // マイク発話検知/手動停止による「保留」はキューからの離脱ではないので、
    // 話している途中のアイテムを skipped で終わらせず waiting に戻し、
    // resume() 後に最初から再生し直す (#finish 側で消費するマーカー)。
    if (this.current) this._holdingItem = this.current;
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
    this.bouyomi?.clear().catch((e) => this.log(`棒読みちゃんのキュー消去に失敗: ${e.message}`));
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
    item._abortController?.abort();
    if (item._audio) {
      try { item._audio.pause(); } catch {}
      // 事前合成中 (まだ src 未設定) は #speakVoiceVox 側の cancelling チェックが
      // 次のループで自己終了する。既にチャンク再生済み (src あり) だと ended/error が
      // 二度と来ないため、Web Speech の speechSynthesis.cancel() → onerror → #finish()
      // と同等の後始末をここで明示的に行う。
      if (item._audio.src) this.#finish(item, "skipped");
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
    item._abortController = new AbortController();
    this.#setState(item, "speaking");

    const engine = item.voice?.engine || (this.voicevox ? "voicevox" : "webspeech");
    if (engine === "bouyomi" && this.bouyomi) {
      this.bouyomi.talk(item.text, { ...item.voice, signal: item._abortController.signal }).then(
        () => this.#finish(item, "done"),
        (e) => {
          if (this.cancelling || e?.kind === "cancelled") { this.#finish(item, "skipped"); return; }
          item.error = `棒読みちゃん送信失敗: ${e.message}`;
          this.#finish(item, "failed");
        },
      );
      return;
    }
    if (engine === "voicevox" && this.voicevox) {
      this.#speakVoiceVox(item).catch((e) => {
        if (this.cancelling || e?.kind === "cancelled") { this.#finish(item, "skipped"); return; }
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
  // チャンク[i]の再生中にチャンク[i+1]の合成を並走させる (1つ先読みパイプライン)。
  // 全チャンクを合成してから再生していた旧実装は、長文だと最初の音が出るまでの
  // 待ち時間が合成回数分積み上がっていた。合成はチャンク単位でタイムアウト・
  // リトライする (#synthChunk) ため、1チャンクの失敗が他チャンクへ波及しない。
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
    const blobUrls = [];
    item._blobUrls = blobUrls;
    // チャンクごとの合成Promiseをキャッシュする (二重合成防止・先読みと再生の疎結合化)。
    const synthesizing = [];
    const ensureSynth = (i) => {
      if (i < 0 || i >= chunks.length) return null;
      if (!synthesizing[i]) {
        synthesizing[i] = this.#synthChunk(chunks[i], v, item._abortController.signal).then((url) => {
          // 先読み完了までにキャンセル/保留で次のアイテムに移っていたら即解放する
          // (そうしないとBlob URLが再生も破棄もされず残り続ける)。
          if (this.current === item) blobUrls[i] = url;
          else try { URL.revokeObjectURL(url); } catch {}
          return url;
        });
      }
      return synthesizing[i];
    };

    audio.addEventListener("ended", () => {
      if (this.cancelling) {
        this.#finish(item, "skipped");
        return;
      }
      const next = item.chunkIndex + 1;
      if (next >= chunks.length) {
        this.#finish(item, "done");
        return;
      }
      advanceTo(next);
    });
    audio.addEventListener("error", () => {
      if (this.cancelling) this.#finish(item, "skipped");
      else this.#finish(item, "failed");
    });

    const advanceTo = async (i) => {
      item.chunkIndex = i;
      this.onUpdate(this.items, this);
      let url;
      try {
        url = await ensureSynth(i);
      } catch (e) {
        if (this.cancelling) { this.#finish(item, "skipped"); return; }
        item.error = `VOICEVOX 読み上げ失敗 (${i + 1}/${chunks.length}チャンク目): ${e.message}`;
        this.#finish(item, "failed");
        return;
      }
      if (this.cancelling) { this.#finish(item, "skipped"); return; }
      ensureSynth(i + 1)?.catch(() => {}); // 次チャンクを先読み合成 (失敗は次のadvanceToで再取得・再送出)
      this.#playChunk(item, audio, url);
    };

    await advanceTo(0);
  }

  // 1チャンク分の合成。タイムアウトのみ即座に再試行する (issue #31)。
  // voicevox.retries が試行回数の上乗せ分。キャンセル/保留中は再試行を打ち切る。
  async #synthChunk(text, v, signal) {
    const maxAttempts = 1 + (Number(this.voicevox.retries) > 0 ? Number(this.voicevox.retries) : 0);
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (this.cancelling || signal?.aborted) throw lastErr ?? new VoiceVoxError("キャンセルされました", "cancelled");
      try {
        const blob = await this.voicevox.synth(text, {
          speaker: v.speaker,
          pitch: v.pitch,
          speed: v.speed ?? v.rate,
          intonation: v.intonation,
          volume: v.volume,
          signal,
        });
        return URL.createObjectURL(blob);
      } catch (e) {
        lastErr = e instanceof VoiceVoxError ? e : new VoiceVoxError(e.message, "server");
        if (lastErr.kind !== "timeout" || attempt === maxAttempts) throw lastErr;
        this.log(`VOICEVOX タイムアウトのため再試行します (${attempt}/${maxAttempts - 1})`);
      }
    }
    throw lastErr;
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
    if (this._holdingItem === item) {
      this._holdingItem = null;
      state = "waiting";
      item.chunkIndex = 0;
    }
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
    item._abortController = null;
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
