export function contentSecurityPolicy(devServerUrl?: string): string {
  const connect = devServerUrl ? `${new URL(devServerUrl).origin} http: https: ws: wss:` : "'self' http: https: ws: wss:";
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    `connect-src ${connect}`,
  ].join("; ");
}

export function securityHeaders(devServerUrl?: string): Record<string, string> {
  return {
    "Content-Security-Policy": contentSecurityPolicy(devServerUrl),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), geolocation=(), microphone=(self)",
  };
}

export function installCspPolicy(devServerUrl?: string): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (!isTrustedAppUrl(details.url, devServerUrl)) return callback({ responseHeaders: details.responseHeaders });
    const headers = securityHeaders(devServerUrl);
    callback({ responseHeaders: { ...details.responseHeaders, ...Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, [value]])) } });
  });
}
import { session } from "electron";
import { isTrustedAppUrl } from "./navigation";
