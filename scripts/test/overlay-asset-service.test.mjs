import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
async function loadModules() {
  const result = await build({ stdin: { contents: [
    `export { resolveAppPaths, ensureAppPaths } from "./electron/main/paths.ts";`,
    `export { validateOverlayAssetBytes, sanitizeOverlayAssetDisplayName } from "./electron/main/services/overlay-assets/overlay-asset-validator.ts";`,
    `export { OverlayAssetService } from "./electron/main/services/overlay-assets/overlay-asset-service.ts";`,
    `export { OverlayAssetRepository } from "./electron/main/services/overlay-assets/overlay-asset-repository.ts";`,
    `export { OverlayAssetUrlResolver } from "./electron/main/services/overlay-assets/overlay-asset-url-resolver.ts";`,
  ].join("\n"), resolveDir: repoRoot, sourcefile: "overlay-assets-test.ts", loader: "ts" }, bundle: true, format: "esm", platform: "node", write: false });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-overlay-module-")); const file = path.join(directory, "modules.mjs"); await fs.writeFile(file, result.outputFiles[0].text); return { modules: await import(file), directory };
}
function png(width = 2, height = 3) { const bytes = Buffer.alloc(32); Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20); return bytes; }
function wav() { const bytes = Buffer.alloc(46); bytes.write("RIFF", 0); bytes.writeUInt32LE(38, 4); bytes.write("WAVEfmt ", 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(8000, 28); bytes.writeUInt16LE(1, 32); bytes.writeUInt16LE(8, 34); bytes.write("data", 36); bytes.writeUInt32LE(2, 40); return bytes; }
function mp3() { const bytes = Buffer.alloc(417); Buffer.from([0xff, 0xfb, 0x90, 0x64]).copy(bytes); return bytes; }
function ogg() { const bytes = Buffer.alloc(58); bytes.write("OggS", 0); bytes[5] = 2; bytes[26] = 1; bytes[27] = 30; bytes[28] = 1; bytes.write("vorbis", 29); return bytes; }
async function fixture(modules, root, selected, references = [], decodeImage = (bytes) => ({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) })) { const paths = modules.resolveAppPaths(root); modules.ensureAppPaths(paths); const service = new modules.OverlayAssetService({ paths, chooseFile: async () => selected.value, findReferences: async () => references, decodeImage, decodeAudio: async () => ({ durationMs: 250 }), clock: () => new Date("2026-07-15T00:00:00.000Z"), randomId: () => "11111111-1111-4111-8111-111111111111" }); await service.initialize(); return { paths, service }; }

