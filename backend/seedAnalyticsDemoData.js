// ---- Analytics demo data seeder ----
// Generates several days of realistic, INTENTIONALLY-CORRELATED sensor
// data so you can actually see the Analytics page produce results instead
// of "not enough data yet." This is for testing/demoing only - it writes
// directly into environment_readings, noise_readings, and occupancy_events,
// same as your real sensors/simulators would.
//
// Usage:
//   node seedAnalyticsDemoData.js                    (14 days, Area A)
//   node seedAnalyticsDemoData.js --days=21           (custom range)
//   node seedAnalyticsDemoData.js --area="Area B"      (custom area)
//   node seedAnalyticsDemoData.js --clear              (wipe existing demo
//                                                        window for that
//                                                        area/range first,
//                                                        so re-running
//                                                        doesn't pile up
//                                                        duplicate data)
//
// The patterns baked in on purpose, so you know what the Analytics page
// SHOULD report back if it's working correctly:
//   - Noise rises with occupancy (busier = louder)      -> positive
//   - Temperature rises a little with occupancy (body
//     heat / AC load)                                    -> weak positive
//   - Humidity falls as temperature rises (classic
//     inverse relationship)                               -> negative
//   - Humidity rises slightly with occupancy              -> weak positive
// If the Analytics page comes back with roughly matching signs/strengths
// after you run this, the math is working end-to-end.

const pool = require('./db');
const { OCCUPANCY_MAX } = require('./thresholds');

function parseArgs() {
  const args = { days: 14, area: 'Area A', clear: false };
  for (const arg of process.argv.slice(2)) {
    if (arg === '--clear') args.clear = true;
    else if (arg.startsWith('--days=')) args.days = parseInt(arg.split('=')[1], 10);
    else if (arg.startsWith('--area=')) args.area = arg.split('=')[1].replace(/^"|"$/g, '');
  }
  return args;
}

