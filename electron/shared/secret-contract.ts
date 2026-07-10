export type SecretKey = string & { readonly __secretKey: unique symbol };
export type SecretStatus = { key: string; configured: boolean; persistent: boolean; hint?: string; updatedAt?: string };
export type SecretStore = {
  isPersistentAvailable(): boolean;
  listStatus(keys?: string[]): Promise<SecretStatus[]>;
  getForService(key: SecretKey): Promise<string | null>;
  set(key: SecretKey, value: string): Promise<void>;
  remove(key: SecretKey): Promise<void>;
};
