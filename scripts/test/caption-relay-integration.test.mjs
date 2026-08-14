// 英語CC (issue #282) のMain側 relay 経路テスト。
//
//   擬似Chromeワーカー (実WebSocketクライアント) -> CaptionWorkerHost -> CaptionPolicy
//   -> ObsCaptionOutputService -> mock OBS WebSocket サーバ
//
// を実プロセス内で通しで動かす。実Chrome・実マイク・実Twitchはこの環境で再現できないため、
// 認識と翻訳の結果だけをfixtureとして注入する (issue #282「認識・翻訳adapterをmock可能にする」)。
// browser E2E (e2e/) はRendererコンテキストなのでMain側のこの経路には到達できず、
// scripts/electron/translation-e2e.mjs 相当の実Electron起動も不要なため、素のNodeで完結させる。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { WebSocket, WebSocketServer } from "ws";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const assetDir = path.join(repoRoot, "resources/caption-worker");

async function loadModules() {
  const result = await build({
    stdin: {
      contents: `export { CaptionSession } from "./electron/main/services/captions/caption-session.ts";
export { CaptionWorkerHost } from "./electron/main/services/captions/caption-worker-host.ts";
export { CAPTION_WORKER_PROTOCOL_VERSION } from "./electron/shared/services/caption-contract.ts";`,
      resolveDir: repoRoot,
      sourcefile: "caption-relay-test.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    external: ["ws"],
    write: false,
  });
  const directory = await fs.mkdtemp(path.join(repoRoot, "node_modules", ".dociai-caption-relay-test-"));
  const file = path.join(directory, "modules.mjs");
  await fs.writeFile(file, result.outputFiles[0].text);
  return { modules: await import(file), directory };
}

async function createMockObs({ streaming = true } = {}) {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => wss.once("listening", resolve));
  const state = { captions: [], sockets: new Set(), streaming };
  wss.on("connection", (socket) => {
    state.sockets.add(socket);
    socket.on("close", () => state.sockets.delete(socket));
    socket.send(JSON.stringify({ op: 0, d: { obsWebSocketVersion: "5.5.0", rpcVersion: 1 } }));
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString("utf8"));
      if (message.op === 1) { socket.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } })); return; }
      if (message.op !== 6) return;
      const { requestType, requestId, requestData } = message.d;
      const respond = (responseData, ok = true) => socket.send(JSON.stringify({ op: 7, d: { requestType, requestId, requestStatus: { result: ok, code: ok ? 100 : 204 }, responseData } }));
      if (requestType === "GetVersion") return respond({ availableRequests: ["GetVersion", "GetStreamStatus", "GetInputMute", "SendStreamCaption"] });
      if (requestType === "GetStreamStatus") return respond({ outputActive: state.streaming });
      if (requestType === "GetInputMute") return respond({ inputMuted: false });
      if (requestType === "SendStreamCaption") { state.captions.push(requestData.captionText); return respond({}); }
      return respond({}, false);
    });
  });
  return {
    state,
    get port() { return wss.address().port; },
    close: () => new Promise((resolve) => { for (const socket of state.sockets) socket.terminate(); wss.close(() => resolve()); }),
  };
}

const waitFor = async (predicate, label, timeoutMs = 4_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
};

const httpGet = (url, headers = {}) => new Promise((resolve, reject) => {
  const request = http.get(url, { headers }, (response) => {
    const chunks = [];
    response.on("data", (chunk) => chunks.push(chunk));
    response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
  });
  request.on("error", reject);
});

const captionsConfig = (overrides = {}) => ({
  enabled: true,
  chromeExecutable: "",
  workerPort: 0,
  obs: { host: "127.0.0.1", port: 0, microphoneInputName: "" },
  maxPending: 2,
  maxAgeMs: 5_000,
  maxCaptionChars: 0,
  replacements: {},
  logCaptions: false,
  ...overrides,
});

// 擬似Chromeワーカー。ブラウザと同じOriginヘッダを送り、helloで認証してからcaptionを流す。
function connectWorker(origin, token, protocolVersion) {
  const socket = new WebSocket(`${origin.replace(/^http:/, "ws:")}/socket`, { headers: { Origin: origin, Host: origin.replace("http://", "") } });
  const received = [];
  socket.on("message", (raw) => received.push(JSON.parse(raw.toString("utf8"))));
  const ready = new Promise((resolve, reject) => {
    socket.once("open", () => socket.send(JSON.stringify({ type: "hello", protocolVersion, token })));
    socket.once("error", reject);
    socket.once("close", (code) => reject(new Error(`worker socket closed: ${code}`)));
  });
  return {
    socket,
    received,
    waitForWelcome: async () => { await Promise.race([ready, waitFor(() => received.some((message) => message.type === "welcome"), "welcome")]); },
    send: (message) => socket.send(JSON.stringify(message)),
    close: () => new Promise((resolve) => { socket.once("close", resolve); socket.close(); }),
  };
}