test("validator detects supported magic bytes, rejects spoofed/unsafe formats, and enforces dimensions", async () => {
  const { modules, directory } = await loadModules(); try {
    assert.deepEqual(modules.validateOverlayAssetBytes(png()).image, { width: 2, height: 3, animated: false }); assert.equal(modules.validateOverlayAssetBytes(wav()).mimeType, "audio/wav"); assert.equal(modules.validateOverlayAssetBytes(mp3()).mimeType, "audio/mpeg"); assert.equal(modules.validateOverlayAssetBytes(ogg()).mimeType, "audio/ogg");
    assert.throws(() => modules.validateOverlayAssetBytes(Buffer.from("<svg><script/></svg>")), (error) => error.code === "UNSUPPORTED_FORMAT"); assert.throws(() => modules.validateOverlayAssetBytes(Buffer.from([0xff, 0xf1, 0x50, 0x80, 0, 0, 0, 0])), (error) => error.code === "UNSUPPORTED_FORMAT"); assert.throws(() => modules.validateOverlayAssetBytes(Buffer.from("RIFF0000WAVE....fmt ....data")), (error) => error.code === "UNSUPPORTED_FORMAT"); assert.throws(() => modules.validateOverlayAssetBytes(Buffer.from("ID3 plus no MPEG frame")), (error) => error.code === "UNSUPPORTED_FORMAT"); assert.throws(() => modules.validateOverlayAssetBytes(png(), "audio"), (error) => error.code === "MIME_MISMATCH"); assert.throws(() => modules.validateOverlayAssetBytes(png(8193, 1)), (error) => error.code === "DIMENSION_OVERSIZE"); const huge = Buffer.alloc(20 * 1024 * 1024 + 1); png().copy(huge); assert.throws(() => modules.validateOverlayAssetBytes(huge), (error) => error.code === "ASSET_OVERSIZE"); assert.equal(modules.sanitizeOverlayAssetDisplayName("../\u0000 日 本 語.png"), "日 本 語.png");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("service imports managed image/audio, deduplicates SHA-256, and never exposes paths", async () => {
  const { modules, directory } = await loadModules(); const root = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-overlay-service-")); try {
    const imageFile = path.join(root, "画像\u0001.png"); await fs.writeFile(imageFile, png()); const selected = { value: imageFile }; const { paths, service } = await fixture(modules, root, selected);
    const first = await service.import("image"); assert.equal(first.deduplicated, false); assert.equal(first.asset.image.width, 2); assert.equal(first.asset.displayName, "画像.png"); assert.equal("storedFileName" in first.asset, false); assert.equal(JSON.stringify(first).includes(root), false);
    const duplicate = await service.import("image"); assert.equal(duplicate.deduplicated, true); assert.equal((await service.list()).assets.length, 1);
    selected.value = path.join(root, "sound.wav"); await fs.writeFile(selected.value, wav()); const audioService = new modules.OverlayAssetService({ paths, chooseFile: async () => selected.value, findReferences: async () => [], decodeAudio: async () => ({ durationMs: 250 }), randomId: () => "22222222-2222-4222-8222-222222222222" }); const audio = await audioService.import("audio"); assert.equal(audio.asset.mimeType, "audio/wav"); assert.equal(audio.asset.audio.durationMs, 250); assert.equal((await audioService.list()).assets.length, 2);
    const raw = await fs.readFile(paths.overlayAssetRegistryFile, "utf8"); assert.equal(raw.includes(root), false); assert.match(raw, /11111111-1111-4111-8111-111111111111\.png/);
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(directory, { recursive: true, force: true }); }
});

test("service treats dialog cancellation as success and rejects extension/magic spoofing", async () => {
  const { modules, directory } = await loadModules(); const root = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-overlay-spoof-")); try {
    const selected = { value: null }; const { service } = await fixture(modules, root, selected); assert.deepEqual(await service.import(), { cancelled: true });
    selected.value = path.join(root, "fake.jpg"); await fs.writeFile(selected.value, png()); await assert.rejects(service.import("image"), (error) => error.code === "MIME_MISMATCH");
    selected.value = path.join(root, "bad.png"); await fs.writeFile(selected.value, png()); const undecodable = (await fixture(modules, path.join(root, "decode"), selected, [], () => null)).service; await assert.rejects(undecodable.import("image"), (error) => error.code === "DECODE_FAILED");
    selected.value = path.join(root, "bad.wav"); await fs.writeFile(selected.value, wav()); const audioPaths = modules.resolveAppPaths(path.join(root, "audio-decode")); modules.ensureAppPaths(audioPaths); const undecodableAudio = new modules.OverlayAssetService({ paths: audioPaths, chooseFile: async () => selected.value, findReferences: async () => [], decodeAudio: async () => null }); await undecodableAudio.initialize(); await assert.rejects(undecodableAudio.import("audio"), (error) => error.code === "DECODE_FAILED");
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(directory, { recursive: true, force: true }); }
});

test("repository backup recovery and service missing/orphan/tmp diagnostics remain non-fatal", async () => {
  const { modules, directory } = await loadModules(); const root = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-overlay-repair-")); try {
    const selected = { value: path.join(root, "a.png") }; await fs.writeFile(selected.value, png()); const { paths, service } = await fixture(modules, root, selected); await service.import("image"); await fs.writeFile(paths.overlayAssetRegistryFile, "{broken"); const recovered = await service.list(); assert.match(recovered.warnings.join(" "), /backup/); assert.equal(recovered.assets.length, 1);
    await fs.rm(path.join(paths.overlayAssetFilesDir, "11111111-1111-4111-8111-111111111111.png")); await fs.writeFile(path.join(paths.overlayAssetFilesDir, "orphan.bin"), "x"); const tmp = path.join(paths.overlayAssetTmpDir, "old.tmp"); await fs.writeFile(tmp, "x"); await fs.utimes(tmp, new Date(0), new Date(0)); await service.initialize(); const scan = await service.list(); assert.equal(scan.assets[0].missing, true); assert.equal(scan.totalBytes, 1, "physical total includes orphan bytes, not stale registry sizes"); assert.deepEqual(scan.repairCandidates.map((entry) => entry.type).sort(), ["missing-file", "orphan-file"]); await assert.rejects(fs.access(tmp));
    const repaired = await service.import("image"); assert.equal(repaired.deduplicated, true); assert.equal((await service.inspect(repaired.asset.id)).asset.missing, undefined);
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(directory, { recursive: true, force: true }); }
});

