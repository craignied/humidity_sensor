# CLAUDE.md — Humidity Sensor Node

Read and follow the instructions in /Users/craign/code/locker/CLAUDE.md before proceeding.

Battery-powered humidity/temperature node built on a FireBeetle 2 ESP32-E. It
wakes on a timer, reads a DHT22, pushes one reading over WiFi to an always-on
Mac (Niedermediamac), and goes back to deep sleep. A small launchd-managed
Python listener on the Mac receives and logs the readings.

This file is the source of truth for the project. Read it before proposing
changes. The hardware is fixed and in hand — do not suggest swapping parts.

---

## Success criteria

- Node reads temp + relative humidity every 5 minutes (configurable) and
  delivers each reading to the Mac.
- Node spends >99% of its time in deep sleep so a single 2500 mAh LiPo lasts
  months (see Power Budget for the honest numbers and the interval tradeoff).
- Listener runs unattended on Niedermediamac, survives reboots, and appends
  every reading to a durable log.
- No purpose-built PCB, no external charger: flash + charge over USB-C, run on
  the LiPo.

---

## Hardware (as-built, do not substitute)

| Item | Part | Notes |
|---|---|---|
| MCU board | DFRobot FireBeetle 2 ESP32-E, **DFR0654-F** (4 MB, pre-soldered headers) | ESP32-WROOM-32E, PCB antenna, onboard LiPo charging + PH2.0 battery connector, USB-C |
| Battery | Qimoo 104050 LiPo, 3.7 V **2500 mAh**, JST **PH2.0** (protected cell) | Plugs straight into the board's PH2.0 socket |
| Sensor | HiLetgo DHT22 / AM2302 module (3-wire pigtail) | 0–100 % RH, ±2 % RH, ±0.5 °C; onboard pull-up present |
| Receiver | **Niedermediamac** — Mac mini 2024 (M4, 16 GB), always-on, Ethernet, runs Roon Core | Chosen because it never sleeps; a sleeping Mac would drop readings |

Deliberately **not** used: 4×AA pack, buck converter, external antenna, DevKitC
clone. Those were considered and rejected earlier — the FireBeetle + single LiPo
is the whole point.

---

## Architecture

```
[FireBeetle 2 ESP32-E]  --WiFi UDP/JSON-->  [Niedermediamac :PORT]
   deep sleep 5 min                            Python UDP listener
   wake → power DHT → read →                    (launchd LaunchAgent)
   connect WiFi → send → sleep                  → append to log (CSV + SQLite)
```

The node is a **client that pushes** — it is never a server and never stays
awake to be polled. That distinction is what preserves battery life. All
persistence and any UI live on the always-on Mac, not the node.

Transport is **UDP + JSON**. UDP is chosen over HTTP/TCP to minimize radio-on
time (no TCP handshake/teardown), which is the dominant battery cost per wake.
Lost packets are acceptable for periodic environmental data. MQTT is a viable
future upgrade if more nodes get added (see Future).

---

## Repository layout

```
humidity-node/
├── CLAUDE.md                 # this file
├── README.md                 # human quick-start
├── firmware/                 # PlatformIO project (Arduino framework)
│   ├── platformio.ini
│   ├── src/main.cpp
│   └── include/config.h      # secrets + tunables (gitignored)
│   └── include/config.example.h
└── listener/                 # Python UDP listener for Niedermediamac
    ├── humidity_listener.py
    ├── com.niedertronics.humidity.listener.plist
    ├── requirements.txt       # stdlib-only if possible; keep deps minimal
    └── install.sh
```

Follow the conventions in the global `~/code/locker/CLAUDE.md`. Target repo:
`github.com/craignied/humidity-node` (or under existing `craignied/scripts` if
preferred). Python is pyenv-managed. Keep the listener dependency-light —
prefer the standard library (socket, json, sqlite3, csv, logging).

---

## Part A — Firmware spec (`firmware/`)

### Toolchain
- PlatformIO, `framework = arduino`, `board = dfrobot_firebeetle2_esp32e`
  (verify board id against PlatformIO's board list; fall back to a generic
  `esp32dev` env with correct flash size if the FireBeetle id is unavailable).
- Library: `adafruit/DHT sensor library` (+ `Adafruit Unified Sensor`), or
  `beegee-tokyo/DHTesp`. Pick one and pin the version in `platformio.ini`.

### Pins (FireBeetle 2 ESP32-E)
Use raw GPIO numbers in code and confirm against the DFRobot pinout/silk before
first flash. Avoid strapping pins (GPIO0, 2, 12, 15).

