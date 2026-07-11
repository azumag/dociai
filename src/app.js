// 操作卓のワイヤリング (issues #1, #12)
// イベントの流れ: コメント/ホットキー/interval → TriggerEngine → PersonaRouter
//   → ContextBuilder → AIConnector → AI応答ログ + SpeechQueue → OBS表示へbroadcast

import { loadFromServer, loadFromFile, saveToServer, validateConfig } from "./config-loader.js";
import { createConnector } from "./connectors.js";
import { CommentStore } from "./comment-store.js";
import { ContextBuilder } from "./context-builder.js";
import { TriggerEngine } from "./trigger-engine.js";
import { PersonaRouter } from "./persona-router.js";
import { SpeechQueue } from "./speech-queue.js";
import { VoiceVoxClient } from "./voicevox.js";
import { BouyomiClient } from "./bouyomi.js";
import { ScreenContext } from "./screen-capture.js";
import { MicMonitor } from "./mic-monitor.js";
import { NewsReader } from "./news-reader.js";
import { TopicReader } from "./topic-reader.js";
import { ManualCommentSource, TwitchChatSource, stripEmotes } from "./comment-sources.js";
import { scrubSecrets, collectApiKeys, checkSecretStorage } from "./security.js";
import { SettingsUI } from "./settings-ui.js";
import { BrowserRuntimeController } from "./runtime/runtime-controller.js";
import { isCancellation } from "./runtime/request-registry.js";
import { processConfig } from "./config/config-pipeline.js";
import { createAppState } from "./app/app-state.js";
import { AppStore } from "./app/app-store.js";
import { bindConsoleUI } from "./ui/bindings.js";
import { ElementRegistry } from "./ui/element-registry.js";
import { ConsoleView } from "./ui/console-view.js";
import { AutomationCoordinator } from "./app/automation-coordinator.js";
import { ResponseCoordinator } from "./app/response-coordinator.js";
import { SourceCoordinator } from "./app/source-coordinator.js";
import { ObsBridge } from "./obs/obs-bridge.js";

const $ = (sel) => document.querySelector(sel);

const appStore = new AppStore(createAppState({
  connectors: new Map(),
  commentStore: new CommentStore({ limit: 80 }),
  manualSource: new ManualCommentSource(),
  obs: new BroadcastChannel("dociai-obs"),
  runtime: new BrowserRuntimeController(),
}));
const state = appStore.createLegacyAdapter();
const consoleView = new ConsoleView(document);
const obsBridge = new ObsBridge({ transport: state.obs, getGeneration: () => state.generation });

const scrub = (text) => scrubSecrets(text, state.secrets);
const hhmmss = (d = new Date()) => new Date(d).toTimeString().slice(0, 8);
// 実在しないペルソナID (コメント読み上げ等) にはニュートラル色を割り当てる。
const personaHue = (id) => {
  const i = state.config?.personas.findIndex((p) => p.id === id) ?? -1;
  return i < 0 ? null : (i * 67 + 145) % 360;
};
const personaColor = (id) => {
  const hue = personaHue(id);
  return hue == null ? "hsl(0 0% 70%)" : `hsl(${hue} 65% 62%)`;
};
const COMMENT_READER_ID = "__comment_reader__";

function broadcast(type, payload) {
  obsBridge.publish(type, payload);
}

// ---- ログ ----

function logEvent(message, level = "info") {
  consoleView.appendSystemLog({ message: scrub(message), level, time: hhmmss() });
  appStore.dispatch({ type: "append-system-log", entry: { message: String(message), level, at: new Date().toISOString() } });
}

function appendReply({ persona, text = null, error = null, triggerId, newsTitle = null, topicTitle = null, contentLabel = null, contentTitle = null }) {
  const label = contentLabel ?? (newsTitle ? "news" : topicTitle ? "topic" : null);
  const title = contentTitle ?? newsTitle ?? topicTitle;
  consoleView.appendReply({ personaName: persona.name, color: personaColor(persona.id), text, error, triggerId, contentLabel: label, contentTitle: title, time: hhmmss() });
}

// ---- 応答フロー ----

