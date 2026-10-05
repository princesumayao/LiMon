/*
  LiMon - Sound + DHT22 + RGB status LED build (no UHF yet, not wired)
  Publishes real noise and temperature/humidity readings over MQTT.

  Wiring:
    Sound sensor AO -> GPIO34
    DHT22 data      -> GPIO13 (with 10k pull-up to 3.3V)
    RGB LED (5mm, 4-leg), each color leg through its OWN resistor (220 ohm):
      Red   -> 220R -> GPIO25
      Green -> 220R -> GPIO26
      Blue  -> 220R -> GPIO27
      Longest leg (common) -> GND   (common cathode, the usual starter-kit type)
                           -> 3V3   (common anode: also set LED_COMMON_ANODE true)

  LED is for the NOISE sensor only (same 50 / 60 cut-offs as backend/thresholds.js):
    Normal = off (or green, see SHOW_GREEN_WHEN_NORMAL)
    Yellow = moderate noise      Red = above limit
  Nothing else touches the LED.

  WiFi + broker setup WITHOUT re-uploading code:
    - First boot (or whenever the saved WiFi can't be reached) the ESP32
      starts its own WiFi called "LiMon-Setup".
    - Connect to it with a phone/laptop. A setup page opens (if not, go to
      192.168.4.1). Pick the WiFi, type its password, and fill in the
      "MQTT broker" field with the laptop's IPv4 address (ipconfig).
    - Settings are saved on the ESP32 and survive power-off.
    - If the broker can't be reached after a few tries (e.g. the laptop
      got a new IP), the setup page opens again by itself.
    - To force setup manually: hold the BOOT button while powering on /
      pressing EN, keep holding for 3 seconds.

  Library needed (Library Manager): "WiFiManager" by tzapu
  (plus the PubSubClient and DHT libraries you already use).
*/

#include <WiFi.h>
#include <WiFiManager.h>
#include <Preferences.h>
#include <PubSubClient.h>
#include <DHT.h>

// ---------- Defaults (only used until you save settings in the setup page) ----------
const char* DEFAULT_BROKER = "192.168.1.100";
const char* DEFAULT_AREA   = "Area A";
const int   MQTT_PORT      = 1883;

