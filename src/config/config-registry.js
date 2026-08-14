const descriptor = (id, label, extra = {}) => Object.freeze({ id, label, ...extra });
export const CONFIG_REGISTRY = Object.freeze({
  providers: Object.freeze([descriptor("openai", "OpenAI", { secretFields: ["apiKey"] }), descriptor("openrouter", "OpenRouter", { secretFields: ["apiKey"] }), descriptor("openai-compatible", "OpenAI互換"), descriptor("ollama", "Ollama"), descriptor("minimax", "MiniMax", { secretFields: ["apiKey"] }), descriptor("mock", "Mock")]),
  triggerTypes: Object.freeze([descriptor("keyword", "キーワード"), descriptor("hotkey", "ホットキー"), descriptor("interval", "間隔"), descriptor("random", "ランダム"), descriptor("manual", "手動")]),
  // news/topicsが同じtriggerを共有しているときの挙動 (config.automation.sharedTriggerMode)。
  // triggerTypesの"random" (コメントごとの確率発火) とは無関係の別概念なので、名前を
  // automationSharedTriggerModesとして明確に分離する。
  automationSharedTriggerModes: Object.freeze([descriptor("both", "両方読み上げる"), descriptor("random-one", "ランダムに片方だけ読み上げる")]),
  voiceEngines: Object.freeze([descriptor("webspeech", "Web Speech"), descriptor("voicevox", "VOICEVOX"), descriptor("bouyomi", "棒読みちゃん")]),
  newsModes: Object.freeze([descriptor("topic", "話題"), descriptor("current", "時事"), descriptor("simple", "簡潔")]),
  newsSourceTypes: Object.freeze([descriptor("rss", "RSS"), descriptor("google-news", "Google News"), descriptor("mock", "Mock")]),
  newsArticleFetchModes: Object.freeze([descriptor("never", "取得しない"), descriptor("auto", "自動"), descriptor("required", "必須")]),
  topicSourceTypes: Object.freeze([descriptor("todoist", "Todoist", { secretFields: ["token"] })]),
  eventTypes: Object.freeze([descriptor("comment", "コメント"), descriptor("follow", "フォロー"), descriptor("subscribe", "サブスク"), descriptor("bits", "Bits"), descriptor("reward", "チャネルポイント")]),
  actionTypes: Object.freeze([descriptor("ai-response", "AI応答"), descriptor("speech", "読み上げ"), descriptor("obs", "OBS表示")]),
  translationSourceLanguages: Object.freeze([descriptor("en", "English"), descriptor("fr", "Français")]),
  translationOutputModes: Object.freeze([descriptor("translated", "日本語訳のみ"), descriptor("originalThenTranslated", "原文の後に日本語訳")]),
  translationFailurePolicies: Object.freeze([descriptor("readOriginal", "原文を読み上げる"), descriptor("skip", "読み上げない")]),
  // issue #282 (英語CC)。MVPはChrome内蔵のWeb Speech API + Translator APIだけを対象とし、
  // Whisper/LocalVocal/外部翻訳APIは候補に含めない。1要素しか無いのは将来差し替えのための
  // 拡張点ではなく、「configで別エンジンを指定しても動かない」ことを検証で明示するため。
  captionRecognitionEngines: Object.freeze([descriptor("chrome-web-speech", "Chrome音声認識")]),
  captionTranslationEngines: Object.freeze([descriptor("chrome-translator", "Chrome内蔵翻訳")]),
});
export const registryIds = (key) => CONFIG_REGISTRY[key].map((entry) => entry.id);
export const registryOptions = (key) => CONFIG_REGISTRY[key].map(({ id, label }) => Object.freeze({ value: id, label }));
