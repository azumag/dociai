// Persists download job records (#76) as JSON with the exact same atomic-write + backup pattern
// installed-registry.ts (#75) uses: write to a temp file in the same directory, fsync, rename
// over the real file, keep the previous version as `.bak`. A corrupt primary falls back to
// `.bak`; if both are unreadable, load() reports repair-needed with an empty job list rather than
// throwing, so a corrupted job-store file can never crash app startup.
import fs from "node:fs/promises";
import path from "node:path";
import {
  DOWNLOAD_JOB_SCHEMA_VERSION,
  SUPPORTED_DOWNLOAD_JOB_SCHEMA_VERSIONS,
} from "../../../../shared/local-llm/model-contract";
import type { DownloadJobFile, DownloadJobRecord, DownloadJobState } from "../../../../shared/local-llm/model-contract";

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const JOB_STATES: readonly DownloadJobState[] = ["queued", "downloading", "verifying", "installing", "completed", "paused", "failed", "cancelled"];

function isErrno(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code);
}

function emptyFile(): DownloadJobFile {
  return { schemaVersion: DOWNLOAD_JOB_SCHEMA_VERSION, updatedAt: new Date(0).toISOString(), jobs: [] };
}

function isJobRecord(value: unknown): value is DownloadJobRecord {
  if (!value || typeof value !== "object") return false;
  const job = value as Record<string, unknown>;
  if (typeof job.id !== "string" || job.id.length === 0) return false;
  if (typeof job.displayName !== "string") return false;
  if (typeof job.fileName !== "string" || job.fileName.length === 0) return false;
  if (!job.source || typeof job.source !== "object") return false;
  const source = job.source as Record<string, unknown>;
  if (source.kind !== "huggingface" && source.kind !== "url") return false;
  if (typeof job.expectedSizeBytes !== "number" || !Number.isFinite(job.expectedSizeBytes) || job.expectedSizeBytes < 0) return false;
  if (job.expectedSha256 !== undefined && (typeof job.expectedSha256 !== "string" || !SHA256_PATTERN.test(job.expectedSha256))) return false;
  if (!job.license || typeof job.license !== "object") return false;
  if (typeof job.licenseAcceptedAt !== "string") return false;
  if (typeof job.state !== "string" || !JOB_STATES.includes(job.state as DownloadJobState)) return false;
  if (typeof job.bytesDownloaded !== "number" || !Number.isFinite(job.bytesDownloaded) || job.bytesDownloaded < 0) return false;
  if (typeof job.attempt !== "number" || !Number.isInteger(job.attempt) || job.attempt < 0) return false;
  if (typeof job.createdAt !== "string" || typeof job.updatedAt !== "string") return false;
  return true;
}

function parseJobFile(raw: string): DownloadJobFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("download job store file is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("download job store root is not an object");
  const value = parsed as Record<string, unknown>;
  if (typeof value.schemaVersion !== "number" || !SUPPORTED_DOWNLOAD_JOB_SCHEMA_VERSIONS.includes(value.schemaVersion)) {
    throw new Error(`download job store schemaVersion is missing or unsupported: ${String(value.schemaVersion)}`);
  }
  if (!Array.isArray(value.jobs) || !value.jobs.every(isJobRecord)) throw new Error("download job store jobs array is invalid");
  return {
    schemaVersion: value.schemaVersion,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString(),
    jobs: value.jobs as DownloadJobRecord[],
  };
}

export type LoadedJobFile = { file: DownloadJobFile; repairNeeded: boolean; recovered: boolean; warnings: string[] };
export type DownloadJobStorePaths = { jobsFile: string; jobsBackupFile: string };

export class DownloadJobStore {
  #writeQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly paths: DownloadJobStorePaths) {}

  async #locked<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.#writeQueue;
    let release!: () => void;
    this.#writeQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }

  async #readRaw(): Promise<LoadedJobFile> {
    try {
      const raw = await fs.readFile(this.paths.jobsFile, "utf8");
      return { file: parseJobFile(raw), repairNeeded: false, recovered: false, warnings: [] };
    } catch (error) {
      if (isErrno(error, "ENOENT")) return { file: emptyFile(), repairNeeded: false, recovered: false, warnings: [] };
      try {
        const backupRaw = await fs.readFile(this.paths.jobsBackupFile, "utf8");
        const file = parseJobFile(backupRaw);
        await fs.mkdir(path.dirname(this.paths.jobsFile), { recursive: true });
        await fs.copyFile(this.paths.jobsBackupFile, this.paths.jobsFile);
        return { file, repairNeeded: false, recovered: true, warnings: ["download-jobs.json was corrupted; recovered from download-jobs.json.bak"] };
      } catch {
        return {
          file: emptyFile(),
          repairNeeded: true,
          recovered: false,
          warnings: ["download-jobs.json and download-jobs.json.bak are both unreadable; starting from an empty job store (repair needed)"],
        };
      }
    }
  }

  async #writeRaw(file: DownloadJobFile): Promise<void> {
    const payload: DownloadJobFile = { ...file, schemaVersion: DOWNLOAD_JOB_SCHEMA_VERSION, updatedAt: new Date().toISOString() };
    const serialized = `${JSON.stringify(payload, null, 2)}\n`;
    await fs.mkdir(path.dirname(this.paths.jobsFile), { recursive: true });
    try {
      await fs.copyFile(this.paths.jobsFile, this.paths.jobsBackupFile);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
    const temporary = `${this.paths.jobsFile}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const handle = await fs.open(temporary, "w", 0o600);
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync().catch(() => { /* fsync is best-effort: not every filesystem/CI sandbox supports it. */ });
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, this.paths.jobsFile);
  }

  async load(): Promise<LoadedJobFile> {
    return this.#readRaw();
  }

  async list(): Promise<{ jobs: DownloadJobRecord[]; repairNeeded: boolean }> {
    const { file, repairNeeded } = await this.load();
    return { jobs: file.jobs, repairNeeded };
  }

  async get(jobId: string): Promise<DownloadJobRecord | null> {
    const { file } = await this.load();
    return file.jobs.find((job) => job.id === jobId) ?? null;
  }

  /** Inserts or replaces (by id) a single job record, inside one lock acquisition so a
   * read-modify-write cycle can never interleave with a concurrent save/upsert (the same reason
   * InstalledRegistry.upsert takes the lock for its whole read+write). */
  async upsert(record: DownloadJobRecord): Promise<DownloadJobFile> {
    return this.#locked(async () => {
      const current = await this.#readRaw();
      const jobs = [...current.file.jobs.filter((job) => job.id !== record.id), record];
      const next: DownloadJobFile = { schemaVersion: DOWNLOAD_JOB_SCHEMA_VERSION, updatedAt: new Date().toISOString(), jobs };
      await this.#writeRaw(next);
      return next;
    });
  }

  async remove(jobId: string): Promise<void> {
    await this.#locked(async () => {
      const current = await this.#readRaw();
      const jobs = current.file.jobs.filter((job) => job.id !== jobId);
      if (jobs.length === current.file.jobs.length) return;
      await this.#writeRaw({ schemaVersion: DOWNLOAD_JOB_SCHEMA_VERSION, updatedAt: new Date().toISOString(), jobs });
    });
  }
}
