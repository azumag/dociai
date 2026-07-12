import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { AppRuntime } from "../../src/app/app-runtime.js";
import { RuntimeFactory } from "../../src/app/runtime-factory.js";
import { defineComponent } from "../../src/app/runtime-bundle.js";
import { RuntimeDisposer } from "../../src/app/runtime-disposer.js";
import { BrowserRuntimeController } from "../../src/runtime/runtime-controller.js";

const root = path.resolve(new URL("../..", import.meta.url).pathname);

// Fake factory: three components a -> b -> c, each recording start/stop/dispose calls
// tagged with the generation they belong to. `failOn` makes that component's start() throw.
function trackingFactory(order, { failOn = null } = {}) {
  return new RuntimeFactory(({ generation, define }) => {
    for (const name of ["a", "b", "c"]) {
      define(name, () => ({ name }), () => ({
        start: () => { order.push(`start:${name}:${generation}`); if (failOn === name) throw new Error(`${name} start failed`); },
        stop: () => order.push(`stop:${name}:${generation}`),
        dispose: () => order.push(`dispose:${name}:${generation}`),
      }));
    }
  });
}

test("AppRuntime starts a candidate's components in order and disposes the superseded bundle in reverse", async () => {
  const order = [];
  const runtime = new AppRuntime({ runtimeController: new BrowserRuntimeController(), factory: trackingFactory(order) });

  const first = await runtime.applyConfig({}, { reason: "boot" });
  assert.equal(first.ok, true);
  assert.deepEqual(order, ["start:a:1", "start:b:1", "start:c:1"]);

  order.length = 0;
  const second = await runtime.applyConfig({}, { reason: "reload" });
  assert.equal(second.ok, true);
  assert.deepEqual(order, [
    "stop:c:1", "dispose:c:1", "stop:b:1", "dispose:b:1", "stop:a:1", "dispose:a:1",
    "start:a:2", "start:b:2", "start:c:2",
  ]);
});

test("a candidate start failure cleans up only the components that actually started, in reverse order", async () => {
  const order = [];
  const runtime = new AppRuntime({ runtimeController: new BrowserRuntimeController(), factory: trackingFactory(order, { failOn: "b" }) });

  const result = await runtime.applyConfig({}, { reason: "boot" });
  assert.equal(result.ok, false);
  assert.equal(result.stage, "start");
  assert.deepEqual(order, ["start:a:1", "start:b:1", "stop:a:1", "dispose:a:1"]);
  assert.equal(runtime.current, null);
  assert.equal(runtime.errorState.error.message, "b start failed");
});

test("every applyConfig attempt, including a rollback, reserves its own monotonic generation", async () => {
  let buildCount = 0;
  const factory = new RuntimeFactory(({ define }) => {
    buildCount += 1;
    const attempt = buildCount;
    define("x", () => ({}), () => ({ start: () => { if (attempt === 2) throw new Error("second boot fails"); } }));
  });
  const controller = new BrowserRuntimeController();
  const runtime = new AppRuntime({ runtimeController: controller, factory });

  const first = await runtime.applyConfig({ v: 1 });
  assert.equal(first.ok, true);
  assert.equal(first.generation, 1);

  const second = await runtime.applyConfig({ v: 2 });
  assert.equal(second.ok, false);
  assert.equal(second.generation, 2);
  assert.equal(second.rollback.ok, true);
  assert.equal(second.rollback.generation, 3);
  assert.equal(controller.generations.current(), 3);
  assert.equal(runtime.current.generation, 3);
});

test("a second applyConfig call while one is in flight is rejected outright (mutex, not a queue)", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const factory = new RuntimeFactory(({ define }) => {
    define("slow", () => ({}), () => ({ start: async () => { await gate; } }));
  });
  const runtime = new AppRuntime({ runtimeController: new BrowserRuntimeController(), factory });

  const firstPromise = runtime.applyConfig({});
  const second = await runtime.applyConfig({});
  assert.equal(second.ok, false);
  assert.equal(second.stage, "busy");

  release();
  const first = await firstPromise;
  assert.equal(first.ok, true);
});

test("rollback failure leaves AppRuntime in an explicit error state rather than a stale one", async () => {
  let mode = "ok";
  const factory = new RuntimeFactory(({ define }) => {
    define("x", () => ({}), () => ({ start: () => { if (mode !== "ok") throw new Error(`start failed (${mode})`); } }));
  });
  const runtime = new AppRuntime({ runtimeController: new BrowserRuntimeController(), factory });

  const boot = await runtime.applyConfig({ v: 1 });
  assert.equal(boot.ok, true);

  mode = "fail-everything";
  const result = await runtime.applyConfig({ v: 2 });
  assert.equal(result.ok, false);
  assert.equal(result.rollback.ok, false);
  assert.equal(runtime.current, null);
  assert.ok(runtime.errorState);
  assert.match(runtime.errorState.error.message, /start failed/);
});

