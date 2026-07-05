#!/usr/bin/env python3
"""dociai 操作卓用のローカルサーバー。
静的ファイル配信 (python3 -m http.server 相当) に加えて、設定エディタ (issue #15) からの
保存を受け付ける PUT /config.local.json を実装する。それ以外のパスへの書き込みはできない。
127.0.0.1 のみで待受け、外部ネットワークには公開しない。

使い方:
  python3 scripts/serve.py [port]   # 既定 8080
"""

import json
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config.local.json"
SAVE_ROUTE = "/config.local.json"


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        # ローカル開発サーバーなので、ブラウザが古いJS/CSSをキャッシュして
        # 編集内容が反映されない事故を防ぐため、常に再検証させる。
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_PUT(self):
        if self.path != SAVE_ROUTE:
            self._json_error(404, "この経路への保存には対応していません")
            return
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else b""
        try:
            parsed = json.loads(body)
        except json.JSONDecodeError as e:
            self._json_error(400, f"JSONの構文エラー: {e}")
            return
        tmp_path = CONFIG_PATH.with_suffix(".json.tmp")
        tmp_path.write_text(json.dumps(parsed, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        tmp_path.replace(CONFIG_PATH)
        self._json_response(200, {"ok": True})

    # send_error() encodes the reason phrase as latin-1 for the HTTP status
    # line, which crashes on Japanese text. Send JSON error bodies directly instead.
    def _json_error(self, status, message):
        self._json_response(status, {"ok": False, "error": message})

    def _json_response(self, status, obj):
        payload = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, fmt, *args):
        sys.stderr.write(f"[dociai-serve] {self.address_string()} {fmt % args}\n")


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"dociai serve: http://127.0.0.1:{port} (root={ROOT})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
