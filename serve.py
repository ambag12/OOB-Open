#!/usr/bin/env python3
"""Local dashboard for Amazon Ads out-of-budget analysis.

    python3 serve.py

Opens http://localhost:8765 in your browser. Drag change-history exports onto
the page and the dashboard appears. Everything runs on this machine -- the
server binds to localhost only and nothing is uploaded anywhere.

This is the single-user local mode: no accounts, no database, no dependencies
beyond openpyxl. The hosted multi-user version is `app.main`, run under uvicorn;
both call the same pipeline in app/services, so the two can never disagree.
"""

from __future__ import annotations

import argparse
import json
import shutil
import tempfile
import threading
import traceback
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from app.services import exporters
from app.services.analysis import run_analysis

HERE = Path(__file__).resolve().parent
WEB = HERE / "web"
MAX_UPLOAD = 200 * 1024 * 1024

MIME = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml",
        ".ico": "image/x-icon"}


class Session:
    """Uploaded files and the most recent analysis, held in memory."""

    def __init__(self) -> None:
        self.dir = Path(tempfile.mkdtemp(prefix="ppc-dashboard-"))
        self.history: list[Path] = []
        self.perf: Path | None = None
        self.last: dict | None = None
        self.lock = threading.Lock()

    def add(self, name: str, data: bytes, kind: str) -> Path:
        # One subfolder per upload keeps path.name the user's real filename, so
        # error messages and the Data Quality sheet never show a "0_" prefix.
        safe = Path(name).name.replace("/", "_") or "upload.xlsx"
        slot = self.dir / f"{len(self.history)}{'p' if kind == 'perf' else ''}"
        slot.mkdir(parents=True, exist_ok=True)
        target = slot / safe
        target.write_bytes(data)
        if kind == "perf":
            self.perf = target
        else:
            self.history.append(target)
        return target

    def clear(self) -> None:
        shutil.rmtree(self.dir, ignore_errors=True)
        self.dir = Path(tempfile.mkdtemp(prefix="ppc-dashboard-"))
        self.history.clear()
        self.perf = None
        self.last = None

    def dispose(self) -> None:
        shutil.rmtree(self.dir, ignore_errors=True)


SESSION = Session()


def analyze(settings_in: dict) -> dict:
    """Run the pipeline over everything uploaded so far."""
    result = run_analysis(SESSION.history, SESSION.perf, settings_in)
    SESSION.last = result.artifacts
    return result.payload


class Handler(BaseHTTPRequestHandler):
    server_version = "PPCDashboard/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quieter console
        if "/api/" in str(args[0]) and "200" not in str(args):
            super().log_message(fmt, *args)

    # ------------------------------------------------------------- helpers

    def _send(self, code, body: bytes, ctype: str, extra: dict | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=HTTPStatus.OK) -> None:
        self._send(code, json.dumps(obj).encode(), "application/json; charset=utf-8")

    def _error(self, message: str, code=HTTPStatus.BAD_REQUEST) -> None:
        self._json({"error": message}, code)

    def _body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_UPLOAD:
            raise ValueError("File is too large.")
        return self.rfile.read(length) if length else b""

    # ------------------------------------------------------------ requests

    def do_GET(self) -> None:
        route = urlparse(self.path)
        path = route.path

        if path == "/api/state":
            self._json({
                "history": [p.name for p in SESSION.history],
                "perf": SESSION.perf.name if SESSION.perf else None,
            })
            return

        if path == "/api/export":
            self._export(parse_qs(route.query).get("format", ["xlsx"])[0])
            return

        rel = "index.html" if path in ("/", "") else path.lstrip("/")
        target = (WEB / rel).resolve()
        if not str(target).startswith(str(WEB.resolve())) or not target.is_file():
            self._send(HTTPStatus.NOT_FOUND, b"Not found", "text/plain; charset=utf-8")
            return
        self._send(HTTPStatus.OK, target.read_bytes(),
                   MIME.get(target.suffix, "application/octet-stream"))

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        try:
            if path == "/api/upload":
                name = self.headers.get("X-Filename", "upload.xlsx")
                kind = self.headers.get("X-Kind", "history")
                data = self._body()
                if not data:
                    self._error("That file was empty.")
                    return
                with SESSION.lock:
                    SESSION.add(name, data, kind)
                self._json({"ok": True, "name": Path(name).name})
                return

            if path == "/api/analyze":
                raw = self._body()
                settings_in = json.loads(raw) if raw else {}
                with SESSION.lock:
                    self._json(analyze(settings_in))
                return

            if path == "/api/clear":
                with SESSION.lock:
                    SESSION.clear()
                self._json({"ok": True})
                return

            self._error("Unknown endpoint.", HTTPStatus.NOT_FOUND)

        except ValueError as exc:
            self._error(str(exc))
        except Exception as exc:  # noqa: BLE001 - surface the real cause in the UI
            traceback.print_exc()
            self._error(f"{type(exc).__name__}: {exc}", HTTPStatus.INTERNAL_SERVER_ERROR)

    def _export(self, fmt: str) -> None:
        last = SESSION.last
        if not last:
            self._error("Analyse some files first.")
            return
        stamp = exporters.export_stamp(last)

        if fmt == "csv":
            self._send(HTTPStatus.OK, exporters.csv_bytes(last), exporters.CSV_MIME,
                       {"Content-Disposition":
                        f'attachment; filename="ppc-budget_{stamp}.csv"'})
            return

        self._send(HTTPStatus.OK, exporters.xlsx_bytes(last), exporters.XLSX_MIME,
                   {"Content-Disposition":
                    f'attachment; filename="ppc-budget-report_{stamp}.xlsx"'})


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Local out-of-budget dashboard.")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--no-browser", action="store_true")
    p.add_argument("--preload", action="store_true",
                   help="Load any exports already sitting in data/ on startup.")
    args = p.parse_args(argv)

    if args.preload:
        for f in sorted((HERE / "data").glob("*.xlsx")):
            if not f.name.startswith("~$"):
                SESSION.add(f.name, f.read_bytes(), "history")
        if SESSION.history:
            print(f"  preloaded {len(SESSION.history)} file(s) from data/")

    url = f"http://localhost:{args.port}"
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError as exc:
        print(f"Could not start on port {args.port}: {exc}")
        print(f"Something else may be using it. Try: python3 serve.py --port {args.port + 1}")
        return 1

    print(f"\n  PPC out-of-budget dashboard running at {url}")
    print("  Drag your amazon-ads-history exports onto the page.")
    print("  Everything stays on this machine. Press Ctrl+C to stop.\n")
    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  stopped")
    finally:
        server.server_close()
        SESSION.dispose()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
