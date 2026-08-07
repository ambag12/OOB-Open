#!/usr/bin/env python3
"""Local dashboard for Amazon Ads out-of-budget analysis.

    python3 serve.py

Opens http://localhost:8765 in your browser. Drag change-history exports onto
the page and the dashboard appears. Everything runs on this machine -- the
server binds to localhost only and nothing is uploaded anywhere.

The analysis is the same code the Excel report uses, so the two can never
disagree.
"""

from __future__ import annotations

import argparse
import json
import shutil
import tempfile
import threading
import traceback
import webbrowser
from datetime import date
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from ppcbudget import actions as actions_mod
from ppcbudget import aggregate, excelout, metrics, payload, perfjoin
from ppcbudget.ingest import dedupe_events, load_history
from ppcbudget.scoring import check_invariants, score_all

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
        safe = Path(name).name.replace("/", "_") or "upload.xlsx"
        target = self.dir / f"{len(self.history)}_{safe}"
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
    if not SESSION.history:
        raise ValueError("No change-history files uploaded yet.")

    events, metas, qas, skipped = [], [], [], []
    for path in SESSION.history:
        try:
            evs, meta, qa = load_history(path)
        except (ValueError, KeyError, OSError) as exc:
            skipped.append(f"{path.name}: {exc}")
            continue
        events.extend(evs)
        metas.append(meta)
        qas.append(qa)

    if not events:
        detail = " ".join(skipped) or "no readable rows"
        raise ValueError(f"None of the files could be read as a change-history export. {detail}")

    events, overlap_rows = dedupe_events(events)
    days = score_all(events, merge_gap_min=int(settings_in.get("merge_gap", 5)))
    if not days:
        raise ValueError("No campaigns had budget-state changes, so there is nothing to score.")

    join_report = None
    roas_source = "account_average"
    if SESSION.perf:
        records, join_report = perfjoin.load_performance(SESSION.perf)
        perfjoin.apply_to(days, records, join_report)
        roas_source = "campaign"

    account_roas = next((m.roas for m in metas if m.roas), None)
    roas_override = settings_in.get("roas")
    settings = metrics.ModelSettings(
        roas=float(roas_override) if roas_override else (account_roas or 4.0),
        roas_source="override" if roas_override else roas_source,
        haircut=float(settings_in.get("haircut", metrics.DEFAULT_ROAS_HAIRCUT)),
        cap_multiple=float(settings_in.get("cap", metrics.DEFAULT_CAP_MULTIPLE)),
    )
    metrics.apply(days, settings)
    totals = metrics.summarize(days)
    rollups = aggregate.rollup(days)
    date_keys = sorted({d.date_key for d in days})

    scored_names = {d.campaign for d in days}
    acts = actions_mod.build(events, date_keys, scored_names)
    act_summary = actions_mod.summarize(acts)

    data = payload.build(days, totals, rollups, qas, metas, settings, date_keys,
                         join_report, overlap_rows, acts, act_summary)
    problems = check_invariants(days)
    data["invariants"] = {"checked": len(days), "failed": problems[:5]}
    data["skipped"] = skipped

    SESSION.last = {
        "days": days, "totals": totals, "rollups": rollups, "qas": qas,
        "metas": metas, "settings": settings, "date_keys": date_keys,
        "join_report": join_report, "overlap_rows": overlap_rows,
        "actions": acts,
    }
    return data


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
                "history": [p.name.split("_", 1)[-1] for p in SESSION.history],
                "perf": SESSION.perf.name.split("_", 1)[-1] if SESSION.perf else None,
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
        stamp = f"{last['date_keys'][-1]}_{date.today():%Y%m%d}"

        if fmt == "csv":
            body = _csv(last["days"], last.get("actions") or {}).encode("utf-8-sig")
            self._send(HTTPStatus.OK, body, "text/csv; charset=utf-8",
                       {"Content-Disposition":
                        f'attachment; filename="ppc-budget_{stamp}.csv"'})
            return

        out = Path(tempfile.mkdtemp()) / f"ppc-budget-report_{stamp}.xlsx"
        excelout.write_report(out, last["days"], last["totals"], last["rollups"],
                              last["qas"], last["metas"], last["settings"],
                              last["date_keys"], last["join_report"],
                              last.get("overlap_rows", 0), last.get("actions"))
        body = out.read_bytes()
        shutil.rmtree(out.parent, ignore_errors=True)
        self._send(HTTPStatus.OK, body,
                   "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                   {"Content-Disposition": f'attachment; filename="{out.name}"'})


def _csv(days, actions: dict) -> str:
    import csv
    import io

    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\r\n")
    w.writerow([
        "date", "campaign", "eligible_hours", "in_budget_hours", "out_of_budget_hours",
        "paused_hours", "pct_of_active_day", "budget_cap_hits", "distinct_outages",
        "first_out", "last_recovery", "ended_out", "daily_budget", "budget_source",
        "spend_rate_per_hour", "lost_spend", "lost_sales", "capped", "severity",
        "diagnosis", "confidence", "uncertainty_hours",
        "last_action", "days_since_action", "what_changed_last", "actions_in_window",
    ])
    for d in sorted(days, key=lambda x: (-x.severity, x.campaign)):
        lost = d.lost or {}
        w.writerow([
            d.date_key, d.campaign, f"{d.eligible_min / 60:.2f}", f"{d.in_hours:.2f}",
            f"{d.oob_hours:.2f}", f"{d.paused_hours:.2f}", f"{d.oob_share:.4f}",
            d.episodes_raw, d.episodes_merged,
            excelout.hhmm(d.first_oob_min), excelout.hhmm(d.last_recovery_min),
            "yes" if d.closed_oob else "no",
            # Deliberately blank, never 0, when unobserved.
            f"{d.budget.time_weighted:.2f}" if d.budget.time_weighted else "",
            d.budget.source,
            f"{lost['spend_rate_per_hour']:.4f}" if lost.get("spend_rate_per_hour") else "",
            f"{lost['lost_spend']:.2f}" if lost.get("lost_spend") is not None else "",
            f"{lost['lost_sales']:.2f}" if lost.get("lost_sales") is not None else "",
            "yes" if lost.get("capped") else "",
            f"{d.severity:.1f}", d.diagnosis, d.confidence,
            f"{d.oob_uncertainty_min / 60:.2f}" if d.chain_breaks else "",
            *_action_columns(actions.get(d.campaign)),
        ])
    return buf.getvalue()


def _action_columns(act) -> tuple:
    """Last meaningful action, or an explicit statement that there was none."""
    if act is None:
        return ("not observed", "", "", "")
    return (act.summary,
            "" if act.days_since is None else act.days_since,
            act.last_label or "",
            act.count or "")


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
