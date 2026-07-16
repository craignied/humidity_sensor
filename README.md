# Humidity Sensor Node

Battery-powered humidity/temperature node built on a FireBeetle 2 ESP32-E. It
wakes on a timer, reads a DHT22, pushes one reading over WiFi (UDP/JSON) to an
always-on Mac, and goes back to deep sleep. A small launchd-managed Python
listener on the Mac receives and logs the readings to CSV and SQLite.

Full spec, rationale, and hardware details live in [CLAUDE.md](CLAUDE.md) —
that file is the source of truth for this project. This README is just the
quick-start.

## Hardware

| Item | Part |
|---|---|
| MCU board | DFRobot FireBeetle 2 ESP32-E (DFR0654-F) |
| Battery | 3.7 V 2500 mAh LiPo, JST PH2.0 |
| Sensor | DHT22 / AM2302 |
| Receiver | Always-on Mac running the Python listener |

## Repository layout

```
firmware/                 # PlatformIO project (Arduino framework)
├── platformio.ini
├── src/main.cpp
└── include/config.example.h   # copy to config.h and fill in secrets
listener/                 # Python UDP listener (runs on the always-on Mac)
├── humidity_listener.py
├── com.niedertronics.humidity.listener.plist
├── requirements.txt
└── install.sh
```

## Wiring

| DHT22 module pin | FireBeetle 2 ESP32-E pin | Silkscreen label |
|---|---|---|
| VCC (+) | GPIO25 | `D2` |
| DATA (out) | GPIO14 | `D6` |
| GND (-) | GND | `GND` |

```
DHT22 module            FireBeetle 2 ESP32-E
-----------             --------------------
VCC  (+)    ----------> D2 / GPIO25   (power gate — NOT the 3V3 pin)
DATA (out)  ----------> D6 / GPIO14   (pull-up on module)
GND  (-)    ----------> GND
```

**Do not wire VCC to the board's 3V3 pin.** `D2`/GPIO25 powers the sensor
directly so it draws zero current in deep sleep — wiring to 3V3 instead works
electrically but defeats that gating.

The GPIO↔silkscreen mapping (`GPIO14`=`D6`, `GPIO25`=`D2`) is confirmed
against the official DFRobot pinout PDF in [docs/](docs/).

**Before first battery plug-in:** meter the LiPo pigtail against the board's
PH2.0 pads and confirm red = `+` matches the board's silk before plugging in.

**Known issue — Qimoo 104050 ships with reversed polarity:** its stock
JST-PH plug is black-to-`+`/red-to-`-` relative to the FireBeetle's socket.
Don't force it in — de-pin and swap the two crimp contacts instead (no
soldering needed). Tutorial: [The easy way to remove/extract female inserts
from JST connector](https://www.youtube.com/watch?v=nRVhPhfdawg). Re-meter
after swapping.

## Build, flash, verify

1. Copy the firmware config template and fill in your WiFi/network values:
   ```bash
   cd firmware && cp include/config.example.h include/config.h
   ```
2. Flash over USB-C and watch the first wake:
   ```bash
   pio run -t upload
   pio device monitor
   ```
3. On the receiving Mac, install the listener as a LaunchAgent:
   ```bash
   cd listener && ./install.sh
   launchctl list | grep humidity   # confirm it's loaded
   ```
4. Watch `~/Library/Logs/humidity-listener.log` for the first datagram, and
   confirm rows land in `~/humidity-data/readings.csv` and `readings.db`.
5. Unplug USB, run the node on the LiPo, and confirm readings keep arriving
   every interval.

## Notes

- Wire polarity, pin assignments, packet format, WiFi fast-connect strategy,
  and expected battery life are all documented in [CLAUDE.md](CLAUDE.md) —
  read it before making hardware or firmware changes.
- `firmware/include/config.h` is gitignored; never commit real WiFi
  credentials or IPs.
