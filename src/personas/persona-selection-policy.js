// ニュース/話題で共通利用するペルソナ選択policy (issue #244)。
// randomを注入可能にし、呼び出し側はitemのattempt開始時に1回だけ解決する。
export function resolvePersona({
  fixedPersonaId = null,
  randomEnabled = false,
  candidatePersonaIds = [],
  personaRouter,
  random = Math.random,
} = {}) {
  const fallback = () => (fixedPersonaId && personaRouter?.get?.(fixedPersonaId))
    || personaRouter?.defaultPersona?.()
    || null;

  if (!randomEnabled || !Array.isArray(candidatePersonaIds)) return fallback();

  const seen = new Set();
  const candidates = [];
  for (const rawId of candidatePersonaIds) {
    const id = String(rawId ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const persona = personaRouter?.get?.(id);
    if (persona && persona.enabled !== false) candidates.push(persona);
  }
  if (!candidates.length) return fallback();

  const sample = Number(random());
  const normalized = Number.isFinite(sample) ? Math.min(Math.max(sample, 0), 1 - Number.EPSILON) : 0;
  return candidates[Math.floor(normalized * candidates.length)];
}