| Function | GPIO | Notes |
|---|---|---|
| DHT22 DATA | **GPIO14** | Digital in; module has its own pull-up |
| DHT22 POWER (gate) | **GPIO25** | Drives sensor VCC so it's fully off during sleep |
| DHT22 GND | GND | — |

**Power-gating rationale:** driving the sensor's VCC from a GPIO means it draws
nothing in deep sleep. On wake, set GPIO25 HIGH, wait for the DHT22 to
stabilize (~2 s), read, then it de-energizes automatically when the board
sleeps. A GPIO sources far more than the DHT22's ~1.5 mA read current, so this
is safe. (Simpler alternative: wire VCC to 3V3 permanently — costs ~30–50 µA
continuous, still fine, but gating is preferred.)

### Program flow (each wake is a fresh boot from deep sleep)
1. Boot. Set GPIO25 HIGH to power the DHT22.
2. **Concurrently** start WiFi connect (see fast-connect) while the DHT warms —
   don't serialize the 2 s sensor warmup after the WiFi connect.
3. After ≥2 s powered, read the DHT22. On `nan`, retry once after 2 s. If still
   `nan`, send the packet with a null reading + error flag (so the Mac sees the
   node is alive) rather than silently skipping.
4. When WiFi is up, send one UDP JSON packet to the Mac.
5. Deep sleep for `SLEEP_SECONDS`.

### WiFi fast-connect (battery-critical)
A cold associate (scan + auth + DHCP) can take 2–4 s at ~120 mA — the single
biggest drain per cycle. Minimize it:
- Store BSSID + channel in `RTC_DATA_ATTR` so they persist across deep sleep.
- Use `WiFi.begin(ssid, pass, channel, bssid)` on subsequent wakes; full scan
  only on first boot or after a failed fast-connect.
- Use a **static IP** via `WiFi.config()` to skip DHCP.
- Connect timeout ~8 s. On failure: **do not busy-retry** (it drains the cell);
  send nothing, clear the stored BSSID so the next wake does a full connect,
  and deep-sleep normally.

### Packet format (UDP, JSON, one datagram)
```json
{
  "node": "humidity-01",
  "fw": "1.0.0",
  "temp_c": 22.4,
  "rh": 48.7,
  "vbat": 3.98,
  "rssi": -62,
  "boot": 42,
  "err": null
}
```
- `vbat` optional — the FireBeetle 2 can sense battery voltage via an onboard
  divider; confirm the ADC pin on the DFRobot wiki and use an **ADC1** pin
  (ADC2 is unusable while WiFi is on). Read it *before* bringing WiFi up. If the
  pin isn't confirmed, omit `vbat` for v1.0.
- `boot` = a counter in `RTC_DATA_ATTR`, handy for spotting resets/missed sends.
- `err` = short string when a read fails, else null.

### Config (`include/config.h`, gitignored)
```c
#define WIFI_SSID     "..."
#define WIFI_PASS     "..."
#define MAC_IP        "192.168.x.x"   // Niedermediamac static/reserved IP
#define MAC_PORT      50505
#define NODE_ID       "humidity-01"
#define SLEEP_SECONDS 300             // 5 min. See Power Budget for tradeoff.
#define STATIC_IP     "192.168.x.y"   // this node
#define GATEWAY_IP    "192.168.x.1"
#define SUBNET_MASK   "255.255.255.0"
```
Ship a `config.example.h` with placeholders; never commit real secrets.

---

## Part B — Listener spec (`listener/`, runs on Niedermediamac)

### Behavior
- Bind a UDP socket on `0.0.0.0:MAC_PORT`.
- For each datagram: parse JSON, validate, then:
  - append a row to a **CSV** (`~/humidity-data/readings.csv`:
    `iso_ts,node,temp_c,rh,vbat,rssi,boot,err`), and
  - insert into a **SQLite** db (`~/humidity-data/readings.db`, table
    `readings`) for easy querying later.
- Log each accepted reading and any parse errors via `logging` to
  `~/Library/Logs/humidity-listener.log`.
- Stdlib only (socket, json, sqlite3, csv, logging, pathlib). No Flask needed.
- Be crash-tolerant: malformed packet → log and continue, never exit.

### launchd (`com.niedertronics.humidity.listener.plist`)
Install as a **LaunchAgent** in `~/Library/LaunchAgents/`. Niedermediamac stays
logged in for Roon, so a user agent is sufficient; note a LaunchDaemon
alternative in the README if it should survive logout.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>            <string>com.niedertronics.humidity.listener</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/USERNAME/.pyenv/shims/python</string>
    <string>/Users/USERNAME/code/humidity-node/listener/humidity_listener.py</string>
  </array>
  <key>RunAtLoad</key>        <true/>
  <key>KeepAlive</key>        <true/>
  <key>StandardOutPath</key>  <string>/Users/USERNAME/Library/Logs/humidity-listener.out.log</string>
  <key>StandardErrorPath</key><string>/Users/USERNAME/Library/Logs/humidity-listener.err.log</string>
