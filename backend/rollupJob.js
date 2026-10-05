const cron = require('node-cron');
const pool = require('./db');
const { localDateStr } = require('./dateUtils');

/**
 * Computes and stores one summary row per area for the given date.
 * Safe to re-run for the same date (upserts via ON DUPLICATE KEY),
 * so you can manually trigger it to backfill or fix a day if needed.
 */
async function rollupDay(dateStr) {
  const [areasRows] = await pool.query(
    `SELECT DISTINCT area FROM (
       SELECT area FROM noise_readings WHERE DATE(recorded_at) = ?
       UNION SELECT area FROM environment_readings WHERE DATE(recorded_at) = ?
       UNION SELECT area FROM occupancy_events WHERE DATE(recorded_at) = ?
       UNION SELECT area FROM notifications WHERE DATE(recorded_at) = ?
     ) AS areas`,
    [dateStr, dateStr, dateStr, dateStr]
  );

  for (const { area } of areasRows) {
    const [[noise]] = await pool.query(
      `SELECT ROUND(AVG(noise_db),2) AS avg, MIN(noise_db) AS min, MAX(noise_db) AS max, COUNT(*) AS cnt
       FROM noise_readings WHERE DATE(recorded_at) = ? AND area = ?`,
      [dateStr, area]
    );
    const [[env]] = await pool.query(
      `SELECT ROUND(AVG(temperature),2) AS avgTemp, MIN(temperature) AS minTemp, MAX(temperature) AS maxTemp,
              ROUND(AVG(humidity),2) AS avgHumidity, MIN(humidity) AS minHumidity, MAX(humidity) AS maxHumidity,
              COUNT(*) AS cnt
       FROM environment_readings WHERE DATE(recorded_at) = ? AND area = ?`,
      [dateStr, area]
    );
    const [[occ]] = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN direction = 'IN' THEN 1 ELSE 0 END), 0) AS entered,
         COALESCE(SUM(CASE WHEN direction = 'OUT' THEN 1 ELSE 0 END), 0) AS exited
       FROM occupancy_events WHERE DATE(recorded_at) = ? AND area = ?`,
      [dateStr, area]
    );
    const [alertRows] = await pool.query(
      `SELECT severity, COUNT(*) AS count FROM notifications
       WHERE DATE(recorded_at) = ? AND area = ? GROUP BY severity`,
      [dateStr, area]
    );
    const alertCounts = { moderate: 0, above_limit: 0 };
    alertRows.forEach(r => { if (alertCounts[r.severity] !== undefined) alertCounts[r.severity] = r.count; });

    await pool.query(
      `INSERT INTO daily_summary (
         summary_date, area, avg_noise_db, min_noise_db, max_noise_db, noise_reading_count,
         avg_temperature, min_temperature, max_temperature,
         avg_humidity, min_humidity, max_humidity, env_reading_count,
         entered, exited, alerts_moderate, alerts_above_limit
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         avg_noise_db=VALUES(avg_noise_db), min_noise_db=VALUES(min_noise_db), max_noise_db=VALUES(max_noise_db),
         noise_reading_count=VALUES(noise_reading_count),
         avg_temperature=VALUES(avg_temperature), min_temperature=VALUES(min_temperature), max_temperature=VALUES(max_temperature),
         avg_humidity=VALUES(avg_humidity), min_humidity=VALUES(min_humidity), max_humidity=VALUES(max_humidity),
         env_reading_count=VALUES(env_reading_count),
         entered=VALUES(entered), exited=VALUES(exited),
         alerts_moderate=VALUES(alerts_moderate), alerts_above_limit=VALUES(alerts_above_limit)`,
      [
        dateStr, area,
        noise.avg, noise.min, noise.max, noise.cnt,
        env.avgTemp, env.minTemp, env.maxTemp, env.avgHumidity, env.minHumidity, env.maxHumidity, env.cnt,
        occ.entered, occ.exited,
        alertCounts.moderate, alertCounts.above_limit,
      ]
    );
  }

  console.log(`Rollup complete for ${dateStr} (${areasRows.length} area(s))`);
}

function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return localDateStr(d);
}

function startRollupJob() {
  // Runs every night at 11:55pm, rolling up that day's data.
  // Local deployment, so this uses the server's own clock/timezone.
  cron.schedule('55 23 * * *', async () => {
    const today = localDateStr(new Date());
    try {
      await rollupDay(today);
    } catch (err) {
      console.error('Rollup job failed:', err);
    }
  });

  console.log('Daily rollup job scheduled for 11:55pm.');
}

module.exports = { startRollupJob, rollupDay, yesterday };
