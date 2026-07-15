// 設定UIエディタのブラウザE2E (issue #15)
// 前提: scripts/serve.py が BASE_URL で動いていて (「保存して適用」が実際にディスクへ書き込む
// ため、保存に対応しない python -m http.server では 適用時にエラー表示になり失敗する)、
// config.local.json がモック構成。
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CHROME = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.env.BASE_URL ?? "http://localhost:8080";
const SHOT_DIR = process.env.SHOT_DIR ?? ".";
// エクスポートのダウンロード先をプロジェクトディレクトリ外に分離 (config.local.json を誤って消さないため)
const DOWNLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dociai-export-"));
// 「保存して適用」は本物の config.local.json を書き換えるため、テスト後に必ず元へ戻す。
const CONFIG_PATH = process.env.CONFIG_PATH ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "config.local.json");
const originalConfigText = fs.readFileSync(CONFIG_PATH, "utf8");

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

  const semantics = await page.evaluate(() => {
    const dialog = document.querySelector("dialog.settings-modal");
    const tabs = [...dialog.querySelectorAll('[role="tab"]')];
    const panel = dialog.querySelector('[role="tabpanel"]');
    const labelledFields = [...dialog.querySelectorAll("[data-config-path]")];
    return {
      dialogLabel: dialog.getAttribute("aria-labelledby"),
      tablist: dialog.querySelector('[role="tablist"]')?.getAttribute("aria-orientation"),
      tabs: tabs.every((tab) => tab.id && tab.getAttribute("aria-controls") && tab.getAttribute("aria-selected") != null),
      panel: panel?.id && panel.getAttribute("aria-labelledby"),
      fields: labelledFields.length > 0 && labelledFields.every((field) => {
        const label = dialog.querySelector(`label[for="${CSS.escape(field.id)}"]`);
        return field.id && label && field.getAttribute("aria-labelledby") === label.id;
      }),
      live: !!dialog.querySelector("#settings-status-live[aria-live=polite]") && !!dialog.querySelector("#settings-error-live[aria-live=assertive]"),
    };
  });
  check("dialog/tab/field/live region のアクセシビリティ構造", Boolean(semantics.dialogLabel && semantics.tablist === "vertical" && semantics.tabs && semantics.panel && semantics.fields && semantics.live), JSON.stringify(semantics));

  // 2. 既定タブは connectors
  const activeTab = await page.$eval(".settings-sidebar button.is-active", (el) => el.dataset.tab);
  check("既定タブは connectors", activeTab === "connectors", `active=${activeTab}`);

  await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "tab", { timeout: 2000 });
  await page.keyboard.press("ArrowDown");
  await page.waitForFunction(() => document.querySelector('[role="tab"][aria-selected="true"]')?.dataset.tab === "personas", { timeout: 2000 });
  await page.keyboard.press("Home");
  await page.waitForFunction(() => document.querySelector('[role="tab"][aria-selected="true"]')?.dataset.tab === "connectors", { timeout: 2000 });
  check("tab は Arrow/Home で roving focus と activation を行う", true);

  // 3. コネクタID (input value) に既存のコネクタが表示されている
  const connText = await visibleText(page);
  const hasConnector = connText.includes("openai_main") || connText.includes("mock_main") || connText.includes("ollama");
  check("コネクタ一覧に既存IDが表示される", hasConnector, connText.slice(0, 120).replace(/\n/g, " "));
  const connectorLimits = await page.evaluate(() => {
    const maxTokens = document.querySelector('[data-config-path="connectors.mock_main.maxTokens"]');
    const timeout = document.querySelector('[data-config-path="connectors.mock_main.timeoutMs"]');
    const timeoutLabel = timeout?.getAttribute("aria-labelledby") ? document.getElementById(timeout.getAttribute("aria-labelledby"))?.textContent : "";
    return { min: maxTokens?.min, max: maxTokens?.max, step: maxTokens?.step, timeoutLabel };
  });
  check("コネクタ maxTokens の境界と timeoutMs の単位が表示される", connectorLimits.min === "1" && connectorLimits.max === "32768" && connectorLimits.step === "1" && connectorLimits.timeoutLabel.includes("(ms)"), JSON.stringify(connectorLimits));
  await page.evaluate(() => {
    const input = document.querySelector('[data-config-path="connectors.mock_main.maxTokens"]');
    input.value = "32768";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

  // 4. ペルソナタブ
  await page.click('.settings-sidebar button[data-tab="personas"]');
  await page.waitForFunction(
    () => document.querySelector('.settings-sidebar button.is-active')?.dataset.tab === "personas",
    { timeout: 2000 },
  );
  const personaText = await visibleText(page);
  check("ペルソナ一覧に相棒AI が表示される", personaText.includes("相棒AI"), personaText.slice(0, 120).replace(/\n/g, " "));

  // 5. トリガータブ
  await page.click('.settings-sidebar button[data-tab="triggers"]');
  await page.waitForFunction(
    () => document.querySelector('.settings-sidebar button.is-active')?.dataset.tab === "triggers",
    { timeout: 2000 },
  );
  const trigText = await visibleText(page);
  check("トリガー一覧に mention_ai が表示される", trigText.includes("mention_ai"), trigText.slice(0, 120).replace(/\n/g, " "));
  const globalShortcutField = await page.evaluate(() => {
    const keyField = [...document.querySelectorAll("[data-config-path]")].find((element) => element.getAttribute("data-config-path").endsWith(".keys") && element.value === "Alt+1");
    const path = keyField?.getAttribute("data-config-path");
    const globalField = path ? document.querySelector(`[data-config-path="${path.replace(/\.keys$/, ".global")}"]`) : null;
    return { path, globalType: globalField?.type, label: globalField?.getAttribute("aria-labelledby") ? document.getElementById(globalField.getAttribute("aria-labelledby"))?.textContent : "" };
  });
  check("ホットキートリガーにElectronグローバル設定が表示される", globalShortcutField.globalType === "checkbox" && globalShortcutField.label.includes("グローバル"), JSON.stringify(globalShortcutField));

  // 6. 画面・文脈タブ
  await page.click('.settings-sidebar button[data-tab="context"]');
  await page.waitForFunction(
    () => document.querySelector('.settings-sidebar button.is-active')?.dataset.tab === "context",
    { timeout: 2000 },
  );
  const ctxText = await visibleText(page);
  check("画面・文脈タブに screenCapture 項目が表示される",
    ctxText.includes("screenCapture") && ctxText.includes("maxTokens"), ctxText.slice(0, 120).replace(/\n/g, " "));

  // 7. VOICEVOX タブ
  await page.click('.settings-sidebar button[data-tab="voicevox"]');
  await page.waitForFunction(
    () => document.querySelector('.settings-sidebar button.is-active')?.dataset.tab === "voicevox",
    { timeout: 2000 },
  );
  const vvText = await visibleText(page);
  check("VOICEVOX タブに baseUrl/defaultSpeaker が表示される",
    vvText.includes("baseUrl") && vvText.includes("defaultSpeaker"), vvText.slice(0, 120).replace(/\n/g, " "));

  await page.click('.settings-sidebar button[data-tab="commentReader"]');
  await page.waitForFunction(() => document.querySelector('.settings-sidebar button.is-active')?.dataset.tab === "commentReader", { timeout: 2000 });
  const commentVoiceFields = await page.evaluate(() => ({
    webspeech: !!document.querySelector('[data-config-path="commentReader.webspeech.rate"]'),
    voicevox: !!document.querySelector('[data-config-path="commentReader.voicevox.speed"]'),
    bouyomi: !!document.querySelector('[data-config-path="commentReader.bouyomi.speed"]'),
    legacyRate: !!document.querySelector('[data-config-path="commentReader.rate"]'),
  }));
  check("コメント読み上げの音声設定が3エンジン別に表示される", commentVoiceFields.webspeech && commentVoiceFields.voicevox && commentVoiceFields.bouyomi && !commentVoiceFields.legacyRate, JSON.stringify(commentVoiceFields));
  await page.evaluate(() => {
    for (const [path, value] of [["commentReader.webspeech.rate", "0.8"], ["commentReader.voicevox.speed", "1.3"], ["commentReader.bouyomi.speed", "140"]]) {
      const input = document.querySelector(`[data-config-path="${path}"]`);
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });

  // 8. コネクタタブに戻して新規コネクタを追加
  await page.click('.settings-sidebar button[data-tab="connectors"]');
  await page.waitForFunction(
    () => document.querySelector('.settings-sidebar button.is-active')?.dataset.tab === "connectors",
    { timeout: 2000 },
  );
  await page.click(".list-header button");
  const connText2 = await visibleText(page);
  check("新規コネクタ new_connector_1 が追加される", connText2.includes("new_connector_1"), connText2.slice(0, 120).replace(/\n/g, " "));

  // 9. ペルソナを1つ追加
  await page.click('.settings-sidebar button[data-tab="personas"]');
  await page.waitForFunction(
    () => document.querySelector('.settings-sidebar button.is-active')?.dataset.tab === "personas",
    { timeout: 2000 },
  );
  await page.click(".list-header button");
  const pText2 = await visibleText(page);
  check("新規ペルソナ new_persona_1 が追加される", pText2.includes("new_persona_1"), pText2.slice(0, 120).replace(/\n/g, " "));

  // 10. 適用ボタン → 設定が再読み込みされる
  await page.click('.settings-footer .btn-primary');
  await page.waitForFunction(
    () => document.querySelector("dialog.settings-modal")?.open === false,
    { timeout: 3000 },
  );
  check("適用でモーダルが閉じる", true);
  const logText = await page.$eval("#event-log", (el) => el.textContent);
  check("適用ログが残る", logText.includes("設定を保存し、適用しました"), logText.slice(0, 120).replace(/\n/g, " "));

  // 11. コネクタ一覧パネルに new_connector_1 が出る
  const listText = await page.$eval("#connector-list", (el) => el.textContent);
  check("適用後のコネクタ一覧に new_connector_1 が反映される", listText.includes("new_connector_1"), listText.slice(0, 120));
  // ペルソナ一覧パネルは表示名で出る (新規ペルソナ1)
  const personaListText = await page.$eval("#persona-list", (el) => el.textContent);
  check("適用後のペルソナ一覧に新規ペルソナ1 が反映される", personaListText.includes("新規ペルソナ1"), personaListText.slice(0, 120));

  // 11b. config.local.json に実際に書き込まれているか (issue #15 の核心: UI編集がディスクへ永続化される)
  const diskConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  check("config.local.json に new_connector_1 が書き込まれる", !!diskConfig.connectors?.new_connector_1);
  check("config.local.json に new_persona_1 が書き込まれる", (diskConfig.personas ?? []).some((p) => p.id === "new_persona_1"));
  check("config.local.json に connector maxTokens が保存される", diskConfig.connectors?.mock_main?.maxTokens === 32768);
  check("commentReaderの3エンジン別音声設定が保存される", diskConfig.commentReader?.webspeech?.rate === 0.8 && diskConfig.commentReader?.voicevox?.speed === 1.3 && diskConfig.commentReader?.bouyomi?.speed === 140);

  // 11c. ページを再読み込みしても編集内容が残る (ダウンロード→手動コピー不要であることの確認)
  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForFunction(
    () => document.querySelector("#config-status")?.textContent.includes("読込済"),
    { timeout: 8000 },
  );
  const reloadedListText = await page.$eval("#connector-list", (el) => el.textContent);
  check("再読み込み後もコネクタ一覧に new_connector_1 が残る (ダウンロード操作なしで永続化)", reloadedListText.includes("new_connector_1"), reloadedListText.slice(0, 120));

  // 12. エクスポートのダウンロードを捕捉
  await page.click("#btn-settings");
  await page.waitForFunction(() => document.querySelector("dialog.settings-modal")?.open === true, { timeout: 3000 });
  const reloadedMaxTokens = await page.$eval('[data-config-path="connectors.mock_main.maxTokens"]', (input) => input.value);
  check("再読み込み後も connector maxTokens が再表示される", reloadedMaxTokens === "32768", `value=${reloadedMaxTokens}`);
  await page.click('.settings-sidebar button[data-tab="commentReader"]');
  const reloadedCommentVoices = await page.evaluate(() => ({
    webspeech: document.querySelector('[data-config-path="commentReader.webspeech.rate"]')?.value,
    voicevox: document.querySelector('[data-config-path="commentReader.voicevox.speed"]')?.value,
    bouyomi: document.querySelector('[data-config-path="commentReader.bouyomi.speed"]')?.value,
  }));
  check("再読み込み後も3エンジン別音声設定が再表示される", reloadedCommentVoices.webspeech === "0.8" && reloadedCommentVoices.voicevox === "1.3" && reloadedCommentVoices.bouyomi === "140", JSON.stringify(reloadedCommentVoices));
  const client = await page.target().createCDPSession();
  await client.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: DOWNLOAD_DIR });
  // 既存のダウンロードファイルがあれば掃除
  try { fs.unlinkSync(`${DOWNLOAD_DIR}/dociai-config-export.json`); } catch {}
  const exportButtons = await page.$$('.settings-footer button');
  for (const b of exportButtons) {
    const t = await page.evaluate((el) => el.textContent, b);
    if (t.includes("JSONエクスポート")) { await b.click(); break; }
  }
  // ダウンロード完了待ち
  let exported = false;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (fs.existsSync(`${DOWNLOAD_DIR}/dociai-config-export.json`)) { exported = true; break; }
  }
  check("JSONエクスポートでファイルがダウンロードされる", exported);
  if (exported) {
    const json = JSON.parse(fs.readFileSync(`${DOWNLOAD_DIR}/dociai-config-export.json`, "utf8"));
    check("エクスポートJSONはversion付きpackageである", json.format === "dociai-config-export" && json.formatVersion === 1 && typeof json.revision === "string");
    check("エクスポートpackageに connectors/personas がある", !!json.config?.connectors && Array.isArray(json.config.personas));
    check("エクスポートpackageに追加した new_connector_1 が含まれる", !!json.config.connectors.new_connector_1);
    check("エクスポートpackageに追加した new_persona_1 が含まれる", (json.config.personas ?? []).some((p) => p.id === "new_persona_1"));
    const containsSecretKey = (value) => Array.isArray(value)
      ? value.some(containsSecretKey)
      : value && typeof value === "object"
        ? Object.entries(value).some(([key, nested]) => /(?:api[-_]?key|token|secret|authorization|password)$/i.test(key) || containsSecretKey(nested))
        : false;
    check("エクスポートpackageに秘密値が含まれない", !containsSecretKey(json.config));
  }

  // 13. validation エラーは visible status と assertive live region に出る
  await page.click('.settings-sidebar button[data-tab="personas"]');
  await page.waitForFunction(() => document.querySelector('[role="tab"][aria-selected="true"]')?.dataset.tab === "personas", { timeout: 2000 });
  await page.evaluate(() => {
    const select = document.querySelector('.settings-body select[data-config-path="personas.0.connector"]');
    select.value = "";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.keyboard.down("Control");
  await page.keyboard.press("s");
  await page.keyboard.up("Control");
  await page.waitForFunction(() => document.querySelector("#settings-error-live")?.textContent.includes("保存できません"), { timeout: 2000 });
  const validationState = await page.evaluate(() => ({
    live: document.querySelector("#settings-error-live")?.textContent,
    visible: document.querySelector(".settings-status")?.textContent,
  }));
  check("Ctrl+S と validation 失敗が screen reader / 可視 status に通知される", validationState.live.includes("保存できません") && validationState.visible.includes("保存できません"), JSON.stringify(validationState));

  // 13b. dirty 状態の ESC は discard dialog を経由し、親 dialog を閉じられる
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelector(".discard-changes-dialog")?.open === true, { timeout: 2000 });
  await page.click('.discard-changes-dialog button:nth-of-type(2)');
  await page.waitForFunction(() => document.querySelector("dialog.settings-modal")?.open === false, { timeout: 2000 });
  check("dirty 状態の ESC は破棄確認を経由する", true);

  // 14. キャンセル (ESC) でモーダルが閉じる
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

  // 14b. 閉じた状態から開き直せることも確認
  await page.click("#btn-settings");
  await page.waitForFunction(() => document.querySelector("dialog.settings-modal")?.open === true, { timeout: 3000 });
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () => document.querySelector("dialog.settings-modal")?.open === false,
    { timeout: 2000 },
  );
  check("閉じた後に開き直せる", true);

  // 15. 320px相当でも modal/footer が画面外へ固定されず、主要操作を横スクロールさせない
  await page.setViewport({ width: 320, height: 640 });
  await page.click("#btn-settings");
  await page.waitForFunction(() => document.querySelector("dialog.settings-modal")?.open === true, { timeout: 3000 });
  const compactLayout = await page.evaluate(() => {
    const dialog = document.querySelector("dialog.settings-modal");
    const footer = dialog.querySelector(".settings-footer").getBoundingClientRect();
    const dialogRect = dialog.getBoundingClientRect();
    return { scrolls: dialog.scrollWidth <= window.innerWidth, footerVisible: footer.bottom <= window.innerHeight + 1, tabOrientation: dialog.querySelector('[role="tablist"]')?.getAttribute("aria-orientation"), footer: { top: footer.top, bottom: footer.bottom }, dialog: { top: dialogRect.top, bottom: dialogRect.bottom }, viewport: { width: window.innerWidth, height: window.innerHeight } };
  });
  check("320px相当で主要操作が切れず footer が見える", compactLayout.scrolls && compactLayout.footerVisible && compactLayout.tabOrientation === "horizontal", JSON.stringify(compactLayout));
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelector("dialog.settings-modal")?.open === false, { timeout: 2000 });
  await page.setViewport({ width: 1440, height: 1000 });

  // 16. localStorage/sessionStorage にAPIキーを書いていない (issue #13 維持)
  const storage = await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }));
  check("エディタ使用後も localStorage/sessionStorage は空", storage.local === 0 && storage.session === 0, JSON.stringify(storage));

  check("ページエラーなし", pageErrors.length === 0, pageErrors.join(" / ").slice(0, 300));
  await page.screenshot({ path: `${SHOT_DIR}/settings-ui.png` });
} finally {
  await browser.close();
  fs.writeFileSync(CONFIG_PATH, originalConfigText);
  fs.rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
