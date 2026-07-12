import type { PlatformInfo } from "./platform";
import type { PublicError } from "./errors";
import type { AiChatInput, AiChatResponse } from "./services/ai-contract";
import type { FeedFetchInput, FeedFetchResponse } from "./services/feed-contract";
import type { TopicCompleteInput, TopicFetchInput, TopicFetchResponse } from "./services/topic-contract";
import type { CatalogListResult, ImportBeginResult, ImportCommitResult, InstalledListResult, InstalledModelEntry } from "./local-llm/model-contract";

export type Result<T> = { ok: true; value: T } | { ok: false; error: PublicError };
export type WindowRole = "console" | "obs";
export type WindowStateSummary = { consoleOpen: boolean; obsOpen: boolean };
export type SecretStatus = { key: string; configured: boolean; persistent: boolean; hint?: string; updatedAt?: string };
export type ExternalOpenResult = { scheme: "https"; host: string };
export type ShowItemKind = "logs" | "models" | "config";
export type ShortcutRegistration = { triggerId: string; accelerator: string; registered: boolean; reason?: "occupied" | "invalid" | "registration_failed" };
export type ShortcutStatus = { entries: ShortcutRegistration[]; updatedAt: number };
export type VoiceVoxSynthesisInput = { text: string; speaker: number; baseUrl?: string; timeoutMs?: number; pitch?: number; speed?: number; intonation?: number; volume?: number; requestId?: string; ownerId?: string; generation?: number };

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
  ai: {
    chat(input: AiChatInput): Promise<Result<AiChatResponse>>;
    cancel(requestId: string): Promise<Result<{ cancelled: boolean }>>;
  };
  feeds: {
    fetch(input: FeedFetchInput): Promise<Result<FeedFetchResponse>>;
    cancel(requestId: string): Promise<Result<{ cancelled: boolean }>>;
  };
  topics: {
    fetch(input: TopicFetchInput): Promise<Result<TopicFetchResponse>>;
    complete(input: TopicCompleteInput): Promise<Result<{ completed: true; requestId: string }>>;
    cancel(requestId: string): Promise<Result<{ cancelled: boolean }>>;
  };
  speech: {
    voicevox: { speakers(input?: { baseUrl?: string; requestId?: string }): Promise<Result<{ speakers: Array<{ id: number; speaker: string; style: string; label: string }>; requestId: string }>>; synthesize(input: VoiceVoxSynthesisInput): Promise<Result<{ audio: ArrayBuffer; contentType: string; requestId: string }>> };
    bouyomi: { talk(input: Record<string, unknown>): Promise<Result<{ submitted: true; requestId: string }>>; clear(input?: Record<string, unknown>): Promise<Result<{ cleared: true; requestId: string }>> };
    cancel(requestId: string): Promise<Result<{ cancelled: boolean }>>;
  };
  bouyomi: { talk(input: Record<string, unknown>): Promise<Result<{ submitted: true; requestId: string }>>; clear(input?: Record<string, unknown>): Promise<Result<{ cleared: true; requestId: string }>> };
  twitch: {
    start(config: Record<string, unknown>): Promise<Result<{ state: string; sessionId: string; channels: string[]; attempt: number }>>;
    stop(): Promise<Result<{ state: string; sessionId: string; channels: string[]; attempt: number }>>;
    reconnect(): Promise<Result<{ reconnected: boolean }>>;
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
  shortcuts: { status(): Promise<Result<ShortcutStatus>> };
  localLlm: {
    catalog: { list(): Promise<Result<CatalogListResult>> };
    installed: {
      list(): Promise<Result<InstalledListResult>>;
      get(modelId: string): Promise<Result<{ model: InstalledModelEntry | null }>>;
    };
    import: {
      begin(): Promise<Result<ImportBeginResult>>;
      commit(token: string): Promise<Result<ImportCommitResult>>;
      cancel(token: string): Promise<Result<{ cancelled: boolean }>>;
    };
  };
  events: {
    subscribe(type: string, listener: (event: unknown) => void): () => void;
  };
  obs: {
    send(message: unknown): boolean;
    subscribe(listener: (message: unknown) => void): () => void;
  };
};
