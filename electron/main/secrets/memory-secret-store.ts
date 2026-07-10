import type { SecretKey, SecretStatus, SecretStore } from "../../shared/secret-contract";

export class MemorySecretStore implements SecretStore {
  #values = new Map<string, { value: string; updatedAt: string }>();
  isPersistentAvailable(): boolean { return false; }
  async listStatus(keys?: string[]): Promise<SecretStatus[]> {
    const selected = keys?.length ? keys : [...this.#values.keys()];
    return selected.map((key) => {
      const item = this.#values.get(key);
      return { key, configured: Boolean(item), persistent: false, hint: item ? "****" : undefined, updatedAt: item?.updatedAt };
    });
  }
  async getForService(key: SecretKey): Promise<string | null> { return this.#values.get(key)?.value ?? null; }
  async set(key: SecretKey, value: string): Promise<void> { this.#values.set(key, { value, updatedAt: new Date().toISOString() }); }
  async remove(key: SecretKey): Promise<void> { this.#values.delete(key); }
}
