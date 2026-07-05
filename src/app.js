// 操作卓のワイヤリング (issues #1, #12)
// イベントの流れ: コメント/ホットキー/interval → TriggerEngine → PersonaRouter
//   → ContextBuilder → AIConnector → AI応答ログ + SpeechQueue → OBS表示へbroadcast

import { loadFromServer, loadFromFile } from "./config-loader.js";
import { createConnector } from "./connectors.js";
import { CommentStore } from "./comment-store.js";
import { ContextBuilder } from "./context-builder.js";
import { TriggerEngine } from "./trigger-engine.js";
import { PersonaRouter } from "./persona-router.js";
import { SpeechQueue } from "./speech-queue.js";
import { VoiceVoxClient } from "./voicevox.js";
import { ScreenContext } from "./screen-capture.js";
import { NewsReader } from "./news-reader.js";
import { ManualCommentSource, TwitchChatSource } from "./comment-sources.js";
import { scrubSecrets, collectApiKeys, checkSecretStorage } from "./security.js";

const $ = (sel) => document.querySelector(sel);

const state = {
  config: null,
  configSource: null,
  configLoadedAt: null,
  secrets: [],
  connectors: new Map(),
  commentStore: new CommentStore({ limit: 80 }),
  contextBuilder: null,
  triggerEngine: null,
  personaRouter: null,
  speechQueue: null,
  screenContext: null,
  newsReader: null,
  manualSource: new ManualCommentSource(),
  externalCommentSources: [],
  thinking: new Set(),
  speakingPersonaId: null,
  lastDebug: null,
  obs: new BroadcastChannel("dociai-obs"),
};

const scrub = (text) => scrubSecrets(text, state.secrets);
const hhmmss = (d = new Date()) => new Date(d).toTimeString().slice(0, 8);
const personaHue = (id) => {
  const i = state.config?.personas.findIndex((p) => p.id === id) ?? 0;
  return (Math.max(i, 0) * 67 + 145) % 360;
};
const personaColor = (id) => `hsl(${personaHue(id)} 65% 62%)`;

function broadcast(type, payload) {
  try {
    state.obs.postMessage({ type, payload });
  } catch {
    // OBS表示が閉じていても操作卓は動き続ける
  }
}

// ---- ログ ----

function logEvent(message, level = "info") {
  const li = document.createElement("li");
  if (level === "error") li.className = "is-error";
  if (level === "warn") li.className = "is-warn";
  li.innerHTML = `<span class="time">${hhmmss()}</span>`;
  li.append(scrub(message));
  const log = $("#event-log");
  log.prepend(li);
  while (log.children.length > 200) log.lastChild.remove();
}

function appendReply({ persona, text = null, error = null, triggerId, newsTitle = null }) {
  const li = document.createElement("li");
  li.className = `reply-item${error ? " is-error" : ""}`;
  li.style.setProperty("--persona-color", personaColor(persona.id));
  const head = document.createElement("div");
  head.className = "reply-head";
  head.innerHTML = `<span class="persona-name"></span><span class="time">${hhmmss()}</span><span>trigger: ${triggerId}</span>`;
  head.querySelector(".persona-name").textContent = persona.name;
  if (newsTitle) {
    const n = document.createElement("span");
    n.textContent = `news: ${newsTitle.slice(0, 24)}`;
    head.append(n);
  }
  const body = document.createElement("div");
  body.className = "reply-text";
  body.textContent = error ? `応答失敗: ${error}` : text;
  li.append(head, body);
  const log = $("#reply-log");
  log.prepend(li);
  while (log.children.length > 100) log.lastChild.remove();
}

// ---- 応答フロー ----

function addComment(raw) {
  const comment = state.commentStore.add(raw);
  broadcast("comment", { author: comment.author, text: comment.text, time: Date.now() });
  state.triggerEngine?.handleComment(comment);
  return comment;
}

function handleTrigger(triggerId, { comment = null, personaId = null, manual = false } = {}) {
  if (!state.config) return;

  // ニュース用トリガーはペルソナ応答ではなくNewsReaderへ
  if (state.newsReader?.enabled && state.config.news.trigger === triggerId) {
    runNews();
    return;
  }

  const { selected, skipped } = state.personaRouter.select(triggerId, {
    comment,
    personaId,
    ignoreCooldown: manual,
  });
  for (const s of skipped) {
    logEvent(`「${s.persona.name}」はスキップ: ${s.reason} (trigger: ${triggerId})`);
  }
  for (const persona of selected) {
    respond(persona, { comment, triggerId });
  }
}

