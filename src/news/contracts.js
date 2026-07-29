// ニュースpipeline共通契約 (issue #187)
// NewsPipelineCoordinatorとstage実装はここに定義した形だけを介してやり取りする。
// 契約は src/news/ のpure moduleを正典とし、Electron shared DTOはserialization境界に限定する
// (issue #186「Domain契約（正典）」)。

import { RequestCancelledError, isCancellation } from "../runtime/request-registry.js";

export const PIPELINE_STAGE_IDS = Object.freeze(["acquire", "select", "research", "generate", "quality", "deliver"]);

export const PIPELINE_STATUS = Object.freeze({
  DELIVERED: "delivered",
  NO_CANDIDATE: "no_candidate",
  SKIPPED: "skipped",
  CANCELLED: "cancelled",
  FAILED: "failed",
});

// ConnectorError.kind / readers/retry-policy.js の RETRYABLE set と同じ語彙にそろえる。
// stageがどれでも、ItemProcessingStore.markFailure() が受け取る kind は一貫させる。
const RETRYABLE_KINDS = new Set(["timeout", "network", "server", "rate_limit", "empty"]);

// Main process の ServiceError (electron/main/services/service-error.ts) に相当する、
// Renderer側stage用の正規化済みerror。stageは例外を握り潰さず、これを投げる。
export class PipelineStageError extends Error {
  constructor(message, { stage = null, kind = "unknown", cause } = {}) {
    super(message);
    this.name = "PipelineStageError";
    this.stage = stage;
    this.kind = kind;
    this.retryable = RETRYABLE_KINDS.has(kind);
    if (cause !== undefined) this.cause = cause;
  }
}

// 任意のthrown valueをPipelineStageErrorへ正規化する。cancellationはisCancellation()判定・
// instanceofが効くように、そのまま素通しする (二重ラップしない)。
export function normalizeStageError(error, stage) {
  if (isCancellation(error)) return error;
  if (error instanceof PipelineStageError) return error;
  const kind = String(error?.kind ?? error?.code ?? "unknown").toLowerCase();
  return new PipelineStageError(error?.message ?? String(error ?? "pipeline stage failed"), { stage, kind, cause: error });
}

export function createPipelineContext({ requestId = null, generation = 0, signal = null, isCurrent = () => true, mode = "topic", startedAt = Date.now() } = {}) {
  return { requestId, generation, signal, isCurrent, mode, startedAt };
}

// 全stage・coordinatorがsideeffectの前後で呼ぶ、唯一のcooperative cancellation checkpoint
// (旧NewsReader#guard()相当)。
export function guardPipelineContext(context = {}) {
  if (context.signal?.aborted) throw context.signal.reason instanceof Error ? context.signal.reason : new RequestCancelledError();
  if (context.isCurrent && !context.isCurrent()) throw new RequestCancelledError("ニュース処理は設定変更で停止しました", "stale-generation");
}

export function emptyDiagnostics(overrides = {}) {
  return {
    runId: null,
    mode: "topic",
    timingsMs: {},
    candidateCounts: { acquired: 0, filtered: 0, eligible: 0 },
    filterStats: null,
    fallbackPath: [],
    rewriteCount: 0,
    sourceIds: [],
    personaSelections: [],
    errorCode: null,
    ...overrides,
  };
}
