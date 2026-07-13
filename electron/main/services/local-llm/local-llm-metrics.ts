// Metrics collection for a single generate() call (#45). "prompt本文はmetrics/logへ含めない" —
// this module only ever sees counts/durations, never message text; model-runtime.ts is responsible
// for not passing anything else in.
import type { GenerationMetrics } from "../../../shared/local-llm/events";

export type MetricsClock = { now(): number };
export const systemMetricsClock: MetricsClock = { now: () => Date.now() };

export class GenerationMetricsCollector {
  readonly #clock: MetricsClock;
  readonly #backend: string;
  readonly #contextSize: number;
  readonly #promptTokens: number;
  readonly #startedAtMs: number;
  #firstTokenAtMs: number | null = null;
  #generatedTokens = 0;

  constructor(options: { backend: string; contextSize: number; promptTokens: number; clock?: MetricsClock }) {
    this.#clock = options.clock ?? systemMetricsClock;
    this.#backend = options.backend;
    this.#contextSize = options.contextSize;
    this.#promptTokens = options.promptTokens;
    this.#startedAtMs = this.#clock.now();
  }

  /** Call once per generated token (or once per emitted text chunk, when per-token counts aren't
   * available — see model-runtime.ts's onTextChunk wiring). */
  recordToken(count = 1): void {
    if (this.#firstTokenAtMs === null) this.#firstTokenAtMs = this.#clock.now();
    this.#generatedTokens += count;
  }

  finish(peakMemoryBytes?: number): GenerationMetrics {
    const finishedAtMs = this.#clock.now();
    const totalGenerationMs = Math.max(0, finishedAtMs - this.#startedAtMs);
    const firstTokenLatencyMs = this.#firstTokenAtMs === null ? null : Math.max(0, this.#firstTokenAtMs - this.#startedAtMs);
    const tokensPerSecond = this.#generatedTokens > 0 && totalGenerationMs > 0 ? Number(((this.#generatedTokens / totalGenerationMs) * 1000).toFixed(2)) : null;
    return {
      backend: this.#backend,
      contextSize: this.#contextSize,
      promptTokens: this.#promptTokens,
      generatedTokens: this.#generatedTokens,
      firstTokenLatencyMs,
      totalGenerationMs,
      tokensPerSecond,
      ...(peakMemoryBytes === undefined ? {} : { peakMemoryBytes }),
    };
  }
}
