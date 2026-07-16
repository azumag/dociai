const descriptor = (id, label, extra = {}) => Object.freeze({ id, label, ...extra });
export const CONFIG_REGISTRY = Object.freeze({
  providers: Object.freeze([descriptor("openai", "OpenAI", { secretFields: ["apiKey"] }), descriptor("openrouter", "OpenRouter", { secretFields: ["apiKey"] }), descriptor("openai-compatible", "OpenAI互換"), descriptor("ollama", "Ollama"), descriptor("minimax", "MiniMax", { secretFields: ["apiKey"] }), descriptor("mock", "Mock")]),
  triggerTypes: Object.freeze([descriptor("keyword", "キーワード"), descriptor("hotkey", "ホットキー"), descriptor("interval", "間隔"), descriptor("random", "ランダム"), descriptor("manual", "手動")]),
  voiceEngines: Object.freeze([descriptor("webspeech", "Web Speech"), descriptor("voicevox", "VOICEVOX"), descriptor("bouyomi", "棒読みちゃん")]),
  newsModes: Object.freeze([descriptor("topic", "話題"), descriptor("current", "時事"), descriptor("simple", "簡潔")]),
  newsSourceTypes: Object.freeze([descriptor("rss", "RSS"), descriptor("google-news", "Google News"), descriptor("mock", "Mock")]),
  newsArticleFetchModes: Object.freeze([descriptor("never", "取得しない"), descriptor("auto", "自動"), descriptor("required", "必須")]),
  topicSourceTypes: Object.freeze([descriptor("todoist", "Todoist", { secretFields: ["token"] })]),
  eventTypes: Object.freeze([descriptor("comment", "コメント"), descriptor("follow", "フォロー"), descriptor("subscribe", "サブスク"), descriptor("bits", "Bits"), descriptor("reward", "チャネルポイント")]),
  actionTypes: Object.freeze([descriptor("ai-response", "AI応答"), descriptor("speech", "読み上げ"), descriptor("obs", "OBS表示")]),
});
export const registryIds = (key) => CONFIG_REGISTRY[key].map((entry) => entry.id);
export const registryOptions = (key) => CONFIG_REGISTRY[key].map(({ id, label }) => Object.freeze({ value: id, label }));
