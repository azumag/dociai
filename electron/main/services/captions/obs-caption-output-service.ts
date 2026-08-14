// OBS Studio へ英語CCを送出する出力側サービス (issue #282)。
//
// 「送出条件をすべて満たすときだけ `SendStreamCaption` を呼ぶ」の最後の2条件 (OBS接続済 /
// OBS配信中 / 対象マイク非ミュート) をここが持つ。CC本文そのものの受理判定は caption-policy.ts。
//
// 字幕機能の障害は非critical (issue #282): OBSが落ちていても例外を投げず degraded を報告するだけで、
// dociai本体のコメント受信・AI応答・読み上げ・OBS表示 (src/obs/ の別系統) は一切止めない。
import { ObsWebSocketClient, type ObsRequestResult, type ObsSocketFactory } from "./obs-websocket-client";

export type ObsCaptionTarget = { host: string; port: number; password: string | null; microphoneInputName: string };
export type ObsCaptionState = {
  connected: boolean;
  streaming: boolean;
  micMuted: boolean;
  captionSupported: boolean;
  lastError: { code: string; message: string } | null;
};

export type ObsCaptionOutputOptions = {
  socketFactory: ObsSocketFactory;
  onStateChange?: (state: ObsCaptionState) => void;
  // 再接続後に「古い字幕を後から流さない」ため、接続が確立し直したことを呼び出し側へ知らせる。
  onReconnected?: () => void;
  log?: (message: string, fields?: Record<string, unknown>) => void;
  requestTimeoutMs?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  // StreamStateChanged / InputMuteStateChanged を取りこぼした場合の自己修復ポーリング。
  // 0で無効 (テストはこれを使う)。
  refreshIntervalMs?: number;
};

// これ以上連続でtimeoutしたら、切断イベントが来ていなくても死んだ接続とみなす。
const MAX_CONSECUTIVE_TIMEOUTS = 3;

const DEFAULT_STATE: ObsCaptionState = { connected: false, streaming: false, micMuted: false, captionSupported: false, lastError: null };

export class ObsCaptionOutputService {
  #options: ObsCaptionOutputOptions;
  #target: ObsCaptionTarget | null = null;
  #client: ObsWebSocketClient | null = null;
  #state: ObsCaptionState = { ...DEFAULT_STATE };
  #backoffMs: number;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #refreshTimer: ReturnType<typeof setInterval> | null = null;
  #stopped = true;
  #everIdentified = false;
  #consecutiveTimeouts = 0;

  constructor(options: ObsCaptionOutputOptions) {
    this.#options = options;
    this.#backoffMs = options.initialBackoffMs ?? 1_000;
  }

