const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const pool = require('./db');
const { startMqttSubscriber } = require('./mqttSubscriber');
const { startRollupJob, rollupDay } = require('./rollupJob');
const { localDateStr, parseLocalDate } = require('./dateUtils');
const { ALLOWED_INTERVALS_MS, loadSettingsCache, getSensorLogIntervalMs, setSensorLogIntervalMs } = require('./settings');
const { hashPassword, verifyPassword, signToken, setSessionCookie, clearSessionCookie, getCurrentUser, requireAdmin, hasValidDeviceKey, requireDeviceKeyOrAdmin } = require('./auth');
const { computeCorrelations } = require('./correlationAnalytics');
require('dotenv').config();

const app = express();
// `origin: true` reflects whatever origin the request came from (rather
// than a fixed URL), and `credentials: true` is required for the browser
// to actually send/receive the session cookie - the dashboard runs on a
// different port than this API, so without both of these, login would
// appear to work but the cookie would silently never arrive.
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// ---- Access gate (Data Protection) ----
// Every /api request needs a valid staff/admin session, EXCEPT the short
// allow-list below. Anything not listed (including routes added later) is
// protected by default. Unauthorized requests get 401 and no data.
//   - login/logout/me: needed to sign in at all
//   - GET /api/tables/status: the public seat-availability page (/seats),
//     which only exposes seat counts per table - no readings, no accounts
//   - POST /api/tables/status: also passes the gate with a valid device
//     key; the route itself then enforces key-or-admin
const PUBLIC_API = new Set([
  'POST /api/login',
  'POST /api/logout',
  'GET /api/me',
  'GET /api/tables/status',
]);
app.use('/api', (req, res, next) => {
  if (req.method === 'OPTIONS') return next();
  const key = `${req.method} ${req.baseUrl}${req.path}`;
  if (PUBLIC_API.has(key)) return next();
  if (key === 'POST /api/tables/status' && hasValidDeviceKey(req)) return next();
  const user = getCurrentUser(req);
  if (!user) return res.status(401).json({ error: 'Access denied: please log in.' });
  req.user = user;
  next();
});

const server = http.createServer(app);
const io = new Server(server, {
  // Dashboard runs on a different port, so cross-origin is needed, and
  // credentials so the session cookie reaches the socket handshake.
  cors: { origin: true, credentials: true }
});

// Live readings go only to logged-in sockets (room 'staff'). Anyone can
// connect (the public seat page needs table-status-update), but they only
// receive events that are emitted to everyone.
io.use((socket, next) => {
  socket.data.user = getCurrentUser(socket.request);
  next();
});
io.on('connection', (socket) => {
  if (socket.data.user) socket.join('staff');
});

const OCCUPANCY_MAX = 60;
const NOISE_MODERATE = 50;
const NOISE_LIMIT = 60;

// ---- Environment (Temperature & Humidity) ----
app.get('/api/environment/latest', async (req, res) => {
  const [rows] = await pool.query(
    `SELECT area, temperature, humidity, recorded_at
     FROM environment_readings
     WHERE (area, recorded_at) IN (
       SELECT area, MAX(recorded_at) FROM environment_readings GROUP BY area
     )`
  );
  res.json(rows);
});

app.get('/api/environment/today', async (req, res) => {
  const [rows] = await pool.query(
    `SELECT area, temperature, humidity, recorded_at
     FROM environment_readings
     WHERE DATE(recorded_at) = CURDATE()
     ORDER BY recorded_at ASC`
  );
  res.json(rows);
});

// ---- Noise ----
app.get('/api/noise/latest', async (req, res) => {
  const [rows] = await pool.query(
    `SELECT area, noise_db, recorded_at
     FROM noise_readings
     WHERE (area, recorded_at) IN (
       SELECT area, MAX(recorded_at) FROM noise_readings GROUP BY area
     )`
  );
  res.json(rows);
});

app.get('/api/noise/today', async (req, res) => {
  const [rows] = await pool.query(
    `SELECT area, noise_db, recorded_at
     FROM noise_readings
     WHERE DATE(recorded_at) = CURDATE()
     ORDER BY recorded_at ASC`
  );
  res.json(rows);
});

