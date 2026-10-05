require('dotenv').config();
/*
  Table status simulator - stands in for the CS department's camera-based
  table occupancy detection until their system is ready. Posts to the same
  /api/tables/status endpoint their camera system will eventually call, so
  when they're ready to integrate, they just point their system at this
  same endpoint with the same payload shape - our dashboard code doesn't
  need to change at all.

  Run with: node tableStatusSimulator.js
*/

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:4000';

// Adjust this list to match your actual mockup's table layout
const TABLES = [
  { area: 'Area A', table_label: 'Table 1', total_seats: 6 },
  { area: 'Area A', table_label: 'Table 2', total_seats: 4 },
  { area: 'Area B', table_label: 'Table 1', total_seats: 6 },
  { area: 'Area B', table_label: 'Table 2', total_seats: 4 },
];

async function postStatus(table, occupied_seats) {
  try {
    await fetch(`${API_BASE_URL}/api/tables/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.DEVICE_API_KEY || '' },
      body: JSON.stringify({
        area: table.area,
        table_label: table.table_label,
        total_seats: table.total_seats,
        occupied_seats,
        source: 'simulated',
      }),
    });
    console.log(`${table.area} / ${table.table_label} -> ${occupied_seats}/${table.total_seats} seats`);
  } catch (err) {
    console.error('Failed to post table status - is the backend running?', err);
  }
}

function randomOccupiedSeats(totalSeats) {
  return Math.floor(Math.random() * (totalSeats + 1)); // 0..totalSeats, inclusive
}

function tick() {
  // Randomly updates one table's seat count per tick, rather than all of
  // them at once, so it doesn't look like a synchronized reset every time.
  const table = TABLES[Math.floor(Math.random() * TABLES.length)];
  postStatus(table, randomOccupiedSeats(table.total_seats));
}

console.log(`Table status simulator posting to ${API_BASE_URL}. Ctrl+C to stop.`);
// Give the API server a moment to finish booting (DB connection, MQTT
// subscriber, etc) before the first POST. Without this, "npm run demo"
// starts every process at once and this simulator's first tick almost
// always loses the race and logs a scary (but harmless) ECONNREFUSED -
// it recovers on its own a few seconds later once the API is listening,
// but this avoids the false alarm on every launch.
setTimeout(tick, 4000);
setInterval(tick, 5000 + Math.random() * 5000);