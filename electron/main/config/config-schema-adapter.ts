// Shared Browser/Main pipeline. The JS module is bundled into Electron by esbuild.
// @ts-expect-error JavaScript config core intentionally has no separate declaration build.
import { processConfig } from "../../../src/config/config-pipeline.js";
// @ts-expect-error JavaScript config core intentionally has no separate declaration build.
import { canonicalConfigHash } from "../../../src/config/config-canonicalize.js";

type PipelineResult = { ok: boolean; stage: string; config?: Record<string, unknown>; issues?: Array<{ path: Array<string | number>; message: string }>; notes?: string[]; migrations?: string[]; secretCandidates?: Array<{ path: Array<string | number>; kind: string }> };
export function processMainConfig(input: unknown): { config: Record<string, unknown>; warnings: string[]; migrations: string[]; secretCandidates: Array<{ path: Array<string | number>; kind: string }> } {
  const result = processConfig(input) as PipelineResult;
  if (!result.ok || !result.config) throw new Error(`${result.stage}: ${(result.issues ?? []).map((entry) => `${entry.path.join(".")}: ${entry.message}`).join("; ")}`);
  return { config: result.config, warnings: result.notes ?? [], migrations: result.migrations ?? [], secretCandidates: result.secretCandidates ?? [] };
}
export function mainConfigRevision(config: Record<string, unknown>): string { return canonicalConfigHash(config) as string; }
