import fs from "node:fs";
import puppeteer from "puppeteer";

export function resolveBrowserExecutable() {
  const explicit = process.env.CHROME_BIN?.trim();
  if (explicit) {
    if (!fs.existsSync(explicit)) {
      throw new Error(`CHROME_BIN does not exist: ${explicit}`);
    }
    return explicit;
  }

  const managed = puppeteer.executablePath();
  if (managed && fs.existsSync(managed)) return managed;

  throw new Error(
    "Chromium executable was not found. Run `npm install` to install Puppeteer's managed browser, or set CHROME_BIN.",
  );
}
