const mqtt = require('mqtt');
const pool = require('./db');
const { getSensorLogIntervalMs } = require('./settings');
require('dotenv').config();

const BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';

const { TEMP_LIMIT, NOISE_MODERATE, NOISE_LIMIT, OCCUPANCY_MAX } = require('./thresholds');
const ABOVE_LIMIT_CONFIRM_MS = 10 * 1000;

// How long a sustained problem has to persist before we log another
// reminder notification for it. Prevents a stuck-above-threshold reading
// from flooding the table, while still nudging you periodically.
const REMINDER_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

// In-memory last-known-severity per "area:type" key. This is what lets us
// tell "still above limit" apart from "just crossed into above limit".
// It resets on server restart, which is fine - worst case you get one
// extra notification after a restart.
const lastNotified = {};
const pendingAboveLimit = {};
const latestSeverity = {};
const latestMessage = {};
let notifierIo = null;

// Tracks the last time we actually WROTE a reading to the database, per
// "area:type" key - separate from lastNotified above, which tracks alert
// state. This is what lets the configurable sensor_log_interval_ms
// setting thin out how densely readings get persisted, without touching
// the live dashboard feed or the alert logic at all: those still run on
// every single incoming message regardless of the log interval, since
// skipping a threshold check could mean missing a real above-limit
// moment. Only the historical log write is throttled.
const lastSavedAt = {};

function shouldSaveReading(key) {
  const intervalMs = getSensorLogIntervalMs();
  if (intervalMs <= 0) return true; // 0 = log every reading, no throttling

  const last = lastSavedAt[key];
  const now = Date.now();
  if (!last || now - last >= intervalMs) {
    lastSavedAt[key] = now;
    return true;
  }
  return false;
}

function clearPendingAboveLimit(key) {
  const pending = pendingAboveLimit[key];
  if (pending) {
    clearTimeout(pending.timerId);
    delete pendingAboveLimit[key];
  }
}

/**
 * Only inserts a notification when the severity actually changes
 * (Normal -> Moderate -> Above Limit, or back down), or when a non-normal
 * severity has persisted longer than REMINDER_COOLDOWN_MS. This is what
 * stops a single noisy sensor reading from spamming one row per second.
 */
async function maybeNotify(area, type, severity, message) {
  const key = `${area}:${type}`;
  const prev = lastNotified[key];
  const now = Date.now();

  latestSeverity[key] = severity;
  latestMessage[key] = message;

  if (severity === 'above_limit') {
    if (prev && prev.severity === 'above_limit') {
      if (now - prev.at >= REMINDER_COOLDOWN_MS) {
        lastNotified[key] = { severity, at: now };
        await insertNotification(area, type, message, severity);
        if (!pendingAboveLimit[key]) {
          pendingAboveLimit[key] = {
            timerId: setTimeout(async () => {
              const currentSeverity = latestSeverity[key];
              const currentMessage = latestMessage[key];

              delete pendingAboveLimit[key];

              if (currentSeverity !== 'above_limit') {
                return;
              }

              if (notifierIo) {
                notifierIo.to('staff').emit('notification-confirmed', {
                  area,
                  type,
                  message: currentMessage || message,
                  severity: 'above_limit',
                  recorded_at: new Date(),
                });
              }
            }, ABOVE_LIMIT_CONFIRM_MS)
          };
        }
      }
      return;
    }

    if (!pendingAboveLimit[key]) {
      await insertNotification(area, type, message, severity);
      pendingAboveLimit[key] = {
        timerId: setTimeout(async () => {
          const currentSeverity = latestSeverity[key];
          const currentMessage = latestMessage[key];

          delete pendingAboveLimit[key];

          if (currentSeverity !== 'above_limit') {
            return;
          }

          try {
            lastNotified[key] = { severity: 'above_limit', at: Date.now() };
            if (notifierIo) {
              notifierIo.to('staff').emit('notification-confirmed', {
                area,
                type,
                message: currentMessage || message,
                severity: 'above_limit',
                recorded_at: new Date(),
              });
            }
          } catch (err) {
            console.error('Failed to confirm delayed above-limit notification for', key, err);
          }
        }, ABOVE_LIMIT_CONFIRM_MS)
      };
    }
    return;
  }

  clearPendingAboveLimit(key);

  if (!prev) {
    lastNotified[key] = { severity, at: now };
    // Don't announce "everything is fine" on the very first reading -
    // only notify immediately if we're starting out in a bad state.
    if (severity !== 'normal') {
      await insertNotification(area, type, message, severity);
    }
    return;
  }

  if (prev.severity !== severity) {
    lastNotified[key] = { severity, at: now };
    await insertNotification(area, type, message, severity);
    return;
  }

  // Same severity as last time - only remind periodically, and only for
  // ongoing problems (don't keep re-announcing "still normal").
  if (severity !== 'normal' && now - prev.at >= REMINDER_COOLDOWN_MS) {
    lastNotified[key] = { severity, at: now };
    await insertNotification(area, type, message, severity);
  }
}