function addComment(raw) {
  const comment = state.commentStore.add(raw);
  broadcast("comment", { author: comment.author, text: comment.text, time: Date.now() });
  readCommentAloud(comment);
  state.triggerEngine?.handleComment(comment);
  return comment;
}

// コメント本文をそのまま読み上げる (issue #31)。AIペルソナの応答読み上げ (respond()) とは
// 独立で、トリガー条件を問わず届いた全コメントが対象。同じ speechQueue に積むため、
// トリガーで応答が生成された場合は自然に「コメント読み上げ→AI応答」の順になる。
function readCommentAloud(comment) {
  const cr = state.config?.commentReader;
  if (!cr?.enabled || !state.speechQueue) return;
  if ((cr.ignoreUsers ?? []).some((u) => String(u).trim().toLowerCase() === comment.author.toLowerCase())) return;

  const body = cr.skipEmotes && comment.emotes ? stripEmotes(comment.text, comment.emotes) : comment.text;
  if (!body.trim()) return;
  const text = cr.includeAuthor === false ? body : `${comment.author}: ${body}`;
  state.speechQueue.enqueue({ personaId: COMMENT_READER_ID, personaName: "コメント読み上げ", text, voice: cr });
}

function handleTrigger(triggerId, { comment = null, personaId = null, manual = false } = {}) {
  if (!state.config) return;

  // ニュース/話題用トリガーはペルソナ応答ではなく専用Readerへ
  let handledByReader = false;
  if (state.newsReader?.enabled && state.config.news.trigger === triggerId) {
    runNews();
    handledByReader = true;
  }
  if (state.topicReader?.enabled && state.config.topics.trigger === triggerId) {
    runTopics();
    handledByReader = true;
  }
  if (handledByReader) return;

  state.responseCoordinator?.handleTrigger(triggerId, { comment, personaId, manual });
}

async function runNews() {
  return state.automationCoordinator?.run("news", state.newsReader);
}

async function runTopics() {
  return state.automationCoordinator?.run("topics", state.topicReader);
}

function onSpeechUpdate(items, queue, generation = state.generation) {
  if (!state.runtime.isCurrent(generation)) return;
  state.speakingPersonaId = queue.current?.personaId ?? null;
  renderSpeechQueue();
  renderTally();
  const current = queue.current;
  broadcast("speech", current
    ? { state: "speaking", personaId: current.personaId, personaName: current.personaName, color: personaColor(current.personaId), text: current.text }
    : { state: "idle" });
}

// ---- 設定読み込み ----