test("repository has a durable commit point and never replaces a valid backup with corrupt primary", async () => {
  const { modules, directory } = await loadModules(); const root = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-overlay-commit-")); try {
    const paths = modules.resolveAppPaths(root); modules.ensureAppPaths(paths); await fs.mkdir(paths.overlayAssetsDir, { mode: 0o700 }); await fs.mkdir(paths.overlayAssetFilesDir, { mode: 0o700 }); await fs.mkdir(paths.overlayAssetTmpDir, { mode: 0o700 });
    const record = { schemaVersion: 1, id: "33333333-3333-4333-8333-333333333333", kind: "image", displayName: "a.png", storedFileName: "33333333-3333-4333-8333-333333333333.png", mimeType: "image/png", byteLength: 32, sha256: "a".repeat(64), createdAt: "2026-07-15T00:00:00.000Z", updatedAt: "2026-07-15T00:00:00.000Z", image: { width: 2, height: 3, animated: false } };
    const failingIo = new Proxy(fs, { get(target, key) { if (key === "rename") return async (source, destination) => { if (destination === paths.overlayAssetRegistryBackupFile) { const error = new Error("backup denied"); error.code = "EACCES"; throw error; } return target.rename(source, destination); }; return target[key]; } });
    const repository = new modules.OverlayAssetRepository(paths, failingIo); const saved = await repository.save([record]); assert.equal(saved.committed, true); assert.match(saved.warnings.join(" "), /backup/); assert.equal((await new modules.OverlayAssetRepository(paths).load()).registry.assets.length, 1);
    const validBackup = `${JSON.stringify({ schemaVersion: 1, assets: [record] }, null, 2)}\n`; await fs.writeFile(paths.overlayAssetRegistryBackupFile, validBackup); await fs.writeFile(paths.overlayAssetRegistryFile, "{broken"); const recovered = await new modules.OverlayAssetRepository(paths).load(); assert.equal(recovered.recovered, true); const changed = { ...record, displayName: "changed.png", updatedAt: "2026-07-15T00:01:00.000Z" }; await new modules.OverlayAssetRepository(paths).save([changed]); assert.equal(await fs.readFile(paths.overlayAssetRegistryBackupFile, "utf8"), validBackup);
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(directory, { recursive: true, force: true }); }
});

test("registry exact schema rejects unknown fields and public DTO uses a recursive allow-list", async () => {
  const { modules, directory } = await loadModules(); const root = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-overlay-dto-")); try {
    const selected = { value: path.join(root, "a.png") }; await fs.writeFile(selected.value, png()); const { paths, service } = await fixture(modules, root, selected); await service.import("image"); const loaded = await service.repository.load(); const record = loaded.registry.assets[0];
    const poisoned = { ...record, absolutePath: "/Users/alice/secret.png", token: "secret-token", image: { ...record.image, sourceUrl: "file:///secret" } }; const bad = `${JSON.stringify({ schemaVersion: 1, assets: [poisoned] })}\n`; await fs.writeFile(paths.overlayAssetRegistryFile, bad); await fs.writeFile(paths.overlayAssetRegistryBackupFile, bad); await assert.rejects(service.list(), (error) => error.code === "REGISTRY_CORRUPT");
    service.repository.load = async () => ({ registry: { schemaVersion: 1, assets: [poisoned] }, recovered: false }); const dto = await service.list(); const serialized = JSON.stringify(dto); assert.doesNotMatch(serialized, /absolutePath|secret-token|sourceUrl|file:\/\/|storedFileName/); assert.deepEqual(dto.assets[0].image, { width: 2, height: 3, animated: false });
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(directory, { recursive: true, force: true }); }
});

