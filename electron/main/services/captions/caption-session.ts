// 英語CC機能の取りまとめ (issue #282)。
//
//   Chromeワーカー (host) -> 受理policy -> OBS出力サービス
//
// の3つを束ね、Renderer(操作卓)へ渡す単一のCaptionStatusを算出する。IPCハンドラ
// (electron/main/ipc/register.ts) が触るのはこのクラスだけで、内部のtoken・OBSパスワード・
// WebSocket URLはRendererへ出さない。
//
// 障害は常に非critical: どのメソッドもthrowせず、状態とlastErrorを更新して返すだけにする
// (issue #282「字幕機能の障害はコメント受信・AI応答・読み上げ・OBS表示を止めない」)。
import { spawn } from "node:child_process";
import fs from "node:fs";
import { CaptionPolicy } from "./caption-policy";
import { resolveCaptionHealth } from "./caption-health";
import { CaptionWorkerHost, type WorkerSocketServerFactory } from "./caption-worker-host";
import { ObsCaptionOutputService } from "./obs-caption-output-service";
import type { ObsSocketFactory } from "./obs-websocket-client";
import type { CaptionRejectReason, CaptionStatus, CaptionWorkerState } from "../../../shared/services/caption-contract";

export type CaptionsConfig = {
  enabled: boolean;
  chromeExecutable: string;
  workerPort: number;
  obs: { host: string; port: number; microphoneInputName: string };
  maxPending: number;
  maxAgeMs: number;
  maxCaptionChars: number;
  replacements: Record<string, string>;
  logCaptions: boolean;
};

export type CaptionSessionOptions = {
  assetDir: string;
  webSocketServerFactory: WorkerSocketServerFactory;
  obsSocketFactory: ObsSocketFactory;
  // OBS WebSocketのパスワードは設定JSONではなくsecret store (safeStorage) から読む。
  // configにもconfig exportにもChromeページにもRendererにも渡さない。
  readObsPassword: () => Promise<string | null>;
  onStatus: (status: CaptionStatus) => void;
  log?: (message: string, fields?: Record<string, unknown>) => void;
  now?: () => number;
  launchBrowser?: (executable: string, url: string) => void;
  obsRefreshIntervalMs?: number;
};

export const DEFAULT_CAPTIONS_CONFIG: CaptionsConfig = {
  enabled: false,
  chromeExecutable: "",
  workerPort: 0,
  obs: { host: "127.0.0.1", port: 4455, microphoneInputName: "" },
  maxPending: 2,
  maxAgeMs: 5_000,
  maxCaptionChars: 0,
  replacements: {},
  logCaptions: false,
};

// 「送出中」表示を維持する時間。SendStreamCaptionは瞬間的な操作なので、成功のたびに
// この長さだけ health を "sending" に張り付かせないとUIがちらつくだけになる。
const SENDING_STICKY_MS = 3_000;

// Chromeの既知パス。見つからない場合は設定の chromeExecutable をユーザーが指定する
// (issue #282: 「Chrome実行ファイルを既知パスから検出し、見つからない場合はユーザーが明示選択」)。
export function chromeCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === "win32") {
    return [
      `${env.PROGRAMFILES ?? "C:\\Program Files"}\\Google\\Chrome\\Application\\chrome.exe`,
      `${env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)"}\\Google\\Chrome\\Application\\chrome.exe`,
      `${env.LOCALAPPDATA ?? ""}\\Google\\Chrome\\Application\\chrome.exe`,
    ].filter((candidate) => !candidate.startsWith("\\"));
  }
  if (platform === "darwin") return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
}

export class CaptionSession {
  #options: CaptionSessionOptions;
  #config: CaptionsConfig = { ...DEFAULT_CAPTIONS_CONFIG };
  #policy = new CaptionPolicy({ maxPending: DEFAULT_CAPTIONS_CONFIG.maxPending, maxAgeMs: DEFAULT_CAPTIONS_CONFIG.maxAgeMs, maxCaptionChars: DEFAULT_CAPTIONS_CONFIG.maxCaptionChars, replacements: {} });
  #host: CaptionWorkerHost;
  #obs: ObsCaptionOutputService;
  #running = false;
  #workerConnected = false;
  #workerState: CaptionWorkerState = "idle";
  #counters = { accepted: 0, rejected: 0, sent: 0, failed: 0 };
  #lastRecognized = "";
  #lastCaption = "";
  #lastError: { code: string; message: string } | null = null;
  #lastSentAt = 0;
  #draining = false;
  // undefined = 未評価。#chromeExecutable() が遅延評価し、applyConfig/openWorker で無効化する。
  #chromeCache: string | null | undefined = undefined;

