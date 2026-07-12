export function bindConsoleUI(elements, actions, { setIntervalImpl = setInterval, clearIntervalImpl = clearInterval } = {}) {
  const removers = [];
  const on = (name, type, listener) => {
    const element = elements.get(name);
    element.addEventListener(type, listener);
    removers.push(() => element.removeEventListener(type, listener));
  };
  const optionalOn = (name, type, listener) => {
    try { on(name, type, listener); } catch (error) { if (!String(error?.message ?? "").startsWith("Unknown DOM element:")) throw error; }
  };
  on("loadServer", "click", () => actions.loadServer());
  on("loadFile", "click", () => elements.get("fileInput").click());
  on("fileInput", "change", (event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) actions.loadFile(file); });
  on("settings", "click", () => actions.openSettings());
  optionalOn("integrationsOpen", "click", () => actions.openIntegrations());
  optionalOn("integrationsOpenPanel", "click", () => actions.openIntegrationsPanel());
  optionalOn("screenSourceRefresh", "click", () => actions.refreshScreenSources());
  optionalOn("screenSourceSelect", "change", (event) => actions.selectScreenSource(event.target.value));
  on("commentForm", "submit", (event) => {
    event.preventDefault();
    const text = elements.get("commentText");
    if (!text.value.trim()) return;
    actions.submitComment({ author: elements.get("commentAuthor").value, text: text.value });
    text.value = "";
    text.focus();
  });
  for (const [name, action] of [["speechStop", "holdSpeech"], ["speechResume", "releaseSpeech"], ["speechSkip", "skipSpeech"], ["speechClear", "clearSpeech"], ["micStart", "startMic"], ["micStop", "stopMic"], ["screenStart", "startScreen"], ["screenStop", "stopScreen"], ["screenRead", "readScreen"], ["newsRead", "readNews"], ["topicRead", "readTopics"], ["twitchReconnect", "reconnectTwitch"]]) {
    on(name, "click", () => actions[action]());
  }
  const timer = setIntervalImpl(() => actions.refreshTimedPanels(), 2000);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const remove of removers.splice(0)) remove();
    clearIntervalImpl(timer);
  };
}
