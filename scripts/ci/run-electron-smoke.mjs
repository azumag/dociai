// CI entrypoint: the workflow builds once, then reuses the local Electron smoke.
await import("../electron/smoke.mjs");
