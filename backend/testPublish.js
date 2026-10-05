// TESTING HELPER ONLY - not part of the real app.
//
// Publishes a fake environment + noise reading once per second, so you
// can watch how the sensor_log_interval_ms setting affects how often
// rows actually land in the database - without needing real ESP32
// hardware. Run it, then watch:
//   - the dashboard charts (should update every second, always)
//   - `SELECT COUNT(*) FROM noise_readings WHERE DATE(recorded_at)=CURDATE();`
//     (should grow slower once you raise the interval on the Reports page)
//
// Usage:  node testPublish.js
// Stop with Ctrl+C.

const mqtt = require('mqtt');
require('dotenv').config();

const BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';
const AREA = 'Area A';

const client = mqtt.connect(BROKER_URL);

client.on('connect', () => {
  console.log('testPublish connected to', BROKER_URL);
  console.log('Publishing one environment + one noise reading per second. Ctrl+C to stop.');

  setInterval(() => {
    const temperature = +(24 + Math.random() * 6).toFixed(1);   // ~24-30 C
    const humidity = +(50 + Math.random() * 20).toFixed(1);      // ~50-70 %
    const noise_db = +(35 + Math.random() * 30).toFixed(1);      // ~35-65 dB

    client.publish('limon/environment', JSON.stringify({ area: AREA, temperature, humidity }));
    client.publish('limon/noise', JSON.stringify({ area: AREA, noise_db }));

    console.log(`Published: temp=${temperature}C humidity=${humidity}% noise=${noise_db}dB`);
  }, 1000);
});

client.on('error', (err) => {
  console.error('testPublish MQTT error - is your broker running?', err.message);
});

// ---- One-off spike, for testing that alerts still fire instantly even
// while saving is throttled. Run: node testPublish.js --spike
if (process.argv.includes('--spike')) {
  setTimeout(() => {
    console.log('>>> Publishing an above-limit noise spike (75 dB)...');
    client.publish('limon/noise', JSON.stringify({ area: AREA, noise_db: 75 }));
  }, 2000);
}
