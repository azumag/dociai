// Hand-maintained type declaration for schemas.js — see contract.d.ts's doc comment for why this
// repo's usual "@ts-expect-error + no declaration build" pattern isn't used for src/stream-events.
import type { StreamEvent, StreamEventIssue } from "./contract.js";

export type StreamEventValidationResult =
  | { ok: true; event: StreamEvent; issues: readonly StreamEventIssue[] }
  | { ok: false; issues: readonly StreamEventIssue[]; input: unknown };

export declare function validateStreamEvent(candidate: unknown): StreamEventValidationResult;
