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
import { ElectronTwitchSource } from "../platform/electron-services.js";
import { listCaptureSources, selectCaptureSource } from "../platform/capture-adapter.js";
import { ElectronIpcTransport } from "../obs/transports/electron-ipc-transport.js";

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
  });
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
