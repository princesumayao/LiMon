// ---- Demo-only: manually trigger a humidity alert during defense ----
//
// Live humidity in a room rarely swings 20 points on cue, so relying on
// the real DHT22 to naturally cross the 40-60% comfort range during a
// defense slot is a gamble. This script publishes a FAKE, ramping
// humidity reading over MQTT on the same topic the real ESP32 uses
// (limon/environment), so the dashboard, alert, and analytics pipeline
// all react exactly as they would to a real out-of-range reading.
//
// This does NOT touch any sensor or firmware. It's a standalone script
// that pretends to be the ESP32 for a few seconds, then stops - the real
// board keeps publishing its own readings the whole time, so afterwards
// things go back to genuine sensor data on the next real publish.
//
// Usage (from the backend/ folder):
//   node demoHumiditySpike.js
//   node demoHumiditySpike.js --area "Area B" --target 68 --seconds 20
//
// Or via npm (see package.json):
//   npm run demo:humidity
//   npm run demo:humidity -- --area "Area B" --target 68

const mqtt = require('mqtt');

const BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';

// ---- Parse simple --flag value pairs from the command line ----
function getArg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const AREA = getArg('area', 'Area A');
const START_HUMIDITY = Number(getArg('start', 55));   // % RH, roughly normal
const TARGET_HUMIDITY = Number(getArg('target', 66));  // % RH, above the 60% "too humid" limit
const DURATION_SECONDS = Number(getArg('seconds', 15));
const TEMP_DURING_DEMO = Number(getArg('temp', 26.5));  // kept steady, only humidity ramps

const STEPS = Math.max(4, Math.floor(DURATION_SECONDS));
const STEP_MS = (DURATION_SECONDS * 1000) / STEPS;

console.log(`Connecting to MQTT broker at ${BROKER_URL} ...`);
const client = mqtt.connect(BROKER_URL);

client.on('connect', () => {
  console.log('Connected. Ramping fake humidity for demo purposes.');
  console.log(`Area: ${AREA} | ${START_HUMIDITY}% -> ${TARGET_HUMIDITY}% over ${DURATION_SECONDS}s`);
  console.log('Publishing on limon/environment, same as the real ESP32 firmware.\n');

  let step = 0;
  const timer = setInterval(() => {
    step++;
    const progress = step / STEPS;
    const humidity = +(START_HUMIDITY + (TARGET_HUMIDITY - START_HUMIDITY) * progress).toFixed(1);

    const payload = JSON.stringify({
      area: AREA,
      temperature: TEMP_DURING_DEMO,
      humidity,
    });

    client.publish('limon/environment', payload);
    console.log(`[${step}/${STEPS}] Published: ${payload}`);

    if (step >= STEPS) {
      clearInterval(timer);
      console.log('\nDone. The real sensor will take over again on its next reading.');
      client.end();
    }
  }, STEP_MS);
});

client.on('error', (err) => {
  console.error('MQTT connection error:', err.message);
  console.error('Check that Mosquitto is running and MQTT_BROKER_URL is correct.');
  process.exit(1);
});
