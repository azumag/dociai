import fs from "node:fs/promises";
import path from "node:path";
import type { SecretKey, SecretStatus, SecretStore } from "../../shared/secret-contract";
import { MemorySecretStore } from "./memory-secret-store";

type SafeStorageLike = {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
};
type SecretFile = { formatVersion: 1; encryption: "safeStorage"; entries: Record<string, { ciphertextBase64: string; updatedAt: string; hint?: string }> };
function isErrno(error: unknown, code: string): boolean { return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code); }

export class SafeStorageSecretStore implements SecretStore {
  #memory = new MemorySecretStore();
  #persistent: boolean;
  #entries = new Map<string, SecretFile["entries"][string]>();
  #loaded: Promise<void>;
  constructor(private readonly storage: SafeStorageLike, private readonly file: string, private readonly backupFile: string) {
    this.#persistent = storage.isEncryptionAvailable() && storage.getSelectedStorageBackend?.() !== "basic_text";
    this.#loaded = this.#read();
  }
  isPersistentAvailable(): boolean { return this.#persistent; }
  async #read(): Promise<void> {
    if (!this.#persistent) return;
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf8")) as SecretFile;
      if (parsed.formatVersion !== 1 || parsed.encryption !== "safeStorage") return;
      for (const [key, entry] of Object.entries(parsed.entries ?? {})) this.#entries.set(key, entry);
    } catch {
      // Missing or corrupt secret files are treated as empty; never fall back to plaintext.
    }
  }
  async listStatus(keys?: string[]): Promise<SecretStatus[]> {
    await this.#loaded;
    const selected = keys?.length ? keys : [...this.#entries.keys()];
    const memory = await this.#memory.listStatus(selected);
    return selected.map((key, index) => {
      const entry = this.#entries.get(key);
      return entry ? { key, configured: true, persistent: true, hint: entry.hint, updatedAt: entry.updatedAt } : memory[index];
    });
  }
  async getForService(key: SecretKey): Promise<string | null> {
    await this.#loaded;
    const entry = this.#entries.get(key);
    if (entry && this.#persistent) {
      try { return this.storage.decryptString(Buffer.from(entry.ciphertextBase64, "base64")); } catch { return null; }
    }
    return this.#memory.getForService(key);
  }
  async set(key: SecretKey, value: string): Promise<void> {
    await this.#loaded;
    if (!this.#persistent) return this.#memory.set(key, value);
    const updatedAt = new Date().toISOString();
    const next = { ciphertextBase64: this.storage.encryptString(value).toString("base64"), updatedAt, hint: "****" };
    this.#entries.set(key, next);
    await this.#write();
  }
  async remove(key: SecretKey): Promise<void> {
    await this.#loaded;
    this.#entries.delete(key);
    await this.#memory.remove(key);
    if (this.#persistent) await this.#write();
  }
  async #write(): Promise<void> {
    const payload: SecretFile = { formatVersion: 1, encryption: "safeStorage", entries: Object.fromEntries(this.#entries) };
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try { await fs.copyFile(this.file, this.backupFile); } catch (error) { if (!isErrno(error, "ENOENT")) throw error; }
    const temporary = `${this.file}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, this.file);
  }
}
