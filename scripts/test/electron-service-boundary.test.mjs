import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(new URL("../..", import.meta.url).pathname);
async function source(relative) { return fs.readFile(path.join(root, relative), "utf8"); }

test("Electron renderer adapters route every external service through Main IPC", async () => {
  const [connectors, news, topics, voicevox, bouyomi, runtimeFactory, platform, captureAdapter, preload, ipc, main, boot] = await Promise.all([
    // issue #187: feed-fetch IPC gating moved from src/news-reader.js (now a compatibility
    // facade delegating to NewsPipelineCoordinator) into the legacy adapter it wraps.
    source("src/connectors.js"), source("src/news/adapters/legacy-news-adapter.js"), source("src/topic-reader.js"), source("src/voicevox.js"), source("src/bouyomi.js"), source("src/app/runtime-factory.js"), source("src/platform/electron-services.js"), source("src/platform/capture-adapter.js"), source("electron/preload/index.ts"), source("electron/main/ipc/register.ts"), source("electron/main/index.ts"), source("src/app/boot.js"),
  ]);
  assert.match(connectors, /hasElectronAiService\(\)/); assert.match(news, /hasElectronFeedService\(\)/); assert.match(topics, /hasElectronTopicService\(\)/);
  assert.match(voicevox, /hasElectronVoiceVoxService\(\)/); assert.match(bouyomi, /window\?\.dociai\?\.(?:bouyomi|speech)/); assert.match(runtimeFactory, /dociai\?\.twitch\?\.start/);
  assert.match(platform, /globalThis\.dociai\.speech\.voicevox/); assert.match(platform, /globalThis\.dociai\.twitch/);
  assert.match(captureAdapter, /globalThis\.dociai\?\.capture/);
  // #405 fix: 設定保存は window.dociai.config/secrets IPC (Main の config.json + safeStorage) を
  // 経由する。config.local.json への直接PUTは405になるread-only プロトコルなので使わない。
  assert.match(platform, /globalThis\.dociai\.config\.get/); assert.match(platform, /globalThis\.dociai\.config\.save/); assert.match(platform, /globalThis\.dociai\.secrets\.set/);
  // issue #188: article本文取得はElectron Main限定 (SafeHttpClient経由)。Rendererが任意URLへ
  // 直接fetchしないことをここでも固定する。
  assert.match(platform, /hasElectronNewsArticleService\(\)/); assert.match(platform, /globalThis\.dociai\.newsArticles\.fetch/);
  assert.match(boot, /hasElectronConfigService\(\)/);
  for (const channel of ["SPEECH_VOICEVOX_SPEAKERS", "SPEECH_VOICEVOX_SYNTHESIZE", "SPEECH_BOUYOMI_TALK", "SPEECH_BOUYOMI_CLEAR", "TWITCH_START", "TWITCH_STOP", "TWITCH_RECONNECT", "SHORTCUT_STATUS", "CAPTURE_LIST_SOURCES", "CAPTURE_SELECT_SOURCE", "CAPTURE_STATUS", "UPDATE_CHECK", "UPDATE_DOWNLOAD", "UPDATE_QUIT_AND_INSTALL", "CONFIG_GET", "CONFIG_SAVE", "SECRET_SET", "NEWS_ARTICLE_FETCH", "NEWS_ARTICLE_CANCEL"]) { assert.match(preload, new RegExp(`CHANNELS\\.${channel}`)); assert.match(ipc, new RegExp(`CHANNELS\\.${channel}`)); }
  assert.match(main, /new SpeechBackendService/); assert.match(main, /new TwitchChatService/);
  assert.match(main, /new NewsSourceService/);
  assert.match(main, /new ShortcutService/);
  assert.match(main, /new CaptureService/); assert.match(main, /installDisplayMediaHandler/);
  // Auto-update (macOS + Windows — see update-service.ts's header comment): must never be
  // constructed for a dev/unpackaged run or an unsupported platform, since electron-updater throws
  // reaching for `app-update.yml`/`dev-app-update.yml` outside a real packaged build.
  assert.match(main, /new UpdateService/);
  assert.match(main, /process\.platform === "darwin" \|\| process\.platform === "win32"/);
});

test("packaged Electron CSP keeps provider connections out of Renderer", async () => {
  const csp = await source("electron/main/security/csp.ts");
  assert.match(csp, /devServerUrl \? .*ws: wss:/s);
  assert.match(csp, /: "'self'"/);
  assert.match(csp, /connect-src \$\{connect\}/);
});
