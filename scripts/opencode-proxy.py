#!/usr/bin/env python3
"""opencode.ai Zen/Go APIはブラウザからのCORSプリフライト(OPTIONS)に対応していないため、
ローカルでCORSヘッダを付与するだけの中継サーバーを立てる。
APIキーはブラウザ側が送るAuthorizationヘッダをそのまま転送するだけで、
このプロキシ自身はキーを保持・ログ出力しない。

使い方:
  python3 scripts/opencode-proxy.py [port]   # 既定 8787

config.local.json 側の設定:
  "baseUrl": "http://localhost:8787"
"""

import sys
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM = "https://opencode.ai/zen/go/v1"


class ProxyHandler(BaseHTTPRequestHandler):
    def _cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors_headers()
        self.end_headers()

    def do_GET(self):
        self._forward(body=None)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else None
        self._forward(body)

    def _forward(self, body):
        url = f"{UPSTREAM}{self.path}"
        headers = {
            "Content-Type": self.headers.get("Content-Type", "application/json"),
            # opencode.aiのCloudflareがurllibの既定UAをbotとして403にするため、
            # ブラウザ相当のUAを送る。
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
            ),
            "Accept": "application/json",
        }
        auth = self.headers.get("Authorization")
        if auth:
            headers["Authorization"] = auth

        req = urllib.request.Request(url, data=body, headers=headers, method=self.command)
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                self._reply(res.status, res.read(), res.headers.get("Content-Type", "application/json"))
        except urllib.error.HTTPError as e:
            self._reply(e.code, e.read(), e.headers.get("Content-Type", "application/json"))
        except urllib.error.URLError as e:
            self._reply(502, str(e.reason).encode("utf-8"), "text/plain")

    def _reply(self, status, payload, content_type):
        self.send_response(status)
        self._cors_headers()
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, fmt, *args):
        sys.stderr.write(f"[opencode-proxy] {self.address_string()} {fmt % args}\n")


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8787
    server = ThreadingHTTPServer(("localhost", port), ProxyHandler)
    print(f"opencode-proxy: http://localhost:{port} -> {UPSTREAM}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