test("remove refuses references; playback uses opaque handles, strict lookup, MIME and ranges", async () => {
  const { modules, directory } = await loadModules(); const root = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-overlay-playback-")); try {
    const selected = { value: path.join(root, "sound.wav") }; await fs.writeFile(selected.value, wav()); const refs = []; const { service } = await fixture(modules, root, selected, refs); const imported = await service.import("audio"); const id = imported.asset.id; refs.push("eventTriggers.t.actions.0.cue.audio.assetId"); await assert.rejects(service.remove(id), (error) => error.code === "ASSET_REFERENCED"); refs.length = 0;
    const resolver = new modules.OverlayAssetUrlResolver(service, () => 1000); const issued = await resolver.issue(id); assert.match(issued.handle, /^dociai-asset:\/\/asset\/[A-Za-z0-9_-]{43}$/); assert.equal(issued.handle.includes(id), false); const full = await resolver.handle(new Request(issued.handle)); assert.equal(full.status, 200); assert.equal(full.headers.get("content-type"), "audio/wav"); assert.equal(full.headers.get("cache-control"), "private, no-store"); const partial = await resolver.handle(new Request(issued.handle, { headers: { range: "bytes=0-3" } })); assert.equal(partial.status, 206); assert.equal(Buffer.from(await partial.arrayBuffer()).toString("ascii"), "RIFF"); assert.equal((await resolver.handle(new Request(issued.handle, { headers: { range: "bytes=-4" } }))).status, 206); assert.equal((await resolver.handle(new Request(issued.handle, { headers: { range: "bytes=-" } }))).status, 416); assert.equal((await resolver.handle({ method: "GET", url: issued.handle.replace("dociai-asset://", "dociai-asset://user@"), headers: new Headers() })).status, 404); assert.equal((await resolver.handle(new Request("dociai-asset://asset/" + "x".repeat(43)))).status, 404); assert.equal((await service.remove(id)).removed, true); assert.equal((await service.remove(id)).removed, false);
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(directory, { recursive: true, force: true }); }
});

test("managed playback rejects symlink and hardlink substitution", async () => {
  const { modules, directory } = await loadModules(); const root = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-overlay-links-")); try {
    const selected = { value: path.join(root, "a.png") }; await fs.writeFile(selected.value, png()); const { paths, service } = await fixture(modules, root, selected); const imported = await service.import("image"); const managed = path.join(paths.overlayAssetFilesDir, `${imported.asset.id}.png`); const outside = path.join(root, "outside.png"); await fs.writeFile(outside, png()); await fs.rm(managed); await fs.symlink(outside, managed); await assert.rejects(service.openPlayback(imported.asset.id)); await fs.rm(managed); await fs.link(outside, managed); await assert.rejects(service.openPlayback(imported.asset.id));
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(directory, { recursive: true, force: true }); }
});

test("managed directory symlink substitution is rejected before import or playback", async () => {
  const { modules, directory } = await loadModules(); const root = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-overlay-dirlink-")); const outside = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-overlay-outside-")); try {
    const paths = modules.resolveAppPaths(root); modules.ensureAppPaths(paths); await fs.symlink(outside, paths.overlayAssetsDir, "dir"); const service = new modules.OverlayAssetService({ paths, chooseFile: async () => null, findReferences: async () => [] }); await assert.rejects(service.initialize(), (error) => error.code === "FORBIDDEN");
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(outside, { recursive: true, force: true }); await fs.rm(directory, { recursive: true, force: true }); }
});

