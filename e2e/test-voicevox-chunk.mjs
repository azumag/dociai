import assert from "node:assert/strict";
import { chunkText, VoiceVoxClient, VoiceVoxError } from "../src/voicevox.js";

// ---- chunkText: soviet_now/voicevox_tts.sh の _split_text と同じアルゴリズム ----
const cases = [
  { text: "こんにちは。", max: 200, expect: ["こんにちは。"] },
  { text: "これは1文目。これは2文目。", max: 200, expect: ["これは1文目。これは2文目。"] },
  { text: "これは1文目。これは2文目。", max: 8, expect: ["これは1文目。", "これは2文目。"] },
  {
    text: "とても長い文章を書いています、これでもかというほどに書き続けています、最後まで読めるかな。",
    max: 30,
    expect: ["とても長い文章を書いています", "これでもかというほどに書き続けています、最後まで読めるかな。"],
  },
  { text: "\n\n空行。\n\n", max: 200, expect: ["空行。"] },
  { text: "", max: 200, expect: [] },
  { text: "記号#＃は除去対象外で分割に影響しない。", max: 200, expect: ["記号#＃は除去対象外で分割に影響しない。"] },
];

for (const { text, max, expect } of cases) {
  const got = chunkText(text, max);
  assert.deepEqual(got, expect, `chunkText(${JSON.stringify(text)}, ${max}) => ${JSON.stringify(got)} (expect ${JSON.stringify(expect)})`);
}

// maxChars が小さすぎても無限ループしない & 1チャンクは必ず1以上
const tiny = chunkText("あいうえおかきくけこさしすせそ", 8);
assert.ok(tiny.length >= 1);
for (const c of tiny) assert.ok(c.length > 0);

// ---- VoiceVoxClient: fetch をモック ----
let lastCall = null;
globalThis.fetch = async (url, init) => {
  lastCall = { url: String(url), init };
  if (url.includes("/speakers")) {
    return {
      ok: true,
      json: async () => [
        {
          name: "ずんだもん",
          styles: [
            { id: 3, name: "ノーマル", type: "talk" },
            { id: 1, name: "あまあま", type: "talk" },
          ],
        },
      ],
    };
  }
  if (url.includes("/audio_query")) {
    return {
      ok: true,
      json: async () => ({
        accent_phrases: [{ moras: [{ text: "テ" }], accent: 1, is_interrogative: false }],
        speedScale: 1.0,
        pitchScale: 0.0,
        intonationScale: 1.0,
        volumeScale: 1.0,
        prePhonemeLength: 0.1,
        postPhonemeLength: 0.1,
        outputSamplingRate: 24000,
        outputStereo: false,
        kana: "テ'_スト",
      }),
    };
  }
  if (url.includes("/synthesis")) {
    return {
      ok: true,
      blob: async () => new Blob([new Uint8Array([0x52, 0x49, 0x46, 0x46])], { type: "audio/wav" }),
    };
  }
  return { ok: false, status: 404, text: async () => "not found" };
};

const client = new VoiceVoxClient({ baseUrl: "http://example:50021", timeoutMs: 5000 });

// speakers: style id 単位に展開される
const speakers = await client.speakers({ force: true });
assert.equal(speakers.length, 2);
assert.equal(speakers[0].id, 3);
assert.equal(speakers[0].speaker, "ずんだもん");
assert.equal(speakers[0].style, "ノーマル");
assert.ok(lastCall.url.startsWith("http://example:50021/speakers"));

// synth: audio_query → synthesis の2段階、scale が適用される
const wav = await client.synth("こんにちは。", { speaker: 3, pitch: -0.05, speed: 1.1, intonation: 1.2, volume: 0.9 });
assert.ok(wav instanceof Blob);
assert.ok(wav.size > 0);

// audio_query の呼び出し引数
const aq = client; // 最後の synthesis 呼び出しよりも前に audio_query が呼ばれている
// synth は audio_query → synthesis の順なので、最後の lastCall は synthesis
assert.ok(lastCall.url.includes("/synthesis?speaker=3"));
// body に scale 系が反映されていることを確認 (synthesis への body)
const synthBody = JSON.parse(lastCall.init.body);
assert.equal(synthBody.speedScale, 1.1);
assert.equal(synthBody.pitchScale, -0.05);
assert.equal(synthBody.intonationScale, 1.2);
assert.equal(synthBody.volumeScale, 0.9);

// speaker 不正
await assert.rejects(() => client.synth("x", { speaker: "abc" }), VoiceVoxError);
// 空テキスト
await assert.rejects(() => client.synth("   ", { speaker: 3 }), VoiceVoxError);
// # は除去される (synth がエラーにならないことだけ確認 — モックはテキストを問わないので)
const wav2 = await client.synth("##テスト##", { speaker: 3 });
assert.ok(wav2 instanceof Blob);

console.log("PASS | voicevox chunkText + client unit");
