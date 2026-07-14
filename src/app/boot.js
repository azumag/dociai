// 操作卓の composition root (issue #99)。DOM/networkに触れるのはこのファイルと ui/* のみで、
// ランタイムの起動・切替・停止はすべて AppRuntime のtransactionを通す。

import { loadFromServer, loadFromFile, saveToServer, validateConfig } from "../config-loader.js";
import { CommentStore } from "../comment-store.js";
import { ManualCommentSource } from "../comment-sources.js";
import { scrubSecrets, checkSecretStorage } from "../security.js";
import { SettingsUI } from "../settings-ui.js";
import { BrowserRuntimeController } from "../runtime/runtime-controller.js";
import { processConfig } from "../config/config-pipeline.js";
import { createAppState } from "./app-state.js";
import { AppStore } from "./app-store.js";
import { bindConsoleUI } from "../ui/bindings.js";
import { ElementRegistry } from "../ui/element-registry.js";
import { ConsoleView } from "../ui/console-view.js";
import { ObsBridge } from "../obs/obs-bridge.js";
import { IntegrationPanel } from "../ui/integrations/integration-panel.js";
import { DiagnosticExportDialog } from "../ui/integrations/diagnostic-export-dialog.js";
import { TwitchOverviewApp } from "../twitch-ui/views/overview.js";
import { deriveSimulationStatus } from "../twitch-ui/history/history-store.js";
import { AppRuntime } from "./app-runtime.js";
import { createDociaiRuntimeFactory, selectPlatformAdapter, personaColorFor } from "./runtime-factory.js";
import { createAppActions } from "./app-actions.js";
import { hasElectronUpdateService, checkForUpdateThroughElectron, downloadUpdateThroughElectron, quitAndInstallUpdateThroughElectron, subscribeUpdateStatusThroughElectron } from "../platform/electron-services.js";

const $ = (sel) => document.querySelector(sel);

const platform = selectPlatformAdapter();
const commentStore = new CommentStore({ limit: 80 });
const manualSource = new ManualCommentSource();
const runtimeController = new BrowserRuntimeController();

const appStore = new AppStore(createAppState({ commentStore, manualSource }));
const state = appStore.createLegacyAdapter();
const consoleView = new ConsoleView(document);

let appRuntime;
const obsBridge = new ObsBridge({ transport: platform.createObsTransport(), getGeneration: () => appRuntime.currentGeneration() });
let integrationPanel = null;
let diagnosticExportDialog = null;
let twitchOverviewApp = null;
let screenSources = [];

const scrub = (text) => scrubSecrets(text, state.secrets);
const hhmmss = (d = new Date()) => new Date(d).toTimeString().slice(0, 8);
const personaColor = (id) => personaColorFor(state.config, id);
const broadcast = (type, payload) => obsBridge.publish(type, payload);

function logEvent(message, level = "info") {
  consoleView.appendSystemLog({ message: scrub(message), level, time: hhmmss() });
  appStore.dispatch({ type: "append-system-log", entry: { message: String(message), level, at: new Date().toISOString() } });
}

function appendReply({ persona, text = null, error = null, triggerId, newsTitle = null, topicTitle = null, contentLabel = null, contentTitle = null }) {
  const label = contentLabel ?? (newsTitle ? "news" : topicTitle ? "topic" : null);
  const title = contentTitle ?? newsTitle ?? topicTitle;
  consoleView.appendReply({ personaName: persona.name, color: personaColor(persona.id), text, error, triggerId, contentLabel: label, contentTitle: title, time: hhmmss() });
}

function onSpeechUpdate(items, queue, generation) {
  if (!appRuntime.isCurrent(generation)) return;
  state.speakingPersonaId = queue.current?.personaId ?? null;
  renderSpeechQueue();
  renderTally();
  const current = queue.current;
  broadcast("speech", current
    ? { state: "speaking", personaId: current.personaId, personaName: current.personaName, color: personaColor(current.personaId), text: current.text }
    : { state: "idle" });
}

function handleResponseAction(action) {
  const { persona } = action;
  if (action.type === "response-skipped") logEvent(`「${persona.name}」はスキップ: ${action.reason} (trigger: ${action.triggerId})`);
  if (action.type === "response-started") { state.thinking.add(persona.id); renderTally(); renderPersonas(); }
  if (action.type === "response-debug") { state.lastDebug = { personaName: persona.name, debugText: action.debugText, at: new Date() }; renderDebug(); }
  if (action.type === "response-final") appendReply({ persona, text: action.text, triggerId: action.triggerId });
  if (action.type === "response-error") appendReply({ persona, error: scrub(action.error.message), triggerId: action.triggerId });
  if (action.type === "response-finished" && appRuntime.isCurrent(action.generation)) { state.thinking.delete(persona.id); renderTally(); renderPersonas(); }
}

