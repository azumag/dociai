// dociai 英語CCワーカー (issue #282)。
//
// デスクトップ版Google Chromeのタブで動く。ElectronのRenderer内ではWeb Speech APIが
// `network error` になる既知報告があるため、認識と翻訳だけを外部Chromeに置き、確定した英訳を
// loopback WebSocketで dociai Main process へ送る。
//
// Translator APIはトップレベルwindowで動かす (Web Workerへは移さない) — `Translator.create()` は
// 初回のモデルダウンロードでユーザー操作を要求するため、明示的な「開始」ボタンから呼ぶ必要がある。
//
// このファイルは dociai 本体のバンドル対象ではなく、resources/caption-worker/ から
// そのままChromeへ配信される素のES module。

const bootstrap = JSON.parse(document.getElementById("caption-bootstrap")?.textContent ?? "{}");

// 一回限りのページ取得tokenをアドレスバー・履歴から即座に消す。WebSocketの認証に使うのは
// HTML本文へ埋め込まれた別のsocket tokenなので、これを消しても再接続には影響しない。
if (location.search) history.replaceState(null, "", location.pathname);

const el = (id) => document.getElementById(id);
const view = {
  start: el("btn-start"),
  stop: el("btn-stop"),
  link: el("state-link"),
  recognition: el("state-recognition"),
  translator: el("state-translator"),
  sent: el("state-sent"),
  recognized: el("preview-recognized"),
  caption: el("preview-caption"),
  message: el("message"),
};

const state = {
  socket: null,
  connected: false,
  recognition: null,
  translator: null,
  running: false,
  stopRequested: false,
  sequence: 0,
  sentCount: 0,
  socketBackoffMs: 1000,
  // hostから明示stopを受けた後はtokenが失効しているので、再接続を試みても4003で切られるだけ。
  linkClosed: false,
  // welcomeを受け取れないまま閉じた連続回数。dociaiが再起動するとsocket tokenが作り直されるため、
  // このページのtokenでは二度と繋がらない — 黙って再試行し続けると「未接続」表示のまま
  // 復帰を待たせてしまうので、一定回数で打ち切って発行し直しを案内する。
  failedReconnects: 0,
  // finalの送出をFIFOに保つための直列化チェーン。翻訳の所要時間は文ごとに違うため、
  // 直列化しないと後の発話が先にTwitchへ出る (sequenceは送信時採番なのでMain側では検出できない)。
  sendChain: Promise.resolve(),
  recognitionBackoffMs: 500,
};

function setMessage(text, isError = false) {
  view.message.textContent = text;
  view.message.classList.toggle("error", isError);
}

function report(workerState, detail = "") {
  if (!state.connected || !state.socket) return;
  try { state.socket.send(JSON.stringify({ type: "state", state: workerState, detail })); } catch { /* 切断直後 */ }
}

// これ以上「一度もwelcomeを受け取れないまま閉じた」が続いたら、tokenが失効していると判断する。
const MAX_FAILED_RECONNECTS = 5;

// ---- dociai との接続 ----

function connect() {
  if (state.socket) return;
  const socket = new WebSocket(bootstrap.socketUrl);
  state.socket = socket;
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ type: "hello", protocolVersion: bootstrap.protocolVersion, token: bootstrap.socketToken, userAgent: navigator.userAgent.slice(0, 200) }));
  });
  socket.addEventListener("message", (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === "welcome") {
      state.connected = true;
      state.socketBackoffMs = 1000;
      state.failedReconnects = 0;
      view.link.textContent = "接続済み";
      report(state.running ? "recognizing" : "idle");
      return;
    }
    if (message.type === "stop") { state.linkClosed = true; stopRecognition("dociaiから停止を受け取りました"); socket.close(); return; }
    if (message.type === "ack" && message.accepted === false) setMessage(`dociai側で字幕を破棄しました (${message.reason})`);
  });
  socket.addEventListener("close", () => {
    const wasConnected = state.connected;
    state.socket = null;
    state.connected = false;
    if (state.linkClosed) { view.link.textContent = "dociaiから停止されました"; return; }
    state.failedReconnects = wasConnected ? 0 : state.failedReconnects + 1;
    if (state.failedReconnects >= MAX_FAILED_RECONNECTS) {
      view.link.textContent = "接続できません";
      setMessage("dociaiとの接続が復帰しません。dociaiの「英語CC」パネルで「Chromeを開く」を押し、新しいURLを発行し直してください。", true);
      return;
    }
    view.link.textContent = "未接続 — 再接続します";
    // dociai側が落ちている間は字幕を送らず、再接続だけを試みる。
    const delay = state.socketBackoffMs;
    state.socketBackoffMs = Math.min(state.socketBackoffMs * 2, 30_000);
    setTimeout(connect, delay);
  });
  socket.addEventListener("error", () => { view.link.textContent = "接続エラー"; });
}

// ---- 翻訳 (Chrome内蔵 Translator API) ----