async function respond(persona, { comment = null, triggerId = "manual", task = null }) {
  const connector = state.connectors.get(persona.connector);
  if (!connector) {
    logEvent(`「${persona.name}」のコネクタ "${persona.connector}" が初期化されていません`, "error");
    return;
  }
  // 二重応答防止のため呼び出し前に記録する
  state.personaRouter.recordReply(persona, comment);
  state.thinking.add(persona.id);
  renderTally();
  renderPersonas();

  const { messages, debugText } = state.contextBuilder.build({ persona, comment, task });
  state.lastDebug = { personaName: persona.name, debugText, at: new Date() };
  renderDebug();

  try {
    const { text } = await connector.chat(messages);
    appendReply({ persona, text, triggerId });
    broadcast("reply", {
      personaId: persona.id,
      personaName: persona.name,
      color: personaColor(persona.id),
      text,
      time: Date.now(),
    });
    state.speechQueue.enqueue({ personaId: persona.id, personaName: persona.name, text, voice: persona.voice });
  } catch (e) {
    const msg = scrub(e.message);
    logEvent(`「${persona.name}」応答失敗: ${msg}`, "error");
    appendReply({ persona, error: msg, triggerId });
  } finally {
    state.thinking.delete(persona.id);
    renderTally();
    renderPersonas();
  }
}

async function runNews() {
  if (!state.newsReader) return;
  try {
    await state.newsReader.run();
  } catch (e) {
    logEvent(`ニュース読み上げ失敗: ${scrub(e.message)}`, "error");
  }
  renderNewsPanel();
}

function onSpeechUpdate(items, queue) {
  state.speakingPersonaId = queue.current?.personaId ?? null;
  renderSpeechQueue();
  renderTally();
  const current = queue.current;
  broadcast("speech", current
    ? { state: "speaking", personaId: current.personaId, personaName: current.personaName, color: personaColor(current.personaId), text: current.text }
    : { state: "idle" });
}

// ---- 設定読み込み ----

async function applyLoaded({ config, warnings, source }) {
  teardown();
  state.config = config;
  state.configSource = source;
  state.configLoadedAt = new Date();
  state.secrets = collectApiKeys(config);

  state.connectors = new Map();
  for (const [id, c] of Object.entries(config.connectors)) {
    try {
      state.connectors.set(id, createConnector(id, c));
    } catch (e) {
      logEvent(`コネクタ "${id}" の初期化に失敗: ${scrub(e.message)}`, "error");
    }
  }

  state.commentStore.setLimit(config.context.commentHistoryLimit);

  state.personaRouter = new PersonaRouter(config.personas, config.router);
  state.personaRouter.onChange(() => {
    renderPersonas();
    renderTally();
  });

  state.speechQueue = new SpeechQueue({
    onUpdate: onSpeechUpdate,
    log: (m) => logEvent(m),
    voicevox: config.voicevox?.enabled
      ? new VoiceVoxClient({
          baseUrl: config.voicevox.baseUrl,
          timeoutMs: config.voicevox.timeoutMs,
          log: (m) => logEvent(m),
        })
      : null,
  });
  if (config.voicevox?.enabled) {
    state.speechQueue.voicevox
      ?.speakers()
      .then((list) => logEvent(`VOICEVOX 接続OK: 話者${list.length}件 / ${config.voicevox.baseUrl}`))
      .catch((e) => logEvent(`VOICEVOX 接続確認に失敗: ${scrub(e.message)}`, "warn"));
  }

  state.screenContext = config.context.screenCapture.enabled
    ? new ScreenContext({ config, getConnector: (id) => state.connectors.get(id), log: (m) => logEvent(m) })
    : null;
  state.screenContext?.onChange(renderScreenPanel);

  state.contextBuilder = new ContextBuilder({
    commentStore: state.commentStore,
    screenContext: state.screenContext,
    config,
  });

  state.newsReader = new NewsReader({
    config,
    getConnector: (id) => state.connectors.get(id),
    personaRouter: state.personaRouter,
    contextBuilder: state.contextBuilder,
    speechQueue: state.speechQueue,
    log: (m, level) => logEvent(m, level),
    onRead: ({ persona, item, text, debugText }) => {
      state.lastDebug = { personaName: `${persona.name} (ニュース)`, debugText, at: new Date() };
      renderDebug();
      appendReply({ persona, text, triggerId: "news", newsTitle: item.title });
      broadcast("reply", {
        personaId: persona.id,
        personaName: persona.name,
        color: personaColor(persona.id),
        text,
        time: Date.now(),
      });
      renderNewsPanel();
    },
  });

  state.triggerEngine = new TriggerEngine(config.triggers, {
    onFire: handleTrigger,
    log: (m) => logEvent(m),
  });
  state.triggerEngine.start();

  startExternalCommentSources(config);

  for (const w of warnings) logEvent(`設定の警告: ${w}`, "warn");

  // issue #13: APIキーが永続ストレージに残っていないことを実測して報告
  const storageCheck = checkSecretStorage(config);
  logEvent(
    storageCheck.ok
      ? "APIキー残留チェック: localStorage / sessionStorage に残留なし"
      : `APIキーが永続ストレージに残っています: ${storageCheck.hits.join(", ")}`,
    storageCheck.ok ? "info" : "error",
  );

  logEvent(`設定を読み込みました (${source}) — コネクタ${state.connectors.size} / ペルソナ${config.personas.length} / トリガー${Object.keys(config.triggers).length}`);
  renderAll();
}