// ---- 設定読み込み ----

async function applyLoadedConfig({ config, warnings = [], source, migration = null, guardSettingsEditor = true }) {
  if (guardSettingsEditor && state.config && settingsUI.root?.open) {
    const closeResult = await settingsUI.close("config-reload");
    if (closeResult === "continued") { logEvent("未保存の設定編集があるため再読込を保留しました", "warn"); return { ok: false, stage: "settings-open" }; }
  }
  const result = await appRuntime.applyConfig(config, { reason: `config reload: ${source}` });
  if (result.teardownReport) {
    state.thinking.clear();
    state.speakingPersonaId = null;
    state.manualSpeechHold = false;
    state.twitchStatus = null;
  }
  if (!result.ok) {
    if (result.stage === "busy") { logEvent("設定の適用は既に進行中です。しばらくしてから再試行してください", "warn"); return result; }
    if (result.stage === "create") {
      // Candidate never touched the old runtime — it is still running the previous config.
      logEvent(`設定の適用に失敗しました (現在の設定のまま継続します): ${scrub(String(result.error?.message ?? result.error))}`, "error");
    } else if (result.stage === "start") {
      logEvent(`ランタイムの切替に失敗しました: ${scrub(String(result.error?.message ?? result.error))}`, "error");
      logEvent(result.rollback?.ok ? "直前の設定に復帰しました" : "直前の設定への復帰にも失敗しました。設定を読み込み直してください", result.rollback?.ok ? "warn" : "error");
    }
    renderAll();
    return result;
  }

  state.config = config;
  state.configSource = source;
  state.configLoadedAt = new Date();
  state.lastTeardown = result.teardownReport;

  for (const w of warnings) logEvent(`設定の警告: ${w}`, "warn");
  if (migration?.steps?.length) logEvent(`設定migrationを適用: ${migration.steps.join(" → ")}`, "warn");

  const storageCheck = checkSecretStorage(config);
  logEvent(
    storageCheck.ok
      ? "APIキー残留チェック: localStorage / sessionStorage に残留なし"
      : `APIキーが永続ストレージに残っています: ${storageCheck.hits.join(", ")}`,
    storageCheck.ok ? "info" : "error",
  );

  const connectors = appRuntime.getComponent("connectors");
  logEvent(`設定を読み込みました (${source}) — コネクタ${connectors?.size ?? 0} / ペルソナ${config.personas.length} / トリガー${Object.keys(config.triggers).length}`);
  renderAll();
  return result;
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
  void renderScreenSources();
  renderNewsPanel();
  renderTopicPanel();
  renderComments();
  renderDebug();
  renderIntegrationHealth();
  renderTwitchOverviewContext();
}

function normalizeExternalHealth(status) {
  if (["healthy", "connected", "ready", "online"].includes(status)) return "ready";
  if (["checking", "connecting", "starting"].includes(status)) return "checking";
  if (["degraded", "reconnecting", "retry_wait"].includes(status)) return "degraded";
  if (["unavailable", "error", "offline", "failed"].includes(status)) return "error";
  return "unknown";
}

