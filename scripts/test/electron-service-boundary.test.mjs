import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(new URL("../..", import.meta.url).pathname);
async function source(relative) { return fs.readFile(path.join(root, relative), "utf8"); }

test("Electron renderer adapters route every external service through Main IPC", async () => {
  const [connectors, news, topics, voicevox, bouyomi, runtimeFactory, platform, captureAdapter, preload, ipc, main] = await Promise.all([
    source("src/connectors.js"), source("src/news-reader.js"), source("src/topic-reader.js"), source("src/voicevox.js"), source("src/bouyomi.js"), source("src/app/runtime-factory.js"), source("src/platform/electron-services.js"), source("src/platform/capture-adapter.js"), source("electron/preload/index.ts"), source("electron/main/ipc/register.ts"), source("electron/main/index.ts"),
  ]);
  assert.match(connectors, /hasElectronAiService\(\)/); assert.match(news, /hasElectronFeedService\(\)/); assert.match(topics, /hasElectronTopicService\(\)/);
  assert.match(voicevox, /hasElectronVoiceVoxService\(\)/); assert.match(bouyomi, /window\?\.dociai\?\.(?:bouyomi|speech)/); assert.match(runtimeFactory, /dociai\?\.twitch\?\.start/);
  assert.match(platform, /globalThis\.dociai\.speech\.voicevox/); assert.match(platform, /globalThis\.dociai\.twitch/);
  assert.match(captureAdapter, /globalThis\.dociai\?\.capture/);
  for (const channel of ["SPEECH_VOICEVOX_SPEAKERS", "SPEECH_VOICEVOX_SYNTHESIZE", "SPEECH_BOUYOMI_TALK", "SPEECH_BOUYOMI_CLEAR", "TWITCH_START", "TWITCH_STOP", "TWITCH_RECONNECT", "SHORTCUT_STATUS", "CAPTURE_LIST_SOURCES", "CAPTURE_SELECT_SOURCE", "CAPTURE_STATUS"]) { assert.match(preload, new RegExp(`CHANNELS\\.${channel}`)); assert.match(ipc, new RegExp(`CHANNELS\\.${channel}`)); }
  assert.match(main, /new SpeechBackendService/); assert.match(main, /new TwitchChatService/);
  assert.match(main, /new ShortcutService/);
  assert.match(main, /new CaptureService/); assert.match(main, /installDisplayMediaHandler/);
});

test("packaged Electron CSP keeps provider connections out of Renderer", async () => {
  const csp = await source("electron/main/security/csp.ts");
  assert.match(csp, /devServerUrl \? .*ws: wss:/s);
  assert.match(csp, /: "'self'"/);
  assert.match(csp, /connect-src \$\{connect\}/);
});
