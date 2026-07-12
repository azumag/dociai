// Disk space checks for the download service (#76): "expected size + temporary overhead" must
// fit in the free space of the filesystem that hosts the models directory before a download job
// is allowed to start. Uses Node's real fs.statfs (available since Node 18.15/19.6, well within
// this repo's `engines.node: "22.x"`).
import fs from "node:fs/promises";

export type DiskSpaceInfo = { freeBytes: number; totalBytes: number };

/** A download needs room for the partial file itself, plus headroom for: the final atomic
 * rename (briefly two directory entries can reference overlapping-but-not-yet-freed extents on
 * some filesystems), sha256 verification not requiring extra space but GGUF header buffering
 * being negligible, and simple safety margin against concurrent downloads/writes elsewhere on the
 * same volume. 512 MiB is a deliberately simple flat constant rather than a percentage, so the
 * overhead does not scale (and become misleadingly huge) for very large models. */
export const DEFAULT_DOWNLOAD_OVERHEAD_BYTES = 512 * 1024 * 1024;

/** Statfs against the real filesystem hosting `targetPath` (the models directory, or any
 * directory on the same volume — statfs reports for the containing filesystem, not the specific
 * path). `bavail` (blocks available to an unprivileged user) is used rather than `bfree` (which
 * includes blocks reserved for the root user and would overstate what this process can actually
 * write). */
export async function getDiskSpace(targetPath: string): Promise<DiskSpaceInfo> {
  const stats = await fs.statfs(targetPath);
  return { freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize };
}

/** Pure decision function, deliberately separated from the statfs call above so it can be unit
 * tested with both real statfs output and injected fake low-space values without touching the
 * filesystem. */
export function hasSufficientSpace(freeBytes: number, expectedSizeBytes: number, overheadBytes: number = DEFAULT_DOWNLOAD_OVERHEAD_BYTES): boolean {
  if (!Number.isFinite(freeBytes) || freeBytes < 0) return false;
  if (!Number.isFinite(expectedSizeBytes) || expectedSizeBytes < 0) return false;
  return freeBytes >= expectedSizeBytes + overheadBytes;
}