function startMqttSubscriber(io) {
  notifierIo = io;
  const client = mqtt.connect(BROKER_URL);

  client.on('connect', () => {
    console.log('MQTT subscriber connected to', BROKER_URL);
    client.subscribe(['limon/environment', 'limon/noise', 'limon/occupancy']);
  });

  client.on('message', async (topic, messageBuf) => {
    let data;
    try {
      data = JSON.parse(messageBuf.toString());
    } catch (err) {
      console.error('Bad MQTT payload on', topic, messageBuf.toString());
      return;
    }

    try {
      if (topic === 'limon/environment') await handleEnvironment(data, io);
      else if (topic === 'limon/noise') await handleNoise(data, io);
      else if (topic === 'limon/occupancy') await handleOccupancy(data, io);
    } catch (err) {
      console.error('Error handling', topic, err);
    }
  });

  return client;
}

// ---- Data integrity: reject malformed or out-of-range sensor payloads ----
// so a bad or spoofed MQTT message can't write nonsense into the history.
const AREA_RE = /^[A-Za-z0-9 _.-]{1,30}$/;
function validArea(a) { return typeof a === 'string' && AREA_RE.test(a); }
function inRange(n, min, max) { return typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max; }
function reject(topic, data) { console.warn('Rejected invalid', topic, 'payload:', JSON.stringify(data)); }

async function handleEnvironment({ area, temperature, humidity }, io) {
  if (!validArea(area) || !inRange(temperature, -40, 85) || !inRange(humidity, 0, 100)) {
    return reject('limon/environment', { area, temperature, humidity });
  }
  if (shouldSaveReading(`env:${area}`)) {
    await pool.query(
      'INSERT INTO environment_readings (area, temperature, humidity) VALUES (?, ?, ?)',
      [area, temperature, humidity]
    );
  }

  io.to('staff').emit('environment-update', { area, temperature, humidity, recorded_at: new Date() });

  const severity = temperature > TEMP_LIMIT ? 'above_limit' : 'normal';
  const message = severity === 'above_limit'
    ? `Temperature above limit: ${temperature}\u00b0C`
    : `Temperature back to normal: ${temperature}\u00b0C`;
  await maybeNotify(area, 'TEMP', severity, message);
}

async function handleNoise({ area, noise_db }, io) {
  if (!validArea(area) || !inRange(noise_db, 0, 140)) {
    return reject('limon/noise', { area, noise_db });
  }
  if (shouldSaveReading(`noise:${area}`)) {
    await pool.query(
      'INSERT INTO noise_readings (area, noise_db) VALUES (?, ?)',
      [area, noise_db]
    );
  }

  io.to('staff').emit('noise-update', { area, noise_db, recorded_at: new Date() });

  let severity, message;
  if (noise_db > NOISE_LIMIT) {
    severity = 'above_limit';
    message = `Noise level above limit: ${noise_db} dB`;
  } else if (noise_db > NOISE_MODERATE) {
    severity = 'moderate';
    message = `Moderate noise: ${noise_db} dB`;
  } else {
    severity = 'normal';
    message = `Noise back to normal: ${noise_db} dB`;
  }
  await maybeNotify(area, 'NOISE', severity, message);
}

async function handleOccupancy({ area, epc, direction }, io) {
  if (!validArea(area) || typeof epc !== 'string' || epc.length < 1 || epc.length > 64 ||
      (direction !== 'IN' && direction !== 'OUT')) {
    return reject('limon/occupancy', { area, epc, direction });
  }
  await pool.query(
    'INSERT INTO occupancy_events (area, epc, direction) VALUES (?, ?, ?)',
    [area, epc, direction]
  );

  const [[{ current }]] = await pool.query(
    `SELECT
       SUM(CASE WHEN direction = 'IN' THEN 1 ELSE -1 END) AS current
     FROM occupancy_events
     WHERE DATE(recorded_at) = CURDATE()`
  );

  const percentUsed = Math.round((current / OCCUPANCY_MAX) * 100);
  io.to('staff').emit('occupancy-update', { area, current, percentUsed });

  const severity = percentUsed >= 60 ? 'moderate' : 'normal';
  const message = severity === 'moderate'
    ? `Occupancy at ${percentUsed}% capacity`
    : `Occupancy back below capacity: ${percentUsed}%`;
  await maybeNotify(area, 'OCC', severity, message);
}

async function insertNotification(area, type, message, severity) {
  await pool.query(
    'INSERT INTO notifications (area, type, message, severity) VALUES (?, ?, ?, ?)',
    [area, type, message, severity]
  );
  if (notifierIo) {
    notifierIo.to('staff').emit('notification-new', { area, type, message, severity, recorded_at: new Date() });
  }
}

module.exports = { startMqttSubscriber };