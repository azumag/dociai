import { RuntimeBundle, defineComponent } from "./runtime-bundle.js";
import { createConnector } from "../connectors.js";
import { collectApiKeys } from "../security.js";
import { PersonaRouter } from "../persona-router.js";
import { SpeechQueue } from "../speech-queue.js";
import { VoiceVoxClient } from "../voicevox.js";
import { BouyomiClient } from "../bouyomi.js";
import { ScreenContext } from "../screen-capture.js";
import { MicMonitor } from "../mic-monitor.js";
import { ContextBuilder } from "../context-builder.js";
import { NewsReader } from "../news-reader.js";
import { TopicReader } from "../topic-reader.js";
import { TriggerEngine } from "../trigger-engine.js";
import { ResponseCoordinator } from "./response-coordinator.js";
import { AutomationCoordinator } from "./automation-coordinator.js";
import { SourceCoordinator } from "./source-coordinator.js";
import { TwitchChatSource, stripEmotes } from "../comment-sources.js";
import { ElectronTwitchSource, subscribeStreamEventsThroughElectron } from "../platform/electron-services.js";
import { listCaptureSources, selectCaptureSource } from "../platform/capture-adapter.js";
import { ElectronIpcTransport } from "../obs/transports/electron-ipc-transport.js";
import { CooldownTracker } from "../triggers/cooldown-tracker.js";
import { GlobalActionBudget } from "../actions/global-action-budget.js";
import { ActionRateLimiter } from "../actions/action-rate-limiter.js";
import { ActionRunner } from "../actions/action-runner.js";
import { runProductionStreamEvent } from "../simulation/stream-event-simulator.js";

const COMMENT_READER_ID = "__comment_reader__";

// Generic, DOM-free engine: turns a NormalizedConfig + platform deps into an unstarted
// RuntimeBundle. `build` never calls start() on anything it creates — that is AppRuntime's
// job, in the order components were define()'d.
export class RuntimeFactory {
  constructor(build) {
    if (typeof build !== "function") throw new Error("RuntimeFactory requires a build function");
    this.build = build;
  }

  async createCandidate({ config, generation, deps = {} }) {
    if (!Number.isInteger(generation)) throw new Error("createCandidate requires an integer generation");
    const values = {};
    const seen = new Set();
    const components = [];
    const claim = (name) => {
      if (seen.has(name)) throw new Error(`Duplicate runtime component: ${name}`);
      seen.add(name);
    };
    const define = (name, createValue, lifecycle = () => ({})) => {
      claim(name);
      const ctx = { values, deps, config, generation };
      const value = createValue(ctx);
      values[name] = value;
      components.push(defineComponent({ name, ...lifecycle(value, ctx) }));
      return value;
    };
    const expose = (name, raw) => {
      claim(name);
      values[name] = raw;
      return raw;
    };
    await this.build({ config, generation, deps, define, expose });
    return new RuntimeBundle({ generation, components, values });
  }
}

export function personaColorFor(config, personaId) {
  const index = config?.personas?.findIndex((persona) => persona.id === personaId) ?? -1;
  if (index < 0) return "hsl(0 0% 70%)";
  const hue = (index * 67 + 145) % 360;
  return `hsl(${hue} 65% 62%)`;
}

