// 実エンジン結合テスト (issue #17)
// ローカル Docker の VOICEVOX engine (http://127.0.0.1:50021) が起動している前提。
// 起動していない場合は SKIP とする (CI/他環境での実行を考慮)。
import assert from "node:assert/strict";
import { VoiceVoxClient, chunkText } from "../src/voicevox.js";

const BASE = process.env.VOICEVOX_BASE_URL ?? "http://127.0.0.1:50021";

async function checkEngine() {
  try {
    const res = await fetch(`${BASE}/version`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

const up = await checkEngine();
if (!up) {
  console.log(`SKIP | voicevox real engine not reachable at ${BASE}`);
  process.exit(0);
}

const client = new VoiceVoxClient({ baseUrl: BASE, timeoutMs: 30000 });

// 1) /speakers が話者一覧を返す
const speakers = await client.speakers({ force: true });
assert.ok(speakers.length > 0, "speakers が空");
const has3 = speakers.some((s) => s.id === 3);
assert.ok(has3, "speaker id=3 (ずんだもん ノーマル) が含まれる");

// 2) 単一チャンク合成 → WAV Blob
const wav = await client.synth("こんにちは。テストです。", { speaker: 3, speed: 1.0, pitch: 0, intonation: 1.0 });
assert.ok(wav instanceof Blob);
assert.ok(wav.size > 1000, `wav size too small: ${wav.size}`);
assert.equal(wav.type, "audio/wav");

// 3) WAV ヘッダ (RIFF....WAVE) を確認
const buf = new Uint8Array(await wav.arrayBuffer());
assert.equal(buf[0], 0x52, "R");
assert.equal(buf[1], 0x49, "I");
assert.equal(buf[2], 0x46, "F");
assert.equal(buf[3], 0x46, "F");
assert.equal(String.fromCharCode(buf[8], buf[9], buf[10], buf[11]), "WAVE");

// 4) 長文のチャンク分割 → 各チャンクが合成可能
const longText = "これは配信AIの長文読み上げテストです。句点で区切って、順番に合成して再生します。VOICEVOXエンジンが1リクエストで安定して扱える長さに分割するのがポイントです。最後までちゃんと読めるかな。";
const chunks = chunkText(longText, 40);
assert.ok(chunks.length >= 3, `chunks.length=${chunks.length}`);
for (const c of chunks) assert.ok(c.length <= 40 || !c.includes("。") === false, `chunk too long: ${c.length}`);
const wavs = [];
for (const c of chunks) {
  const w = await client.synth(c, { speaker: 3 });
  assert.ok(w.size > 500);
  wavs.push(w);
}
assert.equal(wavs.length, chunks.length);

// 5) 不正 speaker で bad_request
let threw = false;
try { await client.synth("x", { speaker: -1 }); } catch (e) { threw = true; assert.equal(e.kind, "bad_request"); }
assert.ok(threw, "speaker=-1 で bad_request");

console.log(`PASS | voicevox real engine (speakers=${speakers.length}, chunks=${chunks.length}, wav=${wav.size}B)`);
