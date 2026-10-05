/*
  DEMO DATA SEEDER - for testing correlation analytics only.

  Generates fake but *internally consistent* sensor history so the
  Analytics page has enough data to actually produce results instead of
  "not enough data yet". It deliberately bakes in real relationships
  (busier building -> louder rooms, busier building -> slightly warmer
  rooms) so you can see what a genuine "Strong connection" card looks
  like, alongside a deliberately unrelated pair so you also see what "No
  clear connection" looks like.

  This is NOT part of the live app - it never runs automatically, only
  when you run it yourself. Safe to re-run: it deletes any rows it
  previously inserted in the same date range/areas before inserting again,
  so running it twice won't double up your data.

  Usage:
    node seedDemoAnalyticsData.js                     (last 10 days, Area A + Area B, 5-minute ticks)
    node seedDemoAnalyticsData.js --days=14
    node seedDemoAnalyticsData.js --start=2026-09-01 --end=2026-09-10
    node seedDemoAnalyticsData.js --areas="Area A"
    node seedDemoAnalyticsData.js --days=365 --tick-minutes=1

  --tick-minutes controls how close together the generated readings are.
  The dashboard/analytics charts bucket real readings by MINUTE, so with
  the default 5-minute ticks, 4 out of every 5 minutes has no data point
  and the line looks gappy when you zoom into a single day up close. Use
  --tick-minutes=1 for a smooth, continuous-looking line (at the cost of
  5x more rows and a slower run) - recommended when you want the charts to
  look their best for a demo/defense. The default stays at 5 minutes for
  faster, lighter-weight generation (e.g. for quickly re-testing Analytics).
*/

const pool = require('./db');
const { OCCUPANCY_MAX } = require('./thresholds');

// ---- CLI args ----
const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
  })
);

const AREAS = args.areas ? args.areas.split(',').map(s => s.trim()) : ['Area A', 'Area B'];
const OCCUPANCY_AREA = 'Entrance'; // matches occupancySimulator.js / correlationAnalytics.js

let rangeStart, rangeEnd;
if (args.start && args.end) {
  rangeStart = new Date(`${args.start}T00:00:00`);
  rangeEnd = new Date(`${args.end}T23:59:59`);
} else {
  const days = Number(args.days) || 10;
  rangeEnd = new Date();
  rangeStart = new Date();
  rangeStart.setDate(rangeStart.getDate() - (days - 1));
  rangeStart.setHours(0, 0, 0, 0);
}

const LIBRARY_OPEN_HOUR = 7;
const LIBRARY_CLOSE_HOUR = 21;
const TICK_MINUTES = Number(args['tick-minutes']) || 5;
// Random-walk step sizes below are tuned for 5-minute ticks. Standard
// Brownian-motion discretization: variance accumulated over a fixed
// real-time span scales with the NUMBER of steps, so halving the tick
// spacing (more, smaller steps covering the same real time) would double
// the accumulated wander unless the per-step sigma is scaled down by
// sqrt(tick spacing) to compensate.
const DRIFT_TIME_SCALE = Math.sqrt(TICK_MINUTES / 5);

// Time-weighted-average curve, shaped like a real day: closed overnight,
// ramps up through the morning, peaks early-mid afternoon, drains toward
// closing. Small day-to-day jitter so it's not a perfectly identical
// repeat every day (which would inflate the correlation unrealistically).
function targetOccupancy(date, dayJitter) {
  const hour = date.getHours() + date.getMinutes() / 60;
  if (hour < LIBRARY_OPEN_HOUR || hour >= LIBRARY_CLOSE_HOUR) return 0;
  const span = LIBRARY_CLOSE_HOUR - LIBRARY_OPEN_HOUR;
  const t = (hour - LIBRARY_OPEN_HOUR) / span; // 0..1 across the open hours
  // Peak around 60% through the day (early-mid afternoon), bell-shaped.
  const bell = Math.exp(-Math.pow((t - 0.6) / 0.28, 2));
  const base = 55 * bell * dayJitter;
  // Clamp to the building's actual capacity (thresholds.js) - dayJitter's
  // upper end (1.25x) previously pushed the peak past 60 on busy-simulated
  // days, which silently exceeded the same OCCUPANCY_MAX every other part
  // of the app (gauges, the 60-person axis, notifications) assumes,
  // overflowing/clipping the occupancy chart's y-axis.
  return Math.max(0, Math.min(OCCUPANCY_MAX, Math.round(base)));
}

function randomEpc() {
  return 'DEMO' + Math.random().toString(16).slice(2, 10).toUpperCase();
}

