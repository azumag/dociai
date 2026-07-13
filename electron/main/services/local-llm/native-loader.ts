// Native module initialization for the Local LLM inference service (#45). Owns the ONE dynamic
// `import("node-llama-cpp")` this whole service ever performs, converts any failure (module not
// installed, no usable backend on this platform, Rosetta, ...) into an `unavailable` capability
// report instead of letting it propagate and take the app down, and records enough diagnostics
// (package/version/platform/arch/backend/runtime mode) for support/debugging without ever needing
// a Renderer-visible stack trace.
//
// Deliberately does NOT import node-llama-cpp's own (huge) type surface. LlamaModuleApi below is
// a narrow, hand-verified structural subset of the real package's API (confirmed against
// node-llama-cpp@3.19.0 by actually loading it and a real tiny GGUF fixture during development —
// see local-llm-service-integration.test.mjs) — just enough for model-runtime.ts to load a model,
// create a context, and run a chat session. Both the real dynamically-imported module and a fully
// fake fixture built for unit tests satisfy this same interface, which is what keeps every other
// module in this service testable without ever touching the native addon.
export type LlamaChatHistoryItemLike = { type: "system"; text: string } | { type: "user"; text: string } | { type: "model"; response: string[] };

export type LlamaChatSessionPromptOptions = {
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
  onTextChunk?: (text: string) => void;
};

export type LlamaChatSessionLike = {
  readonly disposed: boolean;
  prompt(prompt: string, options?: LlamaChatSessionPromptOptions): Promise<string>;
  setChatHistory(history: LlamaChatHistoryItemLike[]): void;
  dispose(options?: { disposeSequence?: boolean }): void;
};

export type LlamaChatSessionConstructor = new (options: {
  contextSequence: LlamaContextSequenceLike;
  systemPrompt?: string;
  autoDisposeSequence?: boolean;
}) => LlamaChatSessionLike;

/** Opaque handle — passed straight from LlamaContextLike.getSequence() into LlamaChatSession's
 * constructor; nothing in this service inspects its shape. */
export type LlamaContextSequenceLike = unknown;

export type LlamaContextLike = {
  readonly contextSize: number;
  getSequence(): LlamaContextSequenceLike;
  dispose(): Promise<void>;
};

export type LlamaModelLike = {
  readonly size: number;
  readonly trainContextSize: number;
  readonly disposed: boolean;
  tokenize(text: string): number[];
  createContext(options: { contextSize?: number }): Promise<LlamaContextLike>;
  dispose(): Promise<void>;
};

export type LlamaLike = {
  readonly gpu: false | string;
  getVramState?(): Promise<{ total: number; used: number; free: number }>;
  // Real node-llama-cpp's LlamaModelOptions names this `loadSignal`, not `signal` — verified
  // against node_modules/node-llama-cpp/dist/evaluator/LlamaModel/LlamaModel.d.ts. Using the wrong
  // key here would make model-runtime.ts's load cancellation a silent no-op (the real loadModel()
  // would just ignore an unrecognized `signal` property and keep loading to completion).
  loadModel(options: { modelPath: string; loadSignal?: AbortSignal }): Promise<LlamaModelLike>;
};

export type LlamaModuleApi = {
  getLlama(options?: Record<string, unknown>): Promise<LlamaLike>;
  LlamaChatSession: LlamaChatSessionConstructor;
  /** Real node-llama-cpp exports this (dist/utils/getModuleVersion.js); optional here only so a
   * fake test module doesn't have to implement it. */
  getModuleVersion?(): Promise<string>;
};

export type NativeDiagnostics = {
  packageName: "node-llama-cpp";
  packageVersion: string | null;
  platform: string;
  arch: string;
  /** "packaged/devでnative resource pathを切り替える" — recorded so a future #50 (native binary
   * packaging) has a concrete hook to branch on; both modes currently resolve node-llama-cpp the
   * same way (a plain dynamic import, which Node's own module resolution satisfies from the repo's
   * node_modules in dev). See build/native/README.md for the packaged-mode plan this anticipates. */
  runtimeMode: "packaged" | "dev";
  backend: string | null;
  attemptedAtMs: number;
  errorMessage?: string;
};

export type NativeLoadResult = { available: true; module: LlamaModuleApi; llama: LlamaLike; diagnostics: NativeDiagnostics } | { available: false; reason: string; diagnostics: NativeDiagnostics };