async function applyLoaded({ config, warnings, source, migration = null }) {
  if (state.config && settingsUI.root?.open) {
    const closeResult = await settingsUI.close("config-reload");
    if (closeResult === "continued") { logEvent("未保存の設定編集があるため再読込を保留しました", "warn"); return; }
  }
  const transition = state.runtime.beginTransition("config reload");
  teardown("config reload", transition.cancelledRequests);
  const generation = transition.generation;
  state.generation = generation;
  state.config = config;
  state.configSource = source;
  state.configLoadedAt = new Date();
  state.secrets = collectApiKeys(config);

  state.connectors = new Map();
  for (const [id, c] of Object.entries(config.connectors)) {
    try {
      state.connectors.set(id, createConnector(id, c, { log: (m) => logEvent(m) }));
    } catch (e) {
      logEvent(`コネクタ "${id}" の初期化に失敗: ${scrub(e.message)}`, "error");
    }
  }

  state.commentStore.setLimit(config.context.commentHistoryLimit);

  state.personaRouter = new PersonaRouter(config.personas, config.router);
  state.personaRouter.onChange(() => {
    if (!state.runtime.isCurrent(generation)) return;
    renderPersonas();
    renderTally();
  });

  state.speechQueue = new SpeechQueue({
    onUpdate: (items, queue) => onSpeechUpdate(items, queue, generation),
    log: (m) => logEvent(m),
    voicevox: config.voicevox?.enabled
      ? new VoiceVoxClient({
          baseUrl: config.voicevox.baseUrl,
          timeoutMs: config.voicevox.timeoutMs,
          retries: config.voicevox.retries,
          log: (m) => logEvent(m),
        })
      : null,
    bouyomi: config.bouyomi?.enabled
      ? new BouyomiClient({
          baseUrl: config.bouyomi.baseUrl,
          timeoutMs: config.bouyomi.timeoutMs,
          defaults: config.bouyomi,
        })
      : null,
    policy: config.speechQueue,
    strictOrdering: config.speechQueue?.strictOrdering,
    onHealth: ({ backend, status, error }) => logEvent(`音声backend[${backend}] ${status}${error ? `: ${error}` : ""}`, status === "error" ? "warn" : "info"),
  });
  if (config.bouyomi?.enabled) {
    logEvent(`棒読みちゃん連携を有効化: ${config.bouyomi.baseUrl}`);
  }
  if (config.voicevox?.enabled) {
    state.speechQueue.voicevox
      ?.speakers()
      .then((list) => { if (state.runtime.isCurrent(generation)) logEvent(`VOICEVOX 接続OK: 話者${list.length}件 / ${config.voicevox.baseUrl}`); })
      .catch((e) => { if (state.runtime.isCurrent(generation)) logEvent(`VOICEVOX 接続確認に失敗: ${scrub(e.message)}`, "warn"); });
  }

  state.screenContext = config.context.screenCapture.enabled
    ? new ScreenContext({ config, getConnector: (id) => state.connectors.get(id), log: (m) => logEvent(m) })
    : null;
  state.screenContext?.onChange(() => { if (state.runtime.isCurrent(generation)) renderScreenPanel(); });

  state.micMonitor = config.micMonitor?.enabled
    ? new MicMonitor({ config, log: (m) => logEvent(m) })
    : null;
  // manual/mic holdは独立reasonとして管理し、両方解除された時だけ再開する。
  state.micMonitor?.onChange(() => {
    if (!state.runtime.isCurrent(generation)) return;
    renderMicPanel();
    if (!state.speechQueue) return;
    if (state.micMonitor.speaking) {
      state.speechQueue.hold("mic");
    } else {
      state.speechQueue.release("mic");
    }
  });

  state.contextBuilder = new ContextBuilder({
    commentStore: state.commentStore,
    screenContext: state.screenContext,
    config,
  });

  state.responseCoordinator = new ResponseCoordinator({
    runtime: state.runtime,
    getGeneration: () => state.generation,
    getConnector: (id) => state.connectors.get(id),
    personaRouter: state.personaRouter,
    contextBuilder: state.contextBuilder,
    speechQueue: state.speechQueue,
    publish: (type, payload) => broadcast(type, { ...payload, color: payload.personaId ? personaColor(payload.personaId) : payload.color }),
    dispatch: (action) => {
      const { persona } = action;
      if (action.type === "response-skipped") logEvent(`「${persona.name}」はスキップ: ${action.reason} (trigger: ${action.triggerId})`);
      if (action.type === "response-started") { state.thinking.add(persona.id); renderTally(); renderPersonas(); }
      if (action.type === "response-debug") { state.lastDebug = { personaName: persona.name, debugText: action.debugText, at: new Date() }; renderDebug(); }
      if (action.type === "response-final") appendReply({ persona, text: action.text, triggerId: action.triggerId });
      if (action.type === "response-error") appendReply({ persona, error: scrub(action.error.message), triggerId: action.triggerId });
      if (action.type === "response-finished" && state.runtime.isCurrent(action.generation)) { state.thinking.delete(persona.id); renderTally(); renderPersonas(); }
    },
    onError: (error, persona) => logEvent(`「${persona?.name ?? "不明"}」応答失敗: ${scrub(error.message)}`, "error"),
  });
  state.automationCoordinator = new AutomationCoordinator({
    runtime: state.runtime,
    getGeneration: () => state.generation,
    onError: (kind, error) => logEvent(`${kind === "news" ? "ニュース" : "話題"}読み上げ失敗: ${scrub(error.message)}`, "error"),
    onComplete: (kind) => kind === "news" ? renderNewsPanel() : renderTopicPanel(),
  });

  state.newsReader = new NewsReader({
    config,
    getConnector: (id) => state.connectors.get(id),
    personaRouter: state.personaRouter,
    contextBuilder: state.contextBuilder,
    speechQueue: state.speechQueue,
    log: (m, level) => logEvent(m, level),
    onRead: ({ persona, item, text, debugText }) => {
      if (!state.runtime.isCurrent(generation)) return;
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

  state.topicReader = new TopicReader({
    config,
    getConnector: (id) => state.connectors.get(id),
    personaRouter: state.personaRouter,
    contextBuilder: state.contextBuilder,
    speechQueue: state.speechQueue,
    log: (m, level) => logEvent(m, level),
    onRead: ({ persona, item, text, debugText }) => {
      if (!state.runtime.isCurrent(generation)) return;
      state.lastDebug = { personaName: `${persona.name} (話題)`, debugText, at: new Date() };
      renderDebug();
      appendReply({ persona, text, triggerId: "topics", topicTitle: item.title });
      broadcast("reply", {
        personaId: persona.id,
        personaName: persona.name,
        color: personaColor(persona.id),
        text,
        time: Date.now(),
      });
      renderTopicPanel();
    },
  });

  state.triggerEngine = new TriggerEngine(config.triggers, {
    onFire: (...args) => { if (state.runtime.isCurrent(generation)) handleTrigger(...args); },
    log: (m) => logEvent(m),
  });
  state.triggerEngine.start();

  state.sourceCoordinator = new SourceCoordinator({
    isCurrent: () => state.runtime.isCurrent(generation),
    onComment: (raw) => addComment(raw),
    onStatus: (_id, status) => { state.twitchStatus = status; renderTwitchChatStatus(); },
    onError: (error) => logEvent(`コメントsourceを開始できません: ${scrub(error.message)}`, "error"),
  });
  const twitch = config.commentSources?.twitch;
  const sourceFactories = [() => state.manualSource];
  if (twitch?.enabled) sourceFactories.push(({ onStatus }) => new TwitchChatSource(twitch, { log: (m, level) => logEvent(m, level), onStatus }));
  state.sourceCoordinator.replace(sourceFactories).then((sources) => { if (state.runtime.isCurrent(generation)) state.externalCommentSources = sources; });

  for (const w of warnings) logEvent(`設定の警告: ${w}`, "warn");
  if (migration?.steps?.length) logEvent(`設定migrationを適用: ${migration.steps.join(" → ")}`, "warn");

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

function teardown(reason = "runtime teardown", preCancelled = 0) {
  const startedAt = Date.now();
  const cancelledRequests = preCancelled + state.runtime.requests.cancelGeneration(state.generation, reason);
  state.responseCoordinator?.dispose();
  state.automationCoordinator?.dispose();
  state.sourceCoordinator?.dispose();
  state.externalCommentSources = [];
  state.triggerEngine?.stop();
  state.screenContext?.stop();
  state.micMonitor?.stop();
  state.speechQueue?.teardown();
  state.thinking.clear();
  state.speakingPersonaId = null;
  state.manualSpeechHold = false;
  state.twitchStatus = null;
  state.lastTeardown = {
    generation: state.generation,
    reason,
    startedAt,
    finishedAt: Date.now(),
    cancelledRequests,
    activeRequests: state.runtime.requests.list(),
  };
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
  renderCommentReaderStatus();
  renderTwitchChatStatus();
  renderMicPanel();
  renderScreenPanel();
  renderNewsPanel();
  renderTopicPanel();
  renderComments();
  renderDebug();
}

function renderConfigStatus() {
  consoleView.renderConfig({ loaded: Boolean(state.config), source: state.configSource, time: state.configLoadedAt ? hhmmss(state.configLoadedAt) : null });
}

function personaState(p) {
  if (!p.enabled) return "off";
  if (state.speakingPersonaId === p.id) return "speaking";
  if (state.thinking.has(p.id)) return "thinking";
  return "ready";
}

function renderTally() {
  consoleView.renderTally((state.personaRouter?.list() ?? []).map((persona) => ({ name: persona.name, state: personaState(persona) })));
}

function renderConnectors() {
  const connectors = Object.entries(state.config?.connectors ?? {}).map(([id, cfg]) => {
    const connector = state.connectors.get(id);
    const info = connector?.describe() ?? { provider: cfg.provider, model: cfg.model, apiKeyMasked: "(初期化失敗)" };
    return { id, ...info };
  });
  consoleView.renderConnectors(connectors);
}

function renderPersonas() {
  const personas = (state.personaRouter?.list() ?? []).map((p) => {
    const cooldown = state.personaRouter.cooldownRemaining(p);
    const pState = personaState(p);
    return { ...p, state: pState, dotColor: p.enabled && pState === "ready" ? personaColor(p.id) : "", detail: `${p.connector} / triggers: ${(p.triggers ?? []).join(", ") || "なし"}${cooldown > 0 ? ` / CD ${Math.ceil(cooldown)}s` : ""}` };
  });
  consoleView.renderPersonas(personas, {
    setPersonaEnabled: (id, enabled) => { const persona = personas.find((entry) => entry.id === id); state.personaRouter.setEnabled(id, enabled); logEvent(`ペルソナ「${persona.name}」を${enabled ? "有効化" : "無効化"}しました`); },
    firePersona: (id) => handleTrigger("manual", { personaId: id, manual: true }),
  });
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
  const triggers = Object.entries(state.config?.triggers ?? {}).map(([id, t]) => {
    const users = (state.config.personas ?? []).filter((p) => (p.triggers ?? []).includes(id)).map((p) => p.name);
    const newsUses = state.config.news?.enabled && state.config.news.trigger === id;
    const topicUses = state.config.topics?.enabled && state.config.topics.trigger === id;
    const uses = [...users];
    if (newsUses) uses.push("ニュース読み上げ");
    if (topicUses) uses.push("話題読み上げ");
    return { id, type: t.type, detail: `${triggerDetail(t)} → ${uses.join(", ") || "(使用ペルソナなし)"}` };
  });
  consoleView.renderTriggers(triggers, { fireTrigger: (id) => state.triggerEngine.fire(id, { reason: "manual" }) });
}

function renderSpeechQueue() {
  const snapshot = state.speechQueue?.snapshot();
  let status = "";
  let statusClass = "chip";
  if (state.speechQueue?.paused) {
    const reasons = state.speechQueue.holdReasons;
    status = reasons.length === 1 && reasons[0] === "manual"
      ? "手動停止中"
      : reasons.length === 1 && reasons[0] === "mic"
        ? "マイク検知で保留中"
        : `保留中: ${reasons.join(" + ")}`;
    statusClass = "chip is-warn";
  } else if (state.speechQueue) {
    status = `待機 ${state.speechQueue.waitingCount()}`;
  }
  const diagnostics = snapshot ? `待機 ${snapshot.pending.length} / 最古 ${Math.round(snapshot.oldestPendingAgeMs / 1000)}秒 / drop ${snapshot.metrics.dropped} / hold ${snapshot.holdReasons.join(", ") || "なし"}${snapshot.activeExecution ? ` / 実行 ${snapshot.activeExecution.id}` : ""}${snapshot.backendWarnings.length ? ` / 警告: ${snapshot.backendWarnings.join("; ")}` : ""}${snapshot.remoteClear.status === "failed" ? ` / remote clear失敗: ${snapshot.remoteClear.error}` : ""}` : "キュー未初期化";
  consoleView.renderSpeech({ current: snapshot?.current ?? null, pending: snapshot ? [...snapshot.pending] : [], history: snapshot ? [...snapshot.history].reverse().slice(0, 8) : [], diagnostics, status, statusClass });
}

function renderCommentReaderStatus() {
  const el = $("#comment-reader-status");
  if (!el) return;
  const reader = state.config?.commentReader;
  if (!state.config) {
    el.textContent = "設定を読み込むとコメント読み上げを開始できます";
    el.className = "reader-status";
    return;
  }
  if (!reader?.enabled) {
    el.textContent = "読み上げ OFF · コメントは画面表示のみ";
    el.className = "reader-status";
    return;
  }
  const sourceNames = ["手動入力"];
  if (state.config.commentSources?.twitch?.enabled) sourceNames.push("Twitch Chat");
  el.textContent = `読み上げ ON · ${reader.engine ?? "webspeech"} · ${sourceNames.join(" + ")}`;
  el.className = "reader-status is-active";
}

function renderTwitchChatStatus() {
  const panel = $("#twitch-chat-panel");
  const el = $("#twitch-chat-status");
  const button = $("#btn-twitch-reconnect");
  if (!panel || !el || !button) return;
  const enabled = Boolean(state.config?.commentSources?.twitch?.enabled);
  panel.hidden = !enabled;
  button.disabled = !enabled;
  if (!enabled) return;
  const status = state.twitchStatus;
  if (!status) { el.textContent = "Twitch: 接続準備中"; return; }
  const channels = (status.channels ?? []).map((entry) => `#${entry.channel}:${entry.status}`).join(" / ");
  const retrySeconds = status.nextRetryAt ? Math.max(0, Math.ceil((status.nextRetryAt - Date.now()) / 1000)) : null;
  const health = status.health?.status ?? status.state;
  const message = status.health?.message ?? "";
  el.textContent = `Twitch: ${health}${channels ? ` · ${channels}` : ""}${retrySeconds !== null ? ` · ${retrySeconds}秒後に再接続` : ""}${message ? ` · ${message}` : ""}`;
}

function renderMicPanel() {
  const el = $("#mic-status");
  const fill = $("#mic-meter-fill");
  const enabled = state.config?.micMonitor?.enabled;
  $("#btn-mic-start").disabled = !enabled || state.micMonitor?.active;
  $("#btn-mic-stop").disabled = !state.micMonitor?.active;
  if (!state.config) {
    el.textContent = "設定を読み込むと使えます";
    fill.style.width = "0%";
    fill.classList.remove("is-speaking");
    return;
  }
  if (!enabled) {
    el.textContent = "設定で無効です (micMonitor.enabled: false)";
    fill.style.width = "0%";
    fill.classList.remove("is-speaking");
    return;
  }
  const s = state.micMonitor.status();
  el.textContent = `監視: ${s.active ? "中" : "停止"}` + (s.active ? ` / ${s.speaking ? "発話検知中 (AI保留)" : "無音"}` : "");
  fill.style.width = `${Math.min(100, Math.round(s.level * 250))}%`;
  fill.classList.toggle("is-speaking", s.speaking);
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

function renderTopicPanel() {
  const el = $("#topic-status");
  $("#btn-topic-read").disabled = !state.topicReader?.enabled || state.topicReader?.busy;
  if (!state.config) {
    el.textContent = "設定を読み込むと使えます";
    return;
  }
  const s = state.topicReader.status();
  if (!s.enabled) {
    el.textContent = "設定で無効です (topics.enabled: false)";
    return;
  }
  const trigger = state.config.topics.trigger ? `トリガー: ${state.config.topics.trigger}` : "トリガー未設定";
  el.textContent = `${trigger} / 既読 ${s.readCount}件` + (s.lastRunAt ? ` / 最終実行 ${hhmmss(s.lastRunAt)}` : "");
}

function renderComments() {
  consoleView.renderComments(state.commentStore.recent(50).reverse().map((comment) => ({ ...comment, time: hhmmss(comment.timestamp) })));
}

function renderDebug() {
  consoleView.renderDebug(state.lastDebug
    ? { meta: `${state.lastDebug.personaName} — ${hhmmss(state.lastDebug.at)} 時点の送信プロンプト`, text: scrub(state.lastDebug.debugText) }
    : { meta: "まだAI呼び出しはありません", text: "" });
}

// ---- 設定UI (issue #15) ----

// UI編集後の素のconfigを受け取り、config.local.json への保存を待ってから applyLoaded に渡す。
// 保存が失敗した場合は例外を投げ、呼び出し元 (SettingsUI) にエラー表示を委ねる。
// APIキーは draft に保持された実値を使う (localStorage には書かない)。
async function applyEditedConfig(rawConfig) {
  const processed = processConfig(rawConfig);
  if (!processed.ok) throw new Error(`設定pipeline失敗: ${processed.stage}`);
  const { errors, warnings } = validateConfig(processed.config);
  if (errors.length) {
    for (const e of errors) logEvent(`設定エディタ: ${scrub(e)}`, "error");
    throw new Error("設定エラーのため保存を中止しました");
  }
  await saveToServer(processed.config);
  const config = processed.config;
  await applyLoaded({ config, warnings: [...processed.notes, ...warnings], source: "UI編集 (config.local.json に保存済み)", migration: { steps: processed.migrations, secretCandidates: processed.secretCandidates, revision: processed.hash } });
}

const settingsUI = new SettingsUI({
  getCurrent: () => state.config,
  onApply: (cfg) => applyEditedConfig(cfg),
  log: (m, level) => logEvent(m, level),
});

// ---- 起動 ----

function createAppActions() {
  const report = (promise) => Promise.resolve(promise).catch(reportConfigError);
  return {
    loadServer: () => report(loadFromServer().then(applyLoaded)),
    loadFile: (file) => report(loadFromFile(file).then(applyLoaded)),
    openSettings: () => settingsUI.open(),
    submitComment: (comment) => state.manualSource.submit(comment),
    holdSpeech: () => { state.manualSpeechHold = true; state.speechQueue?.hold("manual"); },
    releaseSpeech: () => { state.manualSpeechHold = false; state.speechQueue?.release("manual"); },
    skipSpeech: () => state.speechQueue?.skip(),
    clearSpeech: () => state.speechQueue?.clear(),
    startMic: async () => { try { await state.micMonitor.start(); } catch (e) { logEvent(`マイク監視を開始できません: ${scrub(e.message)}`, "error"); } renderMicPanel(); },
    stopMic: () => { state.micMonitor?.stop(); renderMicPanel(); },
    startScreen: async () => { try { await state.screenContext.start(); } catch (e) { logEvent(`画面共有を開始できません: ${scrub(e.message)}`, "error"); } renderScreenPanel(); },
    stopScreen: () => state.screenContext?.stop(),
    readScreen: async () => {
      const screen = state.screenContext;
      const generation = state.generation;
      if (!screen) return;
      const request = state.runtime.createRequest({ generation, ownerId: `screen:${generation}`, kind: "screen-analysis" });
      try { await screen.updateContext({ ...request.context, isCurrent: () => state.runtime.isCurrent(generation) }); }
      catch (e) { if (!isCancellation(e)) logEvent(`画面の読み取りに失敗: ${scrub(e.message)}`, "error"); }
      finally { request.complete(); }
      if (state.runtime.isCurrent(generation)) renderScreenPanel();
    },
    readNews: () => { renderNewsPanel(); runNews(); },
    readTopics: () => { renderTopicPanel(); runTopics(); },
    reconnectTwitch: () => { const source = state.externalCommentSources.find((candidate) => candidate.id === "twitch"); if (source?.reconnectNow()) logEvent("Twitchチャットを手動再接続します"); renderTwitchChatStatus(); },
    refreshTimedPanels: () => { if (state.personaRouter) renderPersonas(); if (state.screenContext?.summary) renderScreenPanel(); if (state.twitchStatus?.nextRetryAt) renderTwitchChatStatus(); },
  };
}

function bindUI() {
  const elements = new ElementRegistry(document, {
    loadServer: "#btn-load-server", loadFile: "#btn-load-file", fileInput: "#file-input", settings: "#btn-settings",
    commentForm: "#comment-form", commentText: "#comment-text", commentAuthor: "#comment-author",
    speechStop: "#btn-speech-stop", speechResume: "#btn-speech-resume", speechSkip: "#btn-speech-skip", speechClear: "#btn-speech-clear",
    micStart: "#btn-mic-start", micStop: "#btn-mic-stop", screenStart: "#btn-screen-start", screenStop: "#btn-screen-stop", screenRead: "#btn-screen-read",
    newsRead: "#btn-news-read", topicRead: "#btn-topic-read", twitchReconnect: "#btn-twitch-reconnect",
  });
  return bindConsoleUI(elements, createAppActions());
}

function boot() {
  bindUI();
  state.commentStore.onChange(renderComments);
  renderAll();
  logEvent("dociai 操作卓を起動しました。設定を読み込んでください");
  // config.local.json がサーバー上にあれば自動読込を試す
  loadFromServer()
    .then(applyLoaded)
    .catch((e) => logEvent(`自動読込は見送り: ${scrub(e.message)}`, "warn"));
  addEventListener("pagehide", () => {
    teardown("window unloaded");
    obsBridge.dispose();
    state.runtime.dispose("window unloaded");
  }, { once: true });
  addEventListener("beforeunload", (event) => { if (settingsUI.dirty) event.preventDefault(); });
}

boot();