function teardown() {
  for (const source of state.externalCommentSources) source.stop();
  state.externalCommentSources = [];
  state.triggerEngine?.stop();
  state.screenContext?.stop();
  state.speechQueue?.clear();
  state.thinking.clear();
  state.speakingPersonaId = null;
}

function startExternalCommentSources(config) {
  const twitch = config.commentSources?.twitch;
  if (!twitch?.enabled) return;

  try {
    const source = new TwitchChatSource(twitch, { log: (m, level) => logEvent(m, level) });
    source.start((raw) => addComment(raw));
    state.externalCommentSources.push(source);
  } catch (e) {
    logEvent(`Twitchチャットを開始できません: ${scrub(e.message)}`, "error");
  }
}

function reportConfigError(e) {
  const details = e.validationErrors ?? [];
  logEvent(`設定の読み込みに失敗: ${scrub(e.message)}`, "error");
  for (const d of details) logEvent(`- ${scrub(d)}`, "error");
  renderConfigStatus();
}

// ---- 描画 ----

function renderAll() {
  renderConfigStatus();
  renderTally();
  renderConnectors();
  renderPersonas();
  renderTriggers();
  renderSpeechQueue();
  renderScreenPanel();
  renderNewsPanel();
  renderComments();
  renderDebug();
}

function renderConfigStatus() {
  const el = $("#config-status");
  if (!state.config) {
    el.textContent = "設定: 未読込";
    el.className = "chip is-warn";
    return;
  }
  el.textContent = `設定: 読込済 (${state.configSource} ${hhmmss(state.configLoadedAt)})`;
  el.className = "chip is-ok";
}

function personaState(p) {
  if (!p.enabled) return "off";
  if (state.speakingPersonaId === p.id) return "speaking";
  if (state.thinking.has(p.id)) return "thinking";
  return "ready";
}

function renderTally() {
  const tally = $("#tally");
  tally.replaceChildren();
  for (const p of state.personaRouter?.list() ?? []) {
    const s = personaState(p);
    const lamp = document.createElement("span");
    lamp.className = `tally-lamp is-${s}`;
    lamp.title = { off: "無効", ready: "待機", thinking: "思考中", speaking: "発話中" }[s];
    const dot = document.createElement("span");
    dot.className = "dot";
    lamp.append(dot, p.name);
    tally.append(lamp);
  }
}

function renderConnectors() {
  const ul = $("#connector-list");
  ul.replaceChildren();
  for (const [id, cfg] of Object.entries(state.config?.connectors ?? {})) {
    const connector = state.connectors.get(id);
    const li = document.createElement("li");
    const info = connector?.describe() ?? { provider: cfg.provider, model: cfg.model, apiKeyMasked: "(初期化失敗)" };
    li.innerHTML = `<div class="grow"><div class="name"></div><div class="detail"></div></div>`;
    li.querySelector(".name").textContent = id;
    li.querySelector(".detail").textContent = `${info.provider} / ${info.model} / key: ${info.apiKeyMasked}`;
    ul.append(li);
  }
  if (!ul.children.length) ul.innerHTML = `<li class="detail">設定を読み込むと表示されます</li>`;
}

