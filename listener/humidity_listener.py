#!/usr/bin/env python3
"""UDP listener for the humidity sensor node.

Receives one JSON datagram per reading from the ESP32 node, validates it,
and appends it to a CSV file and a SQLite database. Runs unattended as a
launchd LaunchAgent on the always-on Mac (Niedermediamac).

Stdlib only. Crash-tolerant: malformed packets are logged and skipped.
"""

import csv
import json
import logging
import socket
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

# --- Config ---
LISTEN_HOST = "0.0.0.0"
LISTEN_PORT = 50505                      # must match MAC_PORT in firmware config.h
DATA_DIR = Path.home() / "humidity-data"
CSV_PATH = DATA_DIR / "readings.csv"
DB_PATH = DATA_DIR / "readings.db"
LOG_PATH = Path.home() / "Library" / "Logs" / "humidity-listener.log"

CSV_FIELDS = ["iso_ts", "node", "temp_c", "rh", "vbat", "rssi", "boot", "err"]


def csv_safe(value):
    """Neutralize spreadsheet formula injection.

    `node` and `err` come straight off the wire (untrusted UDP). A cell that
    begins with = + - @ (or a leading tab/CR) is treated as a formula by
    Excel/Numbers/Sheets, so an attacker who can reach the listener could get
    code to run when someone opens readings.csv. Prefix such cells with a
    single quote, which spreadsheets strip on display but which defuses the
    formula. Non-string values are returned unchanged.
    """
    if isinstance(value, str) and value and value[0] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + value
    return value


def setup_logging() -> None:
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        filename=LOG_PATH,
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )


def init_storage() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not CSV_PATH.exists():
        with CSV_PATH.open("w", newline="") as f:
            csv.writer(f).writerow(CSV_FIELDS)
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """CREATE TABLE IF NOT EXISTS readings (
               iso_ts  TEXT NOT NULL,
               node    TEXT NOT NULL,
               temp_c  REAL,
               rh      REAL,
               vbat    REAL,
               rssi    INTEGER,
               boot    INTEGER,
               err     TEXT
           )"""
    )
    conn.commit()
    return conn


def parse_packet(data: bytes) -> dict:
    """Parse and validate one datagram. Raises ValueError on bad input."""
    try:
        obj = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise ValueError(f"not valid JSON: {e}") from e
    if not isinstance(obj, dict) or "node" not in obj:
        raise ValueError("missing 'node' field")

    row = {
        "iso_ts": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "node": str(obj["node"]),
        "temp_c": obj.get("temp_c"),
        "rh": obj.get("rh"),
        "vbat": obj.get("vbat"),
        "rssi": obj.get("rssi"),
        "boot": obj.get("boot"),
        "err": obj.get("err"),
    }
    # Sanity-check numeric fields; null is allowed (failed sensor read).
    for field in ("temp_c", "rh", "vbat"):
        v = row[field]
        if v is not None and not isinstance(v, (int, float)):
            raise ValueError(f"'{field}' is not numeric: {v!r}")
    return row


def store(conn: sqlite3.Connection, row: dict) -> None:
    with CSV_PATH.open("a", newline="") as f:
        safe_row = {k: csv_safe(v) for k, v in row.items()}
        csv.DictWriter(f, fieldnames=CSV_FIELDS).writerow(safe_row)
    conn.execute(
        "INSERT INTO readings (iso_ts, node, temp_c, rh, vbat, rssi, boot, err) "
        "VALUES (:iso_ts, :node, :temp_c, :rh, :vbat, :rssi, :boot, :err)",
        row,
    )
    conn.commit()


def main() -> None:
    setup_logging()
    conn = init_storage()

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind((LISTEN_HOST, LISTEN_PORT))
    logging.info("Listening on %s:%d", LISTEN_HOST, LISTEN_PORT)

    # The node sends each reading 3x (cold-ARP insurance); dedupe on
    # (node, boot) so only the first copy of each wake's reading is stored.
    last_key = None

    while True:
        try:
            data, addr = sock.recvfrom(2048)
        except OSError as e:
            logging.error("socket error: %s", e)
            continue
        try:
            row = parse_packet(data)
        except ValueError as e:
            logging.warning("bad packet from %s: %s (raw: %r)", addr[0], e, data[:200])
            continue
        key = (row["node"], row["boot"])
        if row["boot"] is not None and key == last_key:
            continue   # duplicate copy of a reading we already stored
        last_key = key
        try:
            store(conn, row)
        except (OSError, sqlite3.Error) as e:
            logging.error("failed to store reading: %s", e)
            continue
        logging.info(
            "%s: temp=%s°C rh=%s%% vbat=%s rssi=%s boot=%s err=%s",
            row["node"], row["temp_c"], row["rh"],
            row["vbat"], row["rssi"], row["boot"], row["err"],
        )


if __name__ == "__main__":
    main()
