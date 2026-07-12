import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";

async function loadModules() {
  const root = path.resolve(new URL("../..", import.meta.url).pathname);
  const result = await build({
    stdin: { contents: `export { CaptureService } from "./electron/main/services/capture/capture-service.ts"; export { installDisplayMediaHandler } from "./electron/main/services/capture/display-media-handler.ts";`, resolveDir: root, sourcefile: "capture-test.ts", loader: "ts" },
    bundle: true, format: "esm", platform: "node", write: false,
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-capture-"));
  const file = path.join(directory, "modules.mjs");
  await fs.writeFile(file, result.outputFiles[0].text);
  return { modules: await import(file), directory };
}

function source(id, name, displayId = "1") {
  return { id, name, display_id: displayId, thumbnail: { toDataURL: () => `data:image/mock;${id}` } };
}

test("capture service sanitizes sources and resolves a preferred source by name", async () => {
  const { modules, directory } = await loadModules();
  try {
    let sources = [source("screen:1", "Main Display", "1"), source("window:42", "OBS", "")];
    const service = new modules.CaptureService({ getSources: async () => sources });
    assert.deepEqual(await service.listSources(), [
      { id: "screen:1", name: "Main Display", type: "screen", displayId: "1", thumbnail: "data:image/mock;screen:1" },
      { id: "window:42", name: "OBS", type: "window", displayId: "", thumbnail: "data:image/mock;window:42" },
    ]);
    service.setPreferredSourceName("OBS");
    sources = [source("screen:2", "Main Display", "2"), source("window:99", "OBS", "")];
    assert.equal((await service.resolveVideo()).id, "window:99");
    assert.deepEqual(await service.selectSource({ id: "window:99" }), { selected: true, name: "OBS", type: "window" });
    assert.deepEqual(service.status(), { selectedName: "OBS", preferredName: "OBS", sourceCount: 2 });
    service.dispose();
    assert.deepEqual(await service.listSources(), []);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("display media handler returns the selected source and cleans up", async () => {
  const { modules, directory } = await loadModules();
  try {
    let installed;
    const session = { defaultSession: { setDisplayMediaRequestHandler(handler) { installed = handler; } } };
    const service = new modules.CaptureService({ getSources: async () => [source("screen:1", "Main Display")] });
    const uninstall = modules.installDisplayMediaHandler(session, service);
    const result = new Promise((resolve) => installed({}, resolve));
    const selected = await result;
    assert.equal(selected.video.id, "screen:1");
    assert.equal(selected.video.name, "Main Display");
    assert.equal(typeof selected.video.thumbnail.toDataURL, "function");
    uninstall();
    assert.equal(installed, null);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