function renderPersonas() {
  const ul = $("#persona-list");
  ul.replaceChildren();
  for (const p of state.personaRouter?.list() ?? []) {
    const li = document.createElement("li");
    const dot = document.createElement("span");
    dot.className = `persona-dot is-${personaState(p)}`;
    dot.style.background = p.enabled && personaState(p) === "ready" ? personaColor(p.id) : "";

    const grow = document.createElement("div");
    grow.className = "grow";
    const cooldown = state.personaRouter.cooldownRemaining(p);
    grow.innerHTML = `<div class="name"></div><div class="detail"></div>`;
    grow.querySelector(".name").textContent = p.name;
    grow.querySelector(".detail").textContent =
      `${p.connector} / triggers: ${(p.triggers ?? []).join(", ") || "なし"}` +
      (cooldown > 0 ? ` / CD ${Math.ceil(cooldown)}s` : "");

    const switchLabel = document.createElement("label");
    switchLabel.className = "switch";
    switchLabel.title = "ペルソナのON/OFF";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = p.enabled;
    checkbox.addEventListener("change", () => {
      state.personaRouter.setEnabled(p.id, checkbox.checked);
      logEvent(`ペルソナ「${p.name}」を${checkbox.checked ? "有効化" : "無効化"}しました`);
    });
    const track = document.createElement("span");
    track.className = "track";
    switchLabel.append(checkbox, track);

    const fire = document.createElement("button");
    fire.type = "button";
    fire.textContent = "発話";
    fire.title = "このペルソナを手動で発話させる";
    fire.addEventListener("click", () => {
      handleTrigger("manual", { personaId: p.id, manual: true });
    });

    li.append(dot, grow, switchLabel, fire);
    ul.append(li);
  }
  if (!ul.children.length) ul.innerHTML = `<li class="detail">設定を読み込むと表示されます</li>`;
}

function triggerDetail(t) {
  switch (t.type) {
    case "keyword": return `keywords: ${(t.keywords ?? []).join(" / ")}`;
    case "hotkey": return `keys: ${t.keys}`;
    case "interval": return `${t.minutes ? `${t.minutes}分` : ""}${t.seconds ? `${t.seconds}秒` : ""}ごと`;
    case "random": return `確率 ${Math.round((t.probability ?? 0) * 100)}%`;
    default: return t.type;
  }
}

function renderTriggers() {
  const ul = $("#trigger-list");
  ul.replaceChildren();
  for (const [id, t] of Object.entries(state.config?.triggers ?? {})) {
    const li = document.createElement("li");
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = t.type;
    const grow = document.createElement("div");
    grow.className = "grow";
    grow.innerHTML = `<div class="name"></div><div class="detail"></div>`;
    grow.querySelector(".name").textContent = id;
    const users = (state.config.personas ?? []).filter((p) => (p.triggers ?? []).includes(id)).map((p) => p.name);
    const newsUses = state.config.news?.enabled && state.config.news.trigger === id;
    grow.querySelector(".detail").textContent =
      `${triggerDetail(t)} → ${newsUses ? "ニュース読み上げ" : users.join(", ") || "(使用ペルソナなし)"}`;
    const fire = document.createElement("button");
    fire.type = "button";
    fire.textContent = "発火";
    fire.addEventListener("click", () => state.triggerEngine.fire(id, { reason: "manual" }));
    li.append(badge, grow, fire);
    ul.append(li);
  }
  if (!ul.children.length) ul.innerHTML = `<li class="detail">設定を読み込むと表示されます</li>`;
}

function renderSpeechQueue() {
  const ul = $("#speech-list");
  ul.replaceChildren();
  const items = state.speechQueue?.items ?? [];
  for (const item of [...items].reverse().slice(0, 8)) {
    const li = document.createElement("li");
    const badge = document.createElement("span");
    badge.className = `badge state-${item.state}`;
    badge.textContent = { waiting: "待機", speaking: "発話中", done: "完了", skipped: "スキップ", failed: "失敗" }[item.state];
    const grow = document.createElement("div");
    grow.className = "grow";
    grow.innerHTML = `<div class="detail"></div>`;
    grow.querySelector(".detail").textContent = `${item.personaName}: ${item.text.slice(0, 60)}${item.error ? ` (${item.error})` : ""}`;
    li.append(badge, grow);
    ul.append(li);
  }
  if (!items.length) ul.innerHTML = `<li class="detail">キューは空です</li>`;

  const chip = $("#speech-state");
  if (!state.speechQueue) {
    chip.textContent = "";
  } else if (state.speechQueue.paused) {
    chip.textContent = "停止中";
    chip.className = "chip is-warn";
  } else {
    chip.textContent = `待機 ${state.speechQueue.waitingCount()}`;
    chip.className = "chip";
  }
}