// ---- Occupancy ----
app.get('/api/occupancy/current', async (req, res) => {
  const [[{ current }]] = await pool.query(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'IN' THEN 1 ELSE -1 END), 0) AS current
     FROM occupancy_events
     WHERE DATE(recorded_at) = CURDATE()`
  );
  const [[{ entered }]] = await pool.query(
    `SELECT COUNT(*) AS entered FROM occupancy_events
     WHERE direction = 'IN' AND DATE(recorded_at) = CURDATE()`
  );
  const [[{ exited }]] = await pool.query(
    `SELECT COUNT(*) AS exited FROM occupancy_events
     WHERE direction = 'OUT' AND DATE(recorded_at) = CURDATE()`
  );

  res.json({
    current: Math.max(current, 0),
    max: OCCUPANCY_MAX,
    percentUsed: Math.round((Math.max(current, 0) / OCCUPANCY_MAX) * 100),
    entered,
    exited,
  });
});

app.get('/api/occupancy/today', async (req, res) => {
  const [rows] = await pool.query(
    `SELECT direction, recorded_at FROM occupancy_events
     WHERE DATE(recorded_at) = CURDATE()
     ORDER BY recorded_at ASC`
  );
  res.json(rows);
});

// ---- Notifications ----
// Kept unpaginated for internal/dashboard-preview use (small cap, most recent first).
app.get('/api/notifications', async (req, res) => {
  const [rows] = await pool.query(
    `SELECT area, type, message, severity, recorded_at
     FROM notifications
     WHERE DATE(recorded_at) = CURDATE()
     ORDER BY recorded_at DESC
     LIMIT 50`
  );
  res.json(rows);
});

// Paginated version for the full Notifications page, so the list has a
// fixed, predictable height instead of growing forever as alerts come in.
app.get('/api/notifications/paged', async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 8, 1), 50);
  const offset = (page - 1) * pageSize;

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM notifications WHERE DATE(recorded_at) = CURDATE()`
  );
  const [rows] = await pool.query(
    `SELECT area, type, message, severity, recorded_at
     FROM notifications
     WHERE DATE(recorded_at) = CURDATE()
     ORDER BY recorded_at DESC
     LIMIT ? OFFSET ?`,
    [pageSize, offset]
  );

  res.json({
    rows,
    page,
    pageSize,
    total,
    totalPages: Math.max(Math.ceil(total / pageSize), 1),
  });
});

