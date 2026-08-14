// OBS Studio の obs-websocket 5.x クライアント (issue #282)。
//
// src/obs/ 一式 (obs-protocol.js / obs-bridge.js) とは全くの別物 — あちらは操作卓と obs.html
// (Electronの第二window) の表示同期用の自前プロトコルで、OBS Studio 本体とは通信しない。
// このファイルは OBS Studio の WebSocket サーバへ実際に接続し、`SendStreamCaption` を叩く。
//
// obs-websocket 5.x を丸ごと実装する必要は無いので、この機能が使う op だけを扱う:
//   op 0 Hello / op 1 Identify / op 2 Identified / op 5 Event / op 6 Request / op 7 RequestResponse。
// 依存を増やさないため、既存の `ws` (package.json dependencies) をコンストラクタ注入で受け取る
// — テストは同じ口へmockソケットを差し込む。
import crypto from "node:crypto";

export const OBS_RPC_VERSION = 1;
// EventSubscription bitflags (obs-websocket 5.x)。Inputs = InputMuteStateChanged、
// Outputs = StreamStateChanged。他のカテゴリは購読しない (受け取っても捨てるだけの帯域になる)。
export const OBS_EVENT_SUBSCRIPTION_INPUTS = 1 << 3;
export const OBS_EVENT_SUBSCRIPTION_OUTPUTS = 1 << 6;

export type ObsSocketLike = {
  readyState?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: string, listener: (...args: any[]) => void): void;
  removeAllListeners?(): void;
};
export type ObsSocketFactory = (url: string) => ObsSocketLike;

export type ObsRequestResult = { ok: true; data: Record<string, unknown> } | { ok: false; code: number; comment: string };

type PendingRequest = { resolve: (result: ObsRequestResult) => void; timer: ReturnType<typeof setTimeout> };

export type ObsWebSocketClientOptions = {
  url: string;
  password: string | null;
  socketFactory: ObsSocketFactory;
  requestTimeoutMs?: number;
  eventSubscriptions?: number;
  onEvent?: (eventType: string, eventData: Record<string, unknown>) => void;
  onOpen?: () => void;
  onIdentified?: () => void;
  onClose?: (reason: string) => void;
  onError?: (error: Error) => void;
};

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});

// obs-websocket 5.x の challenge-response:
//   secret = base64(sha256(password + salt))
//   auth   = base64(sha256(secret + challenge))
export function obsAuthenticationString(password: string, salt: string, challenge: string): string {
  const secret = crypto.createHash("sha256").update(`${password}${salt}`).digest("base64");
  return crypto.createHash("sha256").update(`${secret}${challenge}`).digest("base64");
}

export class ObsWebSocketClient {
  #options: ObsWebSocketClientOptions;
  #socket: ObsSocketLike | null = null;
  #pending = new Map<string, PendingRequest>();
  #requestCounter = 0;
  #identified = false;
  #closed = false;

  constructor(options: ObsWebSocketClientOptions) {
    this.#options = options;
  }

  get identified(): boolean { return this.#identified; }

  connect(): void {
    if (this.#socket) return;
    this.#closed = false;
    let socket: ObsSocketLike;
    try {
      socket = this.#options.socketFactory(this.#options.url);
    } catch (error) {
      this.#options.onError?.(error instanceof Error ? error : new Error(String(error)));
      this.#options.onClose?.("connect-failed");
      return;
    }
    this.#socket = socket;
    socket.on("open", () => this.#options.onOpen?.());
    socket.on("message", (data: unknown) => this.#receive(data));
    socket.on("error", (error: unknown) => this.#options.onError?.(error instanceof Error ? error : new Error(String(error))));
    socket.on("close", () => this.#teardown("closed"));
  }

  close(): void {
    this.#closed = true;
    const socket = this.#socket;
    this.#teardown("disposed");
    try { socket?.close(); } catch { /* already closing */ }
  }

  async request(requestType: string, requestData: Record<string, unknown> = {}): Promise<ObsRequestResult> {
    if (!this.#socket || !this.#identified) return { ok: false, code: 0, comment: "not-identified" };
    this.#requestCounter += 1;
    const requestId = `dociai-caption-${this.#requestCounter}`;
    return new Promise<ObsRequestResult>((resolve) => {
      const timer = setTimeout(() => { this.#pending.delete(requestId); resolve({ ok: false, code: 0, comment: "timeout" }); }, this.#options.requestTimeoutMs ?? 5_000);
      this.#pending.set(requestId, { resolve, timer });
      try {
        this.#socket?.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(requestId);
        resolve({ ok: false, code: 0, comment: error instanceof Error ? error.message : "send-failed" });
      }
    });
  }

  #teardown(reason: string): void {
    const socket = this.#socket;
    this.#socket = null;
    this.#identified = false;
    for (const [, pending] of this.#pending) { clearTimeout(pending.timer); pending.resolve({ ok: false, code: 0, comment: "disconnected" }); }
    this.#pending.clear();
    socket?.removeAllListeners?.();
    if (!this.#closed || reason === "disposed") this.#options.onClose?.(reason);
    this.#closed = true;
  }

  #receive(raw: unknown): void {
    let message: { op?: unknown; d?: unknown };
    try {
      const text = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
      message = JSON.parse(text) as { op?: unknown; d?: unknown };
    } catch {
      this.#options.onError?.(new Error("OBS WebSocketから不正なJSONを受信しました"));
      return;
    }
    const payload = record(message.d);
    if (message.op === 0) { this.#identify(payload); return; }
    if (message.op === 2) { this.#identified = true; this.#options.onIdentified?.(); return; }
    if (message.op === 5) { this.#options.onEvent?.(typeof payload.eventType === "string" ? payload.eventType : "", record(payload.eventData)); return; }
    if (message.op === 7) {
      const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
      const pending = this.#pending.get(requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(requestId);
      const status = record(payload.requestStatus);
      if (status.result === true) pending.resolve({ ok: true, data: record(payload.responseData) });
      else pending.resolve({ ok: false, code: typeof status.code === "number" ? status.code : 0, comment: typeof status.comment === "string" ? status.comment : "request-failed" });
    }
  }

  #identify(hello: Record<string, unknown>): void {
    const identify: Record<string, unknown> = {
      rpcVersion: OBS_RPC_VERSION,
      eventSubscriptions: this.#options.eventSubscriptions ?? (OBS_EVENT_SUBSCRIPTION_INPUTS | OBS_EVENT_SUBSCRIPTION_OUTPUTS),
    };
    const authentication = record(hello.authentication);
    if (typeof authentication.challenge === "string" && typeof authentication.salt === "string") {
      // OBS側で認証が有効なのにパスワードが未設定なら、無認証でIdentifyを投げてサーバに
      // 蹴られるのを待つのではなく、こちら側で理由の分かる形で切る (設定UIへ出す文言が変わる)。
      if (!this.#options.password) {
        this.#options.onError?.(new Error("OBS WebSocketの認証が有効ですが、パスワードが未設定です"));
        this.close();
        return;
      }
      identify.authentication = obsAuthenticationString(this.#options.password, authentication.salt, authentication.challenge);
    }
    try {
      this.#socket?.send(JSON.stringify({ op: 1, d: identify }));
    } catch (error) {
      this.#options.onError?.(error instanceof Error ? error : new Error("Identifyの送信に失敗しました"));
      this.close();
    }
  }
}
