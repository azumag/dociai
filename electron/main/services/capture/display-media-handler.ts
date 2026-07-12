import type { CaptureService } from "./capture-service";

type SessionLike = { defaultSession: { setDisplayMediaRequestHandler(handler: unknown): void } };

// Main-process-only: session.setDisplayMediaRequestHandler intercepts every renderer
// getDisplayMedia() call and resolves it with the pre-selected/preferred source instead of
// showing Electron's picker-less (and on some platforms broken) native prompt (issue #117).
export function installDisplayMediaHandler(electronSession: SessionLike, captureService: CaptureService): () => void {
  const handler = (_request: unknown, callback: (selection: { video?: unknown }) => void) => {
    void captureService.resolveVideo().then((source) => callback({ video: source })).catch(() => callback({ video: undefined }));
  };
  electronSession.defaultSession.setDisplayMediaRequestHandler(handler);
  return () => electronSession.defaultSession.setDisplayMediaRequestHandler(null);
}
