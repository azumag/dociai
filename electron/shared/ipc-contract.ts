import type { PlatformInfo } from "./platform";
import type { PublicError } from "./errors";
import type { AiChatInput, AiChatResponse } from "./services/ai-contract";
import type { FeedFetchInput, FeedFetchResponse } from "./services/feed-contract";
import type { TopicCompleteInput, TopicFetchInput, TopicFetchResponse } from "./services/topic-contract";
import type { CatalogListResult, DownloadJobRecord, DownloadStartInput, ImportBeginResult, ImportCommitResult, InstalledListResult, InstalledModelEntry } from "./local-llm/model-contract";
import type { StreamEventListInput, StreamEventListResult } from "./services/stream-event-ipc-contract";
import type { TwitchAuthOverview, TwitchConnectionOverview, TwitchCustomRewardsOverview, TwitchSubscriptionsOverview } from "./twitch/overview-contract";
import type { UpdateState } from "./services/update-ipc-contract";

export type Result<T> = { ok: true; value: T } | { ok: false; error: PublicError };
export type WindowRole = "console" | "obs";
export type WindowStateSummary = { consoleOpen: boolean; obsOpen: boolean };
export type SecretStatus = { key: string; configured: boolean; persistent: boolean; hint?: string; updatedAt?: string };
export type ExternalOpenResult = { scheme: "https"; host: string };
export type ShowItemKind = "logs" | "models" | "config";
export type ShortcutRegistration = { triggerId: string; accelerator: string; registered: boolean; reason?: "occupied" | "invalid" | "registration_failed" };
export type ShortcutStatus = { entries: ShortcutRegistration[]; updatedAt: number };
export type CaptureSource = { id: string; name: string; type: "screen" | "window"; displayId: string; thumbnail: string };
export type CaptureStatus = { selectedName: string; preferredName: string; sourceCount: number };
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
    // Issue #94: auth (#83-85) + EventSub (#86-88) overview surface — a SEPARATE Twitch integration
    // from the `start`/`stop`/`reconnect` IRC chat-reading service above (that one is
    // TwitchChatService, driven by config.commentSources.twitch; this one is TwitchComposition,
    // driven by config.twitch, for the Bits/Subscriptions/Redemptions EventSub topics).
    auth: {
      status(): Promise<Result<TwitchAuthOverview>>;
      start(input?: { features?: string[] }): Promise<Result<TwitchAuthOverview>>;
      cancel(): Promise<Result<TwitchAuthOverview>>;
      upgradeScopes(): Promise<Result<TwitchAuthOverview>>;
      openVerificationUri(): Promise<Result<{ opened: boolean }>>;
      switchAccount(input?: { features?: string[] }): Promise<Result<TwitchAuthOverview>>;
      logout(): Promise<Result<{ revoked: boolean }>>;
    };
    eventSub: {
      status(): Promise<Result<TwitchConnectionOverview>>;
      connect(): Promise<Result<TwitchConnectionOverview>>;
      reconnect(): Promise<Result<TwitchConnectionOverview>>;
      stop(): Promise<Result<TwitchConnectionOverview>>;
    };
    subscriptions: {
      status(): Promise<Result<TwitchSubscriptionsOverview>>;
    };
    // Issue #95: Get Custom Rewards, for the Event Rule editor's reward selector
    // (src/twitch-ui/rules/reward-selector.js).
    rewards: {
      list(): Promise<Result<TwitchCustomRewardsOverview>>;
    };
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
  capture: {
    listSources(): Promise<Result<CaptureSource[]>>;
    selectSource(input: { id?: string; name?: string }): Promise<Result<{ selected: true; name: string; type: "screen" | "window" }>>;
    status(): Promise<Result<CaptureStatus>>;
  };
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
    download: {
      start(input: DownloadStartInput): Promise<Result<DownloadJobRecord>>;
      cancel(input: { jobId: string; deletePartial?: boolean }): Promise<Result<{ cancelled: boolean }>>;
      retry(jobId: string): Promise<Result<DownloadJobRecord>>;
      list(): Promise<Result<{ jobs: DownloadJobRecord[] }>>;
      status(jobId: string): Promise<Result<{ job: DownloadJobRecord | null }>>;
    };
  };
  // macOS-only for now (electron/main/services/update/update-service.ts) — check()/download() are
  // no-ops that resolve to the current (idle/unsupported) state on other platforms rather than
  // erroring, so renderer code doesn't need its own platform branch on top of hasElectronUpdateService.
  update: {
    check(): Promise<Result<UpdateState>>;
    download(): Promise<Result<UpdateState>>;
    // Never called automatically — quits both windows and installs on next launch. Renderer must
    // get explicit user confirmation first (see update-service.ts's header comment on why this
    // app can't assume "restart" is ever a safe default while a broadcast may be live).
    quitAndInstall(): Promise<Result<{ installing: boolean }>>;
  };
  streamEvents: {
    list(input?: StreamEventListInput): Promise<Result<StreamEventListResult>>;
    clear(): Promise<Result<{ cleared: boolean }>>;
  };
  events: {
    subscribe(type: string, listener: (event: unknown) => void): () => void;
  };
  obs: {
    send(message: unknown): boolean;
    subscribe(listener: (message: unknown) => void): () => void;
  };
};
