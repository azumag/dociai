// dociai PoC E2E検証 (ヘッドレスChrome + puppeteer-core)
// モック設定 (config.local.json) で コメント→トリガー→ペルソナ→AI応答→読み上げキュー→OBS表示 を実測する。
import puppeteer from "puppeteer-core";

const CHROME = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.env.BASE_URL ?? "http://localhost:8080";
const SHOT_DIR = process.env.SHOT_DIR ?? ".";
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? ` | ${detail}` : ""}`);
};
const step = (msg) => console.log(`STEP | ${msg}`);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  protocolTimeout: 20000,
  // ヘッドレスでは speechSynthesis がイベントを返さないことがあるため無効化し、
  // SpeechQueue は未対応環境 (failed) のパスで検証する
  args: [
    "--no-first-run",
    "--mute-audio",
    "--disable-speech-api",
    // ヘッドレスで同一サイトのタブが同一レンダラに同居すると
    // BroadcastChannel配送でメインスレッドが固まる事象があるため、タブごとにプロセスを分ける
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

  // ---- issue #1/#2: 起動と設定自動読込 ----
  await page.goto(`${BASE}/`, { waitUntil: "networkidle0" });
  await page.waitForFunction(
    () => document.querySelector("#config-status")?.textContent.includes("読込済"),
    { timeout: 5000 },
  );
  check("設定の自動読込 (サーバーからfetch)", true,
    await page.$eval("#config-status", (el) => el.textContent));

  const connectors = await page.$eval("#connector-list", (el) => el.textContent);
  check("コネクタ一覧表示 (mock)", connectors.includes("mock_main") && connectors.includes("(不要)"), connectors.trim().slice(0, 80));

  const tally = await page.$eval("#tally", (el) => el.textContent);
  check("タリーランプにペルソナ表示", tally.includes("相棒AI") && tally.includes("ツッコミAI"), tally);

  // ---- issue #115: integration health summary/detail/diagnostic export ----
  const integrationHealth = await page.evaluate(() => ({
    summary: document.querySelector("#integration-health-summary")?.textContent,
    cards: document.querySelectorAll("#integration-health-mini-list .integration-card").length,
    labels: [...document.querySelectorAll("#integration-health-summary [data-status]")].map((element) => element.getAttribute("aria-label")),
  }));
  check("連携ヘルスの一画面サマリー", integrationHealth.cards > 0 && integrationHealth.summary.includes("正常") && integrationHealth.labels.every(Boolean), JSON.stringify(integrationHealth));
  await page.click("#btn-integrations-open");
  const integrationDialog = await page.$eval("#integration-health-dialog", (dialog) => ({ open: dialog.open, title: dialog.querySelector("h2")?.textContent, list: dialog.querySelectorAll(".integration-card").length }));
  check("連携ヘルス詳細パネルが開く", integrationDialog.open && integrationDialog.title.includes("連携ヘルス") && integrationDialog.list > 0, JSON.stringify(integrationDialog));
  await page.click("#integration-health-dialog > .btn-row button:nth-child(3)");
  const exportDialog = await page.$eval("#diagnostic-export-dialog", (dialog) => ({ open: dialog.open, preview: dialog.querySelector("pre")?.textContent }));
  check("診断エクスポートのプレビュー", exportDialog.open && exportDialog.preview.includes("dociai.integration-diagnostic.v1") && !/apiKey|token|prompt|payload|absolutePath/i.test(exportDialog.preview), exportDialog.preview.slice(0, 100));
  await page.click("#diagnostic-export-dialog .btn-row button");
  await page.click("#integration-health-dialog > .btn-row button:last-child");

  // ---- issue #35: コメント読み上げ主体の画面構成 ----
  const commentFirstUi = await page.evaluate(() => ({
    heading: document.querySelector(".panel-comments-primary h1")?.textContent,
    center: document.querySelector("#comment-log")?.closest(".col")?.classList.contains("col-center"),
    readerStatus: document.querySelector("#comment-reader-status")?.textContent,
    controlsLeft: document.querySelector("#speech-list")?.closest(".col")?.classList.contains("col-left"),
  }));
  check("コメント読み上げが中央の主画面", commentFirstUi.heading === "コメント読み上げ" && commentFirstUi.center, JSON.stringify(commentFirstUi));
  check("読み上げ状態とキュー操作が左に集約", commentFirstUi.controlsLeft && commentFirstUi.readerStatus.includes("読み上げ"), commentFirstUi.readerStatus);

  // ---- issue #13: 永続ストレージにAPIキーなし ----
  const storage = await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }));
  check("localStorage/sessionStorageに保存なし", storage.local === 0 && storage.session === 0, JSON.stringify(storage));
  const eventLog1 = await page.$eval("#event-log", (el) => el.textContent);
  check("APIキー残留チェックのログ出力", eventLog1.includes("残留なし"), "");

  // ---- 診断プローブ: BroadcastChannel ----
  step("probe BroadcastChannel");
  const bc = await page.evaluate(() => {
    const c = new BroadcastChannel("probe");
    c.postMessage({ t: 1 });
    c.close();
    return "bc-ok";
  });
  step(`BroadcastChannel probe => ${bc}`);

  // ---- issue #5/#7/#3: コメント→keywordトリガー→モックAI応答 ----
  step("fill + submit comment");
  await page.evaluate(() => {
    document.querySelector("#comment-author").value = "テスト太郎";
    document.querySelector("#comment-text").value = "AIさん、今日の配信どうですか";
    document.querySelector("#comment-form").requestSubmit();
  });
  step("submitted");

  await page.waitForFunction(
    () => document.querySelector("#comment-log")?.textContent.includes("AIさん、今日の配信どうですか"),
    { timeout: 3000 },
  );
  check("コメントがログに追加される", true);

  await page.waitForFunction(
    () => document.querySelector("#reply-log")?.textContent.includes("相棒AI"),
    { timeout: 5000 },
  );
  const reply = await page.$eval("#reply-log", (el) => el.textContent);
  check("keywordトリガーで相棒AIが応答 (モック)", reply.includes("モック応答"), reply.trim().slice(0, 100));
  check("応答にトリガーIDが表示される", reply.includes("mention_ai"), "");

  // ---- issue #6: プロンプトデバッグ表示 ----
  const debug = await page.$eval("#debug-prompt", (el) => el.textContent);
  check("プロンプトデバッグに直近コメントが入る",
    debug.includes("直近のコメント") && debug.includes("AIさん、今日の配信どうですか") && debug.includes("共通ルール"),
    debug.slice(0, 60).replace(/\n/g, " "));

  // ---- issue #8: 音声キューに投入され状態が出る ----
  const speech = await page.$eval("#speech-list", (el) => el.textContent);
  check("音声キューにアイテムが入る", speech.includes("相棒AI"), speech.trim().slice(0, 100));

  // ---- issue #4: クールダウン (2通目は応答しない) ----
  step("second comment (cooldown)");
  await page.evaluate(() => {
    document.querySelector("#comment-text").value = "AIさんもう一回";
    document.querySelector("#comment-form").requestSubmit();
  });
  await page.waitForFunction(
    () => document.querySelector("#event-log")?.textContent.includes("クールダウン中"),
    { timeout: 3000 },
  );
  check("クールダウン中はスキップされログに残る", true);

  // ---- issue #4: 無効化ペルソナは反応しない (手動発話でも) ----
  step("disable persona + manual fire");
  await page.click("#persona-list li:nth-child(1) .switch .track");
  await page.click("#persona-list li:nth-child(1) button");
  await page.waitForFunction(
    () => document.querySelector("#event-log")?.textContent.includes("無効化中"),
    { timeout: 3000 },
  );
  check("無効化ペルソナは手動発話でもスキップ", true);
  await page.click("#persona-list li:nth-child(1) .switch .track"); // 元に戻す

  // ---- issue #7: 手動トリガー発火 (トリガー一覧の発火ボタン = mention_ai) ----
  step("manual trigger fire");
  const replyCountBefore = await page.$eval("#reply-log", (el) => el.children.length);
  await page.click("#trigger-list li:nth-child(1) button");
  await page.waitForFunction(
    (n) => document.querySelector("#reply-log")?.children.length > n,
    { timeout: 5000 },
    replyCountBefore,
  );
  check("トリガー手動発火で応答が増える", true);

  // ---- issue #10: ニュース (mockソース) 取得→要約→キュー投入 ----
  step("news read");
  await page.click("#btn-news-read");
  await page.waitForFunction(
    () => document.querySelector("#news-status")?.textContent.includes("既読 2件"),
    { timeout: 5000 },
  );
  const newsStatus = await page.$eval("#news-status", (el) => el.textContent);
  check("ニュース取得→AI要約→応答ログ (mock)", true, newsStatus);
  const replyAfterNews = await page.$eval("#reply-log", (el) => el.textContent);
  check("ニュース応答がAI応答ログに載る", replyAfterNews.includes("news"), "");
  const eventLog2 = await page.$eval("#event-log", (el) => el.textContent);
  check("ニュース候補ログ (3件中2件読み上げ)", eventLog2.includes("ニュース候補 3件"), "");

  // 既読管理: もう一度読むと残り1件だけ
  await page.click("#btn-news-read");
  await page.waitForFunction(
    () => document.querySelector("#news-status")?.textContent.includes("既読 3件"),
    { timeout: 5000 },
  );
  check("既読ニュースは重複して読まない (既読3件で打ち止め)", true);

  // ---- issue #8: 停止/全消去ボタン ----
  step("speech controls");
  await page.click("#btn-speech-stop");
  const paused = await page.$eval("#speech-state", (el) => el.textContent);
  check("読み上げ停止で「停止中」表示", paused.includes("停止中"), paused);
  await page.click("#btn-speech-clear");
  await page.click("#btn-speech-resume");

  // ---- 画面キャプチャパネル (issue #9): 有効設定でボタン活性 ----
  const screenStatus = await page.$eval("#screen-status", (el) => el.textContent);
  const startEnabled = await page.$eval("#btn-screen-start", (el) => !el.disabled);
  const readDisabled = await page.$eval("#btn-screen-read", (el) => el.disabled);
  check("画面キャプチャ: 共有前は開始のみ活性・読み取り不活性", startEnabled && readDisabled, screenStatus.trim().slice(0, 60));

  // ---- マイク監視パネル (issue #32): 監視開始前はボタン活性状態のみ確認 ----
  // 実マイクでのVAD自体はheadlessでは検証しない (要 --use-fake-device-for-media-stream 等)
  const micStatus = await page.$eval("#mic-status", (el) => el.textContent);
  const micStartEnabled = await page.$eval("#btn-mic-start", (el) => !el.disabled);
  const micStopDisabled = await page.$eval("#btn-mic-stop", (el) => el.disabled);
  check("マイク監視: 開始前は開始のみ活性・停止不活性", micStartEnabled && micStopDisabled, micStatus.trim().slice(0, 60));

  const speechFinal = await page.$eval("#speech-list", (el) => el.textContent);
  console.log("INFO | 音声キュー最終状態:", speechFinal.trim().slice(0, 200));
  await page.screenshot({ path: `${SHOT_DIR}/console-ui.png` });

  // ---- issue #14: OBS表示の描画ロジック ----
  // 注: ヘッドレス+puppeteerでは2ページ同時オープン後のElementHandle操作が
  // ハングする問題があるため、obs.jsの描画は同一ページ内の別チャンネルインスタンス
  // からの自己送信で検証する (クロスタブ配送は headed テストで別途実測)。
  step("open obs page");
  const obs = await browser.newPage();
  await obs.setViewport({ width: 900, height: 500 });
  obs.on("pageerror", (e) => pageErrors.push("obs: " + String(e)));
  await obs.goto(`${BASE}/obs.html?transparent=1`, { waitUntil: "domcontentloaded" });
  await obs.waitForFunction(() => document.querySelector("#obs-connection")?.dataset.state === "connected", { timeout: 5000 });
  const handshakeStatus = await obs.$eval("#obs-connection", (el) => el.textContent);
  check("OBS client handshakeで最新snapshotへ接続", handshakeStatus.includes("接続済み"), handshakeStatus);

  step("obs self-send events");
  await obs.evaluate(() => {
    const c = new BroadcastChannel("dociai-obs");
    c.postMessage({ type: "comment", payload: { author: "テスト太郎", text: "OBS連携テストです", time: 1 } });
    c.postMessage({ type: "reply", payload: { personaId: "partner_ai", personaName: "相棒AI", color: "hsl(145 65% 62%)", text: "モック応答をOBSに表示します", time: 2 } });
    c.postMessage({ type: "speech", payload: { state: "speaking", personaId: "partner_ai", personaName: "相棒AI", text: "読み上げ中" } });
    c.close();
  });

  await obs.waitForFunction(
    () => document.querySelector("#obs-reply")?.hidden === false,
    { timeout: 5000 },
  );
  const obsRoot = await obs.evaluate(() => document.querySelector(".obs-root").textContent);
  check("OBS表示に最新コメントが出る", obsRoot.includes("OBS連携テスト"), "");
  check("OBS表示にAI応答が出る", obsRoot.includes("モック応答をOBSに表示します"), "");
  check("OBS表示にON AIRランプが出る", obsRoot.includes("ON AIR — 相棒AI"), "");
  const obsTransparent = await obs.evaluate(() => document.body.classList.contains("transparent"));
  check("OBS透明背景モード (?transparent=1)", obsTransparent, "");
  await obs.screenshot({ path: `${SHOT_DIR}/obs-ui.png` });

  // ---- JSエラーなし ----
  check("ページエラー (pageerror/console.error) なし", pageErrors.length === 0, pageErrors.join(" / ").slice(0, 300));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