// Renderer never touches Electron/Browser globals directly except through this adapter
// (issue #99: "Browser/Electron platform adapterをbootで注入"). `globalScope` is injectable
// so tests can swap adapters without a real Electron preload bridge or browser globals.
export function selectPlatformAdapter(globalScope = globalThis) {
  const hasTwitchService = () => typeof globalScope.dociai?.twitch?.start === "function";
  const hasCaptureService = () => typeof globalScope.dociai?.capture?.listSources === "function";
  const electron = Boolean(globalScope.dociai?.obs);
  return Object.freeze({
    kind: electron ? "electron" : "browser",
    createObsTransport: () => (electron ? new ElectronIpcTransport(globalScope.dociai.obs) : new BroadcastChannel("dociai-obs")),
    hasTwitchService,
    createTwitchSource: (config, opts) => (hasTwitchService() ? new ElectronTwitchSource(config, opts) : new TwitchChatSource(config, opts)),
    // Screen capture source selection (issue #117): Electron-only, since Browser relies on
    // getDisplayMedia's native picker. Backed by src/platform/capture-adapter.js, the same
    // globalThis.dociai.capture boundary the screenContext component's getDisplayMedia() call
    // is transparently intercepted by on the Main side (session.setDisplayMediaRequestHandler).
    hasCaptureService,
    listCaptureSources,
    selectCaptureSource,
    // Issue #177: Electron-only detection, injectable via `globalScope` for tests — same shape as
    // `hasTwitchService`/`hasCaptureService` above (not the non-injectable
    // hasElectronStreamEventsService() this mirrors, which reads real globalThis directly and is
    // only used below, in subscribeStreamEvents' actual behavior, exactly like ElectronTwitchSource
    // itself already does for its own internal globalThis.dociai use). Browser mode has no
    // Main-process StreamEventBus to subscribe to at all, so eventTriggerRunner's start() below
    // simply never subscribes when this is false.
    hasStreamEventsService: () => typeof globalScope.dociai?.streamEvents?.list === "function",
    subscribeStreamEvents: (listener) => subscribeStreamEventsThroughElectron(listener),
  });
}

// Issue #177: `config.eventTriggers` (#91's map-by-id shape) -> the `EventTriggerConfig[]` array
// matchEvent()/planActions() expect (mirrors src/twitch-ui/views/simulation.js's own
// `triggersFromConfig()` — same read of the same config section, just for the production path
// instead of the operator-facing Simulation tab). A trigger-level `rule.rateLimit` (authored via
// src/twitch-ui/rules/rule-editor.js's own "rate limit" section, #95) is merged onto each of that
// trigger's actions as a DEFAULT `action.rateLimit` (an action's own explicit `rateLimit` always
// wins) — this is what makes ActionRunner's EXISTING, already-tested per-action rate-limiter
// re-check (action-runner.js's own `if (this.rateLimiter && plan.action?.rateLimit)`) actually
// engage for a rule authored with a trigger-level rate limit, with ZERO new rate-limiting logic:
// see this module's own eventTriggerRunner build-site comment for why "aggregate"/"template-only"
// overflow policies are NOT separately resolved here (action-runner.js doesn't resolve them either
// today — both this file and #93's own ActionRunner uniformly skip/drop on ANY overflow decision).
function triggersFromEventConfig(config) {
  return Object.entries(config.eventTriggers ?? {}).map(([id, rule]) => {
    const actions = Array.isArray(rule.actions)
      ? rule.actions.map((action) => (rule.rateLimit && action?.rateLimit === undefined ? { ...action, rateLimit: rule.rateLimit } : action))
      : rule.actions;
    return { ...rule, id, actions };
  });
}

