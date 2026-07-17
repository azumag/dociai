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
    // 任意のcaller-defined metadata (issue #193: NewsSpeechMetadata等)。音声engineへは渡さず、
    // 呼び出し側がqueue上のitemを識別する (attribution表示、重複判定) ためだけに使う。
    metadata: input.metadata ?? null,
    state: "waiting",
    stateChangedAt: createdAt,
    error: null,
    dropReason: null,
    chunkIndex: 0,
    chunkCount: 0,
    resumeNext: Boolean(input.resumeNext),
  };
}
