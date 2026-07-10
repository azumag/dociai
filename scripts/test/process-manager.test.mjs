import assert from "node:assert/strict";
import test from "node:test";
import { ManagedProcess } from "./process-manager.mjs";

test("ManagedProcess captures output and observes an already-finished child", async () => {
  const child = new ManagedProcess("quick", process.execPath, ["-e", "console.log('ready')"], {
    pipeOutput: false,
  }).start();
  await child.waitForOutput("ready");
  const result = await child.waitForExit();
  assert.equal(result.code, 0);
  assert.match(child.logs(), /ready/);
});

test("ManagedProcess stops a long-running process tree", async () => {
  const child = new ManagedProcess("long", process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    pipeOutput: false,
  }).start();
  assert.ok(child.pid);
  await child.stop({ timeoutMs: 2_000 });
  const result = await child.waitForExit();
  assert.ok(result.signal || result.code !== 0);
});

test("ManagedProcess force kills a child that ignores SIGTERM", { skip: process.platform === "win32" }, async () => {
  const child = new ManagedProcess("stubborn", process.execPath, ["-e", "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"], {
    pipeOutput: false,
  }).start();
  await child.waitForOutput("ready");
  await child.stop({ timeoutMs: 50 });
  const result = await child.waitForExit();
  assert.equal(result.signal, "SIGKILL");
});
