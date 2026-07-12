#!/usr/bin/env node
// notarize.mjs (#73): electron-builderの`afterSign`hookとして、macOS向けsigned appの
// notarization submit/wait/stapleを実装する。electron-builder自身にも@electron/notarizeを使う
// 組み込みnotarize機能があるが、electron-builder.yml側で`mac.notarize: false`にして無効化し、
// こちらで`xcrun notarytool`/`xcrun stapler`を直接呼ぶ (Apple公式CLIそのままの手順で、
// credential有無によるskip/失敗理由がscript側で追跡・テストできるようにするため)。
//
// credentialが無い(fork PRなど)場合は必ずgracefulにskipし、never throwする。didSign=falseの
// unsigned build ではelectron-builderがそもそもafterSignを呼ばない(platformPackager.js
// doSignAfterPack: `didSign`が真の時だけemitAfterSignする)ため、ここに来る時点で「appは
// 署名済みだがnotarization credentialだけが無い」というケースも別途あり得る。両方とも
// skip扱いにする。
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { resolveMacNotarizationCredentials, redactSecrets } from "./signing-credentials.mjs";

const execFileAsync = promisify(execFile);

export function buildNotarytoolArgs(zipPath, credentials) {
  if (credentials.mode === "app-store-connect-api-key") {
    return ["notarytool", "submit", zipPath, "--key", credentials.keyFile, "--key-id", credentials.keyId, "--issuer", credentials.issuer, "--wait", "--output-format", "json"];
  }
  if (credentials.mode === "apple-id-password") {
    return ["notarytool", "submit", zipPath, "--apple-id", credentials.appleId, "--password", credentials.appSpecificPassword, "--team-id", credentials.teamId, "--wait", "--output-format", "json"];
  }
  throw new Error(`Unknown notarization credential mode: ${credentials.mode}`);
}

export function buildNotarytoolLogArgs(submissionId, credentials) {
  const base = ["notarytool", "log", submissionId, "--output-format", "json"];
  if (credentials.mode === "app-store-connect-api-key") return [...base, "--key", credentials.keyFile, "--key-id", credentials.keyId, "--issuer", credentials.issuer];
  return [...base, "--apple-id", credentials.appleId, "--password", credentials.appSpecificPassword, "--team-id", credentials.teamId];
}

export function buildStapleArgs(appPath) {
  return ["stapler", "staple", appPath];
}

export function buildStapleValidateArgs(appPath) {
  return ["stapler", "validate", appPath];
}

// appOutDir配下から最初の*.appを探す。electron-builderのAfterPackContextは
// packager.appInfo.productFilenameを持つが、hookの呼び出し経路によっては欠けることがあるため
// filesystem探索をfallbackとして常に用意する。
export async function locateAppBundle(appOutDir, productFilename) {
  if (productFilename) {
    const candidate = path.join(appOutDir, `${productFilename}.app`);
    if (fsSync.existsSync(candidate)) return candidate;
  }
  const entries = await fs.readdir(appOutDir, { withFileTypes: true });
  const appBundle = entries.find((entry) => entry.isDirectory() && entry.name.endsWith(".app"));
  if (!appBundle) throw new Error(`No .app bundle found under ${appOutDir}`);
  return path.join(appOutDir, appBundle.name);
}

async function run(argv, { secrets = [], log }) {
  const [command, ...args] = argv;
  const maskedCommand = redactSecrets([command, ...args].join(" "), secrets);
  log(`INFO | notarize | running: ${maskedCommand}`);
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { maxBuffer: 32 * 1024 * 1024 });
    return { stdout, stderr };
  } catch (error) {
    const message = redactSecrets(error?.stderr ?? error?.message ?? String(error), secrets);
    throw new Error(`command failed: ${maskedCommand}\n${message}`);
  }
}

// zipPathへditto (Apple推奨のnotarization submit形式: symlink/resource forkを保つ) でappをzipする。
export async function zipForNotarization(appPath, zipPath, { log = () => {} } = {}) {
  await run(["ditto", "-c", "-k", "--keepParent", appPath, zipPath], { log });
  return zipPath;
}

export async function submitAndWait(zipPath, credentials, { log = () => {} } = {}) {
  const args = buildNotarytoolArgs(zipPath, credentials);
  const { stdout } = await run(args, { secrets: credentials.secrets, log });
  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new Error(`notarytool submit produced non-JSON output: ${redactSecrets(stdout, credentials.secrets)}`);
  }
  if (result.status !== "Accepted") {
    let logDetail = "";
    if (result.id) {
      try {
        const logArgs = buildNotarytoolLogArgs(result.id, credentials);
        const { stdout: logStdout } = await run(logArgs, { secrets: credentials.secrets, log });
        logDetail = `\nnotarytool log:\n${redactSecrets(logStdout, credentials.secrets)}`;
      } catch {
        // best-effort only; the primary failure reason below is what matters.
      }
    }
    throw new Error(`notarization was not accepted: status=${result.status ?? "unknown"} id=${result.id ?? "unknown"}${logDetail}`);
  }
  return result;
}

export async function stapleAndValidate(appPath, { log = () => {} } = {}) {
  await run(buildStapleArgs(appPath), { log });
  await run(buildStapleValidateArgs(appPath), { log });
}

// appPathを (1) 資格情報が無ければskip、(2) あればzip -> submit --wait -> staple -> validate の
// 順で処理する。この関数自体はcredentials解決とtmpdir管理をmac以外からも呼び出しやすいよう
// 独立させ、afterSign(default export)はcontextの取り出しだけを担う。
export async function notarizeAndStaple(appPath, { env = process.env, log = console.log } = {}) {
  const credentials = resolveMacNotarizationCredentials(env);
  if (!credentials) {
    const reason = "no Apple notarization credentials (APPLE_API_KEY/APPLE_API_KEY_ID/APPLE_API_ISSUER or APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID) present";
    log(`INFO | notarize | skipped: ${reason}`);
    return { status: "skipped", reason };
  }

  const tmpDir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "dociai-notarize-"));
  const zipPath = path.join(tmpDir, `${path.basename(appPath, ".app")}.zip`);
  try {
    log(`INFO | notarize | submitting ${appPath} for notarization (mode=${credentials.mode})`);
    await zipForNotarization(appPath, zipPath, { log });
    const submission = await submitAndWait(zipPath, credentials, { log });
    log(`INFO | notarize | accepted (id=${submission.id ?? "unknown"}), stapling ticket`);
    await stapleAndValidate(appPath, { log });
    log(`PASS | notarize | ${appPath} notarized and stapled`);
    return { status: "notarized", submissionId: submission.id };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

export default async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return { status: "skipped", reason: "not macOS" };
  const appPath = await locateAppBundle(context.appOutDir, context.packager?.appInfo?.productFilename);
  return notarizeAndStaple(appPath, { env: process.env, log: console.log });
}