// Issue #177: THE production wiring gap this issue closes — until now, matchEvent()/ActionRunner
// were only ever exercised by #96's operator-facing Simulation tab (src/twitch-ui/views/
// simulation.js's own header comment says so explicitly: "no Main-process/Renderer-wide
// ActionRunner... is wired into this app's boot sequence yet anywhere"). This function builds the
// FIRST real one, with the SAME connector/speechQueue/OBS-broadcast dependencies
// src/app/response-coordinator.js's existing comment-trigger pipeline already uses (see this
// function's call site in buildDociaiRuntime below) — never a second, parallel set of mocked deps.
//
// ARCHITECTURE DECISION (Renderer, not Main) — see this issue's own PR body for the full
// investigation: the Main process (electron/main/index.ts) owns the StreamEventBus and the EventSub
// connection, but has NO access to AIConnector/SpeechQueue/OBS broadcast at all — those are pure
// `src/*.js` objects this Renderer's own runtime-factory.js (issue #99's composition root)
// constructs fresh on every config reload, mirrored to nothing in Main. Running matchEvent/
// ActionRunner in Main would require either (a) re-implementing/duplicating AIConnector+SpeechQueue
// construction a second time in Main (a real, parallel, drift-prone copy of what this file already
// builds), or (b) proxying every AI/speech/OBS call back over IPC into the Renderer anyway — which
// is exactly what subscribing to the ALREADY-EXPOSED `dociai.streamEvents`/`dociai.events` IPC
// surface from HERE accomplishes directly, with no new IPC surface needed at all (electron/main/
// index.ts already forwards every StreamEventBus publish to the Renderer over the existing
// "stream-event" app:event channel, per #89/#96's own wiring — see electron/main/index.ts's
// `streamEventBus.subscribe(...)` calls). So: Main owns EventSub -> normalize -> bus.publish() (the
// eventsub-to-streamevent-bridge.ts piece), and THIS Renderer owns bus-push -> matcher -> cooldown/
// budget -> ActionRunner, mirroring src/twitch-ui/history/history-store.js's own "how does the
// Renderer receive StreamEvent bus pushes over IPC" prior art one level up, from display into
// triggering.
function buildEventTriggerRunner({ config, deps, generation, isCurrent, personaRouter, connectors, speechQueue }) {
  const triggers = triggersFromEventConfig(config);
  const cooldownTracker = new CooldownTracker();
  const rateLimiter = new ActionRateLimiter();
  const globalActionBudget = new GlobalActionBudget();
  const actionRunner = new ActionRunner({
    runtime: deps.runtimeController,
    globalActionBudget,
    rateLimiter,
    resolvePersona: (id) => personaRouter.get(id),
    getConnector: (id) => connectors.get(id),
    speechQueue,
    obs: { publish: (type, payload) => deps.broadcast(type, payload) },
    dispatch: (event) => deps.onEventTriggerAction?.(event),
    clock: () => Date.now(),
  });

  const state = { unsubscribe: null, lastError: null, lastEventAt: null };

  async function handle(published) {
    if (!isCurrent()) return; // stale generation — belt-and-suspenders; dispose() already
    // unsubscribes this component's own listener before a new generation's ever starts (see
    // AppRuntime#applyConfig's teardown-before-start ordering), so this mainly guards an event
    // already in flight on the event loop at the exact moment a reload lands.
    // Only ever act on production-context events, even though the current Main-process bridge
    // (eventsub-to-streamevent-bridge.ts) is the bus's only publisher today and always tags its
    // publishes "production" — this defends against a future simulation-origin publish reaching
    // the SAME Main-process bus (#96's simulation UI stays fully client-side/Renderer-only today,
    // but nothing enforces that staying true) ever triggering a REAL AI/speech/OBS action.
    if (published?.context && published.context !== "production") return;
    try {
      const result = await runProductionStreamEvent({
        event: published.event,
        triggers,
        actionRunner,
        cooldownTracker,
        cooldownConfigByTrigger: (triggerId) => triggers.find((entry) => entry.id === triggerId)?.cooldown ?? null,
        generation,
      });
      if (!isCurrent()) return; // reload landed WHILE this event was being processed
      state.lastEventAt = Date.now();
      state.lastError = null;
      deps.onEventTriggerResult?.(published, result);
    } catch (error) {
      state.lastError = error;
      deps.log(`event trigger実行に失敗: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }

  return {
    actionRunner,
    cooldownTracker,
    rateLimiter,
    globalActionBudget,
    start() {
      if (!deps.platform.hasStreamEventsService?.()) return; // Browser mode / no IPC bridge
      state.unsubscribe = deps.platform.subscribeStreamEvents((published) => { void handle(published); });
    },
    dispose() {
      state.unsubscribe?.();
      state.unsubscribe = null;
      cooldownTracker.clear();
    },
    status() {
      return { triggerCount: triggers.length, subscribed: Boolean(state.unsubscribe), lastEventAt: state.lastEventAt, lastError: state.lastError ? (state.lastError instanceof Error ? state.lastError.message : String(state.lastError)) : null };
    },
  };
}

function buildConnectors(config, deps) {
  const connectors = new Map();
  for (const [id, cfg] of Object.entries(config.connectors ?? {})) {
    try { connectors.set(id, createConnector(id, cfg, { log: deps.log })); }
    catch (error) { deps.log(`コネクタ "${id}" の初期化に失敗: ${error.message}`, "error"); }
  }
  return connectors;
}

// The concrete dociai component graph: same wiring app.js used to perform imperatively in
// applyLoaded()/teardown(), now split into create (this function) vs. start/stop/dispose
// (the lifecycle objects handed to `define`). Nothing here touches document/window/network
// directly — all of that comes in through `deps`, supplied by boot.js.
export async function buildDociaiRuntime({ config, generation, deps, define, expose }) {
  deps.onSecrets(collectApiKeys(config));
  deps.commentStore.setLimit(config.context.commentHistoryLimit);
  const isCurrent = () => deps.runtimeController.isCurrent(generation);

  const connectors = define("connectors", () => buildConnectors(config, deps));

  const personaRouter = define(
    "personaRouter",
    () => new PersonaRouter(config.personas, config.router),
    (instance) => ({ start: () => instance.onChange(() => { if (isCurrent()) deps.onPersonaChange(); }), dispose: () => instance.dispose() }),
  );

  const speechQueue = define(
    "speechQueue",
    () => new SpeechQueue({
      onUpdate: (items, queue) => deps.onSpeechUpdate(items, queue, generation),
      log: deps.log,
      voicevox: config.voicevox?.enabled
        ? new VoiceVoxClient({ baseUrl: config.voicevox.baseUrl, timeoutMs: config.voicevox.timeoutMs, retries: config.voicevox.retries, log: deps.log })
        : null,
      bouyomi: config.bouyomi?.enabled
        ? new BouyomiClient({ baseUrl: config.bouyomi.baseUrl, timeoutMs: config.bouyomi.timeoutMs, defaults: config.bouyomi })
        : null,
      policy: config.speechQueue,
      strictOrdering: config.speechQueue?.strictOrdering,
      onHealth: ({ backend, status, error }) => deps.log(`音声backend[${backend}] ${status}${error ? `: ${error}` : ""}`, status === "error" ? "warn" : "info"),
    }),
    (instance) => ({
      start: () => {
        if (config.bouyomi?.enabled) deps.log(`棒読みちゃん連携を有効化: ${config.bouyomi.baseUrl}`);
        if (config.voicevox?.enabled) {
          void instance.voicevox
            ?.speakers()
            .then((list) => { if (isCurrent()) deps.log(`VOICEVOX 接続OK: 話者${list.length}件 / ${config.voicevox.baseUrl}`); })
            .catch((error) => { if (isCurrent()) deps.log(`VOICEVOX 接続確認に失敗: ${error.message}`, "warn"); });
        }
      },
      dispose: () => instance.teardown(),
    }),
  );

  const screenContext = config.context?.screenCapture?.enabled
    ? define(
        "screenContext",
        () => new ScreenContext({ config, getConnector: (id) => connectors.get(id), log: deps.log }),
        (instance) => ({ start: () => instance.onChange(() => { if (isCurrent()) deps.onScreenChange(); }), stop: () => instance.stop() }),
      )
    : expose("screenContext", null);

  const micMonitor = config.micMonitor?.enabled
    ? define(
        "micMonitor",
        () => new MicMonitor({ config, log: deps.log }),
        (instance) => ({
          start: () => instance.onChange(() => {
            if (!isCurrent()) return;
            deps.onMicChange();
            if (instance.speaking) speechQueue.hold("mic"); else speechQueue.release("mic");
          }),
          stop: () => instance.stop(),
        }),
      )
    : expose("micMonitor", null);

  const contextBuilder = define("contextBuilder", () => new ContextBuilder({ commentStore: deps.commentStore, screenContext, config }));

  const responseCoordinator = define(
    "responseCoordinator",
    () => new ResponseCoordinator({
      runtime: deps.runtimeController,
      getGeneration: () => generation,
      getConnector: (id) => connectors.get(id),
      personaRouter,
      contextBuilder,
      speechQueue,
      publish: (type, payload) => deps.broadcast(type, { ...payload, color: payload.personaId ? personaColorFor(config, payload.personaId) : payload.color }),
      dispatch: deps.dispatch,
      onError: (error, persona) => deps.onResponseError(error, persona),
    }),
    (instance) => ({ dispose: () => instance.dispose() }),
  );

  // Issue #177: production wiring for the EventSub -> StreamEvent -> Trigger -> ActionRunner
  // pipeline — see buildEventTriggerRunner's own doc comment (above) for the Renderer-vs-Main
  // architecture decision and the trigger-level rateLimit merge. Defined unconditionally (like
  // triggerEngine below, not gated behind a config flag the way screenContext/micMonitor are) —
  // subscribing costs nothing extra when `config.eventTriggers` is empty (matchEvent() against zero
  // triggers is just "no matches", never an error), and IntegrationHealth (src/app/boot.js) needs a
  // component to query regardless of whether any rule is currently configured.
  define(
    "eventTriggerRunner",
    () => buildEventTriggerRunner({ config, deps, generation, isCurrent, personaRouter, connectors, speechQueue }),
    (instance) => ({ start: () => instance.start(), dispose: () => instance.dispose() }),
  );

  const automationCoordinator = define(
    "automationCoordinator",
    () => new AutomationCoordinator({
      runtime: deps.runtimeController,
      getGeneration: () => generation,
      onError: (kind, error) => deps.onAutomationError(kind, error),
      onComplete: (kind) => deps.onAutomationComplete(kind),
    }),
    (instance) => ({ dispose: () => instance.dispose() }),
  );

  const newsReader = define("newsReader", () => new NewsReader({
    config,
    getConnector: (id) => connectors.get(id),
    personaRouter,
    contextBuilder,
    speechQueue,
    log: deps.log,
    onRead: ({ persona, item, text, debugText }) => { if (isCurrent()) deps.onNewsRead({ persona, item, text, debugText }); },
  }));

  const topicReader = define("topicReader", () => new TopicReader({
    config,
    getConnector: (id) => connectors.get(id),
    personaRouter,
    contextBuilder,
    speechQueue,
    log: deps.log,
    onRead: ({ persona, item, text, debugText }) => { if (isCurrent()) deps.onTopicRead({ persona, item, text, debugText }); },
  }));

  const handleTrigger = expose("handleTrigger", (triggerId, options = {}) => {
    if (newsReader.enabled && config.news.trigger === triggerId) { automationCoordinator.run("news", newsReader); return []; }
    if (topicReader.enabled && config.topics.trigger === triggerId) { automationCoordinator.run("topics", topicReader); return []; }
    return responseCoordinator.handleTrigger(triggerId, options);
  });

  const triggerEngine = define(
    "triggerEngine",
    () => new TriggerEngine(config.triggers, { onFire: (...args) => { if (isCurrent()) handleTrigger(...args); }, log: deps.log }),
    (instance) => ({ start: () => instance.start(), stop: () => instance.stop() }),
  );

  const readCommentAloud = expose("readCommentAloud", (comment) => {
    const cr = config.commentReader;
    if (!cr?.enabled) return;
    if ((cr.ignoreUsers ?? []).some((user) => String(user).trim().toLowerCase() === comment.author.toLowerCase())) return;
    const body = cr.skipEmotes && comment.emotes ? stripEmotes(comment.text, comment.emotes) : comment.text;
    if (!body.trim()) return;
    const text = cr.includeAuthor === false ? body : `${comment.author}: ${body}`;
    speechQueue.enqueue({ personaId: COMMENT_READER_ID, personaName: "コメント読み上げ", text, voice: cr });
  });

  const addComment = expose("addComment", (raw) => {
    const comment = deps.commentStore.add(raw);
    deps.broadcast("comment", { author: comment.author, text: comment.text, time: Date.now() });
    readCommentAloud(comment);
    triggerEngine.handleComment(comment);
    return comment;
  });

  define(
    "sourceCoordinator",
    () => new SourceCoordinator({
      isCurrent,
      onComment: (raw) => addComment(raw),
      onStatus: (id, status) => deps.onSourceStatus(id, status),
      onError: (error) => deps.onSourceError(error),
    }),
    (instance) => ({
      start: () => {
        const twitch = config.commentSources?.twitch;
        const sourceFactories = [() => deps.manualSource];
        if (twitch?.enabled) sourceFactories.push(({ onStatus }) => deps.platform.createTwitchSource(twitch, { onStatus, log: deps.log }));
        return instance.replace(sourceFactories);
      },
      dispose: () => instance.dispose(),
    }),
  );
}

export function createDociaiRuntimeFactory() {
  return new RuntimeFactory(buildDociaiRuntime);
}
