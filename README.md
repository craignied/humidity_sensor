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
