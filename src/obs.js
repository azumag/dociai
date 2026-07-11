// OBS表示モード (issue #14)
// 操作卓 (index.html) から BroadcastChannel 経由で最新コメント・AI応答・発話状態を受け取り、
// 配信画面に載せられる最小限の表示だけを行う。操作要素は置かない。
//
// 透明背景: obs.html?transparent=1 で背景を透過する (OBSブラウザソース向け)。
// 制約と運用方法は docs/obs-mode.md を参照。

const $ = (sel) => document.querySelector(sel);

if (new URLSearchParams(location.search).has("transparent")) {
  document.body.classList.add("transparent");
}

import { ObsClient } from "./obs-client/obs-client.js";
import { BroadcastChannelTransport } from "./obs/transports/broadcast-channel-transport.js";
import { ElectronIpcTransport } from "./obs/transports/electron-ipc-transport.js";

const transport = globalThis.dociai?.obs ? new ElectronIpcTransport() : new BroadcastChannelTransport();
let received = false;
const connection = $("#obs-connection");

function render(type, payload) {
  if (!received) { received = true; $("#obs-waiting").hidden = true; }
  if (type === "comment") { $("#obs-comment-author").textContent = payload.author; $("#obs-comment-text").textContent = payload.text; $("#obs-comment").hidden = false; }
  if (type === "reply") { const reply = $("#obs-reply"); reply.style.setProperty("--persona-color", payload.color ?? ""); $("#obs-reply-persona").textContent = payload.personaName; $("#obs-reply-text").textContent = payload.text; reply.hidden = false; }
  if (type === "speech") { const speaking = payload.state === "speaking"; $("#obs-speaking").hidden = !speaking; if (speaking) $("#obs-speaking-name").textContent = `ON AIR — ${payload.personaName}`; }
}

const client = new ObsClient({
  transport: {
    start(listener) { return transport.start((message) => { if (message?.protocolVersion) listener(message); else render(message?.type, message?.payload ?? {}); }); },
    send: (message) => transport.send(message), stop: () => transport.stop(),
  },
  onState(status) { connection.textContent = ({ connected: "接続済み", stale: "再接続中（表示は保持）", disconnected: "操作卓未接続", incompatible: "protocol 非互換", error: "通信エラー", waiting: "接続待機中" })[status] ?? status; connection.dataset.state = status; },
  onSnapshot(snapshot) { if (snapshot.comment) render("comment", snapshot.comment); if (snapshot.reply) render("reply", snapshot.reply); if (snapshot.speech) render("speech", snapshot.speech); },
});
client.start();
setInterval(() => { client.heartbeat(); client.tick(); }, 1_000);
