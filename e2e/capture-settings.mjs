import puppeteer from "puppeteer-core";

const CHROME = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.env.BASE_URL ?? "http://localhost:8080";

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: [
    "--no-first-run",
    "--mute-audio",
    "--disable-speech-api",
    "--window-size=1440,1000",
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000 });
await page.goto(`${BASE}/`, { waitUntil: "networkidle0" });
await page.waitForFunction(
  () => document.querySelector("#config-status")?.textContent.includes("読込済"),
  { timeout: 8000 },
);

await page.click("#btn-settings");
await page.waitForFunction(() => document.querySelector("dialog.settings-modal")?.open === true, { timeout: 3000 });

const tabs = ["connectors", "personas", "triggers", "context", "voicevox", "news", "sources"];
for (const tab of tabs) {
  await page.click(`.settings-sidebar button[data-tab="${tab}"]`);
  await page.waitForFunction(
    (t) => document.querySelector(".settings-sidebar button.is-active")?.dataset.tab === t,
    { timeout: 2000 },
    tab,
  );
  await new Promise((r) => setTimeout(r, 300));
  await page.screenshot({ path: `/tmp/settings-${tab}.png` });
}

await browser.close();
console.log("screenshots saved to /tmp/settings-*.png");