async function withSession(run, { config = {}, obsOptions = {} } = {}) {
  const { modules, directory } = await loadModules();
  const obs = await createMockObs(obsOptions);
  const statuses = [];
  // openWorker()が発行するワーカーURLはRendererにもテストにも公開されないので、Chrome起動口を
  // 差し替えて捕まえる。実Chromeの起動と実マイクは手動E2E (docs/captions.md) の担当。
  const launched = [];
  const session = new modules.CaptionSession({
    assetDir,
    webSocketServerFactory: (options) => new WebSocketServer(options),
    obsSocketFactory: (url) => new WebSocket(url),
    readObsPassword: async () => null,
    onStatus: (status) => statuses.push(status),
    obsRefreshIntervalMs: 0,
    launchBrowser: (_executable, url) => launched.push(url),
  });
  // Chrome実行ファイルの存在チェックだけは実ファイルを見るため、この環境に必ずあるNode自身を
  // 指す (launchBrowserを差し替えているので実際には起動されない)。
  await session.applyConfig(captionsConfig({ chromeExecutable: process.execPath, ...config, obs: { host: "127.0.0.1", port: obs.port, microphoneInputName: "", ...(config.obs ?? {}) } }));
  try {
    await run({ session, obs, statuses, modules, launched });
  } finally {
    await session.dispose();
    await obs.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("final日本語fixture -> 英語fixture -> relay -> mock OBS SendStreamCaption が通しで動く", async () => {
  await withSession(async ({ session, obs, launched }) => {
    const url = await startWorkerAndGetUrl(session, launched);
    const page = await httpGet(url);
    assert.equal(page.status, 200);
    const bootstrap = readBootstrap(page.body);
    const worker = connectWorker(bootstrap.origin, bootstrap.socketToken, bootstrap.protocolVersion);
    await worker.waitForWelcome();
    await waitFor(() => session.status().obs.connected, "obs connected");
    worker.send({ type: "state", state: "recognizing" });
    worker.send({ type: "caption", sequence: 1, isFinal: true, recognized: "今日は国家情報局について取り上げます", text: "Today, we will discuss the proposed intelligence agency.", ageMs: 20 });
    await waitFor(() => obs.state.captions.length === 1, "caption forwarded");
    assert.deepEqual(obs.state.captions, ["Today, we will discuss the proposed intelligence agency."]);
    const status = session.status();
    assert.equal(status.counters.sent, 1);
    assert.equal(status.lastCaption, "Today, we will discuss the proposed intelligence agency.");
    assert.equal(status.health, "sending");
    await worker.close();
  });
});

test("interim・日本語のまま・重複・期限切れはOBSへ送らずackで理由を返す", async () => {
  await withSession(async ({ session, obs, launched }) => {
    const url = await startWorkerAndGetUrl(session, launched);
    const bootstrap = readBootstrap((await httpGet(url)).body);
    const worker = connectWorker(bootstrap.origin, bootstrap.socketToken, bootstrap.protocolVersion);
    await worker.waitForWelcome();
    await waitFor(() => session.status().obs.connected, "obs connected");
    worker.send({ type: "caption", sequence: 1, isFinal: false, recognized: "こんばん", text: "Good ev", ageMs: 0 });
    worker.send({ type: "caption", sequence: 2, isFinal: true, recognized: "こんばんは", text: "こんばんは", ageMs: 0 });
    worker.send({ type: "caption", sequence: 3, isFinal: true, recognized: "こんばんは", text: "Good evening.", ageMs: 0 });
    worker.send({ type: "caption", sequence: 4, isFinal: true, recognized: "こんばんは", text: "Good evening.", ageMs: 0 });
    worker.send({ type: "caption", sequence: 5, isFinal: true, recognized: "遅れました", text: "Too late.", ageMs: 9_000 });
    await waitFor(() => worker.received.filter((message) => message.type === "ack").length >= 5, "acks");
    const acks = Object.fromEntries(worker.received.filter((message) => message.type === "ack").map((message) => [message.sequence, message]));
    assert.equal(acks[1].reason, "not-final");
    assert.equal(acks[2].reason, "source-language-leak");
    assert.equal(acks[3].accepted, true);
    assert.equal(acks[4].reason, "duplicate");
    assert.equal(acks[5].reason, "expired");
    // Twitchへ渡ったのは英訳1件だけ — 日本語原文は一度も送られていない
    assert.deepEqual(obs.state.captions, ["Good evening."]);
    await worker.close();
  });
});

test("OBSが未配信の間はSendStreamCaptionを一度も呼ばない", async () => {
  await withSession(async ({ session, obs, launched }) => {
    const url = await startWorkerAndGetUrl(session, launched);
    const bootstrap = readBootstrap((await httpGet(url)).body);
    const worker = connectWorker(bootstrap.origin, bootstrap.socketToken, bootstrap.protocolVersion);
    await worker.waitForWelcome();
    await waitFor(() => session.status().obs.connected, "obs connected");
    worker.send({ type: "caption", sequence: 1, isFinal: true, recognized: "こんばんは", text: "Good evening.", ageMs: 0 });
    await waitFor(() => session.status().counters.failed === 1, "send refused");
    assert.deepEqual(obs.state.captions, []);
    assert.equal(session.status().health, "obs_not_streaming");
    await worker.close();
  }, { obsOptions: { streaming: false } });
});

test("停止後に届いた古い接続の字幕は破棄され、OBSへ流れない", async () => {
  await withSession(async ({ session, obs, launched }) => {
    const url = await startWorkerAndGetUrl(session, launched);
    const bootstrap = readBootstrap((await httpGet(url)).body);
    const worker = connectWorker(bootstrap.origin, bootstrap.socketToken, bootstrap.protocolVersion);
    await worker.waitForWelcome();
    await waitFor(() => session.status().obs.connected, "obs connected");
    // 停止するとhostがソケットを閉じ、以後のどんな字幕もOBSへは届かない
    await session.stop();
    await waitFor(() => worker.socket.readyState === WebSocket.CLOSED || worker.socket.readyState === WebSocket.CLOSING, "worker socket closed");
    assert.equal(session.status().running, false);
    assert.equal(session.status().health, "disabled");
    assert.deepEqual(obs.state.captions, []);
  });
});

test("session tokenが違う・Originがloopback外・protocolVersion不一致の接続を拒否する", async () => {
  await withSession(async ({ session, modules, launched }) => {
    const url = await startWorkerAndGetUrl(session, launched);
    const bootstrap = readBootstrap((await httpGet(url)).body);
    const rejected = async (token, origin, protocolVersion) => {
      const socket = new WebSocket(`${bootstrap.origin.replace(/^http:/, "ws:")}/socket`, { headers: { Origin: origin } });
      return new Promise((resolve) => {
        socket.once("open", () => socket.send(JSON.stringify({ type: "hello", protocolVersion, token })));
        socket.once("close", () => resolve("closed"));
        socket.once("error", () => resolve("closed"));
      });
    };
    assert.equal(await rejected("wrong-token", bootstrap.origin, bootstrap.protocolVersion), "closed");
    assert.equal(await rejected(bootstrap.socketToken, "http://evil.example", bootstrap.protocolVersion), "closed");
    assert.equal(await rejected(bootstrap.socketToken, bootstrap.origin, modules.CAPTION_WORKER_PROTOCOL_VERSION + 1), "closed");
    assert.equal(session.status().worker.connected, false);
  });
});

test("ページ取得tokenは一回限りで、静的ファイル以外のpathは404、非loopback Hostは403", async () => {
  await withSession(async ({ session, launched }) => {
    const url = await startWorkerAndGetUrl(session, launched);
    const first = await httpGet(url);
    assert.equal(first.status, 200);
    assert.match(first.headers["content-security-policy"] ?? "", /default-src 'none'/);
    assert.equal(first.headers["x-content-type-options"], "nosniff");
    // 同じURLをもう一度踏んでもページは返らない (tokenは1回で失効する)
    assert.equal((await httpGet(url)).status, 403);
    const origin = new URL(url).origin;
    assert.equal((await httpGet(`${origin}/caption-worker.js`)).status, 200);
    assert.equal((await httpGet(`${origin}/../../package.json`)).status, 404);
    assert.equal((await httpGet(`${origin}/`, { Host: "example.com" })).status, 403);
  });
});

// openWorker() は launchBrowser へURLを渡すだけなので、テストではそのURLを捕まえる。
async function startWorkerAndGetUrl(session, launched) {
  const result = await session.openWorker();
  assert.equal(result.opened, true, `openWorker failed: ${result.reason ?? ""}`);
  await waitFor(() => launched.length > 0, "worker url");
  return launched[launched.length - 1];
}

function readBootstrap(html) {
  const match = html.match(/<script id="caption-bootstrap" type="application\/json">(.*?)<\/script>/s);
  assert.ok(match, "bootstrap script is injected into the served page");
  const parsed = JSON.parse(match[1].replace(/\\u003c/g, "<"));
  return { ...parsed, origin: new URL(parsed.socketUrl.replace(/^ws:/, "http:")).origin };
}
