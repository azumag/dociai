// Finalizes a fully-downloaded partial file (#76) into the installed registry. Deliberately the
// same shape as local-import.ts's commitImport tail (validate GGUF header → hash → atomic rename
// → build the registry "manifest" entry → registry commit → quarantine-on-failure), since that is
// this repo's proven pattern for "never let an unverified or unregistered file masquerade as an
// installed model" (#75). The download service calls this only after a stream has fully
// completed; verification itself lives here, not in the download service, so a caller can never
// accidentally skip straight from "bytes on disk" to "installed".
import fs from "node:fs/promises";
import path from "node:path";
import { MODEL_DIR_NAMES, modelsSubdir, resolveWithinModelsDir, sanitizeIdSegment } from "./model-paths";
import { computeSha256, readGgufHeader } from "./gguf-metadata-reader";
import type { InstalledRegistry } from "./installed-registry";
import type { DownloadedModelSource, DownloadJobRecord, InstalledModelEntry } from "../../../../shared/local-llm/model-contract";

export type InstallVerifiedDownloadInput = {
  modelsDir: string;
  registry: InstalledRegistry;
  /** Absolute path to the fully-downloaded staging file (still inside .staging/, same
   * filesystem as modelsDir so the final rename is atomic). */
  partialPath: string;
  job: Pick<DownloadJobRecord, "fileName" | "displayName" | "expectedSha256" | "catalogModelId">;
  sourceUrl: string;
  huggingFace?: { repo: string; revision: string; filename: string };
  now?: () => number;
};

export type InstallResult =
  | { status: "installed"; model: InstalledModelEntry }
  | { status: "duplicate"; existing: InstalledModelEntry }
  | { status: "failed"; reason: string; retryable: boolean };

async function quarantine(filePath: string, quarantineDir: string, label: string): Promise<void> {
  try {
    await fs.mkdir(quarantineDir, { recursive: true, mode: 0o700 });
    await fs.rename(filePath, path.join(quarantineDir, `${label}-${Date.now()}`));
  } catch {
    await fs.rm(filePath, { force: true }).catch(() => {});
  }
}

/** Order per #76's acceptance criteria: verify (GGUF header + sha256) → atomic rename → build the
 * manifest entry → registry commit. A file never reaches "atomic rename" unless both validations
 * passed, and the registry never learns about a model unless the rename already succeeded — so a
 * crash at any point leaves either nothing installed, or a fully-verified+registered model, never
 * something in between. */
export async function installVerifiedDownload(input: InstallVerifiedDownloadInput): Promise<InstallResult> {
  const now = input.now ?? (() => Date.now());
  const quarantineDir = modelsSubdir(input.modelsDir, MODEL_DIR_NAMES.quarantine);
  const safeLabel = sanitizeIdSegment(input.job.fileName.replace(/\.gguf$/i, "") || "model");

  const header = await readGgufHeader(input.partialPath).catch((error) => ({ valid: false as const, reason: error instanceof Error ? error.message : String(error) }));
  if (!header.valid) {
    await quarantine(input.partialPath, quarantineDir, safeLabel);
    return { status: "failed", reason: `not a valid GGUF file: ${header.reason}`, retryable: true };
  }

  let sha256: string;
  try {
    sha256 = await computeSha256(input.partialPath);
  } catch (error) {
    await quarantine(input.partialPath, quarantineDir, safeLabel);
    return { status: "failed", reason: `failed to hash the downloaded file: ${error instanceof Error ? error.message : String(error)}`, retryable: true };
  }

  if (input.job.expectedSha256 && sha256.toLowerCase() !== input.job.expectedSha256.toLowerCase()) {
    await quarantine(input.partialPath, quarantineDir, safeLabel);
    return { status: "failed", reason: `sha256 mismatch: expected ${input.job.expectedSha256}, got ${sha256}`, retryable: true };
  }

  const existing = await input.registry.findByHash(sha256);
  if (existing) {
    await fs.rm(input.partialPath, { force: true }).catch(() => {});
    return { status: "duplicate", existing };
  }

  const finalStat = await fs.stat(input.partialPath);
  const modelId = input.job.catalogModelId ?? `download-${sha256.slice(0, 16)}`;
  const safeFileName = `${safeLabel}.gguf`;
  const relativePath = path.posix.join(MODEL_DIR_NAMES.installed, sanitizeIdSegment(modelId), safeFileName);
  const finalPath = resolveWithinModelsDir(input.modelsDir, relativePath);

  try {
    await fs.mkdir(path.dirname(finalPath), { recursive: true, mode: 0o700 });
    await fs.rename(input.partialPath, finalPath);
  } catch (error) {
    await quarantine(input.partialPath, quarantineDir, safeLabel);
    return { status: "failed", reason: `failed to move downloaded file into place: ${error instanceof Error ? error.message : String(error)}`, retryable: true };
  }

  const source: DownloadedModelSource = {
    kind: "download",
    url: input.sourceUrl,
    ...(input.job.catalogModelId ? { catalogModelId: input.job.catalogModelId } : {}),
    ...(input.huggingFace ? { huggingFace: input.huggingFace } : {}),
  };
  const entry: InstalledModelEntry = {
    id: modelId,
    displayName: input.job.displayName,
    relativePath,
    sizeBytes: finalStat.size,
    sha256,
    ...(header.architecture ? { architecture: header.architecture } : {}),
    ...(typeof header.version === "number" ? { ggufVersion: header.version } : {}),
    source,
    importedAt: new Date(now()).toISOString(),
  };

  try {
    await input.registry.upsert(entry);
  } catch (error) {
    // The file already landed in installed/ but the registry commit failed: quarantine it so it
    // is never reported as installed rather than leaving an unregistered file silently in place.
    await quarantine(finalPath, quarantineDir, safeLabel).catch(() => {});
    return { status: "failed", reason: `failed to commit the registry: ${error instanceof Error ? error.message : String(error)}`, retryable: true };
  }

  return { status: "installed", model: entry };
}