async function ensureTranslator() {
  if (state.translator) return state.translator;
  if (typeof Translator === "undefined") {
    view.translator.textContent = "利用不可";
    report("translator_unavailable", "このChromeはTranslator APIに対応していません");
    throw new Error("Translator APIに対応していません (デスクトップ版Chrome 138以降が必要です)");
  }
  const languages = { sourceLanguage: "ja", targetLanguage: "en" };
  const availability = await Translator.availability(languages);
  if (availability === "unavailable") {
    view.translator.textContent = "利用不可";
    report("translator_unavailable", "ja->enの翻訳が利用できません");
    throw new Error("この環境では日本語→英語の内蔵翻訳が利用できません");
  }
  if (availability !== "available") {
    view.translator.textContent = "ダウンロード中";
    report("translator_downloading", availability);
  }
  state.translator = await Translator.create({
    ...languages,
    monitor(monitor) {
      monitor.addEventListener("downloadprogress", (event) => {
        const percent = Math.round((event.loaded ?? 0) * 100);
        view.translator.textContent = `ダウンロード中 ${percent}%`;
        report("translator_downloading", `${percent}%`);
      });
    },
  });
  view.translator.textContent = "利用可能";
  report("translator_ready");
  return state.translator;
}

// ---- 音声認識 (Web Speech API) ----

function createRecognition() {
  const Recognition = globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition;
  if (!Recognition) throw new Error("このブラウザはWeb Speech APIに対応していません");
  const recognition = new Recognition();
  recognition.lang = "ja-JP";
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.onstart = () => {
    state.recognitionBackoffMs = 500;
    view.recognition.textContent = "聞き取り中";
    report("recognizing");
  };
  recognition.onresult = (event) => { void handleResult(event); };
  recognition.onerror = (event) => {
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      view.recognition.textContent = "マイク未許可";
      report("microphone_permission_required", event.error);
      setMessage("マイクの使用が許可されていません。アドレスバーのマイクアイコンから許可してください。", true);
      state.stopRequested = true;
      return;
    }
    if (event.error === "no-speech" || event.error === "aborted") return;
    report("error", event.error);
    setMessage(`音声認識エラー: ${event.error}`, true);
  };
  // 明示停止でなければ指数バックオフで再開する。Chromeの認識は数十秒〜数分で勝手に終わるため、
  // この再開が無いと長時間配信で字幕が黙って止まる。
  recognition.onend = () => {
    if (state.stopRequested || !state.running) { view.recognition.textContent = "停止"; report("recognition_stopped"); return; }
    view.recognition.textContent = "再開待ち";
    report("recognition_starting");
    const delay = state.recognitionBackoffMs;
    state.recognitionBackoffMs = Math.min(state.recognitionBackoffMs * 2, 10_000);
    setTimeout(() => { if (state.running && !state.stopRequested) { try { recognition.start(); } catch { /* 直後の多重start */ } } }, delay);
  };
  return recognition;
}

async function handleResult(event) {
  let interim = "";
  for (let index = event.resultIndex; index < event.results.length; index += 1) {
    const result = event.results[index];
    const transcript = result[0]?.transcript ?? "";
    if (!result.isFinal) { interim += transcript; continue; }
    // onresultごとに独立した非同期ハンドラが走るので、直列化しないと翻訳の遅い発話を
    // 後の発話が追い越してTwitchへ出てしまう。
    state.sendChain = state.sendChain.then(() => sendFinal(transcript)).catch(() => {});
  }
  // interimはこのタブ内のプレビューだけに使い、dociaiへは一切送らない (issue #282)。
  if (interim) view.recognized.textContent = interim;
}

async function sendFinal(recognized) {
  const source = recognized.trim();
  if (!source) return;
  view.recognized.textContent = source;
  const finalAt = performance.now();
  let translated = "";
  try {
    const translator = await ensureTranslator();
    translated = (await translator.translate(source)).trim();
  } catch (error) {
    // 翻訳に失敗したら日本語原文へフォールバックせず、その字幕を捨てる (issue #282)。
    setMessage(`翻訳に失敗したため字幕を破棄しました: ${error.message}`, true);
    return;
  }
  if (!translated) return;
  view.caption.textContent = translated;
  if (!state.connected || !state.socket) return;
  state.sequence += 1;
  state.socket.send(JSON.stringify({
    type: "caption",
    sequence: state.sequence,
    isFinal: true,
    recognized: source,
    text: translated,
    // 絶対時刻ではなく相対経過時間を送る — ブラウザとdociaiのwall clockがずれていても
    // 期限切れ判定 (maxAgeMs) が壊れないようにするため。
    ageMs: Math.max(0, Math.round(performance.now() - finalAt)),
  }));
  state.sentCount += 1;
  view.sent.textContent = `${state.sentCount}件`;
}

// ---- 操作 ----

async function startRecognition() {
  view.start.disabled = true;
  setMessage("");
  try {
    // 認識開始より先にTranslatorを用意する。ユーザー操作 (このクリック) の文脈が必要なため、
    // 初回のモデルダウンロードもここで始まる。
    report("recognition_starting");
    await ensureTranslator();
    state.recognition = state.recognition ?? createRecognition();
    state.running = true;
    state.stopRequested = false;
    state.recognition.start();
    view.stop.disabled = false;
  } catch (error) {
    state.running = false;
    view.start.disabled = false;
    setMessage(error.message, true);
    report("error", error.message);
  }
}

function stopRecognition(reason = "") {
  state.stopRequested = true;
  state.running = false;
  try { state.recognition?.stop(); } catch { /* 未開始 */ }
  view.start.disabled = false;
  view.stop.disabled = true;
  view.recognition.textContent = "停止";
  report("recognition_stopped");
  if (reason) setMessage(reason);
}

view.start.addEventListener("click", () => { void startRecognition(); });
view.stop.addEventListener("click", () => stopRecognition());
window.addEventListener("beforeunload", () => { state.stopRequested = true; state.socket?.close(); });

connect();