function renderScreenPanel() {
  const el = $("#screen-status");
  const enabled = state.config?.context.screenCapture.enabled;
  $("#btn-screen-start").disabled = !enabled || state.screenContext?.active;
  $("#btn-screen-stop").disabled = !state.screenContext?.active;
  $("#btn-screen-read").disabled = !state.screenContext?.active || state.screenContext?.updating;
  if (!state.config) {
    el.textContent = "設定を読み込むと使えます";
    return;
  }
  if (!enabled) {
    el.textContent = "設定で無効です (context.screenCapture.enabled: false)";
    return;
  }
  const s = state.screenContext.status();
  const parts = [`共有: ${s.active ? "中" : "停止"}`];
  if (s.updating) parts.push("読み取り中…");
  if (s.summary) {
    parts.push(`説明 (${s.ageSeconds}秒前${s.stale ? "・期限切れのため未使用" : ""}): ${s.summary}`);
  } else {
    parts.push("画面説明はまだありません");
  }
  el.textContent = parts.join(" / ");
}

function renderNewsPanel() {
  const el = $("#news-status");
  $("#btn-news-read").disabled = !state.newsReader?.enabled || state.newsReader?.busy;
  if (!state.config) {
    el.textContent = "設定を読み込むと使えます";
    return;
  }
  const s = state.newsReader.status();
  if (!s.enabled) {
    el.textContent = "設定で無効です (news.enabled: false)";
    return;
  }
  const trigger = state.config.news.trigger ? `トリガー: ${state.config.news.trigger}` : "トリガー未設定";
  el.textContent = `${trigger} / 既読 ${s.readCount}件` + (s.lastRunAt ? ` / 最終実行 ${hhmmss(s.lastRunAt)}` : "");
}

function renderComments() {
  const ol = $("#comment-log");
  ol.replaceChildren();
  for (const c of state.commentStore.recent(50).reverse()) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="time">${hhmmss(c.timestamp)}</span><span class="author"></span>`;
    li.querySelector(".author").textContent = c.author;
    li.append(c.text);
    ol.append(li);
  }
}

function renderDebug() {
  const meta = $("#debug-meta");
  const pre = $("#debug-prompt");
  if (!state.lastDebug) {
    meta.textContent = "まだAI呼び出しはありません";
    pre.textContent = "";
    return;
  }
  meta.textContent = `${state.lastDebug.personaName} — ${hhmmss(state.lastDebug.at)} 時点の送信プロンプト`;
  pre.textContent = scrub(state.lastDebug.debugText);
}

// ---- 起動 ----

function bindUI() {
  $("#btn-load-server").addEventListener("click", async () => {
    try {
      applyLoaded(await loadFromServer());
    } catch (e) {
      reportConfigError(e);
    }
  });

  $("#btn-load-file").addEventListener("click", () => $("#file-input").click());
  $("#file-input").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      applyLoaded(await loadFromFile(file));
    } catch (err) {
      reportConfigError(err);
    }
  });

  $("#comment-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $("#comment-text").value;
    if (!text.trim()) return;
    state.manualSource.submit({ author: $("#comment-author").value, text });
    $("#comment-text").value = "";
    $("#comment-text").focus();
  });

  $("#btn-speech-stop").addEventListener("click", () => state.speechQueue?.stop());
  $("#btn-speech-resume").addEventListener("click", () => state.speechQueue?.resume());
  $("#btn-speech-skip").addEventListener("click", () => state.speechQueue?.skip());
  $("#btn-speech-clear").addEventListener("click", () => state.speechQueue?.clear());

  $("#btn-screen-start").addEventListener("click", async () => {
    try {
      await state.screenContext.start();
    } catch (e) {
      logEvent(`画面共有を開始できません: ${scrub(e.message)}`, "error");
    }
    renderScreenPanel();
  });
  $("#btn-screen-stop").addEventListener("click", () => state.screenContext?.stop());
  $("#btn-screen-read").addEventListener("click", async () => {
    try {
      await state.screenContext.updateContext();
    } catch (e) {
      logEvent(`画面の読み取りに失敗: ${scrub(e.message)}`, "error");
    }
    renderScreenPanel();
  });

  $("#btn-news-read").addEventListener("click", () => {
    renderNewsPanel();
    runNews();
  });

  // クールダウン残り秒の表示だけを定期更新する
  setInterval(() => {
    if (state.personaRouter) renderPersonas();
    if (state.screenContext?.summary) renderScreenPanel();
  }, 2000);
}

function boot() {
  bindUI();
  state.manualSource.start((raw) => addComment(raw));
  state.commentStore.onChange(renderComments);
  renderAll();
  logEvent("dociai 操作卓を起動しました。設定を読み込んでください");
  // config.local.json がサーバー上にあれば自動読込を試す
  loadFromServer()
    .then(applyLoaded)
    .catch((e) => logEvent(`自動読込は見送り: ${scrub(e.message)}`, "warn"));
}

boot();
