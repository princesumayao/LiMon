/*
  FULL DATA RESET - wipes every row of collected/generated readings, not
  just today's (see resetTodayData.js for the "just today" version used
  during day-to-day testing).

  Use this when you want a genuinely clean slate to re-run
  seedDemoAnalyticsData.js from scratch - e.g. after tweaking its
  parameters (--tick-minutes, the drift/noise formulas, the date range)
  and wanting the old generated rows gone before generating new ones.

  IMPORTANT: the database does not distinguish "real ESP32 readings" from
  "seeded demo readings" - they live in the exact same tables. This wipes
  BOTH. If your ESP32 boards have been running and you care about keeping
  whatever they've actually captured, export/back it up first (Reports
  page -> CSV export, or a `mysqldump`) before running this.

  Clears ALL rows (regardless of date) in:
    noise_readings, environment_readings, occupancy_events,
    notifications, daily_summary

  Does NOT touch: users, settings, table_status (seat/table map state -
  reset that separately if you want it too; it's a live "is this table
  occupied right now" snapshot, not historical data).

  Usage (from the backend/ folder):
    node resetAllData.js --yes

  The --yes flag is required on purpose - this is a genuinely destructive,
  whole-table wipe, unlike resetTodayData.js.
*/

require('dotenv').config();
const pool = require('./db');

const args = process.argv.slice(2);
if (!args.includes('--yes')) {
  console.log('This will permanently delete ALL rows (every day, not just today) from:');
  console.log('  noise_readings, environment_readings, occupancy_events, notifications, daily_summary\n');
  console.log('This cannot be undone, and it does not distinguish real sensor data from seeded demo data.');
  console.log('If you want that, re-run with: node resetAllData.js --yes\n');
  process.exit(0);
}

// Order matters a little for readability of the output, not for FK
// constraints (none of these tables reference each other).
const TABLES = ['noise_readings', 'environment_readings', 'occupancy_events', 'notifications', 'daily_summary'];

async function main() {
  console.log('Wiping all historical data...\n');

  for (const table of TABLES) {
    const [result] = await pool.query(`DELETE FROM ${table}`);
    console.log(`  ${table}: removed ${result.affectedRows} row(s)`);
  }

  console.log('\nDone. Every table is now empty and ready for a fresh seed.');
  console.log('Next: node seedDemoAnalyticsData.js --days=365 --tick-minutes=1');
  console.log('Then: node backfillDailySummary.js --days=365');
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed to reset:', err.message);
  process.exit(1);
});