// ---- Summary report (computed stats, no AI involved) ----
// Optional ?area=Area%20A limits noise, temperature/humidity and alert
// counts to that one area. With no area, everything is combined (what the
// Dashboard uses). Occupancy is counted at the entrance gate, not per
// area, so it is never filtered.
app.get('/api/summary/today', async (req, res) => {
  const area = req.query.area || null;
  const areaSql = area ? ' AND area = ?' : '';
  const areaParams = area ? [area] : [];

  const [[noiseStats]] = await pool.query(
    `SELECT ROUND(AVG(noise_db),1) AS avg, MIN(noise_db) AS min, MAX(noise_db) AS max, COUNT(*) AS readingCount
     FROM noise_readings WHERE DATE(recorded_at) = CURDATE()${areaSql}`,
    areaParams
  );
  const [[envStats]] = await pool.query(
    `SELECT ROUND(AVG(temperature),1) AS avgTemp, MIN(temperature) AS minTemp, MAX(temperature) AS maxTemp,
            ROUND(AVG(humidity),1) AS avgHumidity, MIN(humidity) AS minHumidity, MAX(humidity) AS maxHumidity,
            COUNT(*) AS readingCount
     FROM environment_readings WHERE DATE(recorded_at) = CURDATE()${areaSql}`,
    areaParams
  );
  const [[occRow]] = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN direction = 'IN' THEN 1 ELSE -1 END), 0) AS current,
       COALESCE(SUM(CASE WHEN direction = 'IN' THEN 1 ELSE 0 END), 0) AS entered,
       COALESCE(SUM(CASE WHEN direction = 'OUT' THEN 1 ELSE 0 END), 0) AS exited
     FROM occupancy_events WHERE DATE(recorded_at) = CURDATE()`
  );
  const occupancyStats = {
    current: Math.max(occRow.current, 0),
    max: OCCUPANCY_MAX,
    percentUsed: Math.round((Math.max(occRow.current, 0) / OCCUPANCY_MAX) * 100),
    entered: occRow.entered,
    exited: occRow.exited,
  };
  const [alertRows] = await pool.query(
    `SELECT severity, COUNT(*) AS count FROM notifications
     WHERE DATE(recorded_at) = CURDATE()
       AND severity IN ('normal', 'moderate', 'above_limit')${areaSql}
     GROUP BY severity`,
    areaParams
  );
  const alertCounts = { normal: 0, moderate: 0, above_limit: 0 };
  alertRows.forEach(r => { alertCounts[r.severity] = r.count; });
  const totalAlerts = alertRows.reduce((sum, r) => sum + r.count, 0);

  // ---- Plain-language verdict for non-technical staff ----
  // Numbers stay in the payload for anyone who wants the detail, but the
  // headline is a sentence, not a stat.
  let noiseWord = 'quiet';
  if (noiseStats.avg >= NOISE_LIMIT) noiseWord = 'loud';
  else if (noiseStats.avg >= NOISE_MODERATE) noiseWord = 'a bit noisy';

  let noiseSummary;
  if (!noiseStats.readingCount) {
    noiseSummary = 'No noise readings recorded yet today.';
  } else if (alertCounts.above_limit > 0) {
    noiseSummary = `Mostly ${noiseWord} today, with ${alertCounts.above_limit} moment${alertCounts.above_limit === 1 ? '' : 's'} above the noise limit.`;
  } else if (alertCounts.moderate > 0) {
    noiseSummary = `Mostly ${noiseWord} today, having ${alertCounts.moderate} moderate level${alertCounts.moderate === 1 ? '' : 's'}.`;
  } else {
    noiseSummary = `Noise stayed within its normal range.`;
  }

  let tempSummary;
  if (!envStats.readingCount) {
    tempSummary = 'No temperature readings recorded yet today.';
  } else {
    tempSummary = `Temperature stayed between ${envStats.minTemp}°C and ${envStats.maxTemp}°C today.`;
  }

  let humiditySummary;
  if (!envStats.readingCount || envStats.avgHumidity === null) {
    humiditySummary = 'No humidity readings recorded yet today.';
  } else {
    humiditySummary = `Humidity ranged from ${envStats.minHumidity}% to ${envStats.maxHumidity}% today, averaging ${envStats.avgHumidity}%.`;
  }

  let occupancySummary;
  if (occupancyStats.entered === 0 && occupancyStats.exited === 0) {
    occupancySummary = 'No occupancy activity recorded yet today.';
  } else if (occupancyStats.percentUsed >= 80) {
    occupancySummary = `Currently ${occupancyStats.current} of ${occupancyStats.max} used (${occupancyStats.percentUsed}%), with ${occupancyStats.entered} entries today.`;
  } else {
    occupancySummary = `Currently at ${occupancyStats.current} of ${occupancyStats.max} (${occupancyStats.percentUsed}% capacity), with ${occupancyStats.entered} entries and ${occupancyStats.exited} exits today.`;
  }

  let overallSummary;
  if (totalAlerts === 0) {
    overallSummary = 'No issues today. All readings stayed within normal ranges.';
  } else {
    overallSummary = `${totalAlerts} alert${totalAlerts === 1 ? '' : 's'} today. See the notifications tab for details.`;
  }

  res.json({
    date: localDateStr(new Date()),
    area: area || 'All areas',
    noise: noiseStats,
    environment: envStats,
    occupancy: occupancyStats,
    alerts: alertCounts,
    totalAlerts,
    friendly: {
      noise: noiseSummary,
      temperature: tempSummary,
      humidity: humiditySummary,
      occupancy: occupancySummary,
      overall: overallSummary,
    },
  });
});

// ---- CSV export (Excel-compatible) ----
function formatPhilippineDateTime(value) {
  if (!value) return '';

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);

  // Keep CSV timestamps human-readable and consistent for PH staff.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const byType = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${byType.year}-${byType.month}-${byType.day} ${byType.hour}:${byType.minute}:${byType.second}`;
}

function displayValue(value, fallback = '--') {
  if (value === null || value === undefined || value === '') return fallback;
  return value;
}

