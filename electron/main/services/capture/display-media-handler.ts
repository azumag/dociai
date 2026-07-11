import type { CaptureService } from "./capture-service";

type SessionLike = { defaultSession: { setDisplayMediaRequestHandler(handler: unknown): void } };

export function installDisplayMediaHandler(electronSession: SessionLike, captureService: CaptureService): () => void {
  const handler = (_request: unknown, callback: (selection: { video?: unknown }) => void) => {
    void captureService.resolveVideo().then((source) => callback({ video: source })).catch(() => callback({ video: undefined }));
  };
  electronSession.defaultSession.setDisplayMediaRequestHandler(handler);
  return () => electronSession.defaultSession.setDisplayMediaRequestHandler(null);
}
