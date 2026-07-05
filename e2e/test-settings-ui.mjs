// 設定UIエディタのブラウザE2E (issue #15)
// 前提: http.server が BASE_URL で動いていて、config.local.json がモック構成。
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CHROME = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.env.BASE_URL ?? "http://localhost:8080";
const SHOT_DIR = process.env.SHOT_DIR ?? ".";
// エクスポートのダウンロード先をプロジェクトディレクトリ外に分離 (config.local.json を誤って消さないため)
const DOWNLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dociai-export-"));

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
    "--disable-speech-api",
    "--disable-features=ProcessPerSiteUpToMainFrameThreshold",
    "--window-size=1440,1000",
  ],
});

// 入力値を含めた「見えている文字列」を取得するヘルパ
const visibleText = (page) => page.evaluate(() => {
  const root = document.querySelector(".settings-body") ?? document.body;
  const parts = [];
  root.querySelectorAll("input, textarea, select").forEach((el) => {
    if (el.tagName === "SELECT") {
      parts.push(el.value || el.options[el.selectedIndex]?.textContent || "");
    } else {
      parts.push(el.value ?? "");
    }
  });
  root.querySelectorAll("label, h3, h4, p, span, div").forEach((el) => {
    if (el.children.length === 0) parts.push(el.textContent);
  });
  return parts.filter(Boolean).join("\n");
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

  // 1. 設定編集ボタンを押すとモーダルが開く
  await page.click("#btn-settings");
  await page.waitForFunction(() => document.querySelector("dialog.settings-modal")?.open === true, { timeout: 3000 });
  check("設定エディタが開く", true);

  // 2. 既定タブは connectors
  const activeTab = await page.$eval(".settings-tabs button.is-active", (el) => el.dataset.tab);
  check("既定タブは connectors", activeTab === "connectors", `active=${activeTab}`);

  // 3. コネクタID (input value) に mock_main が入っている
  const connText = await visibleText(page);
  check("コネクタ一覧に既存ID (mock_main) が表示される", connText.includes("mock_main"), connText.slice(0, 120).replace(/\n/g, " "));

  // 4. ペルソナタブ
  await page.click('.settings-tabs button[data-tab="personas"]');
  await page.waitForFunction(
    () => document.querySelector('.settings-tabs button.is-active')?.dataset.tab === "personas",
    { timeout: 2000 },
  );
  const personaText = await visibleText(page);
  check("ペルソナ一覧に相棒AI が表示される", personaText.includes("相棒AI"), personaText.slice(0, 120).replace(/\n/g, " "));

  // 5. トリガータブ
  await page.click('.settings-tabs button[data-tab="triggers"]');
  await page.waitForFunction(
    () => document.querySelector('.settings-tabs button.is-active')?.dataset.tab === "triggers",
    { timeout: 2000 },
  );
  const trigText = await visibleText(page);
  check("トリガー一覧に mention_ai が表示される", trigText.includes("mention_ai"), trigText.slice(0, 120).replace(/\n/g, " "));

  // 6. 画面・文脈タブ
  await page.click('.settings-tabs button[data-tab="context"]');
  await page.waitForFunction(
    () => document.querySelector('.settings-tabs button.is-active')?.dataset.tab === "context",
    { timeout: 2000 },
  );
  const ctxText = await visibleText(page);
  check("画面・文脈タブに screenCapture 項目が表示される",
    ctxText.includes("screenCapture") && ctxText.includes("maxTokens"), ctxText.slice(0, 120).replace(/\n/g, " "));

  // 7. VOICEVOX タブ
  await page.click('.settings-tabs button[data-tab="voicevox"]');
  await page.waitForFunction(
    () => document.querySelector('.settings-tabs button.is-active')?.dataset.tab === "voicevox",
    { timeout: 2000 },
  );
  const vvText = await visibleText(page);
  check("VOICEVOX タブに baseUrl/defaultSpeaker が表示される",
    vvText.includes("baseUrl") && vvText.includes("defaultSpeaker"), vvText.slice(0, 120).replace(/\n/g, " "));

  // 8. コネクタタブに戻して新規コネクタを追加
  await page.click('.settings-tabs button[data-tab="connectors"]');
  await page.waitForFunction(
    () => document.querySelector('.settings-tabs button.is-active')?.dataset.tab === "connectors",
    { timeout: 2000 },
  );
  await page.click(".list-header button");
  const connText2 = await visibleText(page);
  check("新規コネクタ new_connector_1 が追加される", connText2.includes("new_connector_1"), connText2.slice(0, 120).replace(/\n/g, " "));

  // 9. ペルソナを1つ追加
  await page.click('.settings-tabs button[data-tab="personas"]');
  await page.waitForFunction(
    () => document.querySelector('.settings-tabs button.is-active')?.dataset.tab === "personas",
    { timeout: 2000 },
  );
  await page.click(".list-header button");
  const pText2 = await visibleText(page);
  check("新規ペルソナ new_persona_1 が追加される", pText2.includes("new_persona_1"), pText2.slice(0, 120).replace(/\n/g, " "));

  // 10. 適用ボタン → 設定が再読み込みされる
  await page.click('.settings-footer button.primary');
  await page.waitForFunction(
    () => document.querySelector("dialog.settings-modal")?.open === false,
    { timeout: 3000 },
  );
  check("適用でモーダルが閉じる", true);
  const logText = await page.$eval("#event-log", (el) => el.textContent);
  check("適用ログが残る", logText.includes("UI編集内容で上書き適用"), logText.slice(0, 120).replace(/\n/g, " "));

  // 11. コネクタ一覧パネルに new_connector_1 が出る
  const listText = await page.$eval("#connector-list", (el) => el.textContent);
  check("適用後のコネクタ一覧に new_connector_1 が反映される", listText.includes("new_connector_1"), listText.slice(0, 120));
  // ペルソナ一覧パネルは表示名で出る (新規ペルソナ1)
  const personaListText = await page.$eval("#persona-list", (el) => el.textContent);
  check("適用後のペルソナ一覧に新規ペルソナ1 が反映される", personaListText.includes("新規ペルソナ1"), personaListText.slice(0, 120));

  // 12. エクスポートのダウンロードを捕捉
  await page.click("#btn-settings");
  await page.waitForFunction(() => document.querySelector("dialog.settings-modal")?.open === true, { timeout: 3000 });
  const client = await page.target().createCDPSession();
  await client.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: DOWNLOAD_DIR });
  // 既存のダウンロードファイルがあれば掃除
  try { fs.unlinkSync(`${DOWNLOAD_DIR}/config.local.json`); } catch {}
  const exportButtons = await page.$$('.settings-footer button');
  for (const b of exportButtons) {
    const t = await page.evaluate((el) => el.textContent, b);
    if (t.includes("JSONエクスポート")) { await b.click(); break; }
  }
  // ダウンロード完了待ち
  let exported = false;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (fs.existsSync(`${DOWNLOAD_DIR}/config.local.json`)) { exported = true; break; }
  }
  check("JSONエクスポートでファイルがダウンロードされる", exported);
  if (exported) {
    const json = JSON.parse(fs.readFileSync(`${DOWNLOAD_DIR}/config.local.json`, "utf8"));
    check("エクスポートJSONに connectors/personas がある", !!json.connectors && Array.isArray(json.personas));
    check("エクスポートJSONに追加した new_connector_1 が含まれる", !!json.connectors.new_connector_1);
    check("エクスポートJSONに追加した new_persona_1 が含まれる", (json.personas ?? []).some((p) => p.id === "new_persona_1"));
  }

  // 13. キャンセル (ESC) でモーダルが閉じる
  //     エクスポート後にモーダルが閉じていることがあるので、開いていなければ開き直す
  const openBefore = await page.evaluate(() => document.querySelector("dialog.settings-modal")?.open === true);
  if (!openBefore) {
    await page.click("#btn-settings");
    await page.waitForFunction(() => document.querySelector("dialog.settings-modal")?.open === true, { timeout: 3000 });
  }
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () => document.querySelector("dialog.settings-modal")?.open === false,
    { timeout: 2000 },
  );
  check("ESC でモーダルが閉じる", true);

  // 13b. 閉じた状態から開き直せることも確認
  await page.click("#btn-settings");
  await page.waitForFunction(() => document.querySelector("dialog.settings-modal")?.open === true, { timeout: 3000 });
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () => document.querySelector("dialog.settings-modal")?.open === false,
    { timeout: 2000 },
  );
  check("閉じた後に開き直せる", true);

  // 14. localStorage/sessionStorage にAPIキーを書いていない (issue #13 維持)
  const storage = await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }));
  check("エディタ使用後も localStorage/sessionStorage は空", storage.local === 0 && storage.session === 0, JSON.stringify(storage));

  check("ページエラーなし", pageErrors.length === 0, pageErrors.join(" / ").slice(0, 300));
  await page.screenshot({ path: `${SHOT_DIR}/settings-ui.png` });
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
