// Issue #177: coverage for electron/main/services/twitch/events/eventsub-to-streamevent-bridge.ts —
// the missing wire between a live EventSub `notification` envelope (electron/main/services/twitch/
// eventsub/eventsub-message-parser.ts's `EventSubEnvelope`) and #90's twitch-event-normalizer.ts.
// Follows the exact esbuild-bundle-then-node--test convention #75/#76/#83-90 established (see
// scripts/test/twitch-event-normalizer.test.mjs, whose real fixture files under
// tests/fixtures/twitch/eventsub/*.json this file reuses verbatim rather than re-authoring its own
// notification payloads).
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const fixturesDir = path.join(repoRoot, "tests/fixtures/twitch/eventsub");

async function loadModules() {
  const result = await build({
    stdin: {
      contents: [
        `export { EventSubToStreamEventBridge } from "./electron/main/services/twitch/events/eventsub-to-streamevent-bridge.ts";`,
        `export { parseEventSubMessage } from "./electron/main/services/twitch/eventsub/eventsub-message-parser.ts";`,
      ].join("\n"),
      resolveDir: repoRoot,
      sourcefile: "eventsub-to-streamevent-bridge-test.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-eventsub-bridge-test-"));
  const file = path.join(directory, "modules.mjs");
  await fs.writeFile(file, result.outputFiles[0].text);
  return { modules: await import(file), directory };
}

async function loadFixture(name) {
  return JSON.parse(await fs.readFile(path.join(fixturesDir, name), "utf8"));
}

function makeBridge(modules, overrides = {}) {
  const streamEvents = [];
  const diagnostics = [];
  const bridge = new modules.EventSubToStreamEventBridge({
    onStreamEvent: (event) => streamEvents.push(event),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    now: () => 1_700_000_000_000,
    ...overrides,
  });
  return { bridge, streamEvents, diagnostics };
}

test("EventSubToStreamEventBridge: a real channel.cheer notification (Twitch's own documented fixture) becomes a valid StreamEvent, delivered via onStreamEvent — never silently dropped", async () => {
  const { modules, directory } = await loadModules();
  try {
    const fixture = await loadFixture("cheer.json");
    const envelope = modules.parseEventSubMessage(JSON.stringify(fixture));
    assert.equal(envelope.ok, true);
    assert.equal(envelope.kind, "known");

    const { bridge, streamEvents, diagnostics } = makeBridge(modules);
    bridge.handleNotification(envelope.envelope);

    assert.equal(diagnostics.length, 0);
    assert.equal(streamEvents.length, 1);
    assert.equal(streamEvents[0].kind, "cheer");
    assert.equal(streamEvents[0].data.bits, 1000);
    assert.equal(streamEvents[0].id, fixture.metadata.message_id, "the StreamEvent id must be derived from the EventSub message_id (#89's own dedupe key)");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("EventSubToStreamEventBridge: every SUPPORTED_TYPE_VERSIONS fixture normalizes cleanly (subscribe/subscription-message/subscription-gift/reward-redemption, not just cheer)", async () => {
  const { modules, directory } = await loadModules();
  try {
    for (const [file, expectedKind] of [["subscribe.json", "subscription"], ["subscription-message.json", "resub"], ["subscription-gift.json", "gift-subscription"], ["reward-redemption.json", "reward-redemption"]]) {
      const fixture = await loadFixture(file);
      const envelope = modules.parseEventSubMessage(JSON.stringify(fixture));
      assert.equal(envelope.ok, true, `${file}: parseEventSubMessage must succeed`);
      const { bridge, streamEvents, diagnostics } = makeBridge(modules);
      bridge.handleNotification(envelope.envelope);
      assert.equal(diagnostics.length, 0, `${file}: must not be diagnosed`);
      assert.equal(streamEvents.length, 1, `${file}: must produce exactly one StreamEvent`);
      assert.equal(streamEvents[0].kind, expectedKind, `${file}: unexpected StreamEvent kind`);
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("EventSubToStreamEventBridge: a notification envelope missing subscriptionType/subscriptionVersion is diagnosed, not silently dropped", async () => {
  const { modules, directory } = await loadModules();
  try {
    const { bridge, streamEvents, diagnostics } = makeBridge(modules);
    bridge.handleNotification({ metadata: { messageId: "m1", messageType: "notification", messageTimestamp: "2026-01-01T00:00:00.000Z" }, payload: { event: {} } });

    assert.equal(streamEvents.length, 0);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].reason, "missing-subscription-type-or-version");
    assert.equal(diagnostics[0].messageId, "m1");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("EventSubToStreamEventBridge: an unrecognized type@version (e.g. a future Twitch type this build has no normalizer for) is diagnosed with the real normalizer's own issues, not silently dropped", async () => {
  const { modules, directory } = await loadModules();
  try {
    const { bridge, streamEvents, diagnostics } = makeBridge(modules);
    bridge.handleNotification({
      metadata: { messageId: "m2", messageType: "notification", messageTimestamp: "2026-01-01T00:00:00.000Z", subscriptionType: "channel.raid", subscriptionVersion: "1" },
      payload: { event: { from_broadcaster_user_id: "1", to_broadcaster_user_id: "2" } },
    });

    assert.equal(streamEvents.length, 0);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].reason, "normalize-failed");
    assert.equal(diagnostics[0].type, "channel.raid");
    assert.equal(diagnostics[0].version, "1");
    assert.ok(diagnostics[0].issues.some((issue) => issue.code === "unknown_subscription"));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("EventSubToStreamEventBridge: a known type@version missing a CRITICAL field (e.g. cheer with bits stripped) is diagnosed with the real normalizer's issues, not silently dropped", async () => {
  const { modules, directory } = await loadModules();
  try {
    const fixture = await loadFixture("cheer.json");
    delete fixture.payload.event.bits;
    const envelope = modules.parseEventSubMessage(JSON.stringify(fixture));
    assert.equal(envelope.ok, true);

    const { bridge, streamEvents, diagnostics } = makeBridge(modules);
    bridge.handleNotification(envelope.envelope);

    assert.equal(streamEvents.length, 0);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].reason, "normalize-failed");
    assert.ok(diagnostics[0].issues.length > 0);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("EventSubToStreamEventBridge: onDiagnostic is REQUIRED (not defaulted to a no-op) — constructing without one throws IMMEDIATELY (at wiring time), never lazily inside a live notification handler", async () => {
  const { modules, directory } = await loadModules();
  try {
    assert.throws(() => new modules.EventSubToStreamEventBridge({ onStreamEvent: () => {} }), /onDiagnostic/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
