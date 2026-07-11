import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(new URL("../..", import.meta.url).pathname);
async function source(relative) { return fs.readFile(path.join(root, relative), "utf8"); }

test("Electron renderer adapters route every external service through Main IPC", async () => {
  const [connectors, news, topics, voicevox, bouyomi, app, platform, preload, ipc, main] = await Promise.all([
    source("src/connectors.js"), source("src/news-reader.js"), source("src/topic-reader.js"), source("src/voicevox.js"), source("src/bouyomi.js"), source("src/app.js"), source("src/platform/electron-services.js"), source("electron/preload/index.ts"), source("electron/main/ipc/register.ts"), source("electron/main/index.ts"),
  ]);
  assert.match(connectors, /hasElectronAiService\(\)/); assert.match(news, /hasElectronFeedService\(\)/); assert.match(topics, /hasElectronTopicService\(\)/);
  assert.match(voicevox, /hasElectronVoiceVoxService\(\)/); assert.match(bouyomi, /window\?\.dociai\?\.(?:bouyomi|speech)/); assert.match(app, /hasElectronTwitchService\(\)/);
  assert.match(platform, /globalThis\.dociai\.speech\.voicevox/); assert.match(platform, /globalThis\.dociai\.twitch/);
  for (const channel of ["SPEECH_VOICEVOX_SPEAKERS", "SPEECH_VOICEVOX_SYNTHESIZE", "SPEECH_BOUYOMI_TALK", "SPEECH_BOUYOMI_CLEAR", "TWITCH_START", "TWITCH_STOP", "TWITCH_RECONNECT", "SHORTCUT_STATUS"]) { assert.match(preload, new RegExp(`CHANNELS\\.${channel}`)); assert.match(ipc, new RegExp(`CHANNELS\\.${channel}`)); }
  assert.match(main, /new SpeechBackendService/); assert.match(main, /new TwitchChatService/);
  assert.match(main, /new ShortcutService/);
});

test("packaged Electron CSP keeps provider connections out of Renderer", async () => {
  const csp = await source("electron/main/security/csp.ts");
  assert.match(csp, /devServerUrl \? .*ws: wss:/s);
  assert.match(csp, /: "'self'"/);
  assert.match(csp, /connect-src \$\{connect\}/);
});
