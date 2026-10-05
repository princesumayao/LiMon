// ---- Wipe today's readings for a clean start ----
//
// Testing (simulators, repeated tag waves, demo scripts like
// demoHumiditySpike.js) leaves real rows in the database dated "today".
// Since every "today" query (/api/occupancy/current, Today's Summary,
// the dashboard charts) reads by calendar date, that test data doesn't
// go away on its own - it just keeps accumulating until you clear it.
// This is exactly what caused occupancy to look stuck at 0 despite a
// real IN event: enough leftover OUT events from earlier testing had
// piled up that the running total was negative, and the API clamps
// negative occupancy to 0.
//
// This clears ONLY today's rows (by recorded_at date), in these tables:
//   occupancy_events, noise_readings, environment_readings, notifications
// Nothing about users, settings, table_status, or past days is touched.
//
// Usage (from the backend/ folder):
//   node resetTodayData.js
//
// Safe to run any number of times before defense day, right up until
// the point you actually want today's data to start counting "for real".
// Do NOT run this mid-defense once you've started demoing, or you'll
// wipe out whatever you just showed the panel.

require('dotenv').config();
const pool = require('./db');

const TABLES = ['occupancy_events', 'noise_readings', 'environment_readings', 'notifications'];

async function main() {
  console.log("Clearing today's rows so the dashboard starts clean...\n");

  for (const table of TABLES) {
    const [result] = await pool.query(
      `DELETE FROM ${table} WHERE DATE(recorded_at) = CURDATE()`
    );
    console.log(`  ${table}: removed ${result.affectedRows} row(s)`);
  }

  console.log('\nDone. Occupancy, noise, temperature/humidity and notifications for today are cleared.');
  console.log('Refresh the dashboard - occupancy should read 0/60 with a clean slate.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed to reset:', err.message);
  process.exit(1);
});