function randRange(min, max) {
  return min + Math.random() * (max - min);
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

// Bell-curve-ish target occupancy for a given hour-of-day, scaled by a
// per-day "busyness" factor so it's not identical every day. Library is
// "open" 7:00-21:00, peaking mid-afternoon, empty overnight.
function targetOccupancyForHour(hourFraction, dayFactor) {
  if (hourFraction < 7 || hourFraction >= 21) return 0;
  const peak = 14; // 2 PM
  const spread = 4.5;
  const bell = Math.exp(-Math.pow(hourFraction - peak, 2) / (2 * spread * spread));
  // Clamped to OCCUPANCY_MAX (thresholds.js) rather than trusting the
  // 26/dayFactor/jitter numbers to always stay under capacity on their
  // own - see seedDemoAnalyticsData.js for what happens when a similar
  // formula's worst case wasn't actually checked against the real cap.
  return Math.max(0, Math.min(OCCUPANCY_MAX, Math.round(bell * 26 * dayFactor + randRange(-8, 8))));
}

async function seed() {
  const { days, area, clear } = parseArgs();
  const now = new Date();
  const rangeStart = new Date(now);
  rangeStart.setDate(rangeStart.getDate() - days);
  rangeStart.setHours(0, 0, 0, 0);

  console.log(`Seeding ${days} days of demo data for "${area}" (${rangeStart.toISOString()} to ${now.toISOString()})`);

  if (clear) {
    const [r1] = await pool.query('DELETE FROM environment_readings WHERE area = ? AND recorded_at BETWEEN ? AND ?', [area, rangeStart, now]);
    const [r2] = await pool.query('DELETE FROM noise_readings WHERE area = ? AND recorded_at BETWEEN ? AND ?', [area, rangeStart, now]);
    const [r3] = await pool.query('DELETE FROM occupancy_events WHERE area = ? AND recorded_at BETWEEN ? AND ?', [area, rangeStart, now]);
    console.log(`Cleared existing rows in that window: ${r1.affectedRows} env, ${r2.affectedRows} noise, ${r3.affectedRows} occupancy`);
  }

  const envRows = [];
  const noiseRows = [];
  const occRows = [];

  let currentOccupancy = 0;
  let epcCounter = 1;
  let curDay = -1;
  let dayFactor = 1;

  const SLOT_MINUTES = 15;
  for (let t = new Date(rangeStart); t < now; t = new Date(t.getTime() + SLOT_MINUTES * 60000)) {
    // A new random "how busy is today" multiplier once per calendar day,
    // so the occupancy pattern isn't a carbon copy every single day -
    // otherwise every variable ends up correlating with everything else
    // through the shared hour-of-day shape alone, which looks unrealistic
    // (r > 0.95 on every pair) rather than like real, noisy sensor data.
    if (t.getDate() !== curDay) {
      curDay = t.getDate();
      dayFactor = 1 + randRange(-0.7, 0.7);
    }

    const hourFraction = t.getHours() + t.getMinutes() / 60;
    const target = targetOccupancyForHour(hourFraction, dayFactor);

    // Random-walk the actual occupancy toward the target in small steps,
    // emitting real IN/OUT events (not just an aggregate number) so the
    // event-stream logic in correlationAnalytics.js has real data to walk.
    const diff = target - currentOccupancy;
    const steps = Math.min(Math.abs(diff), 5); // cap how much can change per 15-min slot
    for (let i = 0; i < steps; i++) {
      const direction = diff > 0 ? 'IN' : 'OUT';
      const eventTime = new Date(t.getTime() + randRange(0, SLOT_MINUTES * 60000));
      occRows.push([area, `DEMO-${epcCounter++}`, direction, eventTime]);
      currentOccupancy += diff > 0 ? 1 : -1;
    }
    currentOccupancy = Math.max(0, currentOccupancy);

    // ---- Environment: baked-in relationships, with enough independent
    // noise that correlations land in a believable range instead of a
    // suspicious near-1.0 on everything. ----
    const diurnal = 3.2 * Math.sin((Math.PI * (hourFraction - 6)) / 15);
    const occupancyHeatBump = currentOccupancy * 0.01;
    const temperature = clamp(24.5 + diurnal + occupancyHeatBump + randRange(-3.0, 3.0), 20, 33);

    // Humidity falls as temperature rises (classic inverse relationship),
    // with a small upward nudge from occupancy (more people breathing).
    const humidity = clamp(78 - (temperature - 24.5) * 0.9 + currentOccupancy * 0.015 + randRange(-11, 11), 35, 85);

    envRows.push([area, temperature.toFixed(2), humidity.toFixed(2), t]);

    // ---- Noise: rises with occupancy ----
    const noise = clamp(32 + currentOccupancy * 0.6 + randRange(-14, 14), 28, 78);
    noiseRows.push([area, Math.round(noise), t]);
  }

  console.log(`Generated ${envRows.length} environment rows, ${noiseRows.length} noise rows, ${occRows.length} occupancy events. Inserting...`);

  // Bulk-insert in chunks so we don't send one enormous query.
  async function bulkInsert(table, columns, rows) {
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      await pool.query(
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES ?`,
        [chunk]
      );
    }
  }

  await bulkInsert('environment_readings', ['area', 'temperature', 'humidity', 'recorded_at'], envRows);
  await bulkInsert('noise_readings', ['area', 'noise_db', 'recorded_at'], noiseRows);
  if (occRows.length) await bulkInsert('occupancy_events', ['area', 'epc', 'direction', 'recorded_at'], occRows);

  console.log('\nDone. Open the Analytics page, pick this date range and area, and click "Run Analysis".');
  console.log(`Suggested range: ${rangeStart.toISOString().split('T')[0]} to ${now.toISOString().split('T')[0]}`);
  process.exit(0);
}

seed().catch((err) => {
  console.error('Demo data seed failed:', err);
  process.exit(1);
});
