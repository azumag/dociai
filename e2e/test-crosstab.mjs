// クロスタブBroadcastChannel配送の実測 (headed Chrome, 一時プロファイル)
// 操作卓でコメント送信 → 別タブの obs.html に届くことを確認する。
import puppeteer from "puppeteer-core";

const CHROME = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.env.BASE_URL ?? "http://localhost:8080";

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  protocolTimeout: 20000,
  args: ["--no-first-run", "--mute-audio", "--disable-speech-api", "--window-size=1100,750", "--window-position=60,60"],
});

try {
  const page = await browser.newPage();
  await page.goto(`${BASE}/`, { waitUntil: "networkidle0" });
  await page.waitForFunction(
    () => document.querySelector("#config-status")?.textContent.includes("読込済"),
    { timeout: 8000 },
  );

  const obs = await browser.newPage();
  await obs.goto(`${BASE}/obs.html`, { waitUntil: "domcontentloaded" });

  // 操作卓からコメント送信 (keyword「AIさん」でモックAI応答も発生する)
  // 注: バックグラウンドタブではrAFベースのwaitForFunctionが動かないため、
  // evaluateによる手動ポーリングで確認する
  await page.evaluate(() => {
    document.querySelector("#comment-author").value = "クロスタブ検証";
    document.querySelector("#comment-text").value = "AIさん、クロスタブ配送テスト";
    document.querySelector("#comment-form").requestSubmit();
  });

  const poll = async (label, fn) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (await obs.evaluate(fn)) {
        console.log(`PASS | ${label}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`FAIL | ${label} (10秒待っても届かず)`);
  };

  await poll("クロスタブ: OBSページに操作卓のコメントが届いた", () =>
    document.querySelector("#obs-comment")?.hidden === false &&
    document.querySelector(".obs-root").textContent.includes("クロスタブ配送テスト"));

  await poll("クロスタブ: OBSページにAI応答が届いた", () =>
    document.querySelector("#obs-reply")?.hidden === false &&
    document.querySelector("#obs-reply-text").textContent.includes("モック応答"));

  console.log("==== cross-tab OK ====");
} finally {
  await browser.close();
}
