// 外部Chromeタブ (字幕ワーカー) を受けるloopback HTTP + WebSocketサーバ (issue #282)。
//
// Electron Renderer内のWeb Speech APIは`network error`になる既知報告があるため、認識・翻訳は
// dociaiの外側の通常Chromeタブで動かし、その結果だけをこのサーバで受け取る。
//
// セキュリティ要件 (issue #282):
//   - 127.0.0.1 以外ではlistenしない
//   - session tokenを起動ごとに生成し、ログへ全文を出さない
//   - Host/Origin を loopback の想定値に制限する
//   - 配信するのは resources/caption-worker/ の固定3ファイルだけ (path traversal不可)
//
// tokenは2段構え。URLに載せるのは**一回限りのページ取得token**だけで、実際にWebSocketの認証に
// 使う長寿命のsocket tokenはHTML本文へ埋め込んで渡す。Chromeをコマンドラインから起動する以上、
// URLはプロセス一覧・ブラウザ履歴・配信画面のアドレスバーへ露出しうるため、そこへ長期間有効な
// 認証情報を置かないための分離 (計画レビュー指摘)。
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { CAPTION_SESSION_TOKEN_BYTES, CAPTION_WORKER_PROTOCOL_VERSION, MAX_WORKER_MESSAGE_BYTES } from "../../../shared/services/caption-contract";
import type { CaptionHostMessage, CaptionWorkerState } from "../../../shared/services/caption-contract";

export type WorkerSocketLike = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: string, listener: (...args: any[]) => void): void;
  terminate?(): void;
};
export type WorkerSocketServerLike = {
  handleUpgrade(request: http.IncomingMessage, socket: any, head: Buffer, callback: (ws: WorkerSocketLike) => void): void;
  close(callback?: () => void): void;
};
export type WorkerSocketServerFactory = (options: { noServer: true; maxPayload: number }) => WorkerSocketServerLike;

export type CaptionWorkerHostOptions = {
  assetDir: string;
  webSocketServerFactory: WorkerSocketServerFactory;
  onCaption: (input: { sequence: number; isFinal: boolean; recognized: string; text: string; ageMs: number }, context: { connectionGeneration: number }) => void;
  onWorkerState: (state: CaptionWorkerState, detail: string) => void;
  onConnectionChange: (connected: boolean) => void;
  log?: (message: string, fields?: Record<string, unknown>) => void;
  authTimeoutMs?: number;
};

// 配信を許可する静的ファイル。ここに無いpathは常に404 — 相対pathの正規化に頼らないので
// `..` を含むどんな入力でもファイルシステムへ到達しない。
const STATIC_FILES: Record<string, { file: string; contentType: string }> = {
  "/caption-worker.js": { file: "caption-worker.js", contentType: "text/javascript; charset=utf-8" },
  "/caption-worker.css": { file: "caption-worker.css", contentType: "text/css; charset=utf-8" },
};

// Chromeページ側で許可する取得元を自分自身 (loopback) だけに閉じる。`connect-src`はWebSocketの
// ws: を含める必要があるため 'self' では足りず、明示的にoriginを与える。
function contentSecurityPolicy(origin: string): string {
  const wsOrigin = origin.replace(/^http:/, "ws:");
  return ["default-src 'none'", "script-src 'self'", "style-src 'self'", `connect-src ${wsOrigin}`, "img-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"].join("; ");
}

function securityHeaders(origin: string): Record<string, string> {
  return {
    "Content-Security-Policy": contentSecurityPolicy(origin),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  };
}

const timingSafeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

const newToken = (): string => crypto.randomBytes(CAPTION_SESSION_TOKEN_BYTES).toString("base64url");

export class CaptionWorkerHost {
  #options: CaptionWorkerHostOptions;
  #server: http.Server | null = null;
  #wss: WorkerSocketServerLike | null = null;
  #port = 0;
  #pageToken: string | null = null;
  #socketToken: string | null = null;
  #socket: WorkerSocketLike | null = null;
  #authenticated = false;
  #connectionGeneration = 0;
  #generation = 0;

