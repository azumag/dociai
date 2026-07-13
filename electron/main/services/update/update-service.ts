// Auto-update, macOS-only for now (electron-builder.yml's own header comment explains why: no
// Windows NSIS target yet, so no `latest.yml` ever gets published for win — see also
// docs/release.md/docs/signing.md). electron/main/index.ts only constructs this service, and only
// wires it live, when `process.platform === "darwin" && app.isPackaged` — everywhere else it's
// simply never instantiated, so `enabled: false` below is a defensive fallback, not the primary
// gate.
//
// Broadcast-safety UX (this app is typically open, live, on an operator's screen *during* a
// stream): checking happens automatically, but nothing downloads or installs without an explicit
// renderer-initiated call. `autoInstallOnAppQuit` is deliberately left at electron-updater's own
// default (true) once a download completes — quitting the app normally (e.g. after the stream
// ends) is the one moment installing is actually safe, so there is no reason to make that worse
// than doing nothing.
import type { UpdateState } from "../../../shared/services/update-ipc-contract";

export type UpdateCheckResultLike = { updateInfo?: { version?: string } } | null;
export type UpdateInfoLike = { version: string };
export type ProgressInfoLike = { percent: number };
export type UpdateDownloadedEventLike = { version: string };

// The subset of electron-updater's `autoUpdater` this service actually touches, expressed as an
// interface so tests can inject a fake instead of the real singleton (which requires a packaged
// app and throws outside one) — same pattern as ShortcutService's injected GlobalShortcutLike.
export type AutoUpdaterLike = {
  autoDownload: boolean;
  allowPrerelease: boolean;
  checkForUpdates(): Promise<UpdateCheckResultLike>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: "checking-for-update", listener: () => void): unknown;
  on(event: "update-available", listener: (info: UpdateInfoLike) => void): unknown;
  on(event: "update-not-available", listener: (info: UpdateInfoLike) => void): unknown;
  on(event: "download-progress", listener: (info: ProgressInfoLike) => void): unknown;
  on(event: "update-downloaded", listener: (event: UpdateDownloadedEventLike) => void): unknown;
  // electron-updater's real errors always carry a `.code` (builder-util-runtime's `newError`) even
  // though electron-updater's own upstream types don't declare it — see isNotFoundError's comment.
  on(event: "error", listener: (error: Error & { code?: string }) => void): unknown;
};

// electron-updater's GitHub provider throws (not a clean "not found" result) whenever the repo has
// no matching release yet — true for this repo's entire lifetime until the first signed tag is
// actually published (release.yml refuses to publish an unsigned one). Surfacing that as a loud
// error banner on every periodic check would make the feature look broken from day one, so it's
// folded into the same quiet "not-available" state a real no-update-yet check produces. Anything
// else is a genuine error.
//
// A zero-release repo does NOT surface as an HTTP 404 — electron-updater's GitHubProvider parses
// the (200 OK) releases.atom feed and throws a *synthesized* error when it has no <entry> at all
// (node_modules/electron-updater/out/providers/GitHubProvider.js's `No published versions on
// GitHub`, code ERR_UPDATER_NO_PUBLISHED_VERSIONS, or the underlying XML-parser's ERR_XML_MISSED_
// ELEMENT for the same case) — verified by reading electron-updater 6.8.9's actual source, not
// assumed. `.code` is matched first since it's a stable identifier the message wording isn't; the
// message regex is the fallback for genuine HTTP 404s elsewhere in the resolution chain (e.g. an
// asset request), which DO come back as `HttpError`s whose message contains the status text.
const NOT_AVAILABLE_ERROR_CODES = new Set(["ERR_UPDATER_NO_PUBLISHED_VERSIONS", "ERR_XML_MISSED_ELEMENT"]);
function isNotFoundError(error: Error & { code?: string }): boolean {
  if (error.code && NOT_AVAILABLE_ERROR_CODES.has(error.code)) return true;
  return /404|not found/i.test(error.message);
}