function integrationHealthServices() {
  const config = state.config;
  if (!config) return [{ serviceId: "config", name: "設定", category: "runtime", status: "unknown", critical: true, enabled: true }];
  const connectors = appRuntime.getComponent("connectors");
  const services = [];
  for (const serviceId of Object.keys(config.connectors ?? {})) {
    services.push({ serviceId: `connector:${serviceId}`, name: serviceId, category: "model", status: connectors?.has(serviceId) ? "unknown" : "configuration_required", critical: true, enabled: true, metrics: {}, action: connectors?.has(serviceId) ? "open_diagnostics" : "open_settings" });
  }
  const add = (serviceId, name, category, enabled, status = "unknown", extra = {}) => services.push({ serviceId, name, category, enabled, status: enabled ? status : "disabled", ...extra });
  add("voicevox", "VOICEVOX", "speech", Boolean(config.voicevox?.enabled));
  add("bouyomi", "棒読みちゃん", "speech", Boolean(config.bouyomi?.enabled));
  const twitchStatus = state.twitchStatus;
  const twitchHealth = twitchStatus?.health?.status ?? twitchStatus?.state;
  add("twitch", "Twitch Chat", "stream", Boolean(config.commentSources?.twitch?.enabled), normalizeExternalHealth(twitchHealth), { critical: true, retryAt: twitchStatus?.nextRetryAt, metrics: twitchStatus?.latencyMs == null ? {} : { latencyMs: twitchStatus.latencyMs }, action: twitchHealth === "connected" ? "open_diagnostics" : "retry" });
  add("news", "ニュース", "feed", Boolean(config.news?.enabled));
  add("topics", "話題", "feed", Boolean(config.topics?.enabled));
  add("screen", "画面キャプチャ", "context", Boolean(config.context?.screenCapture?.enabled));
  add("mic", "マイク監視", "context", Boolean(config.micMonitor?.enabled));
  add("obs", "OBS表示", "output", true, "unknown");
  // Issue #177: the production EventSub -> Trigger -> ActionRunner pipeline's own health row —
  // "IntegrationHealthへtrigger実行状態を反映する". `enabled` reflects whether at least one Event
  // Rule is actually configured (an operator with zero rules has nothing to check here); `status`
  // reflects whether the Renderer is genuinely subscribed to the Main-process StreamEventBus
  // (platform.hasStreamEventsService() — false in Browser mode, where this pipeline can never run
  // at all) and whether the most recent production event errored.
  {
    const eventTriggerRunner = appRuntime.getComponent("eventTriggerRunner");
    const eventTriggerStatus = eventTriggerRunner?.status();
    const eventTriggerCount = Object.keys(config.eventTriggers ?? {}).length;
    const status = eventTriggerStatus?.lastError ? "error" : eventTriggerStatus?.subscribed ? "ready" : "unknown";
    add("event-triggers", "Event Trigger", "stream", eventTriggerCount > 0, status, { critical: false, metrics: eventTriggerStatus ? { triggerCount: eventTriggerStatus.triggerCount, lastEventAt: eventTriggerStatus.lastEventAt } : {} });
  }
  return services;
}

function renderIntegrationHealth() {
  const services = integrationHealthServices();
  integrationPanel?.setSnapshot({ services });
  const header = $("#integration-health-header-summary");
  if (header) {
    const ready = services.filter((service) => service.status === "ready").length;
    const errors = services.filter((service) => ["error", "auth_required", "configuration_required"].includes(service.status)).length;
    header.textContent = `連携ヘルス: 正常 ${ready} / 要確認 ${errors + services.filter((service) => ["unknown", "degraded", "checking"].includes(service.status)).length}`;
  }
}

// Issue #94: the 3 preflight rows twitch-ui has no other way to observe (rule/speech/OBS are owned
// by other subsystems entirely — see components/preflight-check.js's own doc comment). `obsAvailable`
// is deliberately always `true` once a config is loaded: the OBS display page (obs.html) is a
// static, always-reachable view in this app, not something that can fail to be "available" the way
// a running service can — there is no real per-install signal to check here beyond "config loaded".
function renderTwitchOverviewContext() {
  if (!twitchOverviewApp) return;
  if (!state.config) { twitchOverviewApp.setContext({ triggerRulesConfigured: "unknown", speechAvailable: "unknown", obsAvailable: "unknown" }); return; }
  const ruleCount = Object.keys(state.config.triggers ?? {}).length + Object.keys(state.config.eventTriggers ?? {}).length;
  const speechAvailable = Boolean(state.config.voicevox?.enabled || state.config.bouyomi?.enabled || state.config.commentReader?.enabled);
  twitchOverviewApp.setContext({ triggerRulesConfigured: ruleCount > 0, speechAvailable, obsAvailable: true });
}

function renderIntegrationNotice(notification) {
  const element = $("#integration-health-notice");
  if (!element || !notification) return;
  element.hidden = false;
  if (notification.type === "recovery") element.textContent = `${notification.service.name ?? notification.service.serviceId} が復旧しました`;
  else if (notification.type === "critical") element.textContent = `重要な連携エラー: ${notification.service.name ?? notification.service.serviceId}`;
  else if (notification.type === "progress") element.textContent = `全連携を確認中: ${notification.event.completed}/${notification.event.total}`;
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
  const personaRouter = appRuntime.getComponent("personaRouter");
  consoleView.renderTally((personaRouter?.list() ?? []).map((persona) => ({ name: persona.name, state: personaState(persona) })));
}

function renderConnectors() {
  const liveConnectors = appRuntime.getComponent("connectors");
  const connectors = Object.entries(state.config?.connectors ?? {}).map(([id, cfg]) => {
    const connector = liveConnectors?.get(id);
    const info = connector?.describe() ?? { provider: cfg.provider, model: cfg.model, apiKeyMasked: "(初期化失敗)" };
    return { id, ...info };
  });
  consoleView.renderConnectors(connectors);
}

