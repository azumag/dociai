import type { PlatformInfo } from "./platform";
import type { PublicError } from "./errors";

export type Result<T> = { ok: true; value: T } | { ok: false; error: PublicError };
export type WindowRole = "console" | "obs";
export type WindowStateSummary = { consoleOpen: boolean; obsOpen: boolean };
export type SecretStatus = { key: string; configured: boolean; persistent: boolean; hint?: string; updatedAt?: string };
export type ExternalOpenResult = { scheme: "https"; host: string };
export type ShowItemKind = "logs" | "models" | "config";

export type DociaiApi = {
  platform: { getInfo(): Promise<Result<PlatformInfo>> };
  config: {
    get(): Promise<Result<{ config: Record<string, unknown>; revision: string; warnings: string[] }>>;
    save(input: { config: Record<string, unknown>; expectedRevision?: string }): Promise<Result<{ saved: true; revision: string }>>;
    importLegacy(confirm?: boolean): Promise<Result<{ imported: boolean; secretKeys: string[]; revision?: string }>>;
  };
  secrets: {
    status(keys?: string[]): Promise<Result<SecretStatus[]>>;
    set(input: { key: string; value: string }): Promise<Result<{ saved: true; persistent: boolean }>>;
    remove(key: string): Promise<Result<{ removed: true }>>;
  };
  windows: {
    openObs(): Promise<Result<{ opened: true }>>;
    closeObs(): Promise<Result<{ closed: true }>>;
    getState(): Promise<Result<WindowStateSummary>>;
  };
  system: {
    openExternal(url: string): Promise<Result<ExternalOpenResult>>;
    showItemInFolder(kind: ShowItemKind): Promise<Result<{ shown: true }>>;
  };
  events: {
    subscribe(type: string, listener: (event: unknown) => void): () => void;
  };
};
