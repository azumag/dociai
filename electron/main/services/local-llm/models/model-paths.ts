// Single chokepoint for turning a model ID / registry-stored relative path into an absolute
// filesystem path. Every other local-llm module MUST go through this file instead of building
// paths itself, so path-traversal defenses live in exactly one place (#75).
import fs from "node:fs/promises";
import path from "node:path";
import { ServiceError } from "../../service-error";

const SERVICE_ID = "local-llm:paths";
const MAX_SEGMENT_LENGTH = 128;
const MAX_RELATIVE_PATH_LENGTH = 512;

export const MODEL_DIR_NAMES = { installed: "installed", staging: ".staging", quarantine: ".quarantine" } as const;

function badPath(message: string): ServiceError {
  return new ServiceError("BAD_REQUEST", message, { serviceId: SERVICE_ID, retryable: false });
}

/** Turns arbitrary user/catalog-provided text (a model id, a file stem, ...) into a string that
 * is always safe to use as a single path segment: no separators, no traversal, no null bytes. */
export function sanitizeIdSegment(value: string, maxLength = MAX_SEGMENT_LENGTH): string {
  if (typeof value !== "string" || value.length === 0) throw badPath("path segment must be a non-empty string");
  const cleaned = value
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  const trimmed = cleaned.slice(0, maxLength);
  if (!trimmed) throw badPath("path segment has no safe characters");
  return trimmed;
}

/**
 * Resolves `relativePath` against `modelsDir` and rejects anything that would escape it:
 * absolute paths, `..` segments (checked explicitly, in addition to the resolve+prefix check
 * below, since `path.resolve` alone would still be safe but a segment-level check gives a
 * clearer error and defends against odd separator mixes), null bytes, and drive-letter/home
 * shorthand forms. Never touches the filesystem — see `assertRealPathWithinModelsDir` for the
 * symlink-aware check performed right before a file is actually opened.
 */
export function resolveWithinModelsDir(modelsDir: string, relativePath: string): string {
  if (typeof relativePath !== "string" || relativePath.length === 0 || relativePath.length > MAX_RELATIVE_PATH_LENGTH) {
    throw badPath("relativePath is invalid");
  }
  if (relativePath.includes("\0")) throw badPath("relativePath contains a null byte");
  if (path.isAbsolute(relativePath)) throw badPath("relativePath must be relative, not absolute");
  if (/^[A-Za-z]:[\\/]/.test(relativePath) || relativePath.startsWith("~")) throw badPath("relativePath must not reference an absolute location");
  const segments = relativePath.split(/[\\/]+/).filter((segment) => segment.length > 0);
  if (segments.length === 0) throw badPath("relativePath is empty");
  if (segments.some((segment) => segment === "..")) throw badPath("relativePath must not contain '..' segments");

  const base = path.resolve(modelsDir);
  const resolved = path.resolve(base, relativePath);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) throw badPath("relativePath escapes the models directory");
  return resolved;
}

/**
 * Symlink-aware companion to `resolveWithinModelsDir`: resolves the real (symlink-followed) path
 * of `candidatePath` and confirms it still lives under the models directory's real path. Call
 * this right before actually opening a file that was reached via a registry-stored relative
 * path, since `resolveWithinModelsDir` alone cannot see through a symlink planted on disk.
 */
export async function assertRealPathWithinModelsDir(modelsDir: string, candidatePath: string): Promise<string> {
  const base = path.resolve(modelsDir);
  let realBase: string;
  try {
    realBase = await fs.realpath(base);
  } catch {
    realBase = base;
  }
  const realCandidate = await fs.realpath(candidatePath);
  if (realCandidate !== realBase && !realCandidate.startsWith(realBase + path.sep)) {
    throw badPath("resolved path escapes the models directory (symlink)");
  }
  return realCandidate;
}

export function modelsSubdir(modelsDir: string, subdir: string): string {
  return path.join(path.resolve(modelsDir), subdir);
}
