import fs from "node:fs/promises";
import path from "node:path";
import { app, protocol } from "electron";
import { ensureAppPaths, resolveAppPaths } from "./paths";
import { createWindowController } from "./windows";
import { installCspPolicy, securityHeaders } from "./security/csp";
import { installPermissionPolicy } from "./security/permissions";
import { registerIpcHandlers } from "./ipc/register";

protocol.registerSchemesAsPrivileged([{
  scheme: "dociai",
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}]);

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  let controller: ReturnType<typeof createWindowController> | null = null;
  let quitting = false;
  const logError = (label: string, error: unknown) => console.error(`[dociai:${label}]`, error instanceof Error ? error.stack ?? error.message : String(error));
  process.on("uncaughtException", (error) => logError("uncaught-exception", error));
  process.on("unhandledRejection", (error) => logError("unhandled-rejection", error));

  app.on("second-instance", () => controller?.focusConsole());
  app.on("before-quit", () => { quitting = true; controller?.dispose(); });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });

  app.whenReady().then(async () => {
    const paths = resolveAppPaths(app.getPath("userData"));
    ensureAppPaths(paths);
    const appPath = app.getAppPath();
    const devServerUrl = process.env.DOCIAI_DEV_SERVER_URL;
    installCspPolicy(devServerUrl);
    installPermissionPolicy(devServerUrl);

    if (!devServerUrl) {
      await protocol.handle("dociai", async (request) => {
        const requestUrl = new URL(request.url);
        const headers = securityHeaders(devServerUrl);
        if (requestUrl.hostname !== "app") return new Response("Not found", { status: 404, headers });
        const relativePath = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, "");
        const configuredFile = paths.configFile;
        const configuredExists = relativePath === "config.local.json" && await fs.stat(configuredFile).then(() => true).catch(() => false);
        const candidate = configuredExists ? configuredFile : path.resolve(appPath, relativePath);
        if (!configuredExists && candidate !== appPath && !candidate.startsWith(`${appPath}${path.sep}`)) return new Response("Forbidden", { status: 403, headers });
        try {
          const body = await fs.readFile(candidate);
          const contentType = relativePath.endsWith(".html") ? "text/html; charset=utf-8" : relativePath.endsWith(".js") ? "text/javascript; charset=utf-8" : relativePath.endsWith(".css") ? "text/css; charset=utf-8" : relativePath.endsWith(".json") ? "application/json; charset=utf-8" : "application/octet-stream";
          return new Response(body, { headers: { ...headers, "Content-Type": contentType, "Cache-Control": "no-store" } });
        } catch {
          if (relativePath === "config.local.json") {
            const example = await fs.readFile(path.join(appPath, "config.local.example.json"));
            return new Response(example, { headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } });
          }
          return new Response("Not found", { status: 404, headers });
        }
      });
    }

    controller = createWindowController({ appPath, preloadPath: path.join(appPath, "preload.cjs"), paths, devServerUrl, isPackaged: app.isPackaged });
    const unregisterIpcHandlers = registerIpcHandlers({ controller, paths, devServerUrl });
    app.once("before-quit", unregisterIpcHandlers);
    controller.createConsoleWindow();
    app.on("activate", () => controller?.createConsoleWindow());
  }).catch((error) => { logError("startup", error); if (!quitting) app.quit(); });
}
