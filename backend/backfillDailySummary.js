/*
  BACKFILL DAILY SUMMARY - computes daily_summary rows for a whole date
  range in one run, instead of waiting for the nightly rollup job
  (rollupJob.js, scheduled for 11:55pm) to fill them in one day at a time.

  Why this is needed: the Reports page's date-range queries and the
  Dashboard's "Week" trend tab both read from daily_summary, not the raw
  noise_readings/environment_readings tables (see the comment on
  /api/reports/range in server.js - daily_summary exists so a multi-month
  range is a handful of small rows, not a scan of every raw reading).
  If you seed a big block of historical data all at once (e.g. with
  seedDemoAnalyticsData.js --days=365), daily_summary has nothing for any
  of those days until this is run - the raw readings exist, but the
  Reports/Week views that depend on the rolled-up table stay empty.

  Safe to re-run: rollupDay() upserts (ON DUPLICATE KEY UPDATE), so running
  this twice over the same range just recomputes the same rows.

  Usage:
    node backfillDailySummary.js                     (last 365 days, through yesterday)
    node backfillDailySummary.js --days=30
    node backfillDailySummary.js --start=2025-09-24 --end=2026-09-23
*/

const pool = require('./db');
const { rollupDay } = require('./rollupJob');

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
  })
);

// Local date, NOT toISOString(): the loop below walks local-midnight Dates, which
// toISOString() shifts back a day in UTC+8 (rolling up the wrong dates and
// skipping yesterday).
const { localDateStr: toDateStr } = require('./dateUtils');

let startStr, endStr;
if (args.start && args.end) {
  startStr = args.start;
  endStr = args.end;
} else {
  const days = Number(args.days) || 365;
  const end = new Date();
  end.setDate(end.getDate() - 1); // through yesterday - today isn't "done" yet, the live app already covers it
  const start = new Date(end);
  start.setDate(start.getDate() - (days - 1));
  startStr = toDateStr(start);
  endStr = toDateStr(end);
}

async function backfill() {
  console.log(`Backfilling daily_summary from ${startStr} to ${endStr}...`);
  let count = 0;
  for (
    let d = new Date(`${startStr}T00:00:00`);
    d <= new Date(`${endStr}T00:00:00`);
    d.setDate(d.getDate() + 1)
  ) {
    const dateStr = toDateStr(d);
    await rollupDay(dateStr);
    count++;
  }
  console.log(`Done. Rolled up ${count} day(s) of daily_summary.`);
  await pool.end();
}

backfill().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
