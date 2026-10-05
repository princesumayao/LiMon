const pool = require('./db');

// In-memory cache so the MQTT handler (which runs on every single sensor
// message, potentially several per second) never has to hit the database
// just to check the current interval. The cache is the source of truth
// for reads; the DB is the source of truth for persistence.
const cache = {
  sensor_log_interval_ms: 0, // 0 = save every reading (default/current behavior)
};

// Allowed intervals, in milliseconds. Keeping this as an allow-list
// (rather than accepting any integer) means a bad request can't set
// something like 3ms and accidentally turn "throttling" into "hammer
// the database even harder than before".
const ALLOWED_INTERVALS_MS = [0, 5000, 10000, 30000, 60000, 300000];

async function loadSettingsCache() {
  try {
    const [rows] = await pool.query(
      `SELECT setting_key, setting_value FROM settings WHERE setting_key = 'sensor_log_interval_ms'`
    );
    if (rows.length) {
      const parsed = parseInt(rows[0].setting_value, 10);
      if (ALLOWED_INTERVALS_MS.includes(parsed)) {
        cache.sensor_log_interval_ms = parsed;
      }
    }
    console.log(`Settings loaded: sensor_log_interval_ms = ${cache.sensor_log_interval_ms}`);
  } catch (err) {
    console.error('Failed to load settings, using defaults:', err);
  }
}

function getSensorLogIntervalMs() {
  return cache.sensor_log_interval_ms;
}

async function setSensorLogIntervalMs(ms) {
  if (!ALLOWED_INTERVALS_MS.includes(ms)) {
    throw new Error(`Invalid interval: must be one of ${ALLOWED_INTERVALS_MS.join(', ')}`);
  }
  await pool.query(
    `INSERT INTO settings (setting_key, setting_value) VALUES ('sensor_log_interval_ms', ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
    [String(ms)]
  );
  cache.sensor_log_interval_ms = ms;
}

module.exports = {
  ALLOWED_INTERVALS_MS,
  loadSettingsCache,
  getSensorLogIntervalMs,
  setSensorLogIntervalMs,
};