function toCsv(rows, columns) {
  const header = columns.map(col => col.label).join(',');
  const lines = rows.map(row =>
    columns.map(col => {
      const rawVal = row[col.key] ?? '';
      const val = col.format ? col.format(rawVal, row) : rawVal;
      const str = String(val).replace(/"/g, '""');
      return /[",\n]/.test(str) ? `"${str}"` : str;
    }).join(',')
  );
  return [header, ...lines].join('\n');
}

app.get('/api/export/summary.csv', async (req, res) => {
  const [[noiseStats]] = await pool.query(
    `SELECT ROUND(AVG(noise_db),1) AS avg, MIN(noise_db) AS min, MAX(noise_db) AS max, COUNT(*) AS readingCount
     FROM noise_readings WHERE DATE(recorded_at) = CURDATE()`
  );
  const [[envStats]] = await pool.query(
    `SELECT ROUND(AVG(temperature),1) AS avgTemp, MIN(temperature) AS minTemp, MAX(temperature) AS maxTemp,
            ROUND(AVG(humidity),1) AS avgHumidity, MIN(humidity) AS minHumidity, MAX(humidity) AS maxHumidity,
            COUNT(*) AS readingCount
     FROM environment_readings WHERE DATE(recorded_at) = CURDATE()`
  );
  const [alertRows] = await pool.query(
    `SELECT severity, COUNT(*) AS count FROM notifications
     WHERE DATE(recorded_at) = CURDATE()
       AND severity IN ('normal', 'moderate', 'above_limit')
     GROUP BY severity`
  );
  const [occupancyRows] = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN direction = 'IN' THEN 1 ELSE -1 END), 0) AS current,
       COALESCE(SUM(CASE WHEN direction = 'IN' THEN 1 ELSE 0 END), 0) AS entered,
       COALESCE(SUM(CASE WHEN direction = 'OUT' THEN 1 ELSE 0 END), 0) AS exited
     FROM occupancy_events
     WHERE DATE(recorded_at) = CURDATE()`
  );

  const alertCounts = { normal: 0, moderate: 0, above_limit: 0 };
  alertRows.forEach(r => { alertCounts[r.severity] = r.count; });
  const totalAlerts = alertRows.reduce((sum, r) => sum + r.count, 0);
  const occCurrent = Math.max(occupancyRows[0]?.current ?? 0, 0);
  const entered = occupancyRows[0]?.entered ?? 0;
  const exited = occupancyRows[0]?.exited ?? 0;
  const percentUsed = Math.round((occCurrent / OCCUPANCY_MAX) * 100);

  let noiseWord = 'quiet';
  if ((noiseStats.avg ?? 0) >= NOISE_LIMIT) noiseWord = 'loud';
  else if ((noiseStats.avg ?? 0) >= NOISE_MODERATE) noiseWord = 'a bit noisy';

  let noiseSummary;
  if (!noiseStats.readingCount) {
    noiseSummary = 'No noise readings recorded yet today.';
  } else if (alertCounts.above_limit > 0) {
    noiseSummary = `Mostly ${noiseWord} today, with ${alertCounts.above_limit} moment${alertCounts.above_limit === 1 ? '' : 's'} above the noise limit.`;
  } else if (alertCounts.moderate > 0) {
    noiseSummary = `Mostly ${noiseWord} today, with ${alertCounts.moderate} moderately noisy moment${alertCounts.moderate === 1 ? '' : 's'}.`;
  } else {
    noiseSummary = 'Noise stayed within the normal range today.';
  }

  let humiditySummary;
  if (!envStats.readingCount || envStats.avgHumidity === null) {
    humiditySummary = 'No humidity readings recorded yet today.';
  } else {
    humiditySummary = `Humidity ranged from ${envStats.minHumidity}% to ${envStats.maxHumidity}% today, averaging ${envStats.avgHumidity}%.`;
  }

  let occupancySummary;
  if (entered === 0 && exited === 0) {
    occupancySummary = 'No occupancy activity recorded yet today.';
  } else {
    occupancySummary = `Currently at ${occCurrent} of ${OCCUPANCY_MAX} (${percentUsed}% capacity), with ${entered} entries and ${exited} exits today.`;
  }

  const rows = [
    { section: 'Report', metric: 'Date', value: localDateStr(new Date()), note: 'Server local date' },
    { section: 'Report', metric: 'Noise summary', value: noiseSummary, note: 'Plain-language overview' },
    { section: 'Report', metric: 'Humidity summary', value: humiditySummary, note: 'Plain-language overview' },
    { section: 'Report', metric: 'Occupancy summary', value: occupancySummary, note: 'Plain-language overview' },
    { section: 'Noise', metric: 'Average noise (dB)', value: displayValue(noiseStats.avg), note: 'Today' },
    { section: 'Noise', metric: 'Lowest noise (dB)', value: displayValue(noiseStats.min), note: 'Today' },
    { section: 'Noise', metric: 'Highest noise (dB)', value: displayValue(noiseStats.max), note: 'Today' },
    { section: 'Noise', metric: 'Reading count', value: displayValue(noiseStats.readingCount, 0), note: 'Today' },
    { section: 'Environment', metric: 'Average temperature (°C)', value: displayValue(envStats.avgTemp), note: 'Today' },
    { section: 'Environment', metric: 'Lowest temperature (°C)', value: displayValue(envStats.minTemp), note: 'Today' },
    { section: 'Environment', metric: 'Highest temperature (°C)', value: displayValue(envStats.maxTemp), note: 'Today' },
    { section: 'Environment', metric: 'Average humidity (%)', value: displayValue(envStats.avgHumidity), note: 'Today' },
    { section: 'Environment', metric: 'Lowest humidity (%)', value: displayValue(envStats.minHumidity), note: 'Today' },
    { section: 'Environment', metric: 'Highest humidity (%)', value: displayValue(envStats.maxHumidity), note: 'Today' },
    { section: 'Environment', metric: 'Reading count', value: displayValue(envStats.readingCount, 0), note: 'Today' },
    { section: 'Occupancy', metric: 'Current occupancy', value: displayValue(occCurrent, 0), note: `Today, capacity ${OCCUPANCY_MAX}` },
    { section: 'Occupancy', metric: 'Percent of capacity', value: `${percentUsed}%`, note: 'Today' },
    { section: 'Occupancy', metric: 'Entered', value: displayValue(entered, 0), note: 'Today' },
    { section: 'Occupancy', metric: 'Exited', value: displayValue(exited, 0), note: 'Today' },
    { section: 'Notifications', metric: 'Total alerts', value: displayValue(totalAlerts, 0), note: 'Today' },
    { section: 'Notifications', metric: 'Moderate alerts', value: displayValue(alertCounts.moderate, 0), note: 'Today' },
    { section: 'Notifications', metric: 'Above-limit alerts', value: displayValue(alertCounts.above_limit, 0), note: 'Today' },
  ];

  const csv = toCsv(rows, [
    { key: 'section', label: 'Section' },
    { key: 'metric', label: 'Metric' },
    { key: 'value', label: 'Value' },
    { key: 'note', label: 'Note' },
  ]);

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="lemon_daily_summary.csv"');
  res.send(csv);
});

app.get('/api/export/noise.csv', async (req, res) => {
  const [rows] = await pool.query(
    `SELECT area, noise_db, recorded_at FROM noise_readings ORDER BY area, recorded_at DESC`
  );
  const csv = toCsv(rows, [
    { key: 'area', label: 'Area' },
    { key: 'noise_db', label: 'Noise (dB)' },
    { key: 'recorded_at', label: 'Recorded At (PHT)', format: formatPhilippineDateTime },
  ]);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="lemon_noise_readings.csv"');
  res.send(csv);
});

app.get('/api/export/environment.csv', async (req, res) => {
  const [rows] = await pool.query(
    `SELECT area, temperature, humidity, recorded_at FROM environment_readings ORDER BY area, recorded_at DESC`
  );
  const csv = toCsv(rows, [
    { key: 'area', label: 'Area' },
    { key: 'temperature', label: 'Temperature (°C)' },
    { key: 'humidity', label: 'Humidity (%)' },
    { key: 'recorded_at', label: 'Recorded At (PHT)', format: formatPhilippineDateTime },
  ]);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="lemon_environment_readings.csv"');
  res.send(csv);
});

app.get('/api/export/occupancy.csv', async (req, res) => {
  const [rows] = await pool.query(
    `SELECT area, direction, recorded_at FROM occupancy_events ORDER BY area, recorded_at DESC`
  );
  const csv = toCsv(rows, [
    { key: 'area', label: 'Area' },
    { key: 'direction', label: 'Direction' },
    { key: 'recorded_at', label: 'Recorded At (PHT)', format: formatPhilippineDateTime },
  ]);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="lemon_occupancy_events.csv"');
  res.send(csv);
});

app.get('/api/export/notifications.csv', async (req, res) => {
  const [rows] = await pool.query(
    `SELECT area, type, message, severity, recorded_at FROM notifications ORDER BY area, recorded_at DESC`
  );
  const csv = toCsv(rows, [
    { key: 'area', label: 'Area' },
    { key: 'type', label: 'Type' },
    { key: 'message', label: 'Message' },
    { key: 'severity', label: 'Severity' },
    { key: 'recorded_at', label: 'Recorded At (PHT)', format: formatPhilippineDateTime },
  ]);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="lemon_notifications.csv"');
  res.send(csv);
});

// ---- Historical reports (reads the pre-aggregated daily_summary table,
// so a 5-month range is just a few hundred small rows, not a scan of every
// raw reading) ----
// daily_summary rows only exist if the 11:55pm rollup actually ran that
// night (the server/laptop was on), and today's row never exists until then.
// That left holes in the dashboard's Week chart (missing days, and no point
// for today). So before reading the range, roll up any recent day that has
// no row yet, and always refresh today (rollupDay upserts, so it's safe to
// re-run). Capped to the last 14 days of the range - older gaps are the
// backfill script's job, and this keeps a multi-month report from
// triggering hundreds of scans.
const AUTO_FILL_MAX_DAYS = 14;
async function fillMissingDailySummaries(start, end) {
  const today = localDateStr(new Date());
  const last = end < today ? end : today;
  const cap = parseLocalDate(last);
  cap.setDate(cap.getDate() - (AUTO_FILL_MAX_DAYS - 1));
  const capStr = localDateStr(cap);
  const first = start > capStr ? start : capStr;
  if (first > last) return;

  const [existing] = await pool.query(
    'SELECT DISTINCT summary_date FROM daily_summary WHERE summary_date BETWEEN ? AND ?',
    [first, last]
  );
  const have = new Set(existing.map(r =>
    r.summary_date instanceof Date ? localDateStr(r.summary_date) : String(r.summary_date).slice(0, 10)
  ));

  for (let d = parseLocalDate(first); localDateStr(d) <= last; d.setDate(d.getDate() + 1)) {
    const ds = localDateStr(d);
    if (!have.has(ds) || ds === today) await rollupDay(ds);
  }
}

app.get('/api/reports/range', async (req, res) => {
  const { start, end, area } = req.query;
  if (!start || !end) {
    return res.status(400).json({ error: 'start and end query params are required (YYYY-MM-DD)' });
  }

  try {
    await fillMissingDailySummaries(start, end);
  } catch (err) {
    // Non-fatal: still return whatever is already in daily_summary.
    console.error('Auto-fill of daily_summary failed:', err);
  }

  const params = [start, end];
  let areaFilter = '';
  if (area) {
    areaFilter = 'AND area = ?';
    params.push(area);
  }

  const [rows] = await pool.query(
    `SELECT * FROM daily_summary
     WHERE summary_date BETWEEN ? AND ? ${areaFilter}
     ORDER BY summary_date ASC`,
    params
  );

  // Also return a simple overall total/average across the range, so the
  // frontend doesn't need to recompute it from the daily rows.
  const totalReadings = rows.reduce((s, r) => s + r.noise_reading_count, 0);
  const avgNoise = rows.length
    ? Math.round((rows.reduce((s, r) => s + (r.avg_noise_db || 0), 0) / rows.length) * 10) / 10
    : null;
  const totalAlerts = rows.reduce((s, r) => s + r.alerts_moderate + r.alerts_above_limit, 0);

  res.json({
    start, end,
    days: rows,
    summary: { totalReadings, avgNoise, totalAlerts },
  });
});

// ---- Single-day, on-demand report ----
// Backs the Reports page's "Request a Report" control. Reads the
// pre-aggregated daily_summary row for that date+area (one indexed
// lookup - cheap regardless of how much raw sensor history exists). Only
// falls back to actually computing anything when that day hasn't been
// rolled up yet (e.g. today, before the 11:55pm job runs, or an older
// date nobody has requested before) - and even then, rollupDay() only
// scans that single date's rows, never the whole table. Once computed,
// it's cached in daily_summary, so the next request for the same day is
// back to a single indexed lookup.
app.get('/api/reports/day', async (req, res) => {
  const { date, area } = req.query;
  if (!date || !area) {
    return res.status(400).json({ error: 'date (YYYY-MM-DD) and area query params are required' });
  }

  try {
    let [[row]] = await pool.query(
      'SELECT * FROM daily_summary WHERE summary_date = ? AND area = ?',
      [date, area]
    );

    if (!row) {
      await rollupDay(date);
      [[row]] = await pool.query(
        'SELECT * FROM daily_summary WHERE summary_date = ? AND area = ?',
        [date, area]
      );
    }

    if (!row) {
      return res.json({ date, area, found: false });
    }

    res.json({
      date, area, found: true,
      noise: { avg: row.avg_noise_db, min: row.min_noise_db, max: row.max_noise_db, count: row.noise_reading_count },
      environment: {
        avgTemp: row.avg_temperature, minTemp: row.min_temperature, maxTemp: row.max_temperature,
        avgHumidity: row.avg_humidity, minHumidity: row.min_humidity, maxHumidity: row.max_humidity,
        count: row.env_reading_count,
      },
      occupancy: { entered: row.entered, exited: row.exited },
      alerts: {
        moderate: row.alerts_moderate,
        above_limit: row.alerts_above_limit,
        total: row.alerts_moderate + row.alerts_above_limit,
      },
    });
  } catch (err) {
    console.error('Single-day report failed:', err);
    res.status(500).json({ error: 'Failed to build report, check server logs' });
  }
});

app.get('/api/export/day.csv', async (req, res) => {
  const { date, area } = req.query;
  if (!date || !area) {
    return res.status(400).json({ error: 'date (YYYY-MM-DD) and area query params are required' });
  }

  try {
    let [[row]] = await pool.query(
      'SELECT * FROM daily_summary WHERE summary_date = ? AND area = ?',
      [date, area]
    );
    if (!row) {
      await rollupDay(date);
      [[row]] = await pool.query(
        'SELECT * FROM daily_summary WHERE summary_date = ? AND area = ?',
        [date, area]
      );
    }

    const rows = !row ? [] : [
      { metric: 'Average noise (dB)', value: displayValue(row.avg_noise_db) },
      { metric: 'Lowest noise (dB)', value: displayValue(row.min_noise_db) },
      { metric: 'Highest noise (dB)', value: displayValue(row.max_noise_db) },
      { metric: 'Noise readings', value: displayValue(row.noise_reading_count, 0) },
      { metric: 'Average temperature (°C)', value: displayValue(row.avg_temperature) },
      { metric: 'Lowest temperature (°C)', value: displayValue(row.min_temperature) },
      { metric: 'Highest temperature (°C)', value: displayValue(row.max_temperature) },
      { metric: 'Average humidity (%)', value: displayValue(row.avg_humidity) },
      { metric: 'Lowest humidity (%)', value: displayValue(row.min_humidity) },
      { metric: 'Highest humidity (%)', value: displayValue(row.max_humidity) },
      { metric: 'Environment readings', value: displayValue(row.env_reading_count, 0) },
      { metric: 'Entered', value: displayValue(row.entered, 0) },
      { metric: 'Exited', value: displayValue(row.exited, 0) },
      { metric: 'Moderate alerts', value: displayValue(row.alerts_moderate, 0) },
      { metric: 'Above-limit alerts', value: displayValue(row.alerts_above_limit, 0) },
    ];

    const csv = toCsv(rows, [
      { key: 'metric', label: 'Metric' },
      { key: 'value', label: 'Value' },
    ]);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="lemon_report_${date}_${area.replace(/\s+/g, '_')}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error('Single-day CSV export failed:', err);
    res.status(500).json({ error: 'Failed to build report, check server logs' });
  }
});


// Pearson r (+ significance + plain-language interpretation) between every
// pair of {temperature, humidity, noise, occupancy}, computed from raw
// sensor data bucketed by hour over the given date range. See
// correlationAnalytics.js for the methodology notes.
app.get('/api/analytics/correlation', requireAdmin, async (req, res) => {
  const { start, end, area } = req.query;
  if (!start || !end || !area) {
    return res.status(400).json({ error: 'start, end (YYYY-MM-DD) and area query params are required' });
  }

  // Treat `end` as inclusive of the whole day, matching how staff would
  // naturally read a date-range picker ("Sep 1 to Sep 7" includes Sep 7).
  const startDt = `${start} 00:00:00`;
  const endDt = `${end} 23:59:59`;

  try {
    const result = await computeCorrelations(startDt, endDt, area);
    res.json(result);
  } catch (err) {
    console.error('Correlation analytics failed:', err);
    res.status(500).json({ error: 'Failed to compute correlation analytics, check server logs' });
  }
});

// Manual trigger, useful for demos/testing without waiting for the nightly
// schedule - rolls up a specific date (defaults to today).
app.post('/api/reports/rollup-now', requireAdmin, async (req, res) => {
  const date = req.body.date || localDateStr(new Date());
  try {
    await rollupDay(date);
    res.json({ ok: true, date });
  } catch (err) {
    console.error('Manual rollup failed:', err);
    res.status(500).json({ error: 'Rollup failed, check server logs' });
  }
});

// ---- Auth ----
app.post('/api/login', async (req, res) => {
  const { staff_id, password } = req.body;
  if (!staff_id || !password) {
    return res.status(400).json({ error: 'staff_id and password are required' });
  }

  const [rows] = await pool.query('SELECT * FROM users WHERE staff_id = ?', [staff_id]);
  const user = rows[0];

  // Same generic error whether the staff_id doesn't exist or the
  // password is wrong - being specific about which one it was makes it
  // easier for someone to guess valid staff IDs.
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid staff ID or password' });
  }

  const token = signToken({ staff_id: user.staff_id, full_name: user.full_name, role: user.role });
  setSessionCookie(res, token);
  res.json({ ok: true, staff_id: user.staff_id, full_name: user.full_name, role: user.role });
});

app.post('/api/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const user = getCurrentUser(req);
  if (!user) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, staff_id: user.staff_id, full_name: user.full_name, role: user.role });
});

// ---- Settings ----
// Currently just the sensor log interval, but kept as a small generic
// endpoint since more runtime-configurable options will likely land here
// later without needing new routes each time.
app.get('/api/settings', (req, res) => {
  res.json({
    sensor_log_interval_ms: getSensorLogIntervalMs(),
    allowed_intervals_ms: ALLOWED_INTERVALS_MS,
  });
});

app.put('/api/settings/sensor-log-interval', requireAdmin, async (req, res) => {
  const ms = Number(req.body.sensor_log_interval_ms);
  if (!Number.isInteger(ms) || !ALLOWED_INTERVALS_MS.includes(ms)) {
    return res.status(400).json({
      error: `sensor_log_interval_ms must be one of: ${ALLOWED_INTERVALS_MS.join(', ')}`,
    });
  }

  try {
    await setSensorLogIntervalMs(ms);
    io.to('staff').emit('settings-update', { sensor_log_interval_ms: ms });
    res.json({ ok: true, sensor_log_interval_ms: ms });
  } catch (err) {
    console.error('Failed to update sensor log interval:', err);
    res.status(500).json({ error: 'Failed to update setting' });
  }
});

// ---- Table occupancy status (simulated for now; same schema the CS
// department's camera system will eventually write to) ----
app.get('/api/tables/status', async (req, res) => {
  const [rows] = await pool.query(
    `SELECT area, table_label, total_seats, occupied_seats, source, updated_at FROM table_status ORDER BY area, table_label`
  );
  res.json(rows);
});

// This is the endpoint the CS department's camera system will call once
// it's ready - same shape as what our own simulator sends, so nothing
// else needs to change when we swap the data source. Seat-count based
// (occupied_seats out of total_seats) rather than a single available/
// occupied flag, since a table can be partially filled.
app.post('/api/tables/status', requireDeviceKeyOrAdmin, async (req, res) => {
  const { area, table_label, total_seats, occupied_seats, source } = req.body;

  const seatsOk = Number.isInteger(total_seats) && total_seats > 0;
  const occupiedOk = Number.isInteger(occupied_seats) && occupied_seats >= 0 && occupied_seats <= total_seats;

  if (!area || !table_label || !seatsOk || !occupiedOk) {
    return res.status(400).json({
      error: 'area, table_label, total_seats (positive integer), and occupied_seats (0..total_seats) are required',
    });
  }

  await pool.query(
    `INSERT INTO table_status (area, table_label, total_seats, occupied_seats, source)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE total_seats = VALUES(total_seats), occupied_seats = VALUES(occupied_seats), source = VALUES(source), updated_at = CURRENT_TIMESTAMP`,
    [area, table_label, total_seats, occupied_seats, source || 'simulated']
  );

  io.emit('table-status-update', { area, table_label, total_seats, occupied_seats, source: source || 'simulated' });
  res.json({ ok: true });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, async () => {
  console.log(`Lemon backend listening on port ${PORT}`);
  await loadSettingsCache();
  startMqttSubscriber(io);
  startRollupJob();
});