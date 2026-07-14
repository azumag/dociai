// マイク監視 (issue #32)
// getUserMedia + Web Audio API でマイク入力のRMS音量を継続監視し、発話区間を検出する。
// 発話検出時/無音復帰時の SpeechQueue 連動 (stop/resume) は src/app/runtime-factory.js 側の配線が担う。
// 構造は ScreenContext (screen-capture.js, issue #9) に倣う: 手動 start()/stop()、
// onChange リスナー、status() でUIに現況を渡す。

const TICK_MS = 50;
const FFT_SIZE = 512;
const START_TIMEOUT_MS = 15000;

export class MicMonitor {
  constructor({ config, log = () => {} } = {}) {
    this.cfg = config.micMonitor ?? {};
    this.log = log;
    this.stream = null;
    this.audioCtx = null;
    this.analyser = null;
    this.sourceNode = null;
    this.intervalId = null;
    this._buf = null;
    this._starting = false;
    this._aboveSince = null;
    this._belowSince = null;
    this.speaking = false;
    this.level = 0;
    this.peak = 0;
    this.listeners = new Set();
  }

  get active() {
    return !!this.stream;
  }

  async start() {
    if (this.stream || this._starting) return;
    this._starting = true;
    let timedOut = false;
    try {
      const mediaPromise = navigator.mediaDevices.getUserMedia({
        // echoCancellation/noiseSuppression: 同一タブで再生するAI音声がマイクに
        // 回り込んでの自己検知を抑える (ブラウザ標準のAEC)。autoGainControl は
        // 無音時のノイズを持ち上げて閾値判定を狂わせるため無効にする。
        // deviceId: Electronにはブラウザのような入力デバイス選択UIが無いため、
        // config.micMonitor.deviceId で明示指定できるようにする (未指定ならOS/既定デバイス)。
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
          ...(this.cfg.deviceId ? { deviceId: { exact: this.cfg.deviceId } } : {}),
        },
      });
      // 隠れた許可ダイアログやOS/ブラウザ側の不具合でgetUserMedia()がハングすると、
      // このawaitが永久に終わらず finally も走らないため _starting が true のまま固着し、
      // 以後「監視開始」を押しても無反応になる。タイムアウトで諦めてエラーとして伝える。
      // タイムアウト後に遅れてストリームが届いた場合は使わずに即破棄する。
      mediaPromise.then((stream) => { if (timedOut) stream.getTracks().forEach((t) => t.stop()); }, () => {});
      this.stream = await Promise.race([
        mediaPromise,
        new Promise((_, reject) => setTimeout(() => {
          timedOut = true;
          reject(new Error(`マイクの許可待ちがタイムアウトしました (${START_TIMEOUT_MS / 1000}秒)`));
        }, START_TIMEOUT_MS)),
      ]);
      this.audioCtx = new AudioContext();
      this.sourceNode = this.audioCtx.createMediaStreamSource(this.stream);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = FFT_SIZE;
      // 分析用途のみ。destinationには繋がない (繋ぐとマイク音声がそのままスピーカーに
      // 返るハウリング事故になる)。
      this.sourceNode.connect(this.analyser);
      this._buf = new Float32Array(this.analyser.fftSize);
      this.speaking = false;
      this.level = 0;
      this.peak = 0;
      this._aboveSince = null;
      this._belowSince = null;
      // OS側の権限取消/デバイス切断に追従して自動停止する
      this.stream.getAudioTracks()[0]?.addEventListener("ended", () => this.stop());
      this.intervalId = setInterval(() => this.#tick(), TICK_MS);
      this.log("マイク監視を開始しました");
      this.#notify();
    } finally {
      this._starting = false;
    }
  }

  stop() {
    if (!this.stream) return;
    clearInterval(this.intervalId);
    this.intervalId = null;
    this.stream.getTracks().forEach((t) => t.stop());
    try { this.audioCtx.close(); } catch {}
    this.stream = null;
    this.audioCtx = null;
    this.analyser = null;
    this.sourceNode = null;
    this._buf = null;
    this.speaking = false;
    this.level = 0;
    this.peak = 0;
    this.log("マイク監視を停止しました");
    this.#notify();
  }

  status() {
    return { active: this.active, speaking: this.speaking, level: this.level, peak: this.peak };
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // RMS音量を計算し、しきい値の継続超過/継続未満でヒステリシス判定する。
  // 単発のノイズで発話状態がちらつかないよう、状態を切り替えるには
  // minSpeechMs/silenceHoldMs の間ずっと閾値を超え/下回り続ける必要がある。
  #tick() {
    this.analyser.getFloatTimeDomainData(this._buf);
    let sumSquares = 0;
    let peak = 0;
    for (let i = 0; i < this._buf.length; i++) {
      const v = this._buf[i];
      sumSquares += v * v;
      const abs = Math.abs(v);
      if (abs > peak) peak = abs;
    }
    this.level = Math.sqrt(sumSquares / this._buf.length);
    // ピーク瞬間振幅 (0-1)。UIメーターは実際のサンプルが±1.0 (0dBFS) に達したときに
    // 初めてMAX表示となるよう、しきい値判定用のRMS (level) とは別にこちらを使う。
    this.peak = peak;

    const threshold = this.cfg.threshold ?? 0.05;
    const minSpeechMs = this.cfg.minSpeechMs ?? 150;
    const silenceHoldMs = this.cfg.silenceHoldMs ?? 800;
    const now = Date.now();
    const above = this.level >= threshold;

    if (above) {
      this._belowSince = null;
      if (this._aboveSince == null) this._aboveSince = now;
      if (!this.speaking && now - this._aboveSince >= minSpeechMs) {
        this.speaking = true;
        this.log("マイク: 発話を検知しました");
      }
    } else {
      this._aboveSince = null;
      if (this._belowSince == null) this._belowSince = now;
      if (this.speaking && now - this._belowSince >= silenceHoldMs) {
        this.speaking = false;
        this.log("マイク: 発話が止みました");
      }
    }
    this.#notify();
  }

  #notify() {
    for (const fn of this.listeners) fn(this);
  }
}
