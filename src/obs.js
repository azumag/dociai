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

const channel = new BroadcastChannel("dociai-obs");
let received = false;

channel.onmessage = ({ data }) => {
  if (!received) {
    received = true;
    $("#obs-waiting").hidden = true;
  }
  const { type, payload } = data ?? {};

  if (type === "comment") {
    $("#obs-comment-author").textContent = payload.author;
    $("#obs-comment-text").textContent = payload.text;
    $("#obs-comment").hidden = false;
  }

  if (type === "reply") {
    const reply = $("#obs-reply");
    reply.style.setProperty("--persona-color", payload.color ?? "");
    $("#obs-reply-persona").textContent = payload.personaName;
    $("#obs-reply-text").textContent = payload.text;
    reply.hidden = false;
  }

  if (type === "speech") {
    const speaking = payload.state === "speaking";
    $("#obs-speaking").hidden = !speaking;
    if (speaking) $("#obs-speaking-name").textContent = `ON AIR — ${payload.personaName}`;
  }
};
