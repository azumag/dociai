let sequence = 0;

export const TERMINAL_SPEECH_STATES = new Set(["done", "skipped", "cancelled", "failed", "dropped", "submitted"]);

export function createSpeechItem(input, now = Date.now()) {
  const createdAt = Number(input.createdAt ?? now);
  const priority = Number.isFinite(Number(input.priority)) ? Number(input.priority) : 0;
  const itemSequence = ++sequence;
  return {
    id: input.id ?? `s${itemSequence}`,
    sequence: itemSequence,
    source: String(input.source ?? input.personaId ?? "default"),
    commentId: input.commentId ?? null,
    personaId: input.personaId,
    personaName: input.personaName,
    text: String(input.text ?? ""),
    voice: input.voice ?? {},
    priority,
    createdAt,
    deadlineAt: input.deadlineAt == null ? null : Number(input.deadlineAt),
    state: "waiting",
    stateChangedAt: createdAt,
    error: null,
    dropReason: null,
    chunkIndex: 0,
    chunkCount: 0,
    resumeNext: Boolean(input.resumeNext),
  };
}