  constructor(options: CaptionSessionOptions) {
    this.#options = options;
    this.#host = new CaptionWorkerHost({
      assetDir: options.assetDir,
      webSocketServerFactory: options.webSocketServerFactory,
      onCaption: (input, context) => this.#onCaption(input, context),
      onWorkerState: (state, detail) => this.#onWorkerState(state, detail),
      onConnectionChange: (connected) => this.#onWorkerConnectionChange(connected),
      log: options.log,
    });
    this.#obs = new ObsCaptionOutputService({
      socketFactory: options.obsSocketFactory,
      refreshIntervalMs: options.obsRefreshIntervalMs,
      onStateChange: () => this.#emit(),
      // 再接続直後に古い字幕を流さない (issue #282「再接続後に古い字幕キューを流さない」)。
      onReconnected: () => { this.#policy.clearQueue(); this.#emit(); },
      log: options.log,
    });
  }

  get running(): boolean { return this.#running; }

  status(): CaptionStatus {
    const obs = this.#obs.state;
    const chromeFound = this.#chromeExecutable() !== null;
    // OBS側のエラー (入力名の誤り・SendStreamCaptionの失敗) もCaptionStatusへ載せる。
    // ここで拾わないと、字幕が出ない原因がOBS側にある場合に操作卓から一切見えない。
    const lastError = this.#lastError ?? obs.lastError;
    return {
      enabled: this.#config.enabled,
      running: this.#running,
      generation: this.#policy.generation,
      health: resolveCaptionHealth({
        enabled: this.#config.enabled,
        running: this.#running,
        chromeFound,
        workerConnected: this.#workerConnected,
        workerState: this.#workerState,
        obsConnected: obs.connected,
        obsCaptionSupported: obs.captionSupported,
        obsStreaming: obs.streaming,
        micMuted: obs.micMuted,
        sendingRecently: this.#now() - this.#lastSentAt < SENDING_STICKY_MS,
        hasError: lastError !== null,
      }),
      worker: { connected: this.#workerConnected, state: this.#workerState, chromeFound },
      obs: { connected: obs.connected, streaming: obs.streaming, micMuted: obs.micMuted, captionSupported: obs.captionSupported },
      counters: { ...this.#counters },
      lastRecognized: this.#lastRecognized,
      lastCaption: this.#lastCaption,
      ...(lastError ? { lastError } : {}),
    };
  }

  // 起動時とCONFIG_SAVE時の両方から呼ばれる。enabledがOFFになったら確実に停止し、
  // ONのまま接続先だけが変わった場合はOBS側だけを張り替える。
  async applyConfig(config: CaptionsConfig): Promise<void> {
    const previous = this.#config;
    this.#config = config;
    this.#chromeCache = undefined;
    this.#policy.configure({ maxPending: config.maxPending, maxAgeMs: config.maxAgeMs, maxCaptionChars: config.maxCaptionChars, replacements: config.replacements });
    if (!config.enabled) { if (this.#running) await this.stop(); else this.#emit(); return; }
    if (!this.#running) { this.#emit(); return; }
    if (previous.workerPort !== config.workerPort) {
      // ポート変更はhostの張り替えが必要 — 一度停止して同じrunning状態へ戻す。
      await this.stop();
      await this.start();
      return;
    }
    this.#obs.reconfigure({ ...config.obs, password: await this.#options.readObsPassword() });
    this.#emit();
  }

  async start(): Promise<CaptionStatus> {
    if (!this.#config.enabled) { this.#setError("disabled", "英語CCが設定で無効になっています"); return this.status(); }
    if (this.#running) return this.status();
    this.#lastError = null;
    const generation = this.#policy.reset();
    try {
      await this.#host.start(this.#config.workerPort, generation);
    } catch (error) {
      this.#setError("worker_host_failed", error instanceof Error ? error.message : String(error));
      return this.status();
    }
    this.#running = true;
    this.#obs.start({ ...this.#config.obs, password: await this.#options.readObsPassword() });
    this.#emit();
    return this.status();
  }

  async stop(): Promise<CaptionStatus> {
    this.#running = false;
    this.#workerConnected = false;
    this.#workerState = "idle";
    this.#policy.reset();
    this.#obs.stop();
    await this.#host.stop();
    this.#emit();
    return this.status();
  }

  // 「Chromeを開く」。既にChromeが起動中の場合、spawnしたプロセスは既存インスタンスへ
  // URLを渡して即終了するため、この子プロセスハンドルでワーカーの生存は判定できない —
  // 生存判定は常にWebSocket接続状態 (#workerConnected) だけで行う。
  async openWorker(): Promise<{ opened: boolean; reason?: string }> {
    // 前回の chrome_not_found / chrome_launch_failed を引きずったままだと、
    // 設定を直して開き直してもhealthが "error" に固定されてしまう。
    if (this.#lastError?.code.startsWith("chrome_")) this.#lastError = null;
    this.#chromeCache = undefined;
    if (!this.#running) {
      const started = await this.start();
      if (!started.running) return { opened: false, reason: this.#lastError?.message ?? "字幕ワーカーを起動できませんでした" };
    }
    const executable = this.#chromeExecutable();
    if (!executable) { this.#setError("chrome_not_found", "Google Chromeの実行ファイルが見つかりません"); return { opened: false, reason: "chrome_not_found" }; }
    let url: string;
    try { url = this.#host.issueWorkerUrl(); } catch (error) { this.#setError("worker_host_failed", error instanceof Error ? error.message : String(error)); return { opened: false, reason: "worker_host_failed" }; }
    try {
      // remote debugging や --disable-web-security の類は一切渡さない (issue #282 セキュリティ要件)。
      // URLに載るのは一回限りのページ取得tokenだけ (caption-worker-host.ts のヘッダ参照)。
      if (this.#options.launchBrowser) this.#options.launchBrowser(executable, url);
      else {
        const child = spawn(executable, [url], { detached: true, stdio: "ignore" });
        // ENOENT/EACCES (実行権限の無いパスやディレクトリを chromeExecutable に指定した場合) は
        // 同期throwではなく非同期の"error"イベントで届く。ここでlistenしていないと
        // 「開きました」と表示したままuncaughtExceptionになるだけで、運用者が原因に辿り着けない。
        child.on("error", (error) => this.#setError("chrome_launch_failed", error.message));
        child.unref();
      }
    } catch (error) {
      this.#setError("chrome_launch_failed", error instanceof Error ? error.message : String(error));
      return { opened: false, reason: "chrome_launch_failed" };
    }
    this.#emit();
    return { opened: true };
  }

  // 操作卓の「テスト字幕」。実際の送出条件 (OBS接続/配信中/非ミュート) をそのまま通すので、
  // 送れなかった理由がそのまま運用者への診断になる。policyの重複排除も通す。
  async testCaption(text: string): Promise<{ sent: boolean; reason?: string }> {
    if (!this.#running) return { sent: false, reason: "disabled" };
    const evaluation = this.#policy.evaluate({ sequence: -1, isFinal: true, recognized: "", text, ageMs: 0 }, { connectionGeneration: this.#policy.generation });
    if (!evaluation.ok) { this.#counters.rejected += 1; this.#emit(); return { sent: false, reason: evaluation.reason }; }
    this.#counters.accepted += 1;
    this.#lastCaption = evaluation.text;
    this.#policy.enqueue(evaluation.segments, { sequence: -1, now: this.#now(), ageMs: 0 });
    const result = await this.#drain();
    this.#emit();
    return result;
  }

  async dispose(): Promise<void> {
    this.#obs.dispose();
    await this.#host.stop();
    this.#running = false;
  }

  #now(): number { return this.#options.now?.() ?? Date.now(); }

  // status()は字幕1件ごと (ack/state変化ごと) に呼ばれるMain processのホットパスなので、
  // 実ファイル探索の結果はキャッシュし、設定変更時 (applyConfig) と明示操作時にだけ再評価する。
  #chromeExecutable(): string | null {
    if (this.#chromeCache === undefined) this.#chromeCache = this.#resolveChromeExecutable();
    return this.#chromeCache;
  }

  #resolveChromeExecutable(): string | null {
    const configured = this.#config.chromeExecutable.trim();
    if (configured) return fs.existsSync(configured) ? configured : null;
    return chromeCandidates(process.platform, process.env).find((candidate) => fs.existsSync(candidate)) ?? null;
  }

  #setError(code: string, message: string): void {
    this.#lastError = { code, message };
    this.#options.log?.("英語CCのエラー", { code });
    this.#emit();
  }

  #onWorkerConnectionChange(connected: boolean): void {
    this.#workerConnected = connected;
    if (!connected) {
      this.#workerState = "idle";
      // 切断時に溜まっていた字幕は捨てる — 再接続後に古い発話が流れると配信内容とずれる。
      this.#counters.rejected += this.#policy.clearQueue();
    }
    this.#emit();
  }

  #onWorkerState(state: CaptionWorkerState, detail: string): void {
    this.#workerState = state;
    if (state === "error" || state === "translator_unavailable") this.#lastError = { code: `worker_${state}`, message: detail || "Chrome字幕ワーカーでエラーが発生しました" };
    else if (this.#lastError?.code.startsWith("worker_")) this.#lastError = null;
    this.#emit();
  }

  #onCaption(input: { sequence: number; isFinal: boolean; recognized: string; text: string; ageMs: number }, context: { connectionGeneration: number }): void {
    const evaluation = this.#policy.evaluate(input, context);
    if (!evaluation.ok) {
      this.#counters.rejected += 1;
      this.#reject(input.sequence, evaluation.reason);
      // interimはプレビュー用の正常系なので、認識文の表示だけは更新する (送出はしない)。
      if (evaluation.reason === "not-final") this.#lastRecognized = input.recognized.slice(0, 200);
      this.#emit();
      return;
    }
    this.#counters.accepted += 1;
    this.#lastRecognized = evaluation.recognized;
    this.#lastCaption = evaluation.text;
    const dropped = this.#policy.enqueue(evaluation.segments, { sequence: input.sequence, now: this.#now(), ageMs: input.ageMs });
    this.#counters.rejected += dropped.dropped;
    this.#host.send({ type: "ack", sequence: input.sequence, accepted: true });
    // 溢れて捨てた分は、受理ackを出したあとでも破棄されたことをworkerへ伝える。
    for (const sequence of dropped.droppedSequences) this.#reject(sequence, "queue-overflow");
    if (dropped.dropped) this.#policy.forgetLastSent();
    if (this.#config.logCaptions) this.#options.log?.("英語CCを受理しました", { sequence: input.sequence, chars: evaluation.text.length, segments: evaluation.segments.length });
    void this.#drain().then(() => this.#emit());
  }

  #reject(sequence: number, reason: CaptionRejectReason): void {
    this.#host.send({ type: "ack", sequence, accepted: false, reason });
  }

  // キューを順に送出する。SendStreamCaptionの応答を待ってから次を送るので、分割チャンクが
  // OBSへ同時に殺到しない (チャンク間の適切な間隔はissue #282 Phase 0の実機検証項目)。
  async #drain(): Promise<{ sent: boolean; reason?: string }> {
    if (this.#draining) return { sent: false, reason: "busy" };
    this.#draining = true;
    let sent = false;
    let reason: string | undefined;
    try {
      for (;;) {
        const taken = this.#policy.take(this.#now());
        this.#counters.rejected += taken.expired;
        // 期限切れで一度も送れなかった字幕は、重複排除の記憶からも外す。
        if (taken.expired) this.#policy.forgetLastSent();
        if (!taken.caption) break;
        const result = await this.#obs.sendCaption(taken.caption.text);
        if (result.sent) { this.#counters.sent += 1; this.#lastSentAt = this.#now(); sent = true; continue; }
        this.#counters.failed += 1;
        reason = result.reason;
        this.#policy.forgetLastSent();
        // 送れない理由が解消していない間キューを抱え続けても古くなるだけなので捨てる。
        this.#counters.rejected += this.#policy.clearQueue();
        break;
      }
    } finally {
      this.#draining = false;
    }
    return { sent, ...(reason ? { reason } : {}) };
  }

  #emit(): void { this.#options.onStatus(this.status()); }
}
