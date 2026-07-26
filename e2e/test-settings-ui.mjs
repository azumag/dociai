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
  const addListItemAndAssert = async ({ tab, panel, label, name, fillUrl = false }) => {
    await page.click(`.settings-sidebar button[data-tab="${tab}"]`);
    await page.waitForFunction((expectedTab) => document.querySelector('.settings-sidebar button.is-active')?.dataset.tab === expectedTab, {}, tab);
    const before = await page.$$eval(`${panel} .card`, (cards) => cards.length);
    await page.click(`${panel} [aria-label="${label}"]`);
    await page.waitForFunction(({ panelSelector, count }) => {
      const root = document.querySelector(panelSelector);
      const cards = [...root.querySelectorAll(".card")];
      return cards.length === count + 1 && document.activeElement?.closest(".card") === cards.at(-1);
    }, {}, { panelSelector: panel, count: before });
    const state = await page.evaluate((panelSelector) => {
      const root = document.querySelector(panelSelector);
      const last = [...root.querySelectorAll(".card")].at(-1);
      const target = document.activeElement;
      const bodyRect = document.querySelector(".settings-body")?.getBoundingClientRect();
      const targetRect = target?.getBoundingClientRect();
      return {
        focused: !!target && last?.contains(target),
        visible: !!targetRect && !!bodyRect && targetRect.top >= bodyRect.top && targetRect.bottom <= bodyRect.bottom,
      };
    }, panel);
    check(`${name}追加後、末尾カードの入力欄へフォーカスし表示される`, state.focused && state.visible, JSON.stringify(state));
    if (fillUrl) {
      await page.evaluate((panelSelector) => {
        const card = [...document.querySelector(panelSelector).querySelectorAll(".card")].at(-1);
        const input = card.querySelector('[data-config-path$=".url"]');
        input.value = "https://example.com/generated-feed.xml";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }, panel);
    }
  };
  const assertAddMarksDirty = async ({ tab, panel, label, name }) => {
    await page.click("#btn-settings");
    await page.waitForFunction(() => document.querySelector("dialog.settings-modal")?.open === true, { timeout: 3000 });
    await page.click(`.settings-sidebar button[data-tab="${tab}"]`);
    await page.waitForFunction((expectedTab) => document.querySelector('.settings-sidebar button.is-active')?.dataset.tab === expectedTab, {}, tab);
    await page.click(`${panel} [aria-label="${label}"]`);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector(".discard-changes-dialog")?.open === true, { timeout: 2000 });
    await page.click('.discard-changes-dialog button:nth-of-type(2)');
    await page.waitForFunction(() => document.querySelector("dialog.settings-modal")?.open === false, { timeout: 2000 });
    check(`${name}の追加だけでclean状態からdirtyとなり破棄確認を経由する`, true);
  };

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
  await page.click('[data-config-path="personas.1.enabled"]');

  // 5. トリガータブ
  await page.click('.settings-sidebar button[data-tab="triggers"]');
  await page.waitForFunction(
    () => document.querySelector('.settings-sidebar button.is-active')?.dataset.tab === "triggers",
    { timeout: 2000 },
  );
  const trigText = await visibleText(page);
  check("トリガー一覧に mention_ai が表示される", trigText.includes("mention_ai"), trigText.slice(0, 120).replace(/\n/g, " "));
  const triggersAddState = await page.evaluate(() => {
    const panel = document.querySelector("#settings-panel-triggers");
    const add = panel.querySelector('[aria-label="トリガーを追加"]');
    const cardNodes = [...panel.querySelectorAll(":scope > .card")];
    const addIndex = add ? [...panel.children].indexOf(add) : -1;
    const cardIndex = cardNodes.length ? [...panel.children].indexOf(cardNodes.at(-1)) : -1;
    return { hasAdd: !!add, addImmediatelyAfterLastCard: addIndex === cardIndex + 1 && cardIndex >= 0 };
  });
  check("トリガー追加ボタンは最後のトリガーカードの直後にある", triggersAddState.hasAdd && triggersAddState.addImmediatelyAfterLastCard, JSON.stringify(triggersAddState));
  await addListItemAndAssert({ tab: "triggers", panel: "#settings-panel-triggers", label: "トリガーを追加", name: "トリガー" });
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
    collapseEmoji: !!document.querySelector('[data-config-path="commentReader.collapseConsecutiveEmoji"]'),
    legacyRate: !!document.querySelector('[data-config-path="commentReader.rate"]'),
  }));
  check("コメント読み上げの音声設定と絵文字連投抑制が表示される", commentVoiceFields.webspeech && commentVoiceFields.voicevox && commentVoiceFields.bouyomi && commentVoiceFields.collapseEmoji && !commentVoiceFields.legacyRate, JSON.stringify(commentVoiceFields));
  await page.evaluate(() => {
    for (const [path, value] of [["commentReader.webspeech.rate", "0.8"], ["commentReader.voicevox.speed", "1.3"], ["commentReader.bouyomi.speed", "140"]]) {
      const input = document.querySelector(`[data-config-path="${path}"]`);
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    const collapseEmoji = document.querySelector('[data-config-path="commentReader.collapseConsecutiveEmoji"]');
    collapseEmoji.click();
  });

  // ニュースitem単位のランダムペルソナ設定。無効personaは保存候補として残せるが、
  // UI上で抽選対象外と明示される。
  await page.click('.settings-sidebar button[data-tab="news"]');
  await page.waitForFunction(() => document.querySelector('.settings-sidebar button.is-active')?.dataset.tab === "news", { timeout: 2000 });
  await page.click('[data-config-path="news.randomPersona"]');
  await page.waitForSelector('.persona-candidate-pool[data-persona-section="news"]');
  const newsPoolText = await page.$eval('.persona-candidate-pool[data-persona-section="news"]', (element) => element.textContent);
  check("ニュースのランダム候補UIは無効personaを抽選対象外と表示する", newsPoolText.includes("ツッコミAI") && newsPoolText.includes("無効・抽選対象外"), newsPoolText.slice(0, 180));
  check("ニュースのランダム候補UIは削除済みpersonaを保持して明示する", newsPoolText.includes("deleted_ai") && newsPoolText.includes("存在しません・抽選対象外"), newsPoolText.slice(0, 180));
  await page.click('.persona-candidate-pool[data-persona-section="news"] input[value="deleted_ai"]');
  const emptyWarning = await page.$eval('.persona-candidate-pool[data-persona-section="news"] .settings-inline-warning', (element) => ({ hidden: element.hidden, text: element.textContent }));
  check("ニュースのランダム候補が0件ならフォールバック警告を表示する", !emptyWarning.hidden && emptyWarning.text.includes("候補が0件"), JSON.stringify(emptyWarning));
  await page.click('.persona-candidate-pool[data-persona-section="news"] input[value="partner_ai"]');
  await page.click('.persona-candidate-pool[data-persona-section="news"] input[value="tsukkomi_ai"]');
  const newsPoolState = await page.evaluate(() => ({
    selected: [...document.querySelectorAll('.persona-candidate-pool[data-persona-section="news"] input:checked')].map((input) => input.value),
    warningHidden: document.querySelector('.persona-candidate-pool[data-persona-section="news"] .settings-inline-warning')?.hidden,
  }));
  check("ニュースのランダム候補を複数選択できる", newsPoolState.selected.includes("partner_ai") && newsPoolState.selected.includes("tsukkomi_ai") && newsPoolState.warningHidden, JSON.stringify(newsPoolState));

  // 8. コネクタタブに戻して新規コネクタを追加
  await page.click('.settings-sidebar button[data-tab="connectors"]');
  await page.waitForFunction(
    () => document.querySelector('.settings-sidebar button.is-active')?.dataset.tab === "connectors",
    { timeout: 2000 },
  );
  const connectorsAddState = await page.evaluate(() => {
    const panel = document.querySelector("#settings-panel-connectors");
    const add = panel.querySelector('[aria-label="コネクタを追加"]');
    const cardNodes = [...panel.querySelectorAll(":scope > .card")];
    const addIndex = add ? [...panel.children].indexOf(add) : -1;
    const cardIndex = cardNodes.length ? [...panel.children].indexOf(cardNodes.at(-1)) : -1;
    return { hasAdd: !!add, addImmediatelyAfterLastCard: addIndex === cardIndex + 1 && cardIndex >= 0 };
  });
  check("コネクタ追加ボタンは最後のコネクタカードの直後にある", connectorsAddState.hasAdd && connectorsAddState.addImmediatelyAfterLastCard, JSON.stringify(connectorsAddState));
  await page.click('#settings-panel-connectors .btn-add[aria-label="コネクタを追加"]');
  const connText2 = await visibleText(page);
  check("新規コネクタ new_connector_1 が追加される", connText2.includes("new_connector_1"), connText2.slice(0, 120).replace(/\n/g, " "));
  await page.waitForFunction(() => document.activeElement?.getAttribute("data-config-path")?.includes("connectors.new_connector_1.id"), { timeout: 2000 });
  const connectorFocusState = await page.evaluate(() => {
    const target = document.querySelector('[data-config-path="connectors.new_connector_1.id"]');
    const panel = document.querySelector("#settings-panel-connectors");
    const targetRect = target?.getBoundingClientRect();
    const panelRect = panel?.getBoundingClientRect();
    return {
      focused: document.activeElement === target,
      visible: !!targetRect && !!panelRect && targetRect.top >= panelRect.top && targetRect.bottom <= panelRect.bottom,
    };
  });
  check("新規コネクタ追加後、ID入力欄へフォーカスし表示される", connectorFocusState.focused && connectorFocusState.visible, JSON.stringify(connectorFocusState));

  // 9. ペルソナを1つ追加
  await page.click('.settings-sidebar button[data-tab="personas"]');
  await page.waitForFunction(
    () => document.querySelector('.settings-sidebar button.is-active')?.dataset.tab === "personas",
    { timeout: 2000 },
  );
  const personasAddState = await page.evaluate(() => {
    const panel = document.querySelector("#settings-panel-personas");
    const add = panel.querySelector('[aria-label="ペルソナを追加"]');
    const cardNodes = [...panel.querySelectorAll(":scope > .card")];
    const addIndex = add ? [...panel.children].indexOf(add) : -1;
    const cardIndex = cardNodes.length ? [...panel.children].indexOf(cardNodes.at(-1)) : -1;
    return { hasAdd: !!add, addImmediatelyAfterLastCard: addIndex === cardIndex + 1 && cardIndex >= 0 };
  });
  check("ペルソナ追加ボタンは最後のペルソナカードの直後にある", personasAddState.hasAdd && personasAddState.addImmediatelyAfterLastCard, JSON.stringify(personasAddState));
  await page.click('#settings-panel-personas .btn-add[aria-label="ペルソナを追加"]');
  const pText2 = await visibleText(page);
  check("新規ペルソナ new_persona_1 が追加される", pText2.includes("new_persona_1"), pText2.slice(0, 120).replace(/\n/g, " "));
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("data-config-path")?.includes("personas.2.id"),
    { timeout: 2000 },
  );
  const personaFocusState = await page.evaluate(() => {
    const target = document.querySelector('[data-config-path="personas.2.id"]');
    const panel = document.querySelector("#settings-panel-personas");
    const targetRect = target?.getBoundingClientRect();
    const panelRect = panel?.getBoundingClientRect();
    return {
      focused: document.activeElement === target,
      visible: !!targetRect && !!panelRect && targetRect.top >= panelRect.top && targetRect.bottom <= panelRect.bottom,
    };
  });
  check("新規ペルソナ追加後、ID入力欄へフォーカスし表示される", personaFocusState.focused && personaFocusState.visible, JSON.stringify(personaFocusState));

  // 9a. 狭い表示域でも、高さのある新規カードの先頭フィールドを表示したままフォーカスする
  await page.setViewport({ width: 320, height: 640 });
  await page.click('#settings-panel-personas .btn-add[aria-label="ペルソナを追加"]');
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("data-config-path")?.includes("personas.3.id"),
    { timeout: 2000 },
  );
  const compactPersonaFocusState = await page.evaluate(() => {
    const target = document.querySelector('[data-config-path="personas.3.id"]');
    const body = document.querySelector(".settings-body");
    const targetRect = target?.getBoundingClientRect();
    const bodyRect = body?.getBoundingClientRect();
    return {
      focused: document.activeElement === target,
      visible: !!targetRect && !!bodyRect && targetRect.top >= bodyRect.top && targetRect.bottom <= bodyRect.bottom,
    };
  });
  check("狭い表示域でも新規ペルソナの先頭入力欄が表示されたままフォーカスされる", compactPersonaFocusState.focused && compactPersonaFocusState.visible, JSON.stringify(compactPersonaFocusState));
  await page.setViewport({ width: 1280, height: 720 });

  // 9b. ニュースソース追加ボタンを確認（末尾配置）
  await page.click('.settings-sidebar button[data-tab="news"]');
  await page.waitForFunction(() => document.querySelector('.settings-sidebar button.is-active')?.dataset.tab === "news", { timeout: 2000 });
  const newsAddState = await page.evaluate(() => {
    const panel = document.querySelector("#settings-panel-news");
    const add = panel.querySelector('[aria-label="ニュースソースを追加"]');
    const cardNodes = [...panel.querySelectorAll(':scope > .card')];
    const sourceCards = cardNodes.slice(1); // 先頭カードはニュース設定本体
    const addIndex = add ? [...panel.children].indexOf(add) : -1;
    const sourceLastIndex = sourceCards.length ? [...panel.children].indexOf(sourceCards.at(-1)) : -1;
    return {
      hasAdd: !!add,
      hasNewsSources: sourceCards.length > 0,
      isAddImmediatelyAfterSources: sourceCards.length > 0 && addIndex === sourceLastIndex + 1,
      sourceCount: sourceCards.length,
    };
  });
  check("ニュースソース追加ボタンは既存ニュースソースの末尾直後にある", newsAddState.hasAdd && newsAddState.hasNewsSources && newsAddState.isAddImmediatelyAfterSources, JSON.stringify(newsAddState));
  await addListItemAndAssert({ tab: "news", panel: "#settings-panel-news", label: "ニュースソースを追加", name: "ニュースソース", fillUrl: true });

  // 9c. 話題ソース（初期空配列）は空状態メッセージの直後に追加先ボタンがある
  await page.click('.settings-sidebar button[data-tab="topics"]');
  await page.waitForFunction(
    () => document.querySelector('.settings-sidebar button.is-active')?.dataset.tab === "topics",
    { timeout: 2000 },
  );
  const topicAddState = await page.evaluate(() => {
    const panel = document.querySelector("#settings-panel-topics");
    const sectionHeader = [...panel.querySelectorAll(":scope > .list-header")].find((h) => h.textContent.includes("話題ソース"));
    const emptyMessage = panel.querySelector(":scope > .list-empty");
    const add = panel.querySelector('[aria-label="話題ソースを追加"]');
    return {
      hasAdd: !!add,
      headerExists: !!sectionHeader,
      emptyMessageText: emptyMessage?.textContent,
      messageAfterHeader: !!sectionHeader && emptyMessage === sectionHeader.nextElementSibling,
      addAfterMessage: !!emptyMessage && add === emptyMessage.nextElementSibling,
    };
  });
  check("話題ソース追加ボタンは空状態メッセージの直後にある", topicAddState.hasAdd && topicAddState.headerExists && topicAddState.emptyMessageText?.includes("話題ソースがありません") && topicAddState.messageAfterHeader && topicAddState.addAfterMessage, JSON.stringify(topicAddState));
  await addListItemAndAssert({ tab: "topics", panel: "#settings-panel-topics", label: "話題ソースを追加", name: "話題ソース" });

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

  // 11a. 各リストはclean状態の追加だけでdirtyになり、破棄確認を表示する
  await assertAddMarksDirty({ tab: "triggers", panel: "#settings-panel-triggers", label: "トリガーを追加", name: "トリガー" });
  await assertAddMarksDirty({ tab: "news", panel: "#settings-panel-news", label: "ニュースソースを追加", name: "ニュースソース" });
  await assertAddMarksDirty({ tab: "topics", panel: "#settings-panel-topics", label: "話題ソースを追加", name: "話題ソース" });
  // ペルソナ一覧パネルは表示名で出る (新規ペルソナ1)
  const personaListText = await page.$eval("#persona-list", (el) => el.textContent);
  check("適用後のペルソナ一覧に新規ペルソナ1 が反映される", personaListText.includes("新規ペルソナ1"), personaListText.slice(0, 120));

  // 11b. config.local.json に実際に書き込まれているか (issue #15 の核心: UI編集がディスクへ永続化される)
  const diskConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  check("config.local.json に new_connector_1 が書き込まれる", !!diskConfig.connectors?.new_connector_1);
  check("config.local.json に new_persona_1 が書き込まれる", (diskConfig.personas ?? []).some((p) => p.id === "new_persona_1"));
  check("config.local.json に connector maxTokens が保存される", diskConfig.connectors?.mock_main?.maxTokens === 32768);
  check("commentReaderの3エンジン別音声設定が保存される", diskConfig.commentReader?.webspeech?.rate === 0.8 && diskConfig.commentReader?.voicevox?.speed === 1.3 && diskConfig.commentReader?.bouyomi?.speed === 140);
  check("commentReaderの絵文字連投抑制が保存される", diskConfig.commentReader?.collapseConsecutiveEmoji === true);
  check("ニュースのランダムペルソナ設定が保存される", diskConfig.news?.randomPersona === true && diskConfig.news?.personas?.includes("partner_ai") && diskConfig.news?.personas?.includes("tsukkomi_ai"));

  // 11c. ページを再読み込みしても編集内容が残る (ダウンロード→手動コピー不要であることの確認)
  await page.reload({ waitUntil: "domcontentloaded" });
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
  await page.click('.settings-sidebar button[data-tab="news"]');
  await page.waitForFunction(() => document.querySelector('.settings-sidebar button.is-active')?.dataset.tab === "news", { timeout: 2000 });
  const reloadedNewsPersonas = await page.evaluate(() => ({
    random: document.querySelector('[data-config-path="news.randomPersona"]')?.checked,
    selected: [...document.querySelectorAll('.persona-candidate-pool[data-persona-section="news"] input:checked')].map((input) => input.value),
  }));
  check("再読み込み後もニュースのランダム候補が復元される", reloadedNewsPersonas.random && reloadedNewsPersonas.selected.includes("partner_ai") && reloadedNewsPersonas.selected.includes("tsukkomi_ai"), JSON.stringify(reloadedNewsPersonas));
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

  // 14b. 追加操作だけでもdirtyになり、破棄確認を経由する
  await page.click("#btn-settings");
  await page.waitForFunction(() => document.querySelector("dialog.settings-modal")?.open === true, { timeout: 3000 });
  await page.click('.settings-sidebar button[data-tab="connectors"]');
  await page.waitForFunction(() => document.querySelector('[role="tab"][aria-selected="true"]')?.dataset.tab === "connectors", { timeout: 2000 });
  await page.click('#settings-panel-connectors .btn-add[aria-label="コネクタを追加"]');
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelector(".discard-changes-dialog")?.open === true, { timeout: 2000 });
  await page.click('.discard-changes-dialog button:nth-of-type(2)');
  await page.waitForFunction(
    () => document.querySelector("dialog.settings-modal")?.open === false,
    { timeout: 2000 },
  );
  check("追加操作だけでもdirty状態の破棄確認を経由する", true);

  // 14c. リスト項目の削除: map形式(コネクタ)・配列形式(ペルソナ)・空状態(話題ソース)の3系統で、
  //      削除がリストへ反映され、dirtyになり、意図した追加ボタンへフォーカスが移り、
  //      破棄すると保存済み設定へ戻ってclean状態になることを確認する。
  const openSettingsModal = async () => {
    await page.click("#btn-settings");
    await page.waitForFunction(() => document.querySelector("dialog.settings-modal")?.open === true, { timeout: 3000 });
  };
  const gotoSettingsTab = async (tab) => {
    await page.click(`.settings-sidebar button[data-tab="${tab}"]`);
    await page.waitForFunction((expectedTab) => document.querySelector('.settings-sidebar button.is-active')?.dataset.tab === expectedTab, { timeout: 2000 }, tab);
  };
  // 条件成立を待ち、成立可否を true/false で返す (未成立でも throw せず check() のFAILとして残すため)
  const waitTrue = async (fn, ...args) => {
    try { await page.waitForFunction(fn, { timeout: 2000 }, ...args); return true; } catch { return false; }
  };
  // dirtyな状態のESCが破棄確認を経由してモーダルを閉じられたかを返す
  const escapeWithDiscard = async () => {
    await page.keyboard.press("Escape");
    if (!await waitTrue(() => document.querySelector(".discard-changes-dialog")?.open === true)) return false;
    await page.click('.discard-changes-dialog button:nth-of-type(2)');
    return await waitTrue(() => document.querySelector("dialog.settings-modal")?.open === false);
  };
  // clean判定が外れた場合に後続テストへ影響させないための後始末
  const ensureSettingsClosed = async () => {
    if (await page.$(".discard-changes-dialog[open]")) await page.click('.discard-changes-dialog button:nth-of-type(2)');
    if (await page.evaluate(() => document.querySelector("dialog.settings-modal")?.open === true)) await escapeWithDiscard();
    await waitTrue(() => document.querySelector("dialog.settings-modal")?.open === false);
  };
  const readIdValues = (panel) => page.$$eval(`${panel} [data-config-path$=".id"]`, (inputs) => inputs.map((input) => input.value));

  // 14c-1. map形式リスト (コネクタ)
  await openSettingsModal();
  await gotoSettingsTab("connectors");
  const connectorIdsBeforeDelete = await readIdValues("#settings-panel-connectors");
  await page.click('#settings-panel-connectors [aria-label="コネクタ「new_connector_1」を削除"]');
  const connectorRemoved = await waitTrue(() => !document.querySelector('[data-config-path="connectors.new_connector_1.id"]'));
  const connectorIdsAfterDelete = await readIdValues("#settings-panel-connectors");
  check(
    "コネクタ(map形式)の削除で対象だけがリストから消える",
    connectorRemoved && JSON.stringify(connectorIdsAfterDelete) === JSON.stringify(connectorIdsBeforeDelete.filter((id) => id !== "new_connector_1")),
    JSON.stringify({ before: connectorIdsBeforeDelete, after: connectorIdsAfterDelete }),
  );
  check("コネクタ削除後、コネクタ追加ボタンへフォーカスが移る", await waitTrue(() => document.activeElement === document.querySelector('.btn-add[data-list-add="connectors"]')));
  check("コネクタ削除がライブリージョンへ通知される", await waitTrue(() => document.querySelector("#settings-status-live")?.textContent.includes("new_connector_1 を削除しました")));
  check("コネクタの削除だけでclean状態からdirtyとなり破棄確認を経由する", await escapeWithDiscard());

  await openSettingsModal();
  const connectorIdsAfterDiscard = await readIdValues("#settings-panel-connectors");
  check(
    "破棄後に再オープンすると削除したコネクタが復元されている",
    JSON.stringify(connectorIdsAfterDiscard) === JSON.stringify(connectorIdsBeforeDelete),
    JSON.stringify(connectorIdsAfterDiscard),
  );
  await page.keyboard.press("Escape");
  const closedWithoutDiscardDialog = await waitTrue(() => document.querySelector("dialog.settings-modal")?.open === false);
  const discardDialogReappeared = await page.evaluate(() => document.querySelector(".discard-changes-dialog")?.open === true);
  check("破棄直後の再オープンはclean状態でESCが破棄確認なしに閉じる", closedWithoutDiscardDialog && !discardDialogReappeared, JSON.stringify({ closedWithoutDiscardDialog, discardDialogReappeared }));
  await ensureSettingsClosed();

  // 14c-2. 配列形式リスト (ペルソナ): 削除後に以降の項目が繰り上がって再採番される
  await openSettingsModal();
  await gotoSettingsTab("personas");
  const personaIdsBeforeDelete = await readIdValues("#settings-panel-personas");
  const personaDeleteIndex = personaIdsBeforeDelete.indexOf("new_persona_1");
  check("削除対象のペルソナ new_persona_1 が存在する", personaDeleteIndex >= 0, JSON.stringify(personaIdsBeforeDelete));
  await page.evaluate((index) => {
    document.querySelector(`[data-config-path="personas.${index}.id"]`).closest(".card").querySelector(".btn-remove").click();
  }, personaDeleteIndex);
  const personaRemoved = await waitTrue((count) => document.querySelectorAll('#settings-panel-personas [data-config-path$=".id"]').length === count, personaIdsBeforeDelete.length - 1);
  const personaIdsAfterDelete = await readIdValues("#settings-panel-personas");
  check(
    "ペルソナ(配列形式)の削除で以降の項目が繰り上がって再採番される",
    personaRemoved && JSON.stringify(personaIdsAfterDelete) === JSON.stringify(personaIdsBeforeDelete.filter((id) => id !== "new_persona_1")),
    JSON.stringify({ before: personaIdsBeforeDelete, after: personaIdsAfterDelete }),
  );
  check("ペルソナ削除後、ペルソナ追加ボタンへフォーカスが移る", await waitTrue(() => document.activeElement === document.querySelector('.btn-add[data-list-add="personas"]')));
  check("ペルソナの削除だけでclean状態からdirtyとなり破棄確認を経由する", await escapeWithDiscard());

  await openSettingsModal();
  await gotoSettingsTab("personas");
  const personaIdsAfterDiscard = await readIdValues("#settings-panel-personas");
  check(
    "破棄後に再オープンすると削除したペルソナが復元されている",
    JSON.stringify(personaIdsAfterDiscard) === JSON.stringify(personaIdsBeforeDelete),
    JSON.stringify(personaIdsAfterDiscard),
  );
  await ensureSettingsClosed();

  // 14c-3. 最後の1件を削除したリスト (話題ソース) は空状態メッセージへ戻る
  await openSettingsModal();
  await gotoSettingsTab("topics");
  const countTopicSources = () => page.$$eval("#settings-panel-topics .btn-remove", (buttons) => buttons.length);
  const topicSourcesBeforeDelete = await countTopicSources();
  check("削除対象の話題ソースが存在する", topicSourcesBeforeDelete > 0, `count=${topicSourcesBeforeDelete}`);
  for (let remaining = topicSourcesBeforeDelete; remaining > 0; remaining--) {
    await page.click("#settings-panel-topics .btn-remove");
    await waitTrue((count) => document.querySelectorAll("#settings-panel-topics .btn-remove").length === count, remaining - 1);
  }
  const topicsAddFocused = await waitTrue(() => document.activeElement === document.querySelector('.btn-add[data-list-add="topics-sources"]'));
  const topicsEmptyState = await page.evaluate(() => {
    const panel = document.querySelector("#settings-panel-topics");
    const emptyMessage = panel.querySelector(":scope > .list-empty");
    const add = panel.querySelector('[aria-label="話題ソースを追加"]');
    const children = [...panel.children];
    return {
      remaining: panel.querySelectorAll(".btn-remove").length,
      emptyMessageText: emptyMessage?.textContent ?? "",
      addAfterMessage: !!emptyMessage && !!add && children.indexOf(add) > children.indexOf(emptyMessage),
    };
  });
  check(
    "最後の話題ソースを削除すると空状態メッセージとその後ろの追加ボタンに戻る",
    topicsEmptyState.remaining === 0 && topicsEmptyState.emptyMessageText.includes("話題ソースがありません") && topicsEmptyState.addAfterMessage,
    JSON.stringify(topicsEmptyState),
  );
  check("話題ソース削除後も話題ソース追加ボタンへフォーカスが移る", topicsAddFocused);
  check("話題ソースの削除だけでclean状態からdirtyとなり破棄確認を経由する", await escapeWithDiscard());

  await openSettingsModal();
  await gotoSettingsTab("topics");
  const topicSourcesAfterDiscard = await countTopicSources();
  check("破棄後に再オープンすると話題ソースが復元されている", topicSourcesAfterDiscard === topicSourcesBeforeDelete, `before=${topicSourcesBeforeDelete} after=${topicSourcesAfterDiscard}`);
  await ensureSettingsClosed();

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
