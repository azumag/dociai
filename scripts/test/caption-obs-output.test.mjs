// 英語CC (issue #282) のOBS出力側テスト。実OBSを使わず、obs-websocket 5.xのHello/Identify/
// 認証・Request/Response・Eventを喋るmockサーバに対して検証する。
//
// 受け入れ条件のうち「OBS配信中だけSendStreamCaptionが呼ばれる」「OBSマイクミュート中は字幕が
// 送られない」「OBS切断後に自動回復する」をここで担保する。
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { WebSocket, WebSocketServer } from "ws";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);

async function loadModules() {
  const result = await build({
    stdin: {
      contents: `export { ObsCaptionOutputService } from "./electron/main/services/captions/obs-caption-output-service.ts";
export { obsAuthenticationString, ObsWebSocketClient } from "./electron/main/services/captions/obs-websocket-client.ts";`,
      resolveDir: repoRoot,
      sourcefile: "caption-obs-output-test.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    external: ["ws"],
    write: false,
  });
  const directory = await fs.mkdtemp(path.join(repoRoot, "node_modules", ".dociai-caption-obs-test-"));
  const file = path.join(directory, "modules.mjs");
  await fs.writeFile(file, result.outputFiles[0].text);
  return { modules: await import(file), directory };
}

// obs-websocket 5.x のサーバ側を必要な範囲だけ実装したmock。
async function createMockObs({ password = null, streaming = true, muted = false, silent = false, availableRequests = ["GetVersion", "GetStreamStatus", "GetInputMute", "SendStreamCaption"] } = {}) {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => wss.once("listening", resolve));
  const state = { captions: [], sockets: new Set(), streaming, muted, identifyFailures: 0, closedByClient: 0 };
  wss.on("connection", (socket) => {
    state.sockets.add(socket);
    socket.on("close", () => { state.sockets.delete(socket); state.closedByClient += 1; });
    const salt = "salt-value";
    const challenge = "challenge-value";
    socket.send(JSON.stringify({ op: 0, d: { obsWebSocketVersion: "5.5.0", rpcVersion: 1, ...(password ? { authentication: { challenge, salt } } : {}) } }));
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString("utf8"));
      if (message.op === 1) {
        if (password) {
          const secret = crypto.createHash("sha256").update(`${password}${salt}`).digest("base64");
          const expected = crypto.createHash("sha256").update(`${secret}${challenge}`).digest("base64");
          if (message.d.authentication !== expected) { state.identifyFailures += 1; socket.close(4009, "auth failed"); return; }
        }
        socket.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
        return;
      }
      if (message.op !== 6 || silent) return;
      const { requestType, requestId, requestData } = message.d;
      const respond = (responseData, ok = true, code = 100) => socket.send(JSON.stringify({ op: 7, d: { requestType, requestId, requestStatus: { result: ok, code }, responseData } }));
      if (requestType === "GetVersion") return respond({ obsVersion: "31.0.0", availableRequests });
      if (requestType === "GetStreamStatus") return respond({ outputActive: state.streaming });
      if (requestType === "GetInputMute") return requestData.inputName === "Mic/Aux" ? respond({ inputMuted: state.muted }) : respond({}, false, 600);
      if (requestType === "SendStreamCaption") { state.captions.push(requestData.captionText); return respond({}); }
      return respond({}, false, 204);
    });
  });
  return {
    state,
    get port() { return wss.address().port; },
    broadcast: (eventType, eventData) => { for (const socket of state.sockets) socket.send(JSON.stringify({ op: 5, d: { eventType, eventData } })); },
    dropConnections: () => { for (const socket of state.sockets) socket.close(); },
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

async function withService(mockOptions, run, serviceOptions = {}) {
  const { modules, directory } = await loadModules();
  const obs = await createMockObs(mockOptions);
  const service = new modules.ObsCaptionOutputService({
    socketFactory: (url) => new WebSocket(url),
    refreshIntervalMs: 0,
    initialBackoffMs: 20,
    maxBackoffMs: 40,
    ...serviceOptions,
  });
  try {
    await run({ service, obs, modules });
  } finally {
    service.dispose();
    await obs.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("認証つきOBSへ接続し、配信中のときだけSendStreamCaptionを呼ぶ", async () => {
  await withService({ password: "s3cret", streaming: false }, async ({ service, obs }) => {
    service.start({ host: "127.0.0.1", port: obs.port, password: "s3cret", microphoneInputName: "" });
    await waitFor(() => service.state.connected, "identified");
    assert.equal(service.state.captionSupported, true);
    assert.equal(service.state.streaming, false);
    // 未配信の間は一度も送らない
    assert.deepEqual(await service.sendCaption("Hello."), { sent: false, reason: "obs_not_streaming" });
    assert.deepEqual(obs.state.captions, []);
    obs.state.streaming = true;
    obs.broadcast("StreamStateChanged", { outputActive: true, outputState: "OBS_WEBSOCKET_OUTPUT_STARTED" });
    await waitFor(() => service.state.streaming, "streaming");
    assert.deepEqual(await service.sendCaption("Hello."), { sent: true });
    assert.deepEqual(obs.state.captions, ["Hello."]);
  });
});

test("パスワードが違うとIdentifyが拒否され、字幕は送られない", async () => {
  await withService({ password: "s3cret" }, async ({ service, obs }) => {
    service.start({ host: "127.0.0.1", port: obs.port, password: "wrong", microphoneInputName: "" });
    await waitFor(() => obs.state.identifyFailures > 0, "identify rejection");
    assert.equal(service.state.connected, false);
    assert.equal((await service.sendCaption("Hello.")).sent, false);
    assert.deepEqual(obs.state.captions, []);
  });
});

test("対象マイクがミュートの間は送らず、ミュート解除イベントで再開する", async () => {
  await withService({ muted: true }, async ({ service, obs }) => {
    service.start({ host: "127.0.0.1", port: obs.port, password: null, microphoneInputName: "Mic/Aux" });
    await waitFor(() => service.state.connected, "identified");
    await waitFor(() => service.state.micMuted, "muted");
    assert.deepEqual(await service.sendCaption("Hello."), { sent: false, reason: "mic_muted" });
    obs.broadcast("InputMuteStateChanged", { inputName: "Mic/Aux", inputMuted: false });
    await waitFor(() => !service.state.micMuted, "unmuted");
    assert.deepEqual(await service.sendCaption("Hello."), { sent: true });
    // 別入力のミュートイベントは無視する
    obs.broadcast("InputMuteStateChanged", { inputName: "Desktop Audio", inputMuted: true });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(service.state.micMuted, false);
  });
});

test("マイク入力名が未設定ならミュート判定自体を行わない", async () => {
  await withService({ muted: true }, async ({ service, obs }) => {
    service.start({ host: "127.0.0.1", port: obs.port, password: null, microphoneInputName: "" });
    await waitFor(() => service.state.connected, "identified");
    assert.equal(service.state.micMuted, false);
    assert.deepEqual(await service.sendCaption("Hello."), { sent: true });
  });
});

test("SendStreamCaption非対応のOBSでは字幕だけをdegradedにする", async () => {
  await withService({ availableRequests: ["GetVersion", "GetStreamStatus"] }, async ({ service, obs }) => {
    service.start({ host: "127.0.0.1", port: obs.port, password: null, microphoneInputName: "" });
    await waitFor(() => service.state.connected, "identified");
    assert.equal(service.state.captionSupported, false);
    assert.equal(service.state.lastError?.code, "caption_unsupported");
    assert.deepEqual(await service.sendCaption("Hello."), { sent: false, reason: "caption_unsupported" });
  });
});

test("切断後は自動再接続し、再接続をonReconnectedで通知する", async () => {
  let reconnected = 0;
  await withService({}, async ({ service, obs }) => {
    service.start({ host: "127.0.0.1", port: obs.port, password: null, microphoneInputName: "" });
    await waitFor(() => service.state.connected, "identified");
    obs.dropConnections();
    await waitFor(() => !service.state.connected, "disconnected");
    assert.deepEqual(await service.sendCaption("Hello."), { sent: false, reason: "obs_disconnected" });
    await waitFor(() => service.state.connected, "reconnected");
    assert.equal(reconnected, 1);
    assert.deepEqual(await service.sendCaption("Hello."), { sent: true });
  }, { onReconnected: () => { reconnected += 1; } });
});

test("対象マイク入力名が誤っていると送出を止め (fail-closed)、理由をlastErrorへ出す", async () => {
  await withService({}, async ({ service, obs }) => {
    service.start({ host: "127.0.0.1", port: obs.port, password: null, microphoneInputName: "Typo/Mic" });
    await waitFor(() => service.state.connected, "identified");
    await waitFor(() => service.state.lastError?.code === "obs_input_missing", "input error");
    // 入力名が誤っていると InputMuteStateChanged も永遠に一致しないため、
    // fail-openにすると「実際はミュート中でも字幕が出続ける」状態が見えないまま成立してしまう。
    assert.equal(service.state.micMuted, true);
    assert.deepEqual(await service.sendCaption("Hello."), { sent: false, reason: "mic_muted" });
    assert.deepEqual(obs.state.captions, []);
  });
});

test("応答が連続でtimeoutしたら自分から切断して再接続へ落とす (half-open対策)", async () => {
  await withService({ silent: true }, async ({ service, obs }) => {
    service.start({ host: "127.0.0.1", port: obs.port, password: null, microphoneInputName: "" });
    await waitFor(() => service.state.connected, "identified");
    // GetVersionが返らないままなので、connected:true のまま固まらずに切断→再接続が起きる
    await waitFor(() => obs.state.closedByClient > 0, "self-disconnect", 8_000);
    // refreshIntervalMs でポーリングを続けさせ、timeoutが規定回数連続する状況を作る
  }, { requestTimeoutMs: 60, refreshIntervalMs: 40 });
});

test("OBSのchallenge-responseはobs-websocket 5.xの仕様どおりに計算される", async () => {
  const { modules, directory } = await loadModules();
  try {
    const secret = crypto.createHash("sha256").update("passsalt").digest("base64");
    const expected = crypto.createHash("sha256").update(`${secret}challenge`).digest("base64");
    assert.equal(modules.obsAuthenticationString("pass", "salt", "challenge"), expected);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