test("a candidate creation failure never touches the old runtime", async () => {
  const order = [];
  let mode = "ok";
  const factory = new RuntimeFactory(({ generation, define }) => {
    if (mode === "fail-create") throw new Error("candidate build failed");
    define("x", () => ({}), () => ({ start: () => order.push(`start:${generation}`), dispose: () => order.push(`dispose:${generation}`) }));
  });
  const runtime = new AppRuntime({ runtimeController: new BrowserRuntimeController(), factory });

  await runtime.applyConfig({ v: 1 });
  assert.deepEqual(order, ["start:1"]);

  mode = "fail-create";
  const result = await runtime.applyConfig({ v: 2 });
  assert.equal(result.ok, false);
  assert.equal(result.stage, "create");
  assert.equal(result.teardownReport, null);
  assert.equal(runtime.current.generation, 1);
  assert.deepEqual(order, ["start:1"]);
});

test("AppRuntime.stop() and dispose() are idempotent", async () => {
  const order = [];
  const runtime = new AppRuntime({ runtimeController: new BrowserRuntimeController(), factory: trackingFactory(order) });
  await runtime.applyConfig({});

  const firstStop = await runtime.stop("shutdown");
  assert.equal(firstStop.failed, false);
  assert.ok(firstStop.results.length > 0);

  const secondStop = await runtime.stop("shutdown");
  assert.equal(secondStop.results.length, 0);
  assert.equal(runtime.current, null);

  const firstDispose = await runtime.dispose("shutdown");
  const secondDispose = await runtime.dispose("shutdown");
  assert.equal(runtime.disposed, true);
  assert.equal(firstDispose, secondDispose);

  const afterDispose = await runtime.applyConfig({});
  assert.equal(afterDispose.ok, false);
  assert.equal(afterDispose.stage, "disposed");
});

test("RuntimeDisposer records per-component stop/dispose timeouts without blocking the rest of the sweep", async () => {
  const disposer = new RuntimeDisposer({ timeoutMs: 20 });
  const order = [];
  const components = [
    defineComponent({ name: "a", stop: () => order.push("stop:a"), dispose: () => order.push("dispose:a") }),
    defineComponent({ name: "hangs", stop: () => new Promise(() => {}), dispose: () => order.push("dispose:hangs") }),
    defineComponent({ name: "c", stop: () => order.push("stop:c"), dispose: () => order.push("dispose:c") }),
  ];

  const report = await disposer.teardown(components, { reason: "test" });
  assert.equal(report.failed, true);
  assert.equal(report.timedOut, true);
  const hangEntry = report.results.find((entry) => entry.name === "hangs" && entry.phase === "stop");
  assert.equal(hangEntry.timedOut, true);
  assert.equal(hangEntry.ok, false);
  assert.deepEqual(order, ["stop:c", "dispose:c", "dispose:hangs", "stop:a", "dispose:a"]);
});

test("a throwing dispose() does not stop the sweep from disposing earlier components", async () => {
  const disposer = new RuntimeDisposer({ timeoutMs: 1000 });
  const order = [];
  const components = [
    defineComponent({ name: "a", dispose: () => order.push("dispose:a") }),
    defineComponent({ name: "broken", dispose: () => { throw new Error("boom"); } }),
  ];
  const report = await disposer.teardown(components, { reason: "test" });
  assert.equal(report.failed, true);
  assert.deepEqual(order, ["dispose:a"]);
});

test("src/app.js was removed and nothing still references it as an entry point", async () => {
  const appJsExists = await fs.access(path.join(root, "src/app.js")).then(() => true, () => false);
  assert.equal(appJsExists, false, "src/app.js should be deleted per issue #99's acceptance criteria");
  const indexHtml = await fs.readFile(path.join(root, "index.html"), "utf8");
  assert.match(indexHtml, /src="\.\/src\/app\/boot\.js"/);
  assert.doesNotMatch(indexHtml, /src\/app\.js/);
});

test("issue #99 runtime modules form a DAG and stay DOM/network free outside boot.js", async () => {
  const files = ["runtime-bundle.js", "runtime-disposer.js", "app-runtime.js", "runtime-factory.js", "app-actions.js", "boot.js"];
  const sources = {};
  const graph = {};
  for (const file of files) {
    const source = await fs.readFile(path.join(root, "src/app", file), "utf8");
    sources[file] = source;
    graph[file] = [...source.matchAll(/from "\.\/([\w-]+\.js)"/g)].map((match) => match[1]).filter((dep) => files.includes(dep));
  }
  for (const file of files) {
    if (file === "boot.js") continue; // composition root: touching document/window is its job
    assert.doesNotMatch(sources[file], /\bdocument\.|\bwindow\.\w|\bfetch\(|new XMLHttpRequest\(/, `${file} must not touch DOM/network directly`);
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (name, trail = []) => {
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new Error(`circular dependency detected: ${[...trail, name].join(" -> ")}`);
    visiting.add(name);
    for (const dep of graph[name] ?? []) visit(dep, [...trail, name]);
    visiting.delete(name);
    visited.add(name);
  };
  for (const file of files) visit(file);
});