const char* SETUP_AP_NAME  = "LiMon-Setup";   // WiFi name the ESP32 creates for setup
const int   RESET_BUTTON_PIN = 0;X`1                                        // BOOT button on most ESP32 dev boards
const int   MAX_MQTT_ATTEMPTS = 5;            // failed tries before reopening setup

#define SOUND_PIN 34
#define DHT_PIN   13
#define DHT_TYPE  DHT22

// ---------- RGB status LED ----------
// Pins chosen to avoid ESP32 boot/strapping pins (0, 2, 12, 15) and the
// input-only pins (34-39).
#define LED_R_PIN 25
#define LED_G_PIN 26
#define LED_B_PIN 27
const bool LED_COMMON_ANODE = false;   // true if the long leg goes to 3V3

// true  = green when noise is normal (handy for demos: shows the unit is alive)
// false = LED stays dark when normal, lights only for yellow/red (final design)
const bool SHOW_GREEN_WHEN_NORMAL = true;

// Keep these equal to NOISE_MODERATE / NOISE_LIMIT in backend/thresholds.js
// so the LED and the dashboard always agree.
const int NOISE_MODERATE_DB = 50;
const int NOISE_LIMIT_DB    = 60;

const unsigned long SOUND_SAMPLE_WINDOW_MS = 50;
const unsigned long NOISE_PUBLISH_INTERVAL_MS = 1000;
const unsigned long ENV_PUBLISH_INTERVAL_MS = 5000;

DHT dht(DHT_PIN, DHT_TYPE);
WiFiClient espClient;
PubSubClient mqtt(espClient);
Preferences prefs;

char mqttBroker[40];
char deviceArea[20];

// Per-board noise calibration (edited in the setup portal, saved on the board).
// dB = calOffsetDb + (raw peak-to-peak * calSlope). Defaults = the old fixed values.
char  calOffsetStr[12] = "35.0";
char  calSlopeStr[12]  = "0.043";
float calOffsetDb = 35.0;
float calSlope    = 0.043;
int   lastRaw     = 0;   // last raw peak-to-peak, printed to Serial for calibrating

unsigned long lastNoisePublish = 0;
unsigned long lastEnvPublish = 0;

// ---------- RGB LED ----------
// Every color goes through setLed(). When the single LED is swapped for the
// RGB strip later, this is the only function that needs to change.
void setLed(bool r, bool g, bool b) {
  if (LED_COMMON_ANODE) { r = !r; g = !g; b = !b; }
  digitalWrite(LED_R_PIN, r ? HIGH : LOW);
  digitalWrite(LED_G_PIN, g ? HIGH : LOW);
  digitalWrite(LED_B_PIN, b ? HIGH : LOW);
}

void ledOff()      { setLed(false, false, false); }
void ledGreen()    { setLed(false, true,  false); }
void ledYellow()   { setLed(true,  true,  false); }
void ledRed()      { setLed(true,  false, false); }

void updateNoiseLed(int db) {
  if (db > NOISE_LIMIT_DB)         ledRed();
  else if (db > NOISE_MODERATE_DB) ledYellow();
  else if (SHOW_GREEN_WHEN_NORMAL) ledGreen();
  else                             ledOff();
}

// ---------- Saved settings ----------
void loadSettings() {
  prefs.begin("limon", true);
  String b = prefs.getString("broker", DEFAULT_BROKER);
  String a = prefs.getString("area", DEFAULT_AREA);
  String co = prefs.getString("calOff", "35.0");
  String cs = prefs.getString("calSlope", "0.043");
  prefs.end();
  b.toCharArray(mqttBroker, sizeof(mqttBroker));
  a.toCharArray(deviceArea, sizeof(deviceArea));
  co.toCharArray(calOffsetStr, sizeof(calOffsetStr));
  cs.toCharArray(calSlopeStr, sizeof(calSlopeStr));
  calOffsetDb = atof(calOffsetStr);
  calSlope    = atof(calSlopeStr);
  if (calSlope <= 0) { calSlope = 0.043; strcpy(calSlopeStr, "0.043"); }  // guard against bad input
}

void saveSettings(const char* broker, const char* area, const char* calOff, const char* calSlopeVal) {
  prefs.begin("limon", false);
  prefs.putString("broker", broker);
  prefs.putString("area", area);
  prefs.putString("calOff", calOff);
  prefs.putString("calSlope", calSlopeVal);
  prefs.end();
}

// Opens the "LiMon-Setup" WiFi + page. Blocks until saved or timed out,
// then restarts so everything reconnects cleanly with the new settings.
void openSetupPortal() {
  Serial.println("Opening setup portal: connect to WiFi \"" + String(SETUP_AP_NAME) + "\"");

  WiFiManager wm;
  WiFiManagerParameter brokerParam("broker", "MQTT broker (laptop IPv4)", mqttBroker, sizeof(mqttBroker) - 1);
  WiFiManagerParameter areaParam("area", "Area name (e.g. Area A)", deviceArea, sizeof(deviceArea) - 1);
  WiFiManagerParameter calOffParam("calOff", "Noise calibration: offset (dB)", calOffsetStr, sizeof(calOffsetStr) - 1);
  WiFiManagerParameter calSlopeParam("calSlope", "Noise calibration: slope (dB per raw unit)", calSlopeStr, sizeof(calSlopeStr) - 1);
  wm.addParameter(&brokerParam);
  wm.addParameter(&areaParam);
  wm.addParameter(&calOffParam);
  wm.addParameter(&calSlopeParam);
  wm.setConfigPortalTimeout(180);   // give up after 3 min and just retry

  wm.startConfigPortal(SETUP_AP_NAME);

  // Always save what the fields hold: if the page was submitted they're the
  // new values, and if it timed out they're just the current ones again.
  saveSettings(brokerParam.getValue(), areaParam.getValue(),
               calOffParam.getValue(), calSlopeParam.getValue());
  Serial.println("Settings saved.");
  delay(500);
  ESP.restart();
}

// Hold BOOT for 3 seconds (while the board is running) to wipe saved WiFi and reopen setup.
void checkResetButton() {
  pinMode(RESET_BUTTON_PIN, INPUT_PULLUP);
  if (digitalRead(RESET_BUTTON_PIN) != LOW) return;

  Serial.println("BOOT held... keep holding 3 seconds to reset WiFi settings.");
  unsigned long held = millis();
  while (digitalRead(RESET_BUTTON_PIN) == LOW) {
    if (millis() - held >= 3000) {
      Serial.println("Resetting saved WiFi + broker settings.");
      WiFiManager wm;
      wm.resetSettings();
      // Keep this board's noise calibration; only broker/area go back to defaults.
      saveSettings(DEFAULT_BROKER, DEFAULT_AREA, calOffsetStr, calSlopeStr);
      loadSettings();
      openSetupPortal();   // restarts when done
      return;
    }
    delay(50);
  }
}

void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin();   // uses the WiFi credentials saved by the setup page
  Serial.print("Connecting to WiFi");

  unsigned long startedAt = millis();
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
    if (millis() - startedAt > 20000) {   // 20s with no luck -> ask for new WiFi
      Serial.println(" failed");
      openSetupPortal();
    }
  }
  Serial.println(" connected");
  Serial.print("ESP32 IP: ");
  Serial.println(WiFi.localIP());
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_R_PIN, OUTPUT);
  pinMode(LED_G_PIN, OUTPUT);
  pinMode(LED_B_PIN, OUTPUT);
  ledOff();
  dht.begin();
  loadSettings();
  checkResetButton();
  connectWiFi();
  mqtt.setServer(mqttBroker, MQTT_PORT);
}

void loop() {
  // Hold BOOT for 3 seconds while running to reset WiFi + reopen setup.
  // (Holding BOOT while powering on puts the ESP32 into flash-download
  // mode instead, so the sketch never starts - that's why this lives here.)
  checkResetButton();

  if (WiFi.status() != WL_CONNECTED) connectWiFi();
  if (!mqtt.connected()) reconnectMqtt();
  mqtt.loop();

  unsigned long now = millis();

  if (now - lastNoisePublish >= NOISE_PUBLISH_INTERVAL_MS) {
    lastNoisePublish = now;
    readAndPublishNoise();
  }

  if (now - lastEnvPublish >= ENV_PUBLISH_INTERVAL_MS) {
    lastEnvPublish = now;
    readAndPublishEnvironment();
  }
}

void reconnectMqtt() {
  int attempts = 0;
  while (!mqtt.connected()) {
    Serial.print("Connecting to MQTT broker at ");
    Serial.print(mqttBroker);
    Serial.println(" ...");

    String clientId = "esp32-" + String(deviceArea);
    if (mqtt.connect(clientId.c_str())) {
      Serial.println("MQTT connected!");
    } else {
      Serial.print("MQTT connect failed, rc=");
      Serial.print(mqtt.state());
      Serial.println(" retrying in 2s");
      delay(2000);
      if (++attempts >= MAX_MQTT_ATTEMPTS) {
        Serial.println("Broker unreachable. Reopening setup so the IP can be fixed.");
        openSetupPortal();
      }
    }
  }
}

// ---------- Noise ----------
int readSoundPeakToPeak() {
  unsigned long startTime = millis();
  int sampleMax = 0;
  int sampleMin = 4095;

  while (millis() - startTime < SOUND_SAMPLE_WINDOW_MS) {
    int reading = analogRead(SOUND_PIN);
    if (reading > sampleMax) sampleMax = reading;
    if (reading < sampleMin) sampleMin = reading;
  }
  return sampleMax - sampleMin;
}

int readNoiseDb() {
  int raw = readSoundPeakToPeak();
  lastRaw = raw;
  int approxDb = (int)(calOffsetDb + (raw * calSlope));
  if (approxDb < 30) approxDb = 30;
  if (approxDb > 100) approxDb = 100;
  return approxDb;
}

void readAndPublishNoise() {
  int db = readNoiseDb();
  updateNoiseLed(db);   // local, instant: LED doesn't wait on the network
  char payload[96];
  snprintf(payload, sizeof(payload), "{\"area\":\"%s\",\"noise_db\":%d}", deviceArea, db);
  mqtt.publish("limon/noise", payload);
  Serial.print("Noise: ");
  Serial.print(payload);
  Serial.print("  raw=");
  Serial.println(lastRaw);
}

// ---------- Environment ----------
void readAndPublishEnvironment() {
  float temp = dht.readTemperature();
  float hum  = dht.readHumidity();

  if (isnan(temp) || isnan(hum)) {
    Serial.println("DHT22 read failed - check wiring");
    return;
  }

  char payload[128];
  snprintf(payload, sizeof(payload),
           "{\"area\":\"%s\",\"temperature\":%.1f,\"humidity\":%.1f}",
           deviceArea, temp, hum);
  mqtt.publish("limon/environment", payload);
  Serial.print("Environment: ");
  Serial.println(payload);
}