// Emits at most once per DOWNLOAD_PROGRESS_THROTTLE_MS — electron-updater's download-progress
// fires far more often than any UI needs to redraw — but the terminal 100%/downloaded state is
// never dropped (emitted directly from the update-downloaded handler, bypassing the throttle).
const DOWNLOAD_PROGRESS_THROTTLE_MS = 250;

export class UpdateService {
  #updater: AutoUpdaterLike | null;
  #emitStatus: (state: UpdateState) => void;
  #state: UpdateState = { phase: "idle" };
  #lastProgressEmitMs = 0;
  #disposed = false;

  constructor(updater: AutoUpdaterLike | null, emitStatus: (state: UpdateState) => void = () => {}, options: { allowPrerelease?: boolean } = {}) {
    this.#updater = updater;
    this.#emitStatus = emitStatus;
    if (!updater) return;
    updater.autoDownload = false;
    updater.allowPrerelease = options.allowPrerelease ?? false;
    updater.on("checking-for-update", () => this.#setState({ phase: "checking" }));
    updater.on("update-available", (info) => this.#setState({ phase: "available", version: info.version }));
    updater.on("update-not-available", () => this.#setState({ phase: "not-available" }));
    updater.on("download-progress", (info) => this.#onProgress(info));
    updater.on("update-downloaded", (event) => this.#setState({ phase: "downloaded", version: event.version }));
    updater.on("error", (error) => this.#setState(isNotFoundError(error) ? { phase: "not-available" } : { phase: "error", message: error.message }));
  }

  get enabled(): boolean { return this.#updater !== null; }

  status(): UpdateState { return this.#state; }

  async check(): Promise<UpdateState> {
    if (!this.#updater) return this.#state;
    // A download already in flight or finished must never be regressed back to
    // checking/available by a routine periodic/on-reload check (electron-updater's
    // checkForUpdates() re-fires checking-for-update -> update-available unconditionally) — that
    // would silently strand an already-downloaded update behind quitAndInstall()'s "must be
    // downloaded" guard until the whole download is redone.
    if (this.#state.phase === "downloading" || this.#state.phase === "downloaded") return this.#state;
    try { await this.#updater.checkForUpdates(); }
    catch (error) { this.#setState(this.#classifyError(error)); }
    return this.#state;
  }

  async download(): Promise<UpdateState> {
    if (!this.#updater) return this.#state;
    if (this.#state.phase === "downloading" || this.#state.phase === "downloaded") return this.#state;
    try { await this.#updater.downloadUpdate(); }
    catch (error) { this.#setState(this.#classifyError(error)); }
    return this.#state;
  }

  // isSilent=false, isForceRunAfter=true: shows the platform's own "installing update" UI instead
  // of a silent background swap, and relaunches afterward rather than leaving the app closed —
  // matches what an operator explicitly clicking "restart and install" expects to happen. Returns
  // whether it actually installed — the IPC layer must not claim success when this was a no-op
  // (disabled, or nothing downloaded yet), since the renderer's confirm dialog leads the operator
  // to expect the app is about to restart.
  quitAndInstall(): boolean {
    if (!this.#updater || this.#state.phase !== "downloaded") return false;
    this.#updater.quitAndInstall(false, true);
    return true;
  }

  dispose(): void { this.#disposed = true; }

  #classifyError(error: unknown): UpdateState {
    const err = error instanceof Error ? error : new Error(String(error));
    return isNotFoundError(err) ? { phase: "not-available" } : { phase: "error", message: err.message };
  }

  #onProgress(info: ProgressInfoLike): void {
    const state = this.#state;
    if (state.phase !== "downloading" && state.phase !== "available") return;
    const now = Date.now();
    const next: UpdateState = { phase: "downloading", version: state.version, percent: info.percent };
    if (now - this.#lastProgressEmitMs < DOWNLOAD_PROGRESS_THROTTLE_MS) { this.#state = next; return; }
    this.#lastProgressEmitMs = now;
    this.#setState(next);
  }

  #setState(state: UpdateState): void {
    if (this.#disposed) return;
    this.#state = state;
    this.#emitStatus(state);
  }
}
