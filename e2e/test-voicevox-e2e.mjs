// VoiceVox 音声キューのブラウザE2E (issue #17)
// モックAI応答 → voicevoxエンジンで合成 → <audio> で再生、をpuppeteerで実測する。
//前提:
//   - http.server が BASE_URL (既定 http://localhost:8080) で動いている
//   - config.local.json は voicevox.enabled=true, mock_test コネクタ, ペルソナが
//     engine:"voicevox" + speaker を指定した最小構成になっていること
//   - VOICEVOX engine が VOICEVOX_BASE_URL (既定 http://127.0.0.1:50021) で動いている
import puppeteer from "puppeteer-core";

const CHROME = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.env.BASE_URL ?? "http://localhost:8080";
const VV = process.env.VOICEVOX_BASE_URL ?? "http://127.0.0.1:50021";

async function engineUp() {
  try { return (await fetch(`${VV}/version`, { signal: AbortSignal.timeout(2000) })).ok; }
  catch { return false; }
}

if (!(await engineUp())) {
  console.log(`SKIP | voicevox engine not reachable at ${VV}`);
  process.exit(0);
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? ` | ${detail}` : ""}`);
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  protocolTimeout: 30000,
  args: [
    "--no-first-run",
    "--mute-audio",
    // Web Speech API は使わないが、自動voiceschanged取得を止めないため殺さない
    "--autoplay-policy=no-user-gesture-required",
    "--disable-features=ProcessPerSiteUpToMainFrameThreshold",
    "--window-size=1440,1000",
  ],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") pageErrors.push(`console.error: ${m.text()}`);
  });

  await page.goto(`${BASE}/`, { waitUntil: "networkidle0" });
  await page.waitForFunction(
    () => document.querySelector("#config-status")?.textContent.includes("読込済"),
    { timeout: 8000 },
  );

  // 設定に voicevox が有効化されているか
  const vvOk = await page.evaluate(() => {
    return window.__dociaiState?.config?.voicevox?.enabled === true;
  });
  // app.js が state を globalThis に出すかどうかで分岐。出していない場合は event-log から確認。
  const vvLog = await page.$eval("#event-log", (el) => el.textContent);
  check("VOICEVOX 接続ログが出る", vvLog.includes("VOICEVOX 接続OK"), vvLog.slice(0, 200));

  // コメント投入 → keywordトリガーで相棒AIが応答 → 音声キューに投入
  await page.evaluate(() => {
    document.querySelector("#comment-author").value = "テスト太郎";
    document.querySelector("#comment-text").value = "AIさん、VOICEVOXのテストです";
    document.querySelector("#comment-form").requestSubmit();
  });
  await page.waitForFunction(
    () => document.querySelector("#comment-log")?.textContent.includes("VOICEVOXのテストです"),
    { timeout: 5000 },
  );

  // 音声キューにアイテムが入り、speaking 状態になる (合成～再生)
  await page.waitForFunction(
    () => document.querySelector("#speech-list")?.textContent.includes("発話中") ||
          document.querySelector("#speech-list")?.textContent.includes("完了"),
    { timeout: 15000 },
  );
  const speechText = await page.$eval("#speech-list", (el) => el.textContent);
  check("音声キューにvoicevoxアイテムが入る", speechText.length > 0, speechText.trim().slice(0, 120));

  // 完了まで待つ (長くても数チャンクなので 30秒)
  await page.waitForFunction(
    () => document.querySelector("#speech-list")?.textContent.includes("完了"),
    { timeout: 30000 },
  );
  const finalSpeech = await page.$eval("#speech-list", (el) => el.textContent);
  check("voicevox再生が完了する", finalSpeech.includes("完了"), finalSpeech.trim().slice(0, 120));

  // event-log にチャンク進捗または合成ログが出ている
  const eventLog = await page.$eval("#event-log", (el) => el.textContent);
  check("音声ログにVOICEVOX読み上げ完了が残る", eventLog.includes("完了"), eventLog.slice(0, 200).replace(/\n/g, " "));

  check("ページエラーなし", pageErrors.length === 0, pageErrors.join(" / ").slice(0, 300));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