test("post-initialize root/files/tmp substitution and selected-file symlinks cannot escape import/remove", async () => {
  const { modules, directory } = await loadModules(); const root = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-overlay-postinit-")); const outside = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-overlay-postinit-out-")); try {
    const selected = { value: path.join(root, "a.png") }; await fs.writeFile(selected.value, png()); const { paths, service } = await fixture(modules, root, selected);
    const realFiles = `${paths.overlayAssetFilesDir}.real`; await fs.rename(paths.overlayAssetFilesDir, realFiles); await fs.symlink(outside, paths.overlayAssetFilesDir, "dir"); await assert.rejects(service.import("image"), (error) => error.code === "FORBIDDEN"); assert.deepEqual(await fs.readdir(outside), []); await fs.rm(paths.overlayAssetFilesDir); await fs.rename(realFiles, paths.overlayAssetFilesDir);
    const realTmp = `${paths.overlayAssetTmpDir}.real`; await fs.rename(paths.overlayAssetTmpDir, realTmp); await fs.symlink(outside, paths.overlayAssetTmpDir, "dir"); await assert.rejects(service.import("image"), (error) => error.code === "FORBIDDEN"); assert.deepEqual(await fs.readdir(outside), []); await fs.rm(paths.overlayAssetTmpDir); await fs.rename(realTmp, paths.overlayAssetTmpDir);
    const symlinkSource = path.join(root, "source-link.png"); await fs.symlink(selected.value, symlinkSource); selected.value = symlinkSource; await assert.rejects(service.import("image"), (error) => error.code === "INVALID_INPUT"); selected.value = path.join(root, "a.png"); const imported = await service.import("image");
    await fs.rename(paths.overlayAssetFilesDir, realFiles); await fs.symlink(outside, paths.overlayAssetFilesDir, "dir"); const sentinel = path.join(outside, `${imported.asset.id}.png`); await fs.writeFile(sentinel, "outside"); await assert.rejects(service.remove(imported.asset.id), (error) => error.code === "FORBIDDEN"); assert.equal(await fs.readFile(sentinel, "utf8"), "outside"); await fs.rm(paths.overlayAssetFilesDir); await fs.rename(realFiles, paths.overlayAssetFilesDir);
    const realRoot = `${paths.overlayAssetsDir}.real`; await fs.rename(paths.overlayAssetsDir, realRoot); await fs.symlink(outside, paths.overlayAssetsDir, "dir"); await assert.rejects(service.list(), (error) => error.code === "FORBIDDEN"); await fs.rm(paths.overlayAssetsDir); await fs.rename(realRoot, paths.overlayAssetsDir);
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(outside, { recursive: true, force: true }); await fs.rm(directory, { recursive: true, force: true }); }
});

test("typed IPC exposes no path input and enforces console/OBS role boundaries", async () => {
  const [contract, preload, register, channels, main, csp] = await Promise.all([
    fs.readFile(path.join(repoRoot, "electron/shared/overlay-asset-contract.ts"), "utf8"),
    fs.readFile(path.join(repoRoot, "electron/preload/index.ts"), "utf8"),
    fs.readFile(path.join(repoRoot, "electron/main/ipc/register.ts"), "utf8"),
    fs.readFile(path.join(repoRoot, "electron/shared/ipc-channels.ts"), "utf8"),
    fs.readFile(path.join(repoRoot, "electron/main/index.ts"), "utf8"),
    fs.readFile(path.join(repoRoot, "electron/main/security/csp.ts"), "utf8"),
  ]);
  assert.doesNotMatch(contract, /import\([^)]*path|getPlaybackHandle\([^)]*path/); assert.match(preload, /OVERLAY_ASSETS_IMPORT/); assert.match(channels, /overlay-assets:get-playback-handle/);
  assert.match(register, /OVERLAY_ASSETS_LIST[\s\S]*?\["console", "obs"\]/); assert.match(register, /OVERLAY_ASSETS_IMPORT[\s\S]*?\["console"\]/); assert.match(register, /OVERLAY_ASSETS_REMOVE[\s\S]*?\["console"\]/); assert.match(register, /OVERLAY_ASSETS_PLAYBACK_HANDLE[\s\S]*?\["console", "obs"\]/);
  assert.match(main, /protocol\.handle\("dociai-asset"/); assert.match(main, /dialog\.showOpenDialog/);
  assert.match(csp, /img-src[^\n]*dociai-asset:/); assert.match(csp, /media-src[^\n]*dociai-asset:/);
});