  get state(): ObsCaptionState { return { ...this.#state }; }

  // 送出可能条件。ここが false の間、SendStreamCaption は一度も呼ばれない。
  get canSend(): boolean {
    return this.#state.connected && this.#state.captionSupported && this.#state.streaming && !this.#state.micMuted;
  }

  start(target: ObsCaptionTarget): void {
    this.#target = target;
    this.#stopped = false;
    this.#backoffMs = this.#options.initialBackoffMs ?? 1_000;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    this.#target = null;
    if (this.#reconnectTimer) { clearTimeout(this.#reconnectTimer); this.#reconnectTimer = null; }
    if (this.#refreshTimer) { clearInterval(this.#refreshTimer); this.#refreshTimer = null; }
    this.#client?.close();
    this.#client = null;
    this.#everIdentified = false;
    this.#patch({ ...DEFAULT_STATE });
  }

  dispose(): void { this.stop(); }

  async sendCaption(text: string): Promise<{ sent: boolean; reason?: string }> {
    if (!this.canSend || !this.#client) {
      return { sent: false, reason: !this.#state.connected ? "obs_disconnected" : !this.#state.captionSupported ? "caption_unsupported" : !this.#state.streaming ? "obs_not_streaming" : "mic_muted" };
    }
    const result = await this.#request("SendStreamCaption", { captionText: text });
    // 送出できたなら直前のOBS側エラーはもう解消している (caption_unsupportedはOBSの能力そのもの
    // なので、ここでは消さない — そもそもcanSendがfalseになりここへ来ない)。
    if (result.ok) { if (this.#state.lastError?.code.startsWith("obs_")) this.#patch({ lastError: null }); return { sent: true }; }
    // 本文はログに出さない (issue #282: 通常ログには文字数・状態・error codeまで)。
    this.#options.log?.("SendStreamCaptionが失敗しました", { code: result.code, comment: result.comment, chars: text.length });
    this.#patch({ lastError: { code: `obs_request_${result.code}`, message: result.comment } });
    return { sent: false, reason: "request_failed" };
  }

  // 設定reload時にOBS接続先やマイク入力名だけが変わったケースを扱う。接続先が同じならソケットは
  // 張り替えず、マイク入力名の追従だけをやり直す (配信中の無駄な切断を避ける)。
  reconfigure(target: ObsCaptionTarget): void {
    const previous = this.#target;
    this.#target = target;
    if (!previous || this.#stopped) { this.start(target); return; }
    if (previous.host !== target.host || previous.port !== target.port || previous.password !== target.password) {
      this.stop();
      this.start(target);
      return;
    }
    if (previous.microphoneInputName !== target.microphoneInputName) void this.#refreshMuteState();
  }

  // OBSがTCPのFIN/RSTを返さないまま消えた場合 (別ホストの電源断・スリープ・NAT切れ) は、
  // socketの"close"が長時間発火せず connected:true のまま全リクエストがtimeoutし続ける。
  // 一定回数連続でtimeoutしたら自分から切って、通常の再接続バックオフへ落とす。
  async #request(requestType: string, requestData: Record<string, unknown> = {}): Promise<ObsRequestResult> {
    const client = this.#client;
    if (!client) return { ok: false, code: 0, comment: "not-connected" };
    const result = await client.request(requestType, requestData);
    if (result.ok || result.comment !== "timeout") { this.#consecutiveTimeouts = 0; return result; }
    this.#consecutiveTimeouts += 1;
    if (this.#consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS && this.#client === client) {
      this.#consecutiveTimeouts = 0;
      this.#options.log?.("OBS WebSocketが応答しないため切断して再接続します");
      client.close();
    }
    return result;
  }

  #connect(): void {
    if (this.#stopped || !this.#target || this.#client) return;
    const target = this.#target;
    const client = new ObsWebSocketClient({
      url: `ws://${target.host}:${target.port}`,
      password: target.password,
      socketFactory: this.#options.socketFactory,
      requestTimeoutMs: this.#options.requestTimeoutMs,
      onIdentified: () => { void this.#onIdentified(); },
      onEvent: (eventType, eventData) => this.#onEvent(eventType, eventData),
      onError: (error) => {
        this.#options.log?.("OBS WebSocketエラー", { message: error.message });
        this.#patch({ lastError: { code: "obs_socket_error", message: error.message } });
      },
      onClose: () => this.#onClose(),
    });
    this.#client = client;
    client.connect();
  }

  async #onIdentified(): Promise<void> {
    const client = this.#client;
    if (!client) return;
    this.#backoffMs = this.#options.initialBackoffMs ?? 1_000;
    const version = await this.#request("GetVersion");
    // awaitの最中に切断・stopが起きていたら、#onClose()が既にconnected:falseへ落としている。
    // ここでconnected:trueを書き戻すと「切れているのに接続済み」という状態が残るので何もしない。
    if (this.#client !== client) return;
    // `availableRequests` を持たない (もしくは SendStreamCaption を含まない) OBSでは、
    // 字幕だけをdegradedにして接続自体は維持する — 運用者が設定UIで理由を確認できるようにする。
    const availableRequests = version.ok && Array.isArray(version.data.availableRequests) ? version.data.availableRequests as unknown[] : [];
    const captionSupported = availableRequests.some((entry) => entry === "SendStreamCaption");
    this.#patch({
      connected: true,
      captionSupported,
      lastError: captionSupported ? null : { code: "caption_unsupported", message: "接続中のOBSはSendStreamCaptionに対応していません" },
    });
    await this.#refreshStreamState();
    await this.#refreshMuteState();
    if (this.#client !== client) return;
    const interval = this.#options.refreshIntervalMs ?? 30_000;
    if (interval > 0 && !this.#refreshTimer) {
      this.#refreshTimer = setInterval(() => { void this.#refreshStreamState(); void this.#refreshMuteState(); }, interval);
      this.#refreshTimer.unref?.();
    }
    if (this.#everIdentified) this.#options.onReconnected?.();
    this.#everIdentified = true;
  }

  // 応答が返るまでに切断・再接続していたら、その結果はもう現在の接続の状態ではないので捨てる。
  async #refreshStreamState(): Promise<void> {
    const client = this.#client;
    const result = client ? await this.#request("GetStreamStatus") : null;
    if (result?.ok && this.#client === client) this.#patch({ streaming: result.data.outputActive === true });
  }

  // 対象マイク入力名が未設定なら、ミュート判定そのものを行わない (常に非ミュート扱い)。
  // 「入力名を指定していないのに字幕が出ない」という詰み方を避けるため、degradedにもしない。
  async #refreshMuteState(): Promise<void> {
    const inputName = this.#target?.microphoneInputName ?? "";
    if (!inputName) { this.#patch({ micMuted: false }); return; }
    const client = this.#client;
    const result = client ? await this.#request("GetInputMute", { inputName }) : null;
    if (!result || this.#client !== client) return;
    if (result.ok) { this.#patch({ micMuted: result.data.inputMuted === true, ...(this.#state.lastError?.code === "obs_input_missing" ? { lastError: null } : {}) }); return; }
    // 入力名のtypo等でミュート状態を取得できない場合はfail-closed (ミュート扱い) にする。
    // fail-openにすると「実際にはミュート中なのに字幕が出続ける」= issue #282の送出条件を
    // 満たさない状態が、運用者に見えないまま成立してしまう。lastErrorはCaptionStatus経由で
    // 操作卓に出るので、誤設定はパネル側で気付ける。
    this.#patch({ micMuted: true, lastError: { code: "obs_input_missing", message: `OBS入力「${inputName}」の状態を取得できません。入力名を確認してください` } });
  }

  #onEvent(eventType: string, eventData: Record<string, unknown>): void {
    if (eventType === "StreamStateChanged") { this.#patch({ streaming: eventData.outputActive === true }); return; }
    if (eventType === "InputMuteStateChanged") {
      const inputName = this.#target?.microphoneInputName ?? "";
      if (!inputName || eventData.inputName !== inputName) return;
      this.#patch({ micMuted: eventData.inputMuted === true });
    }
  }

  #onClose(): void {
    this.#client = null;
    this.#consecutiveTimeouts = 0;
    if (this.#refreshTimer) { clearInterval(this.#refreshTimer); this.#refreshTimer = null; }
    this.#patch({ connected: false, streaming: false, captionSupported: false, micMuted: false });
    if (this.#stopped || this.#reconnectTimer) return;
    const delay = this.#backoffMs;
    this.#backoffMs = Math.min(this.#backoffMs * 2, this.#options.maxBackoffMs ?? 30_000);
    this.#reconnectTimer = setTimeout(() => { this.#reconnectTimer = null; this.#connect(); }, delay);
    this.#reconnectTimer.unref?.();
  }

  #patch(patch: Partial<ObsCaptionState>): void {
    const next = { ...this.#state, ...patch };
    const changed = (Object.keys(next) as Array<keyof ObsCaptionState>).some((key) => key === "lastError"
      ? (next.lastError?.code ?? null) !== (this.#state.lastError?.code ?? null)
      : next[key] !== this.#state[key]);
    this.#state = next;
    if (changed) this.#options.onStateChange?.({ ...next });
  }
}