  constructor(options: CaptionWorkerHostOptions) { this.#options = options; }

  get port(): number { return this.#port; }
  get listening(): boolean { return this.#server !== null; }
  get connected(): boolean { return this.#authenticated; }
  get origin(): string { return `http://127.0.0.1:${this.#port}`; }

  // `port` 0 でephemeral port。固定ポートを指定した場合だけ競合を明示エラーにする
  // (Chromeのマイク許可はorigin単位で永続化されるため、固定したい運用も成立させる)。
  async start(port: number, generation: number): Promise<{ port: number }> {
    if (this.#server) await this.stop();
    this.#generation = generation;
    this.#socketToken = null;
    this.#pageToken = null;
    const server = http.createServer((request, response) => { void this.#handleRequest(request, response); });
    const wss = this.#options.webSocketServerFactory({ noServer: true, maxPayload: MAX_WORKER_MESSAGE_BYTES });
    server.on("upgrade", (request, socket, head) => this.#handleUpgrade(request, socket, head, wss));
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.removeListener("listening", onListening);
        reject(error.code === "EADDRINUSE" ? new Error(`字幕ワーカー用ポート ${port} は既に使用されています`) : error);
      };
      const onListening = () => { server.removeListener("error", onError); resolve(); };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "127.0.0.1");
    });
    server.on("error", (error) => this.#options.log?.("字幕ワーカーhostのエラー", { message: error.message }));
    const address = server.address();
    this.#port = typeof address === "object" && address ? address.port : port;
    this.#server = server;
    this.#wss = wss;
    return { port: this.#port };
  }

  async stop(): Promise<void> {
    this.#closeWorker("shutdown");
    this.#pageToken = null;
    this.#socketToken = null;
    const server = this.#server;
    this.#server = null;
    this.#wss?.close();
    this.#wss = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.#port = 0;
  }

  // 「Chromeを開く」たびに新しい一回限りのURLを発行する。前回発行分は即失効する。
  issueWorkerUrl(): string {
    if (!this.#server) throw new Error("字幕ワーカーhostが起動していません");
    this.#pageToken = newToken();
    return `${this.origin}/?t=${this.#pageToken}`;
  }

  send(message: CaptionHostMessage): void {
    if (!this.#socket || !this.#authenticated) return;
    try { this.#socket.send(JSON.stringify(message)); } catch { /* 切断直後 — closeハンドラ側で回収される */ }
  }

  #closeWorker(reason: "operator" | "shutdown"): void {
    const socket = this.#socket;
    const wasConnected = this.#authenticated;
    this.#socket = null;
    this.#authenticated = false;
    if (socket) {
      try { socket.send(JSON.stringify({ type: "stop", reason } satisfies CaptionHostMessage)); } catch { /* 送れなくても閉じる */ }
      try { socket.close(1001, reason); } catch { /* already closing */ }
    }
    if (wasConnected) this.#options.onConnectionChange(false);
  }

  disconnectWorker(): void { this.#closeWorker("operator"); }

  async #handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const headers = securityHeaders(this.origin);
    if (!this.#isLoopbackRequest(request)) { response.writeHead(403, headers).end("Forbidden"); return; }
    if (request.method !== "GET") { response.writeHead(405, headers).end("Method Not Allowed"); return; }
    const url = new URL(request.url ?? "/", this.origin);
    const asset = STATIC_FILES[url.pathname];
    if (asset) {
      try {
        const body = await fs.readFile(path.join(this.#options.assetDir, asset.file));
        response.writeHead(200, { ...headers, "Content-Type": asset.contentType }).end(body);
      } catch {
        response.writeHead(404, headers).end("Not Found");
      }
      return;
    }
    if (url.pathname !== "/") { response.writeHead(404, headers).end("Not Found"); return; }
    const token = url.searchParams.get("t") ?? "";
    if (!this.#pageToken || !timingSafeEqual(token, this.#pageToken)) {
      // ページ取得tokenは一回限りなので、タブを再読み込みするとここへ来る (URLからtokenを
      // 消しているため)。素の"Forbidden"だと運用者が復帰方法に辿り着けないので、
      // 何をすれば良いかだけを書いた最小のHTMLを返す (本文にtokenは一切含めない)。
      this.#options.log?.("字幕ワーカーページのtokenが一致しません");
      response.writeHead(403, { ...headers, "Content-Type": "text/html; charset=utf-8" })
        .end("<!DOCTYPE html><html lang=\"ja\"><meta charset=\"UTF-8\"><title>dociai 英語CC</title><body><h1>このページのURLは失効しています</h1><p>字幕ワーカーのURLは一度きり有効です。dociaiの操作卓にある「英語CC」パネルの「Chromeを開く」を押し直してください。</p></body></html>");
      return;
    }
    // 一回限り: ページを1枚返した時点でURLのtokenは失効し、以後同じURLを踏んでも403になる。
    this.#pageToken = null;
    this.#socketToken = newToken();
    try {
      const template = await fs.readFile(path.join(this.#options.assetDir, "index.html"), "utf8");
      const bootstrap = `<script id="caption-bootstrap" type="application/json">${JSON.stringify({ socketToken: this.#socketToken, protocolVersion: CAPTION_WORKER_PROTOCOL_VERSION, socketUrl: `${this.origin.replace(/^http:/, "ws:")}/socket` }).replace(/</g, "\\u003c")}</script>`;
      response.writeHead(200, { ...headers, "Content-Type": "text/html; charset=utf-8" }).end(template.replace("<!--CAPTION_BOOTSTRAP-->", bootstrap));
    } catch (error) {
      this.#options.log?.("字幕ワーカーページを読み込めません", { message: error instanceof Error ? error.message : String(error) });
      response.writeHead(500, headers).end("Internal Server Error");
    }
  }

  // Host/Origin ともに自分のloopback originだけを許可する。Originヘッダが無いのは
  // 非ブラウザからのアクセス (curl等) なので拒否する — 想定利用は常にChromeタブ。
  #isLoopbackRequest(request: http.IncomingMessage): boolean {
    const allowedHosts = new Set([`127.0.0.1:${this.#port}`, `localhost:${this.#port}`]);
    const allowedOrigins = new Set([`http://127.0.0.1:${this.#port}`, `http://localhost:${this.#port}`]);
    const host = request.headers.host ?? "";
    if (!allowedHosts.has(host)) return false;
    const origin = request.headers.origin;
    if (origin === undefined) return request.headers.upgrade === undefined;
    return typeof origin === "string" && allowedOrigins.has(origin);
  }

  #handleUpgrade(request: http.IncomingMessage, socket: any, head: Buffer, wss: WorkerSocketServerLike): void {
    const url = new URL(request.url ?? "/", this.origin);
    if (url.pathname !== "/socket" || !this.#isLoopbackRequest(request) || !this.#socketToken) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => this.#acceptSocket(ws));
  }

  #acceptSocket(ws: WorkerSocketLike): void {
    // 認証前のソケットを放置しない。helloが来ないまま期限が切れたら切る。
    let authTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      authTimer = null;
      try { ws.close(4001, "unauthenticated"); } catch { /* already closing */ }
    }, this.#options.authTimeoutMs ?? 5_000);
    authTimer.unref?.();
    let authenticated = false;
    ws.on("message", (data: unknown) => {
      const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : "";
      if (text.length > MAX_WORKER_MESSAGE_BYTES) { try { ws.close(4009, "payload-too-large"); } catch { /* closing */ } return; }
      let message: Record<string, unknown>;
      try { message = JSON.parse(text) as Record<string, unknown>; } catch { return; }
      if (!authenticated) {
        if (message.type !== "hello" || typeof message.token !== "string" || !this.#socketToken || !timingSafeEqual(message.token, this.#socketToken)
          || message.protocolVersion !== CAPTION_WORKER_PROTOCOL_VERSION) {
          this.#options.log?.("字幕ワーカーの認証に失敗しました");
          try { ws.close(4003, "unauthorized"); } catch { /* closing */ }
          return;
        }
        authenticated = true;
        if (authTimer) { clearTimeout(authTimer); authTimer = null; }
        // 同時に1本だけ。あとから来た接続 (ページ再読込) を活かし、古い方を明示的に閉じる。
        if (this.#socket && this.#socket !== ws) this.#closeWorker("operator");
        this.#socket = ws;
        this.#authenticated = true;
        this.#connectionGeneration = this.#generation;
        this.#options.onConnectionChange(true);
        this.send({ type: "welcome", protocolVersion: CAPTION_WORKER_PROTOCOL_VERSION, generation: this.#generation });
        return;
      }
      if (this.#socket !== ws) return;
      this.#handleWorkerMessage(message);
    });
    ws.on("close", () => {
      if (authTimer) { clearTimeout(authTimer); authTimer = null; }
      if (this.#socket !== ws) return;
      this.#socket = null;
      const wasConnected = this.#authenticated;
      this.#authenticated = false;
      if (wasConnected) this.#options.onConnectionChange(false);
    });
    ws.on("error", () => { try { ws.close(); } catch { /* closing */ } });
  }

  #handleWorkerMessage(message: Record<string, unknown>): void {
    if (message.type === "state") {
      const state = typeof message.state === "string" ? message.state as CaptionWorkerState : "error";
      this.#options.onWorkerState(state, typeof message.detail === "string" ? message.detail.slice(0, 200) : "");
      return;
    }
    if (message.type !== "caption") return;
    if (typeof message.sequence !== "number" || !Number.isSafeInteger(message.sequence) || message.sequence < 0) return;
    if (typeof message.text !== "string" || typeof message.recognized !== "string") return;
    if (typeof message.ageMs !== "number") return;
    this.#options.onCaption(
      { sequence: message.sequence, isFinal: message.isFinal === true, recognized: message.recognized, text: message.text, ageMs: message.ageMs },
      { connectionGeneration: this.#connectionGeneration },
    );
  }
}