export type NativeLoaderDeps = {
  importModule?: () => Promise<unknown>;
  now?: () => number;
  /** Matches electron/main/runtime-layout.ts's convention: the caller (electron/main/index.ts,
   * which alone imports `app` from "electron") injects this rather than each service module
   * probing Electron itself — keeps this file loadable in a plain Node unit-test process with no
   * Electron runtime present at all. Defaults to `false` (dev). */
  isPackaged?: boolean;
  platform?: string;
  arch?: string;
  /** Forwarded verbatim to node-llama-cpp's `getLlama(options)` — defaults to `undefined` (auto:
   * GPU-preferring backend selection, node-llama-cpp's own documented default). Real production
   * code should never need to override this; it exists so a caller (e.g. a test suite that wants
   * to avoid GPU/Metal driver contention when many processes run concurrently — see
   * local-llm-service-integration.test.mjs) can force `{gpu: false}` (CPU-only) explicitly. */
  getLlamaOptions?: Record<string, unknown>;
};

function isLlamaModuleApi(value: unknown): value is LlamaModuleApi {
  return Boolean(value && typeof value === "object" && typeof (value as Record<string, unknown>).getLlama === "function" && typeof (value as Record<string, unknown>).LlamaChatSession === "function");
}

async function readPackageVersion(module: LlamaModuleApi): Promise<string | null> {
  try {
    return (await module.getModuleVersion?.()) ?? null;
  } catch {
    return null; // best-effort diagnostic only — never fails native module loading over this.
  }
}

/** Main-process-only. Never re-exported to preload/Renderer — see local-llm-service.ts, which is
 * the only consumer. */
export class NativeLoader {
  #initPromise: Promise<NativeLoadResult> | undefined;
  #disposed = false;
  readonly #importModule: () => Promise<unknown>;
  readonly #now: () => number;
  readonly #isPackaged: boolean;
  readonly #platform: string;
  readonly #arch: string;
  readonly #getLlamaOptions: Record<string, unknown> | undefined;

  constructor(deps: NativeLoaderDeps = {}) {
    this.#importModule = deps.importModule ?? (() => import("node-llama-cpp"));
    this.#now = deps.now ?? (() => Date.now());
    this.#isPackaged = deps.isPackaged ?? false;
    this.#platform = deps.platform ?? process.platform;
    this.#arch = deps.arch ?? process.arch;
    this.#getLlamaOptions = deps.getLlamaOptions;
  }

  /** "initializeを多重実行しても同じPromiseを返す" — single-flight, memoized for the lifetime of
   * this instance. "dispose後に再利用しない" — once disposed, always reports unavailable without
   * ever attempting (or re-attempting) the dynamic import again. */
  async load(): Promise<NativeLoadResult> {
    if (this.#disposed) return this.#unavailable("native loader has been disposed");
    if (this.#initPromise) return this.#initPromise;
    const promise = this.#loadOnce();
    this.#initPromise = promise;
    return promise;
  }

  dispose(): void {
    this.#disposed = true;
  }

  async #loadOnce(): Promise<NativeLoadResult> {
    const attemptedAtMs = this.#now();
    const runtimeMode: NativeDiagnostics["runtimeMode"] = this.#isPackaged ? "packaged" : "dev";
    const baseDiagnostics = { packageName: "node-llama-cpp" as const, platform: this.#platform, arch: this.#arch, runtimeMode, attemptedAtMs };

    let imported: unknown;
    try {
      imported = await this.#importModule();
    } catch (error) {
      return this.#unavailable(describeImportFailure(error), baseDiagnostics);
    }
    if (this.#disposed) return this.#unavailable("native loader was disposed while loading", baseDiagnostics);
    if (!isLlamaModuleApi(imported)) return this.#unavailable("node-llama-cpp module did not export the expected API shape", baseDiagnostics);

    let llama: LlamaLike;
    try {
      llama = await imported.getLlama(this.#getLlamaOptions);
    } catch (error) {
      return this.#unavailable(describeImportFailure(error), { ...baseDiagnostics, packageVersion: await readPackageVersion(imported) });
    }
    if (this.#disposed) return this.#unavailable("native loader was disposed while loading", baseDiagnostics);

    const diagnostics: NativeDiagnostics = { ...baseDiagnostics, packageVersion: await readPackageVersion(imported), backend: llama.gpu === false ? "cpu" : llama.gpu };
    return { available: true, module: imported, llama, diagnostics };
  }

  #unavailable(reason: string, partial: Partial<NativeDiagnostics> = {}): NativeLoadResult {
    const diagnostics: NativeDiagnostics = {
      packageName: "node-llama-cpp",
      packageVersion: null,
      platform: this.#platform,
      arch: this.#arch,
      runtimeMode: this.#isPackaged ? "packaged" : "dev",
      backend: null,
      attemptedAtMs: this.#now(),
      errorMessage: reason,
      ...partial,
    };
    return { available: false, reason, diagnostics };
  }
}

function describeImportFailure(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return "node-llama-cpp failed to load for an unknown reason";
}