function gaussianNoise(sigma) {
  // Box-Muller, good enough for demo data
  const u1 = Math.random(), u2 = Math.random();
  return sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toSqlDatetime(d) {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

async function clearExistingRange() {
  console.log(`Clearing any existing rows between ${toSqlDatetime(rangeStart)} and ${toSqlDatetime(rangeEnd)} for: ${AREAS.join(', ')}, ${OCCUPANCY_AREA}...`);
  const allAreas = [...AREAS, OCCUPANCY_AREA];
  const placeholders = allAreas.map(() => '?').join(',');
  await pool.query(
    `DELETE FROM environment_readings WHERE recorded_at BETWEEN ? AND ? AND area IN (${AREAS.map(() => '?').join(',')})`,
    [rangeStart, rangeEnd, ...AREAS]
  );
  await pool.query(
    `DELETE FROM noise_readings WHERE recorded_at BETWEEN ? AND ? AND area IN (${AREAS.map(() => '?').join(',')})`,
    [rangeStart, rangeEnd, ...AREAS]
  );
  await pool.query(
    `DELETE FROM occupancy_events WHERE recorded_at BETWEEN ? AND ? AND area = ?`,
    [rangeStart, rangeEnd, OCCUPANCY_AREA]
  );
}

async function seed() {
  await clearExistingRange();

  const envRows = [];   // [area, temperature, humidity, recorded_at]
  const noiseRows = []; // [area, noise_db, recorded_at]
  const occRows = [];   // [area, epc, direction, recorded_at]

  let lastOccupancy = 0;
  let cursorDay = -1;
  let dayJitter = 1;

  // A slow random walk per area/metric, updated a little each tick. Without
  // this, every tick's reading is an independent random draw, which reads
  // as scattered/jittery noise when charted (real sensors don't teleport
  // between values tick to tick - they drift smoothly). This is what makes
  // the generated line look like an actual sensor trace instead of static.
  const drift = {};
  AREAS.forEach(area => { drift[area] = { noise: 0, temp: 0, humid: 0 }; });

  for (let t = new Date(rangeStart); t <= rangeEnd; t = new Date(t.getTime() + TICK_MINUTES * 60000)) {
    const dayIndex = Math.floor((t - rangeStart) / 86400000);
    if (dayIndex !== cursorDay) {
      cursorDay = dayIndex;
      dayJitter = 0.75 + Math.random() * 0.5; // some days busier than others
    }

    const occ = targetOccupancy(t, dayJitter);

    // Emit the delta as IN/OUT events so a reconstruction of the running
    // count (like correlationAnalytics.js does) lands back on this exact
    // curve - same idea as the real RFID gate, just generated instead of
    // read from hardware.
    const delta = occ - lastOccupancy;
    if (delta !== 0) {
      const direction = delta > 0 ? 'IN' : 'OUT';
      for (let i = 0; i < Math.abs(delta); i++) {
        // Spread events across the tick instead of stacking them on one
        // timestamp, so it reads like real staggered arrivals.
        const jitterMs = Math.floor(Math.random() * TICK_MINUTES * 60000);
        occRows.push([OCCUPANCY_AREA, randomEpc(), direction, new Date(t.getTime() + jitterMs)]);
      }
    }
    lastOccupancy = occ;

    for (const area of AREAS) {
      const a = drift[area];

      // --- Noise: strongly, intentionally tied to building occupancy ---
      // (busier building -> louder rooms), plus a bit of per-area offset
      // so Area A/B aren't identical, plus a slow drift and a much smaller
      // residual jitter than before (was pure gaussianNoise(2.5) every
      // tick, which looked scattered/spiky when charted).
      a.noise = clamp(a.noise + gaussianNoise(0.15 * DRIFT_TIME_SCALE), -3, 3);
      const areaOffset = area === 'Area B' ? -2 : 0;
      const noise = 32 + areaOffset + occ * 0.55 + a.noise + gaussianNoise(0.8);

      // --- Temperature: mildly tied to occupancy (body heat/HVAC load)
      // plus a slow daily heat cycle (warmer midafternoon regardless of
      // occupancy), plus its own slow drift, so it's realistic - not
      // occupancy's proxy - and smooth rather than jittery.
      const hourOfDay = t.getHours() + t.getMinutes() / 60;
      const dailyHeatCycle = 1.2 * Math.sin(((hourOfDay - 6) / 24) * 2 * Math.PI);
      a.temp = clamp(a.temp + gaussianNoise(0.02 * DRIFT_TIME_SCALE), -0.6, 0.6);
      const temperature = 25 + dailyHeatCycle + occ * 0.035 + a.temp + gaussianNoise(0.15);

      // --- Humidity: deliberately NOT tied to occupancy or temperature
      // in any strong way here - just its own gentle drift - so the demo
      // also shows a realistic "No clear connection" card, not just
      // strong connections everywhere.
      a.humid = clamp(a.humid + gaussianNoise(0.3 * DRIFT_TIME_SCALE), -5, 5);
      const humidity = 58 + a.humid + gaussianNoise(1.5);

      if (occ > 0 || Math.random() < 0.3) {
        // Skip most readings while occupancy is 0 (closed hours) to avoid
        // padding the dataset with thousands of identical overnight rows.
        envRows.push([area, +temperature.toFixed(1), +Math.max(30, Math.min(90, humidity)).toFixed(1), new Date(t)]);
        noiseRows.push([area, Math.round(Math.max(25, noise)), new Date(t)]);
      }
    }
  }

  console.log(`Inserting ${envRows.length} environment rows, ${noiseRows.length} noise rows, ${occRows.length} occupancy events...`);

  const chunk = (arr, size) => Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, i * size + size));

  for (const batch of chunk(envRows, 500)) {
    await pool.query('INSERT INTO environment_readings (area, temperature, humidity, recorded_at) VALUES ?', [batch]);
  }
  for (const batch of chunk(noiseRows, 500)) {
    await pool.query('INSERT INTO noise_readings (area, noise_db, recorded_at) VALUES ?', [batch]);
  }
  for (const batch of chunk(occRows, 500)) {
    await pool.query('INSERT INTO occupancy_events (area, epc, direction, recorded_at) VALUES ?', [batch]);
  }

  console.log('Done. Try the Analytics page now for:', AREAS.join(', '), `(${args.start ? args.start : toSqlDatetime(rangeStart).slice(0,10)} to ${args.end ? args.end : toSqlDatetime(rangeEnd).slice(0,10)})`);
  console.log('Expect: Noise x Occupancy -> strong, Temperature x Occupancy -> some/moderate, Humidity pairs -> mostly no clear connection (by design).');
  await pool.end();
}

seed().catch(err => {
  console.error('Seeding failed:', err);
  process.exit(1);
});
