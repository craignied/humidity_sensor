// Humidity Sensor Node — configuration template.
// Copy to config.h and fill in real values. config.h is gitignored;
// NEVER commit real credentials.

#pragma once

#define WIFI_SSID     "your-ssid"
#define WIFI_PASS     "your-password"

#define MAC_IP        "192.168.1.xxx"   // Niedermediamac static/reserved IP
#define MAC_PORT      50505

#define NODE_ID       "humidity-01"
#define FW_VERSION    "1.0.0"

// Sleep interval between readings. 300 s = 5 min (~6-7 months battery with
// fast-connect); 900 s = 15 min (~1 year). See CLAUDE.md Power Budget.
#define SLEEP_SECONDS 300

// Static IP for this node — skips DHCP to shorten radio-on time.
// Give it a DHCP reservation on the router so nothing else claims it.
#define STATIC_IP     "192.168.1.yyy"
#define GATEWAY_IP    "192.168.1.1"
#define SUBNET_MASK   "255.255.255.0"
