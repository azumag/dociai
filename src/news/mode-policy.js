// ニュースmode -> pipeline方針の解決 (issue #186/#187)。
// stage実装がconfig.news.modeへ直接分岐しないよう、利用側は必ずこの解決結果 (NewsModePolicy)
// だけを参照する。値そのものは後続issueでconfig側からoverride可能にする。

const BASE_POLICIES = Object.freeze({
  topic: Object.freeze({
    mode: "topic",
    research: "article",
    targetChars: Object.freeze({ min: 200, max: 500 }),
    allowOpinion: true,
    requireMultipleViewpoints: false,
    qualityProfile: "brief",
  }),
  current: Object.freeze({
    mode: "current",
    research: "multi_source",
    targetChars: Object.freeze({ min: 800, max: 1600 }),
    allowOpinion: true,
    requireMultipleViewpoints: true,
    qualityProfile: "grounded",
  }),
  simple: Object.freeze({
    mode: "simple",
    research: "multi_source",
    targetChars: Object.freeze({ min: 300, max: 800 }),
    allowOpinion: false,
    requireMultipleViewpoints: false,
    qualityProfile: "strict_factual",
  }),
});

// 未知のmodeはtopic相当にfallbackする (ContextBuilderのNEWS_MODE_INSTRUCTIONSと同じ既定)。
export function resolveModePolicy(mode, overrides = {}) {
  const base = BASE_POLICIES[mode] ?? BASE_POLICIES.topic;
  return {
    ...base,
    ...overrides,
    targetChars: { ...base.targetChars, ...(overrides?.targetChars ?? {}) },
  };
}

export function listModePolicies() {
  return Object.values(BASE_POLICIES);
}
