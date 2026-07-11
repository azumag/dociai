// CI entrypoint: reuse the same managed workspace/process runner as local Browser E2E.
await import("../test/run-browser-e2e.mjs");
await import("../test/run-settings-e2e.mjs");
