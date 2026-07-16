import { isCancellation } from "../runtime/request-registry.js";

// AppActions is the facade ui/bindings.js drives. It never keeps its own reference to a
// service instance — every call resolves the live component through appRuntime.getComponent()
// so it automatically follows whatever RuntimeBundle is currently committed, and never
// operates on a service a config reload has already disposed.
export function createAppActions({
  appRuntime,
  runtimeController,
  store,
  manualSource,
  settingsUI,
  platform = null,
  // Screen capture source select control (issue #117) needs the last list() result to resolve
  // a chosen <option> back to {id, name} — that list lives in boot.js, alongside the DOM it renders.
  getScreenSources = () => [],
  // Functions, not values: IntegrationPanel/DiagnosticExportDialog are constructed after
  // AppActions (their constructors need actions.integrationAction), so actions can only see
  // them through a getter that resolves once boot.js has finished wiring the UI shell.
  getIntegrationPanel = () => null,
  getDiagnosticExportDialog = () => null,
  // Same "constructed after AppActions, reached through a getter" shape as IntegrationPanel above
  // — TwitchOverviewApp (issue #94) is constructed after AppActions since its own onOpenSettings
  // callback wants settingsUI, which this factory already has directly (unlike IntegrationPanel it
  // needs no actions.* callback of its own, but boot.js still wires it after bindUI() for symmetry).
  getTwitchOverviewApp = () => null,
  log = () => {},
  scrub = (text) => text,
  loadServer,
  loadFile,
  applyLoadedConfig,
  reportConfigError = () => {},
  render = {},
}) {
  const component = (name) => appRuntime.getComponent(name);
  const report = (promise) => Promise.resolve(promise).catch(reportConfigError);
  const setManualSpeechHold = (value) => store.dispatch({ type: "set", key: "manualSpeechHold", value });

  return {
    loadServer: () => report(loadServer().then(applyLoadedConfig)),
    loadFile: (file) => report(loadFile(file).then(applyLoadedConfig)),
    openSettings: () => settingsUI.open(),
    submitComment: (comment) => manualSource.submit(comment),
    holdSpeech: () => { setManualSpeechHold(true); component("speechQueue")?.hold("manual"); },
    releaseSpeech: () => { setManualSpeechHold(false); component("speechQueue")?.release("manual"); },
    skipSpeech: () => component("speechQueue")?.skip(),
    clearSpeech: () => component("speechQueue")?.clear(),
    startMic: async () => {
      try { await component("micMonitor")?.start(); }
      catch (error) { log(`マイク監視を開始できません: ${scrub(error.message)}`, "error"); }
      render.mic?.();
    },
    stopMic: () => { component("micMonitor")?.stop(); render.mic?.(); },
    setMicBargeIn: (enabled) => {
      store.dispatch({ type: "set", key: "micBargeInEnabled", value: enabled });
      const micMonitor = component("micMonitor");
      const speechQueue = component("speechQueue");
      if (speechQueue && micMonitor?.active) {
        if (enabled && micMonitor.speaking) speechQueue.hold("mic");
        else if (!enabled) speechQueue.release("mic");
      }
      render.mic?.();
    },
    startScreen: async () => {
      try { await component("screenContext")?.start(); }
      catch (error) { log(`画面共有を開始できません: ${scrub(error.message)}`, "error"); }
      render.screen?.();
    },
    stopScreen: () => component("screenContext")?.stop(),
    refreshScreenSources: () => render.screenSources?.(),
    selectScreenSource: async (id) => {
      const source = getScreenSources().find((candidate) => candidate.id === id);
      if (!source || !platform) return;
      try {
        const result = await platform.selectCaptureSource({ id: source.id, name: source.name });
        if (result?.ok) log(`画面キャプチャ対象を選択: ${source.name}`);
        else log(`画面キャプチャ対象を選択できません: ${scrub(result?.error?.message ?? "unknown")}`, "warn");
      } catch (error) {
        log(`画面キャプチャ対象を選択できません: ${scrub(error.message)}`, "warn");
      }
    },
    readScreen: async () => {
      const screenContext = component("screenContext");
      const generation = appRuntime.currentGeneration();
      if (!screenContext) return;
      const request = runtimeController.createRequest({ generation, ownerId: `screen:${generation}`, kind: "screen-analysis" });
      try { await screenContext.updateContext({ ...request.context, isCurrent: () => appRuntime.isCurrent(generation) }); }
      catch (error) { if (!isCancellation(error)) log(`画面の読み取りに失敗: ${scrub(error.message)}`, "error"); }
      finally { request.complete(); }
      if (appRuntime.isCurrent(generation)) render.screen?.();
    },
    readNews: () => { render.news?.(); component("automationCoordinator")?.run("news", component("newsReader")); },
    readTopics: () => { render.topics?.(); component("automationCoordinator")?.run("topics", component("topicReader")); },
    reconnectTwitch: () => {
      const source = component("sourceCoordinator")?.sources.get("twitch");
      if (source?.reconnectNow?.()) log("Twitchチャットを手動再接続します");
      render.twitchStatus?.();
    },
    openIntegrations: () => getIntegrationPanel()?.open(),
    openIntegrationsPanel: () => getIntegrationPanel()?.open(),
    integrationAction: (action, service) => handleIntegrationAction(action, service, { appRuntime, settingsUI, getIntegrationPanel, getDiagnosticExportDialog, log }),
    openTwitchOverview: () => getTwitchOverviewApp()?.open(),
    refreshTimedPanels: () => render.timed?.(),
  };
}

export function handleIntegrationAction(action, service, { appRuntime, settingsUI, getIntegrationPanel = () => null, getDiagnosticExportDialog = () => null, log = () => {} }) {
  if (["open_settings", "reauth", "open_manager"].includes(action)) { settingsUI.open(); return; }
  if (["retry", "start_service"].includes(action) && service?.serviceId === "twitch") {
    const source = appRuntime.getComponent("sourceCoordinator")?.sources.get("twitch");
    if (source?.reconnectNow) void source.reconnectNow();
    log("Twitch連携の確認を開始しました");
    return;
  }
  if (action === "open_diagnostics") {
    getDiagnosticExportDialog()?.open(getIntegrationPanel()?.exportPayload({ build: "web" }));
    return;
  }
  log(`${service?.name ?? service?.serviceId ?? "連携"} の操作: ${action}`);
}
