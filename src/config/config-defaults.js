export function applyConfigDefaults(config) {
  const copy = structuredClone(config);
  copy.router = { defaultPersona: copy.personas?.[0]?.id, maxRepliesPerComment: 1, cooldownSeconds: 8, ...(copy.router ?? {}) };
  copy.context = { commentHistoryLimit: 80, includeRecentComments: 20, maxPromptChars: 4000, ...(copy.context ?? {}), screenCapture: { enabled: false, maxAgeSeconds: 120, maxTokens: 768, ...(copy.context?.screenCapture ?? {}) } };
  copy.speechQueue = { maxPending: 50, maxPendingPerSource: 20, maxAgeMs: 120000, maxHistory: 50, overflow: "drop-oldest", expireWhileHeld: true, strictOrdering: false, ...(copy.speechQueue ?? {}) };
  copy.personas = (copy.personas ?? []).map((persona) => ({ enabled: true, triggers: [], ...persona, voice: { enabled: true, engine: "webspeech", name: "default", rate: 1, pitch: 1, ...(persona.voice ?? {}) } }));
  return copy;
}
