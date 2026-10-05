/*
  Occupancy simulator - stands in for the UHF entrance gate until that
  hardware is built. Publishes fake IN/OUT events over MQTT, using the
  exact same topic and message shape a real ESP32 would send - so the
  rest of the system (backend, database, dashboard, CSV export) works
  identically now and later. When the real UHF hardware is ready, just
  stop running this script and start the real ESP32 firmware instead;
  nothing else needs to change.

  Run with: node occupancySimulator.js
*/

const mqtt = require('mqtt');
require('dotenv').config();

const BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:4000';
const AREA = 'Entrance';
const MAX_OCCUPANCY = Number(process.env.SIM_MAX_OCCUPANCY) || 60;

// ---- Tunables for how "busy" the simulated library looks ----
// Lower delays / higher burst chance = fills up faster, good for demos.
// All overridable via .env without touching this file.
const MIN_DELAY_MS = Number(process.env.SIM_MIN_DELAY_MS) || 1000; // was 3000
const MAX_DELAY_MS = Number(process.env.SIM_MAX_DELAY_MS) || 3000; // was 8000
const BURST_CHANCE = Number(process.env.SIM_BURST_CHANCE) || 0.25; // chance a "tick" is a group, not one person
const BURST_MIN_SIZE = Number(process.env.SIM_BURST_MIN_SIZE) || 2;
const BURST_MAX_SIZE = Number(process.env.SIM_BURST_MAX_SIZE) || 5; // e.g. a class walking in together
const BURST_GAP_MS = Number(process.env.SIM_BURST_GAP_MS) || 250; // spacing between events within a burst

let currentCount = 20; // fallback only - overwritten by real DB state on startup, see syncStartingCount()

async function syncStartingCount() {
  try {
    const res = await fetch(`${API_BASE_URL}/api/occupancy/current`);
    const data = await res.json();
    currentCount = data.current;
    console.log(`Synced starting count from real database: ${currentCount}`);
  } catch (err) {
    console.warn('Could not sync starting count from backend, using fallback of 12:', err.message);
  }
}

function randomEpc() {
  return 'SIM' + Math.random().toString(16).slice(2, 10).toUpperCase();
}

function pickDirection() {
  // Biased so occupancy trends up early, stays busy through midday/afternoon,
  // and drains later - gives more realistic (and more "aggressive") looking
  // data than pure 50/50 randomness.
  const hour = new Date().getHours();
  let inChance = 0.55;
  if (hour < 10) inChance = 0.8;        // morning rush
  else if (hour < 16) inChance = 0.6;   // stays busy through the day
  else inChance = 0.3;                  // evening drain

  // Don't let it go negative or wildly over capacity
  if (currentCount <= 0) return 'IN';
  if (currentCount >= MAX_OCCUPANCY) return 'OUT';

  return Math.random() < inChance ? 'IN' : 'OUT';
}

function publishEvent(client) {
  const direction = pickDirection();
  currentCount += direction === 'IN' ? 1 : -1;

  const payload = JSON.stringify({ area: AREA, epc: randomEpc(), direction });
  client.publish('limon/occupancy', payload);
  console.log('Simulated:', payload, '| running count:', currentCount);
}

// A "burst" simulates a group (a class, a study group) entering or leaving
// together in quick succession, instead of one tag at a time - this is what
// gets the count climbing quickly instead of trickling up by ones.
function publishBurst(client) {
  const size = BURST_MIN_SIZE + Math.floor(Math.random() * (BURST_MAX_SIZE - BURST_MIN_SIZE + 1));
  let i = 0;
  function next() {
    if (i >= size) return;
    publishEvent(client);
    i += 1;
    setTimeout(next, BURST_GAP_MS);
  }
  next();
}

const client = mqtt.connect(BROKER_URL);

client.on('connect', async () => {
  console.log('Occupancy simulator connected to', BROKER_URL);
  await syncStartingCount();
  console.log(`Publishing a fake entry/exit every ${MIN_DELAY_MS / 1000}-${MAX_DELAY_MS / 1000}s (${Math.round(BURST_CHANCE * 100)}% chance of a group burst). Ctrl+C to stop.`);

  function scheduleNext() {
    const delay = MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
    setTimeout(() => {
      if (Math.random() < BURST_CHANCE) {
        publishBurst(client);
      } else {
        publishEvent(client);
      }
      scheduleNext();
    }, delay);
  }
  scheduleNext();
});

client.on('error', (err) => console.error('MQTT connection error:', err));