</dict>
</plist>
```
`install.sh`: copy the plist (with `USERNAME`/paths filled in), then
`launchctl load -w ~/Library/LaunchAgents/com.niedertronics.humidity.listener.plist`.

### macOS gotchas
- The **application firewall** may prompt to allow incoming connections for
  `python` — allow it, or the datagrams get dropped. If Niedermediamac's
  firewall is set to block all incoming, add an explicit allow for the pyenv
  python binary.
- Give the node a **DHCP reservation** (or the static IP above) on the router so
  `MAC_IP` and the node's IP never drift.
- This is the same launchd + always-on pattern already used on Niedermediamac
  (SSH, Roon, prior FTP-transfer agent), so it should slot in cleanly.

---

## Wiring

```
DHT22 module            FireBeetle 2 ESP32-E
-----------             --------------------
VCC  (+)    ----------> GPIO25   (power gate)
DATA (out)  ----------> GPIO14   (pull-up on module)
GND  (-)    ----------> GND

LiPo (Qimoo, PH2.0) --> PH2.0 battery socket   *** verify polarity first ***
USB-C ---------------->  flashing + charging
```

**Before first battery plug-in:** meter the LiPo pigtail against the board's
PH2.0 pads and confirm red = `+` matches the board's silk. DFRobot added an
anti-reverse silkscreen, but reversed polarity kills the board — 30 s with a
meter is cheap insurance.

---

## Power budget & expected battery life

Honest numbers, 2500 mAh usable, gated DHT, board deep sleep ~10 µA. WiFi is the
dominant cost per wake, so the association time and the send interval drive
everything. (The "~1 year" figure discussed earlier assumed ESP-NOW's sub-100 ms
radio bursts; WiFi's multi-second associate costs more — hence the ranges below.)

| Config | Per-wake WiFi | ~Avg current | Est. life |
|---|---|---|---|
| 5 min, cold associate each wake (~3 s) | expensive | ~1.0 mA | **~3 months** |
| 5 min, fast reconnect (stored BSSID/ch + static IP, <1 s) | cheap | ~0.5 mA | **~6–7 months** |
| 15 min, fast reconnect | cheap | ~0.16 mA | **~1 year** (shelf-life capped) |

Implication: implement fast-connect from the start. If you want a full year and
5-minute data isn't essential, widen `SLEEP_SECONDS` to 900. All three live on
the same slider in the battery calculator from earlier — sleep current and
interval are the knobs.

---

## Build, flash, verify

1. `cd firmware && cp include/config.example.h include/config.h` and fill in.
2. `pio run -t upload` over USB-C. `pio device monitor` to watch the first wake.
3. On Niedermediamac: `cd listener && ./install.sh`, confirm the agent is
   loaded (`launchctl list | grep humidity`).
4. Watch `~/Library/Logs/humidity-listener.log` for the first datagram, and
   confirm rows land in `readings.csv` / `readings.db`.
5. Unplug USB, run on LiPo, confirm readings keep arriving every interval.

---

## Gotchas (carry these forward — they were learned the hard way)

- **Never feed 6 V (or anything >3.6 V) to the 3V3 pin.** Moot now that we're on
  a single LiPo, but noted so no one "improves" the power input later.
- **DHT22 needs ~2 s after power-up** for a stable first reading; discard/ignore
  `nan` on the first attempt.
- **ADC2 pins don't work while WiFi is on** — read `vbat` on an ADC1 pin before
  connecting.
- **Don't drive the onboard WS2812 RGB LED.** Leaving it unaddressed keeps it
  dark; only the power LED draws idle current, and removing it is an optional
  last-mile optimization, not needed for months of runtime.
- **Sleeping Macs drop packets** and won't wake for a normal UDP packet (that
  needs a WoL magic packet the node won't send). The receiver MUST be an
  always-on machine — Niedermediamac or the NAS, never a workstation.

---

## Future (not v1.0)

- Move transport to MQTT (Mosquitto on Niedermediamac or the NAS) if more nodes
  are added — cleaner fan-out and pairs with Home Assistant.
- ESP-NOW to a USB-attached ESP32 bridge if battery life needs to approach a
  year at 5-minute cadence without a second always-on dependency.
- Small dashboard reading from the SQLite db.
