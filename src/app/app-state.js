export function createAppState(overrides = {}) {
  return {
    config: null,
    configSource: null,
    configLoadedAt: null,
    secrets: [],
    connectors: new Map(),
    contextBuilder: null,
    triggerEngine: null,
    personaRouter: null,
    speechQueue: null,
    screenContext: null,
    micMonitor: null,
    newsReader: null,
    topicReader: null,
    manualSource: null,
    externalCommentSources: [],
    commentStore: null,
    thinking: new Set(),
    speakingPersonaId: null,
    manualSpeechHold: false,
    micBargeInEnabled: true,
    lastDebug: null,
    obs: null,
    runtime: null,
    generation: 0,
    lastTeardown: null,
    twitchStatus: null,
    systemLogs: [],
    ...overrides,
  };
}

export function appReducer(state, action) {
  switch (action.type) {
    case "set": return { ...state, [action.key]: action.value };
    case "patch": return { ...state, ...action.value };
    case "append-system-log": return { ...state, systemLogs: [...state.systemLogs, action.entry].slice(-200) };
    default: throw new Error(`Unknown AppStore action: ${action.type}`);
  }
}