function renderPersonas() {
  const personaRouter = appRuntime.getComponent("personaRouter");
  const personas = (personaRouter?.list() ?? []).map((p) => {
    const cooldown = personaRouter.cooldownRemaining(p);
    const pState = personaState(p);
    return { ...p, state: pState, dotColor: p.enabled && pState === "ready" ? personaColor(p.id) : "", detail: `${p.connector} / triggers: ${(p.triggers ?? []).join(", ") || "なし"}${cooldown > 0 ? ` / CD ${Math.ceil(cooldown)}s` : ""}` };
  });
  consoleView.renderPersonas(personas, {
    setPersonaEnabled: (id, enabled) => { const persona = personas.find((entry) => entry.id === id); personaRouter.setEnabled(id, enabled); logEvent(`ペルソナ「${persona.name}」を${enabled ? "有効化" : "無効化"}しました`); },
    firePersona: (id) => appRuntime.getComponent("handleTrigger")?.("manual", { personaId: id, manual: true }),
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
  const triggerEngine = appRuntime.getComponent("triggerEngine");
  const triggers = Object.entries(state.config?.triggers ?? {}).map(([id, t]) => {
    const users = (state.config.personas ?? []).filter((p) => (p.triggers ?? []).includes(id)).map((p) => p.name);
    const newsUses = state.config.news?.enabled && state.config.news.trigger === id;
    const topicUses = state.config.topics?.enabled && state.config.topics.trigger === id;
    const uses = [...users];
    if (newsUses) uses.push("ニュース読み上げ");
    if (topicUses) uses.push("話題読み上げ");
    return { id, type: t.type, detail: `${triggerDetail(t)} → ${uses.join(", ") || "(使用ペルソナなし)"}`, unused: uses.length === 0 };
  });
  consoleView.renderTriggers(triggers, { fireTrigger: (id) => triggerEngine?.fire(id, { reason: "manual" }) });
}

function renderSpeechQueue() {
  const speechQueue = appRuntime.getComponent("speechQueue");
  const snapshot = speechQueue?.snapshot();
  let status = "";
  let statusClass = "chip";
  if (speechQueue?.paused) {
    const reasons = speechQueue.holdReasons;
    status = reasons.length === 1 && reasons[0] === "manual"
      ? "手動停止中"
      : reasons.length === 1 && reasons[0] === "mic"
        ? "マイク検知で保留中"
        : `保留中: ${reasons.join(" + ")}`;
    statusClass = "chip is-warn";
  } else if (speechQueue) {
    status = `待機 ${speechQueue.waitingCount()}`;
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
  renderIntegrationHealth();
}

function renderMicPanel() {
  const el = $("#mic-status");
  const fill = $("#mic-meter-fill");
  const micMonitor = appRuntime.getComponent("micMonitor");
  const enabled = state.config?.micMonitor?.enabled;
  $("#btn-mic-start").disabled = !enabled || micMonitor?.active;
  $("#btn-mic-stop").disabled = !micMonitor?.active;
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
  const s = micMonitor.status();
  el.textContent = `監視: ${s.active ? "中" : "停止"}` + (s.active ? ` / ${s.speaking ? "発話検知中 (AI保留)" : "無音"}` : "");
  fill.style.width = `${Math.min(100, Math.round(s.level * 250))}%`;
  // メーターの色ゾーン(緑/琥珀/赤)はトラック全幅を基準にした固定位置なので、fill自身の
  // background-sizeをトラックの実測幅に毎回同期させる。固定px指定だと画面幅が変わった
  // 環境(設定ウィンドウの縮小・狭い解像度等)でゾーン境界がずれ、パターンが繰り返し表示
  // されて誤った配色に見えるバグがあった。
  const track = fill.parentElement;
  if (track) fill.style.backgroundSize = `${track.clientWidth}px 100%`;
  fill.classList.toggle("is-speaking", s.speaking);
}

function renderScreenPanel() {
  const el = $("#screen-status");
  const screenContext = appRuntime.getComponent("screenContext");
  const enabled = state.config?.context.screenCapture.enabled;
  $("#btn-screen-start").disabled = !enabled || screenContext?.active;
  $("#btn-screen-stop").disabled = !screenContext?.active;
  $("#btn-screen-read").disabled = !screenContext?.active || screenContext?.updating;
  if (!state.config) {
    el.textContent = "設定を読み込むと使えます";
    return;
  }
  if (!enabled) {
    el.textContent = "設定で無効です (context.screenCapture.enabled: false)";
    return;
  }
  const s = screenContext.status();
  const parts = [`共有: ${s.active ? "中" : "停止"}`];
  if (s.updating) parts.push("読み取り中…");
  if (s.summary) {
    parts.push(`説明 (${s.ageSeconds}秒前${s.stale ? "・期限切れのため未使用" : ""}): ${s.summary}`);
  } else {
    parts.push("画面説明はまだありません");
  }
  el.textContent = parts.join(" / ");
}

// Electron専用: desktopCapturerで列挙したsource一覧をセレクタへ反映する (issue #117)。
// Browser版はgetDisplayMediaのOSピッカーに任せるため、コントロールごと非表示にする。
async function renderScreenSources() {
  const controls = $("#screen-source-controls");
  const select = $("#screen-source-select");
  const refresh = $("#btn-screen-source-refresh");
  const help = $("#screen-source-help");
  if (!controls || !select || !refresh) return;
  const available = platform.hasCaptureService();
  controls.hidden = !available;
  refresh.disabled = !available;
  if (!available) return;
  const result = await platform.listCaptureSources();
  if (!result?.ok) {
    if (help) { help.hidden = false; help.textContent = "画面ソースを取得できません。macOS は「システム設定 > プライバシーとセキュリティ > 画面収録」で dociai を許可してから再試行してください。"; }
    logEvent(`画面ソース一覧を取得できません: ${scrub(result?.error?.message ?? "unknown")}`, "warn");
    return;
  }
  screenSources = result.value ?? [];
  if (help) {
    help.hidden = screenSources.length > 0;
    help.textContent = "画面ソースがありません。macOS は「システム設定 > プライバシーとセキュリティ > 画面収録」で dociai を許可してから再試行してください。";
  }
  select.replaceChildren(new Option("メイン画面", ""));
  for (const source of screenSources) {
    const option = new Option(`${source.type === "window" ? "ウィンドウ" : "画面"}: ${source.name}`, source.id);
    option.dataset.sourceName = source.name;
    select.append(option);
  }
  const preferred = state.config?.context?.screenCapture?.sourceName ?? "";
  select.value = screenSources.find((source) => source.name === preferred)?.id ?? "";
}

function renderNewsPanel() {
  const el = $("#news-status");
  const failures = $("#news-failures");
  const newsReader = appRuntime.getComponent("newsReader");
  $("#btn-news-read").disabled = !newsReader?.enabled || newsReader?.busy;
  if (!state.config) {
    el.textContent = "設定を読み込むと使えます";
    failures.replaceChildren();
    return;
  }
  const s = newsReader.status();
  if (!s.enabled) {
    el.textContent = "設定で無効です (news.enabled: false)";
    failures.replaceChildren();
    return;
  }
  const trigger = state.config.news.trigger ? `トリガー: ${state.config.news.trigger}` : "トリガー未設定";
  el.textContent = readerLifecycleText(trigger, s);
  renderReaderFailures(failures, newsReader, s, () => { renderNewsPanel(); appRuntime.getComponent("automationCoordinator")?.run("news", appRuntime.getComponent("newsReader")); }, renderNewsPanel);
}

function renderTopicPanel() {
  const el = $("#topic-status");
  const failures = $("#topic-failures");
  const topicReader = appRuntime.getComponent("topicReader");
  $("#btn-topic-read").disabled = !topicReader?.enabled || topicReader?.busy;
  if (!state.config) {
    el.textContent = "設定を読み込むと使えます";
    failures.replaceChildren();
    return;
  }
  const s = topicReader.status();
  if (!s.enabled) {
    el.textContent = "設定で無効です (topics.enabled: false)";
    failures.replaceChildren();
    return;
  }
  const trigger = state.config.topics.trigger ? `トリガー: ${state.config.topics.trigger}` : "トリガー未設定";
  el.textContent = readerLifecycleText(trigger, s);
  renderReaderFailures(failures, topicReader, s, () => { renderTopicPanel(); appRuntime.getComponent("automationCoordinator")?.run("topics", appRuntime.getComponent("topicReader")); }, renderTopicPanel);
}

function readerLifecycleText(trigger, status) {
  const counts = status.counts ?? {};
  const parts = [
    trigger,
    `未読 ${counts.unread ?? 0}件`,
    `既読 ${counts.read ?? status.readCount ?? 0}件`,
    `再試行待ち ${counts.retry_wait ?? 0}件`,
    `要確認 ${counts.failed_permanent ?? 0}件`,
  ];
  if (counts.skipped) parts.push(`skip ${counts.skipped}件`);
  if (status.nextRetryAt) parts.push(`次回再試行 ${hhmmss(new Date(status.nextRetryAt))}`);
  if (status.lastRunAt) parts.push(`最終実行 ${hhmmss(status.lastRunAt)}`);
  return parts.join(" / ");
}

function renderReaderFailures(container, reader, status, onRetry, onChange) {
  container.replaceChildren();
  for (const record of status.failures ?? []) {
    const row = document.createElement("div");
    row.className = "reader-failure";
    const details = document.createElement("span");
    const error = record.lastError?.message ? `: ${scrub(record.lastError.message)}` : "";
    const retry = record.state === "retry_wait" && record.nextRetryAt ? ` / 次回 ${hhmmss(new Date(record.nextRetryAt))}` : "";
    details.textContent = `${record.sourceName || "source"} / ${record.title || "(無題)"} / ${record.attempts}回 / ${record.state}${retry}${error}`;
    const retryButton = document.createElement("button");
    retryButton.type = "button";
    retryButton.textContent = "再試行";
    retryButton.disabled = reader.busy;
    retryButton.addEventListener("click", () => { if (reader.retryNow(record.key)) onRetry(); });
    const skipButton = document.createElement("button");
    skipButton.type = "button";
    skipButton.textContent = "skip";
    skipButton.disabled = reader.busy;
    skipButton.addEventListener("click", () => { if (reader.skip(record.key)) onChange(); });
    row.append(details, retryButton, skipButton);
    container.append(row);
  }
}

function renderComments() {
  consoleView.renderComments(commentStore.recent(50).reverse().map((comment) => ({ ...comment, time: hhmmss(comment.timestamp) })));
}

function renderDebug() {
  consoleView.renderDebug(state.lastDebug
    ? { meta: `${state.lastDebug.personaName} — ${hhmmss(state.lastDebug.at)} 時点の送信プロンプト`, text: scrub(state.lastDebug.debugText) }
    : { meta: "まだAI呼び出しはありません", text: "" });
}

// ---- 設定UI (issue #15) ----

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
  // このパスは設定エディタ自身の保存フロー (SettingsUI#apply → onApply) から呼ばれるため、
  // applyLoadedConfig の「設定エディタが開いていたら閉じるか確認する」ガードは常に自分自身に
  // 発火してしまい、保存の途中で二重の確認ダイアログが出て保存が失敗扱いになる (settingsUI は
  // まだ閉じていない状態でここに来る)。ここでは呼び出し元自身が保存後に閉じるので不要。
  const result = await applyLoadedConfig({ config, warnings: [...processed.notes, ...warnings], source: "UI編集 (config.local.json に保存済み)", migration: { steps: processed.migrations, secretCandidates: processed.secretCandidates, revision: processed.hash }, guardSettingsEditor: false });
  if (!result.ok) throw new Error(`設定の適用に失敗しました (${result.stage})`);
}

// ---- 自動アップデート (Electron macOS版のみ。hasElectronUpdateService()が false のBrowser版/
// Windows版/未packaged実行では何もしない) ----

function renderUpdateStatus(state) {
  const badge = $("#update-status");
  const action = $("#btn-update-action");
  if (!badge || !action) return;
  const set = (text, actionLabel, onAction) => {
    badge.hidden = !text;
    badge.textContent = text ?? "";
    action.hidden = !actionLabel;
    action.textContent = actionLabel ?? "";
    action.onclick = onAction ?? null;
  };
  if (state.phase === "available") {
    set(`新バージョン v${state.version} があります`, "ダウンロード", () => { void downloadUpdateThroughElectron(); });
  } else if (state.phase === "downloading") {
    set(`アップデートをダウンロード中… ${Math.round(state.percent)}%`, null, null);
  } else if (state.phase === "downloaded") {
    set(`v${state.version} の準備ができました`, "再起動して適用", () => {
      if (!window.confirm("dociaiを再起動してアップデートを適用します。配信中の場合は放送終了後に行ってください。よろしいですか？")) return;
      quitAndInstallUpdateThroughElectron().then((result) => {
        if (result?.ok && !result.value.installing) logEvent("アップデートの適用に失敗しました。ダウンロードが完了しているか確認してください", "warn");
      });
    });
  } else if (state.phase === "error") {
    set(`アップデート確認に失敗しました: ${scrub(state.message)}`, null, null);
  } else {
    // idle/checking/not-availableはヘッダーを静かなままにする — 「確認中」を毎回出すと
    // 数時間ごとのバックグラウンドpollingがノイズになる。
    set(null, null, null);
  }
}

function setupUpdateStatus() {
  if (!hasElectronUpdateService()) return;
  renderUpdateStatus({ phase: "idle" });
  subscribeUpdateStatusThroughElectron(renderUpdateStatus);
  // The Main-process UpdateService instance (and its state) outlives any one console window/reload
  // — check()'s return value, not just the app:event push, so a downloaded-but-not-yet-installed
  // badge reappears immediately after a reload instead of only after the next state CHANGE (check()
  // itself is now a safe no-op while downloading/downloaded, so this never regresses that state).
  checkForUpdateThroughElectron().then((result) => { if (result?.ok) renderUpdateStatus(result.value); });
}

const settingsUI = new SettingsUI({
  getCurrent: () => state.config,
  onApply: (cfg) => applyEditedConfig(cfg),
  log: (m, level) => logEvent(m, level),
});

// ---- Runtime ----

appRuntime = new AppRuntime({
  runtimeController,
  factory: createDociaiRuntimeFactory(),
  startTimeoutMs: 8000,
  log: (message, level) => logEvent(message, level),
  deps: {
    runtimeController,
    commentStore,
    manualSource,
    platform,
    log: (message, level = "info") => logEvent(message, level),
    broadcast,
    dispatch: handleResponseAction,
    onSecrets: (secrets) => { state.secrets = secrets; },
    onPersonaChange: () => { renderPersonas(); renderTally(); },
    onSpeechUpdate,
    onScreenChange: () => renderScreenPanel(),
    onMicChange: () => renderMicPanel(),
    onResponseError: (error, persona) => logEvent(`「${persona?.name ?? "不明"}」応答失敗: ${scrub(error.message)}`, "error"),
    onAutomationError: (kind, error) => logEvent(`${kind === "news" ? "ニュース" : "話題"}読み上げ失敗: ${scrub(error.message)}`, "error"),
    onAutomationComplete: (kind) => (kind === "news" ? renderNewsPanel() : renderTopicPanel()),
    onNewsRead: ({ persona, item, text, debugText }) => {
      state.lastDebug = { personaName: `${persona.name} (ニュース)`, debugText, at: new Date() };
      renderDebug();
      appendReply({ persona, text, triggerId: "news", newsTitle: item.title });
      broadcast("reply", { personaId: persona.id, personaName: persona.name, color: personaColor(persona.id), text, time: Date.now() });
      renderNewsPanel();
    },
    onTopicRead: ({ persona, item, text, debugText }) => {
      state.lastDebug = { personaName: `${persona.name} (話題)`, debugText, at: new Date() };
      renderDebug();
      appendReply({ persona, text, triggerId: "topics", topicTitle: item.title });
      broadcast("reply", { personaId: persona.id, personaName: persona.name, color: personaColor(persona.id), text, time: Date.now() });
      renderTopicPanel();
    },
    onSourceStatus: (_id, status) => { state.twitchStatus = status; renderTwitchChatStatus(); },
    onSourceError: (error) => logEvent(`コメントsourceを開始できません: ${scrub(error.message)}`, "error"),
    // Issue #177: production EventSub-triggered actions (src/app/runtime-factory.js's
    // eventTriggerRunner). `onEventTriggerAction` mirrors `dispatch` (`handleResponseAction`) above
    // one layer down (ActionRunner's own `action-*` event names, never the `response-*` ones
    // handleResponseAction already switches on) — only the failure-shaped ones are logged here, so
    // an operator sees a production event-trigger error in the same system log a comment-trigger
    // error already reaches, without a second on-screen affordance for this issue's scope.
    onEventTriggerAction: (action) => {
      if (action.type === "action-error") logEvent(`event trigger action失敗 (${action.triggerId}): ${scrub(action.error?.message ?? "unknown error")}`, "error");
      if (action.type === "action-fallback") logEvent(`event trigger action fallback (${action.triggerId}): ${action.reason}`, "warn");
    },
    // `deriveSimulationStatus()`/the `EventHistoryStore` are #96's own real, already-tested pieces —
    // reused here unchanged (never re-derived) so a production event's history entry uses the exact
    // same "pending -> handled/skipped/failed" status derivation a simulation run already gets. The
    // entry is recorded here (idempotent by `(context, event.id)` — see EventHistoryStore.
    // recordProduction()'s own doc comment) rather than relying solely on EventHistoryView's own
    // lazy, tab-open-triggered subscription, so a production trigger's result is captured even if
    // the operator never opens the Event History tab.
    onEventTriggerResult: (published, result) => {
      const store = twitchOverviewApp?.historyStore;
      if (!store) return;
      const entry = store.recordProduction(published);
      if (!entry) return;
      store.updateStatus(entry.id, { status: deriveSimulationStatus(result), trace: result, promptPreviews: [] });
      renderIntegrationHealth();
    },
  },
});

// ---- 起動 ----

function bindUI() {
  const elements = new ElementRegistry(document, {
    loadServer: "#btn-load-server", loadFile: "#btn-load-file", fileInput: "#file-input", settings: "#btn-settings",
    integrationsOpen: "#btn-integrations-open", integrationsOpenPanel: "#btn-integrations-open-panel",
    twitchOverviewOpen: "#btn-twitch-overview-open",
    commentForm: "#comment-form", commentText: "#comment-text", commentAuthor: "#comment-author",
    speechStop: "#btn-speech-stop", speechResume: "#btn-speech-resume", speechSkip: "#btn-speech-skip", speechClear: "#btn-speech-clear",
    micStart: "#btn-mic-start", micStop: "#btn-mic-stop", screenStart: "#btn-screen-start", screenStop: "#btn-screen-stop", screenRead: "#btn-screen-read",
    screenSourceRefresh: "#btn-screen-source-refresh", screenSourceSelect: "#screen-source-select",
    newsRead: "#btn-news-read", topicRead: "#btn-topic-read", twitchReconnect: "#btn-twitch-reconnect",
  });
  const actions = createAppActions({
    appRuntime,
    runtimeController,
    store: appStore,
    manualSource,
    settingsUI,
    platform,
    getScreenSources: () => screenSources,
    log: (m, level) => logEvent(m, level),
    scrub,
    loadServer: loadFromServer,
    loadFile: loadFromFile,
    applyLoadedConfig,
    reportConfigError,
    // integrationPanel/diagnosticExportDialog are constructed below (their constructors need
    // actions.integrationAction), so actions can only reach them through these getters.
    getIntegrationPanel: () => integrationPanel,
    getDiagnosticExportDialog: () => diagnosticExportDialog,
    getTwitchOverviewApp: () => twitchOverviewApp,
    render: { mic: renderMicPanel, screen: renderScreenPanel, screenSources: renderScreenSources, news: renderNewsPanel, topics: renderTopicPanel, twitchStatus: renderTwitchChatStatus, timed: refreshTimedPanels },
  });
  diagnosticExportDialog = new DiagnosticExportDialog(document.querySelector("#diagnostic-export-dialog"), { document, onStatus: (status) => logEvent(`診断エクスポート: ${status}`) });
  integrationPanel = new IntegrationPanel(document.querySelector("#integration-health-dialog"), {
    document,
    summaryRoot: document.querySelector("#integration-health-summary"),
    miniRoot: document.querySelector("#integration-health-mini-list"),
    onAction: actions.integrationAction,
    onNotify: renderIntegrationNotice,
    onExport: () => diagnosticExportDialog.open(integrationPanel.exportPayload({ build: "web" })),
  });
  twitchOverviewApp = new TwitchOverviewApp(document.querySelector("#twitch-overview-dialog"), {
    document,
    onOpenSettings: () => settingsUI.open(),
    // Issue #95: the Event Rule editor's save button goes through this SAME applyEditedConfig()
    // (processConfig -> validateConfig -> saveToServer -> applyLoadedConfig) every other settings
    // section already uses — see applyEditedConfig's own call site just above for the identical
    // wiring into SettingsUI's onApply.
    getConfig: () => state.config,
    onApplyConfig: (cfg) => applyEditedConfig(cfg),
    log: (m, level) => logEvent(m, level),
  });
  renderTwitchOverviewContext();
  return bindConsoleUI(elements, actions);
}

function refreshTimedPanels() {
  if (appRuntime.getComponent("personaRouter")) renderPersonas();
  if (appRuntime.getComponent("screenContext")?.summary) renderScreenPanel();
  if (state.twitchStatus?.nextRetryAt) renderTwitchChatStatus();
}

function boot() {
  const unbindUI = bindUI();
  commentStore.onChange(renderComments);
  renderAll();
  setupUpdateStatus();
  logEvent("dociai 操作卓を起動しました。設定を読み込んでください");
  loadFromServer()
    .then(applyLoadedConfig)
    .catch((e) => logEvent(`自動読込は見送り: ${scrub(e.message)}`, "warn"));
  addEventListener("pagehide", () => {
    unbindUI();
    integrationPanel?.dispose();
    twitchOverviewApp?.dispose();
    obsBridge.dispose();
    void appRuntime.dispose("window unloaded");
  }, { once: true });
  addEventListener("beforeunload", (event) => { if (settingsUI.dirty) event.preventDefault(); });
}

boot();
