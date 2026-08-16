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
    // preserve: 自動破棄 (max-age期限切れ・キュー上限によるdrop-oldest) を一切行わない
    // 項目 (issue #277: コメント読み上げ、#285: AI応答)。ユーザーが明示的にキャンセル/
    // スキップ/全消去した場合だけが終端に遷移する。呼び出し元
    // (CommentSpeechPipeline / ResponseCoordinator / ActionRunner) が立てる。
    preserve: Boolean(input.preserve),
    // bypassMicHold: マイク発話による保留 (issue #32のhold("mic")) が効いていても、
    // この項目だけは保留を無視して再生を開始してよい (issue #286: ごく短いコメント・
    // エモートのみコメントの即時読み上げオプション)。手動停止やruntime保留は対象外 —
    // SpeechQueue側が保留理由が"mic"のみのときだけバイパスを許可する。
    bypassMicHold: Boolean(input.bypassMicHold),
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
