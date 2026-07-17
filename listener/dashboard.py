#!/usr/bin/env python3
"""Humidity node dashboard.

Small stdlib-only HTTP server that reads the SQLite database written by
humidity_listener.py and serves a single-page dashboard: stat tiles, three
small-multiple line charts (temperature, humidity, battery), and a table.

Runs on the same always-on Mac as the listener (launchd LaunchAgent).
Port 8011 — registered in ~/code/locker/PORTS.md.
"""

import json
import logging
import sqlite3
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

PORT = 8011
DB_PATH = Path.home() / "humidity-data" / "readings.db"
STATIC_DIR = Path(__file__).parent / "static"
LOG_PATH = Path.home() / "Library" / "Logs" / "humidity-dashboard.log"

MAX_ROWS = 5000

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
}


def query_readings(hours: int) -> list:
    """Rows since now-hours, ascending. iso_ts strings share a fixed local
    offset, so lexicographic comparison against a same-format cutoff works."""
    cutoff = (datetime.now().astimezone() - timedelta(hours=hours)).isoformat(
        timespec="seconds"
    )
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    try:
        rows = conn.execute(
            "SELECT iso_ts, temp_c, rh, vbat, rssi, boot, err FROM readings "
            "WHERE iso_ts >= ? ORDER BY iso_ts LIMIT ?",
            (cutoff, MAX_ROWS),
        ).fetchall()
    finally:
        conn.close()
    keys = ("iso_ts", "temp_c", "rh", "vbat", "rssi", "boot", "err")
    return [dict(zip(keys, r)) for r in rows]


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        route = parsed.path
        try:
            if route == "/api/readings":
                qs = parse_qs(parsed.query)
                hours = min(int(qs.get("hours", ["24"])[0]), 24 * 90)
                body = json.dumps({"rows": query_readings(hours)}).encode()
                self._send(200, "application/json", body)
            elif route == "/":
                self._send_file(STATIC_DIR / "index.html")
            elif route in ("/style.css", "/app.js"):
                self._send_file(STATIC_DIR / route.lstrip("/"))
            else:
                self._send(404, "text/plain", b"not found")
        except (OSError, sqlite3.Error, ValueError) as e:
            logging.error("%s %s -> %s", self.command, self.path, e)
            self._send(500, "text/plain", b"server error")

    def _send_file(self, path: Path):
        body = path.read_bytes()
        self._send(200, CONTENT_TYPES.get(path.suffix, "text/plain"), body)

    def _send(self, status: int, ctype: str, body: bytes):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass  # quiet; errors are logged explicitly above


def main():
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        filename=LOG_PATH,
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    logging.info("Dashboard on http://0.0.0.0:%d (db: %s)", PORT, DB_PATH)
    server.serve_forever()


if __name__ == "__main__":
    main()
