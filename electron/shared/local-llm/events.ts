// Streaming/event shapes for the Local LLM inference service (#45) — the counterpart to
// contract.ts's request/response shapes, mirroring this repo's existing service-contract.ts
// (request plumbing) vs. service-events.ts (event stream shapes) split.
import type { LocalLlmErrorShape, LoadPhase } from "./contract";

/** Emitted once per load() phase transition (see model-runtime.ts's load sequence). Not part of
 * generate()'s AsyncIterable — load() itself stays a plain Promise per the issue's public
 * contract, so this is delivered via a caller-supplied `onProgress` callback instead. */
export type LoadProgressEvent = { requestId: string; modelId: string; phase: LoadPhase; at: number };

/** "prompt本文やlocal pathが通常診断へ露出しない" — every field here is a count/duration, never the
 * prompt or generated text itself. `peakMemoryBytes` is included only when the backend actually
 * reports it (node-llama-cpp's VRAM state query; best-effort). */
export type GenerationMetrics = {
  backend: string;
  contextSize: number;
  promptTokens: number;
  generatedTokens: number;
  firstTokenLatencyMs: number | null;
  totalGenerationMs: number;
  tokensPerSecond: number | null;
  peakMemoryBytes?: number;
};

/** The AsyncIterable<GenerationEvent> element type generate() yields. Exactly one terminal event
 * ("done" | "cancelled" | "error") always ends the stream; "token" events only ever precede it —
 * see generation-queue.ts/model-runtime.ts's "cancel後にtoken eventを配送しない" invariant. */
export type GenerationEvent =
  | { type: "token"; requestId: string; text: string; at: number }
  | { type: "done"; requestId: string; text: string; metrics: GenerationMetrics; at: number }
  | { type: "cancelled"; requestId: string; at: number }
  | { type: "error"; requestId: string; error: LocalLlmErrorShape; at: number };
