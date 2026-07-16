// Humidity Sensor Node — FireBeetle 2 ESP32-E + DHT22
//
// Each wake is a fresh boot from deep sleep:
//   power DHT → start WiFi (concurrent with sensor warmup) → read DHT →
//   send one UDP JSON packet → deep sleep.
//
// See ../CLAUDE.md for the full spec, power budget, and rationale.

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiUdp.h>
#include <DHT.h>
#include "config.h"

// --- Pins (confirmed against docs/ pinout PDF) ---
#define DHT_DATA_PIN   14   // D6 on silkscreen
#define DHT_POWER_PIN  25   // D2 on silkscreen — gates sensor VCC
#define VBAT_PIN       34   // A2 — onboard 2x1M divider, battery/2 (ADC1, WiFi-safe)

#define DHT_WARMUP_MS    2000   // DHT22 needs ~2 s after power-up
#define WIFI_TIMEOUT_MS  8000   // per spec: don't busy-retry beyond this

// Survives deep sleep; lost on power cycle / reset button.
RTC_DATA_ATTR uint32_t bootCount = 0;
RTC_DATA_ATTR uint8_t  savedBssid[6];
RTC_DATA_ATTR int32_t  savedChannel = 0;   // 0 = no saved fast-connect info

DHT dht(DHT_DATA_PIN, DHT22);

static void goToSleep() {
    WiFi.disconnect(true);   // radio off before sleeping
    WiFi.mode(WIFI_OFF);
    Serial.printf("Sleeping for %d s\n", SLEEP_SECONDS);
    Serial.flush();
    esp_sleep_enable_timer_wakeup((uint64_t)SLEEP_SECONDS * 1000000ULL);
    esp_deep_sleep_start();
}

void setup() {
    uint32_t t0 = millis();
    bootCount++;

    Serial.begin(115200);

    // 1. Power the DHT22 immediately so its warmup overlaps WiFi connect.
    pinMode(DHT_POWER_PIN, OUTPUT);
    digitalWrite(DHT_POWER_PIN, HIGH);
    uint32_t dhtPoweredAt = millis();
    dht.begin();

    // 2. Read battery voltage BEFORE WiFi (ADC1 pin, but keep radio quiet).
    //    Onboard divider halves the battery voltage.
    analogSetPinAttenuation(VBAT_PIN, ADC_11db);
    float vbat = analogReadMilliVolts(VBAT_PIN) * 2.0f / 1000.0f;

    // 3. Start WiFi. Static IP skips DHCP; saved BSSID+channel skips the scan.
    IPAddress ip, gw, mask, mac_ip;
    ip.fromString(STATIC_IP);
    gw.fromString(GATEWAY_IP);
    mask.fromString(SUBNET_MASK);
    mac_ip.fromString(MAC_IP);

    WiFi.mode(WIFI_STA);
    WiFi.config(ip, gw, mask);
    bool fastConnect = (savedChannel != 0);
    if (fastConnect) {
        WiFi.begin(WIFI_SSID, WIFI_PASS, savedChannel, savedBssid);
    } else {
        WiFi.begin(WIFI_SSID, WIFI_PASS);
    }

    // 4. Read the DHT22 once it has had >= 2 s of power (WiFi connects in
    //    parallel). Retry once on nan; on double-failure send an error packet
    //    so the Mac still sees the node is alive.
    uint32_t elapsed = millis() - dhtPoweredAt;
    if (elapsed < DHT_WARMUP_MS) delay(DHT_WARMUP_MS - elapsed);

    float temp = dht.readTemperature();
    float rh   = dht.readHumidity();
    const char *err = NULL;
    if (isnan(temp) || isnan(rh)) {
        delay(2000);
        temp = dht.readTemperature();
        rh   = dht.readHumidity();
        if (isnan(temp) || isnan(rh)) err = "dht_read_failed";
    }

    // 5. Wait for WiFi (bounded). On failure: clear fast-connect info so the
    //    next wake does a full scan, send nothing, sleep. No busy-retry.
    while (WiFi.status() != WL_CONNECTED && millis() - t0 < WIFI_TIMEOUT_MS) {
        delay(50);
    }
    if (WiFi.status() != WL_CONNECTED) {
        Serial.println("WiFi connect failed; clearing saved BSSID");
        savedChannel = 0;
        goToSleep();
    }

    // Save BSSID + channel for fast connect on the next wake.
    memcpy(savedBssid, WiFi.BSSID(), 6);
    savedChannel = WiFi.channel();

    // 6. Build and send one UDP JSON datagram.
    char tempStr[16], rhStr[16];
    if (err) {
        strcpy(tempStr, "null");
        strcpy(rhStr, "null");
    } else {
        snprintf(tempStr, sizeof(tempStr), "%.1f", temp);
        snprintf(rhStr, sizeof(rhStr), "%.1f", rh);
    }

    char errStr[32];
    if (err) snprintf(errStr, sizeof(errStr), "\"%s\"", err);
    else     strcpy(errStr, "null");

    char packet[256];
    int len = snprintf(packet, sizeof(packet),
        "{\"node\":\"%s\",\"fw\":\"%s\",\"temp_c\":%s,\"rh\":%s,"
        "\"vbat\":%.2f,\"rssi\":%d,\"boot\":%u,\"err\":%s}",
        NODE_ID, FW_VERSION, tempStr, rhStr,
        vbat, WiFi.RSSI(), bootCount, errStr);

    WiFiUDP udp;
    udp.beginPacket(mac_ip, MAC_PORT);
    udp.write((const uint8_t *)packet, len);
    udp.endPacket();
    delay(50);   // let the radio actually flush the datagram

    Serial.printf("Sent (%s connect, %lu ms awake): %s\n",
                  fastConnect ? "fast" : "full",
                  (unsigned long)(millis() - t0), packet);

    // 7. Sleep. DHT power pin drops LOW automatically in deep sleep.
    goToSleep();
}

void loop() {
    // Never reached — every wake runs setup() then deep-sleeps.
}
