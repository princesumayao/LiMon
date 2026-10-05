// ---- Correlation Analytics ----
// Computes Pearson correlation coefficients between pairs of environmental/
// occupancy variables (temperature, humidity, noise, occupancy) from raw
// sensor data, with a significance test (p-value) and a plain-language
// interpretation for non-technical staff.
//
// Why hourly buckets instead of daily_summary: daily_summary gives one row
// per area per day, which is too few points (n) to correlate meaningfully
// early in deployment. Bucketing the raw, timestamped readings by hour
// keeps each variable's natural resolution while still giving enough
// observations to compute a statistically defensible r, even from a few
// days of data.
const pool = require('./db');

// ---- Pearson correlation coefficient ----
function pearson(pairs) {
  const n = pairs.length;
  if (n < 3) return { r: null, n };
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (const [x, y] of pairs) {
    sumX += x; sumY += y; sumXY += x * y; sumX2 += x * x; sumY2 += y * y;
  }
  const num = n * sumXY - sumX * sumY;
  const den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  if (den === 0) return { r: 0, n }; // one variable had zero variance
  return { r: num / den, n };
}

// ---- Significance test (two-tailed p-value for Pearson r, df = n-2) ----
// Implemented from scratch (Lanczos log-gamma + continued-fraction
// incomplete beta) since there's no stats library in the project's
// dependencies and pulling one in for this alone felt heavier than needed.
function logGamma(x) {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function betacf(x, a, b) {
  const MAXIT = 200, EPS = 3e-7, FPMIN = 1e-30;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

function regularizedIncompleteBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x)
  );
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(x, a, b)) / a;
  return 1 - (bt * betacf(1 - x, b, a)) / b;
}

function pValue(r, n) {
  if (r === null || n <= 2) return null;
  if (Math.abs(r) >= 1) return 0;
  const df = n - 2;
  const t = Math.abs(r) * Math.sqrt(df / (1 - r * r));
  const x = df / (df + t * t);
  return regularizedIncompleteBeta(x, df / 2, 0.5);
}

// ---- Strength classification (standard rule-of-thumb bands) ----
function classifyStrength(r) {
  const abs = Math.abs(r);
  if (abs < 0.1) return 'negligible';
  if (abs < 0.3) return 'weak';
  if (abs < 0.5) return 'moderate';
  if (abs < 0.7) return 'strong';
  return 'very strong';
}

const VARIABLES = {
  temperature: { label: 'Temperature', unit: '°C' },
  humidity: { label: 'Humidity', unit: '%' },
  noise: { label: 'Noise', unit: 'dB' },
  occupancy: { label: 'Occupancy', unit: 'people' },
};

// Occupancy is currently only measured building-wide, by the single RFID
// gate at the entrance (area: 'Entrance' in occupancy_events) - there's no
// per-room occupancy sensor yet (that's the RFID + dual IR-beam hardware
// mentioned as "not ordered yet"). Temperature/humidity/noise, by
// contrast, ARE measured per room (area: 'Area A' / 'Area B'). So unlike
// the other three variables, occupancy is intentionally NOT filtered by
// the selected area - it's compared as "total people in the building"
// against that room's readings. Once room-level occupancy hardware exists
// and starts tagging events with the room's area instead of 'Entrance',
// change OCCUPANCY_AREA below to null (or remove this special-case) to
// switch to a same-room comparison instead.
const OCCUPANCY_AREA = 'Entrance';

// ---- Staff-facing plain-language summary ----
// Hand-written per pair (only 6 of them) rather than templated, so the
// wording reads naturally instead of like a stats sentence with nouns
// swapped in. "qualifier" softens/strengthens the verb based on effect size.
const PLAIN_PHRASES = {
  'humidity|temperature': {
    up: (area, q) => `In ${area}, humidity tends to rise ${q} as it gets warmer.`,
    down: (area, q) => `In ${area}, humidity tends to drop ${q} as it gets warmer.`,
  },
  'noise|temperature': {
    up: (area, q) => `In ${area}, it tends to get ${q} noisier as the temperature rises.`,
    down: (area, q) => `In ${area}, it tends to get ${q} quieter as the temperature rises.`,
  },
  'occupancy|temperature': {
    up: (area, q) => `In ${area}, temperature tends to climb ${q} when the building gets busier.`,
    down: (area, q) => `In ${area}, temperature tends to drop ${q} when the building gets busier.`,
  },
  'humidity|noise': {
    up: (area, q) => `In ${area}, noise tends to rise ${q} along with humidity.`,
    down: (area, q) => `In ${area}, noise tends to drop ${q} as humidity rises.`,
  },
  'humidity|occupancy': {
    up: (area, q) => `In ${area}, humidity tends to rise ${q} when the building gets busier.`,
    down: (area, q) => `In ${area}, humidity tends to drop ${q} when the building gets busier.`,
  },
  'noise|occupancy': {
    up: (area, q) => `In ${area}, it tends to get ${q} noisier as the building fills up.`,
    down: (area, q) => `In ${area}, it tends to get ${q} quieter as the building fills up.`,
  },
};

const QUALIFIER = { moderate: 'a little', strong: 'noticeably', 'very strong': 'sharply' };

// Plain badge shown to staff by default - no r/p/n jargon.
function plainVerdict(r, p, n) {
  if (n < 8) return { label: 'Not enough data yet', tone: 'neutral' };
  if (r === null || p === null || p >= 0.05) return { label: 'No clear connection', tone: 'neutral' };
  const strength = classifyStrength(r);
  if (strength === 'negligible' || strength === 'weak') return { label: 'No clear connection', tone: 'neutral' };
  if (strength === 'moderate') return { label: 'Some connection', tone: 'mild' };
  return { label: 'Strong connection', tone: 'strong' }; // strong or very strong
}

function plainSummary(varA, varB, r, p, n, area) {
  const key = [varA, varB].sort().join('|');
  const verdict = plainVerdict(r, p, n);

  if (verdict.label === 'Not enough data yet') {
    return `Not enough readings yet in ${area} to tell if ${VARIABLES[varA].label.toLowerCase()} and ${VARIABLES[varB].label.toLowerCase()} are connected. Keep collecting data.`;
  }
  if (verdict.label === 'No clear connection') {
    return `No clear connection found between ${VARIABLES[varA].label.toLowerCase()} and ${VARIABLES[varB].label.toLowerCase()} in ${area} for this period.`;
  }
  const strength = classifyStrength(r);
  const qualifier = QUALIFIER[strength] || 'a little';
  const phrases = PLAIN_PHRASES[key];
  if (!phrases) return `${VARIABLES[varA].label} and ${VARIABLES[varB].label} in ${area} tend to move together.`;
  return r > 0 ? phrases.up(area, qualifier) : phrases.down(area, qualifier);
}

// Technical detail, hidden behind a toggle for admins/defense panels who
// want the actual statistics behind the plain-language sentence above.
function technicalDetail(varA, varB, r, p, n) {
  if (r === null) return `Not enough matched hourly readings to compute a correlation (n=${n}).`;
  const strength = classifyStrength(r);
  const direction = r > 0 ? 'positive' : 'negative';
  const sig = (p !== null && p < 0.05 && n >= 8)
    ? 'statistically significant'
    : 'not statistically significant, so treat this as inconclusive';
  return `Pearson r = ${r.toFixed(2)} (${strength} ${direction} correlation), p = ${p === null ? 'n/a' : p.toFixed(3)}, based on n = ${n} hourly readings. This result is ${sig}.`;
}

// ---- Hourly bucketing helpers ----
function hourBucket(date) {
  const d = new Date(date);
  d.setMinutes(0, 0, 0);
  return d.toISOString();
}

// Turns a stream of IN/OUT events into an average-occupants-per-hour series
// by walking the running count across time and weighting by how much of
// each hour each count value was in effect (time-weighted average, so a
// burst of entries right before the hour boundary doesn't skew the bucket
// the same as a burst spread evenly across it).
function bucketOccupancyByHour(events, rangeStart, rangeEnd) {
  const buckets = new Map(); // bucketKey -> { weightedSum, totalMs }
  let count = 0;
  let cursor = new Date(rangeStart);

  const ensureBucket = (key) => {
    if (!buckets.has(key)) buckets.set(key, { weightedSum: 0, totalMs: 0 });
    return buckets.get(key);
  };

  const addSpan = (from, to, level) => {
    let t = new Date(from);
    const end = new Date(to);
    while (t < end) {
      const hourEnd = new Date(t);
      hourEnd.setMinutes(0, 0, 0);
      hourEnd.setHours(hourEnd.getHours() + 1);
      const segEnd = hourEnd < end ? hourEnd : end;
      const ms = segEnd - t;
      if (ms > 0) {
        const b = ensureBucket(hourBucket(t));
        b.weightedSum += level * ms;
        b.totalMs += ms;
      }
      t = segEnd;
    }
  };

  for (const ev of events) {
    const at = new Date(ev.recorded_at);
    if (at > cursor) {
      addSpan(cursor, at, Math.max(count, 0));
      cursor = at;
    }
    count += ev.direction === 'IN' ? 1 : -1;
  }
  if (cursor < rangeEnd) addSpan(cursor, rangeEnd, Math.max(count, 0));

  const result = new Map();
  for (const [key, { weightedSum, totalMs }] of buckets) {
    if (totalMs > 0) result.set(key, weightedSum / totalMs);
  }
  return result;
}

async function fetchHourlyBuckets(start, end, area) {
  // environment + noise bucket cleanly in SQL (simple averages);
  // occupancy needs the running-count walk above, done in JS.
  const [envRows] = await pool.query(
    `SELECT DATE_FORMAT(recorded_at, '%Y-%m-%dT%H:00:00.000Z') AS bucket,
            AVG(temperature) AS avgTemp, AVG(humidity) AS avgHumidity
     FROM environment_readings
     WHERE recorded_at BETWEEN ? AND ? AND area = ?
     GROUP BY bucket`,
    [start, end, area]
  );
  const [noiseRows] = await pool.query(
    `SELECT DATE_FORMAT(recorded_at, '%Y-%m-%dT%H:00:00.000Z') AS bucket,
            AVG(noise_db) AS avgNoise
     FROM noise_readings
     WHERE recorded_at BETWEEN ? AND ? AND area = ?
     GROUP BY bucket`,
    [start, end, area]
  );
  const [occEvents] = await pool.query(
    `SELECT direction, recorded_at FROM occupancy_events
     WHERE recorded_at BETWEEN ? AND ? AND area = ?
     ORDER BY recorded_at ASC`,
    [start, end, OCCUPANCY_AREA || area]
  );
  const occBuckets = bucketOccupancyByHour(occEvents, new Date(start), new Date(end));

  const merged = new Map();
  const get = (key) => {
    if (!merged.has(key)) merged.set(key, {});
    return merged.get(key);
  };
  for (const r of envRows) {
    const b = get(r.bucket);
    b.temperature = Number(r.avgTemp);
    b.humidity = Number(r.avgHumidity);
  }
  for (const r of noiseRows) {
    get(r.bucket).noise = Number(r.avgNoise);
  }
  for (const [key, val] of occBuckets) {
    get(key).occupancy = val;
  }
  return merged;
}

// ---- Prescriptive layer ----
// Turns a correlation that's already been found (r, p, n) into a concrete,
// area-specific suggestion - this is what makes it "prescriptive" rather
// than just descriptive. Reuses the exact same threshold numbers that
// already drive your live notifications (thresholds.js), so a
// recommendation here and an alert elsewhere never disagree with each
// other about what counts as "too loud" or "too hot".
const THRESHOLDS = require('./thresholds');

function formatHour12(hour) {
  const h = ((hour % 24) + 24) % 24;
  const period = h < 12 ? 'AM' : 'PM';
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display} ${period}`;
}

// Finds the hour-of-day (0-23) where `variable` runs highest on average,
// aggregated across every day in the range - e.g. "occupancy usually
// peaks around 2 PM", not just "was high once on one specific day".
function peakHourOfDay(entries, variable) {
  const sums = new Array(24).fill(0);
  const counts = new Array(24).fill(0);
  for (const [bucketKey, row] of entries) {
    if (row[variable] === undefined) continue;
    const hour = new Date(bucketKey).getHours();
    sums[hour] += row[variable];
    counts[hour] += 1;
  }
  let bestHour = null, bestAvg = -Infinity;
  for (let h = 0; h < 24; h++) {
    if (counts[h] === 0) continue;
    const avg = sums[h] / counts[h];
    if (avg > bestAvg) { bestAvg = avg; bestHour = h; }
  }
  return bestHour === null ? null : { hour: bestHour, avg: bestAvg };
}

// Average value of `variable` specifically during a given hour-of-day,
// across all days in range - used to check "does it actually cross the
// threshold during the peak, on average" rather than guessing.
function avgAtHour(entries, variable, hour) {
  let sum = 0, count = 0;
  for (const [bucketKey, row] of entries) {
    if (row[variable] === undefined) continue;
    if (new Date(bucketKey).getHours() !== hour) continue;
    sum += row[variable]; count += 1;
  }
  return count === 0 ? null : sum / count;
}

function generateRecommendation(varA, varB, r, p, n, area, entries) {
  if (r === null || p === null || p >= 0.05 || n < 8) return null;
  const strength = classifyStrength(r);
  if (strength === 'negligible' || strength === 'weak') return null;

  const key = [varA, varB].sort().join('|');
  const direction = r > 0 ? 'up' : 'down';

  // ---- Pairs involving building-wide occupancy: timed, threshold-aware ----
  if (varA === 'occupancy' || varB === 'occupancy') {
    const effectVar = varA === 'occupancy' ? varB : varA;
    const peak = peakHourOfDay(entries, 'occupancy');
    if (!peak) return null;
    const peakStr = formatHour12(peak.hour);
    const effectAtPeak = avgAtHour(entries, effectVar, peak.hour);

    // Counterintuitive direction (busier -> quieter/cooler) is unusual
    // enough that it's more likely a sensor issue than a real effect -
    // flag it as a check rather than a capacity action.
    if (direction === 'down' && (effectVar === 'noise' || effectVar === 'temperature')) {
      return {
        text: `${VARIABLES[effectVar].label} in ${area} drops when the building gets busier - the opposite of what you'd usually expect. Check if the ${effectVar} sensor is placed correctly.`,
        reasoning: `Flagged because ${effectVar} correlates negatively with building occupancy (unexpected direction), r=${r.toFixed(2)}, p=${p.toFixed(3)}, n=${n}. Peak building traffic is around ${peakStr}.`,
      };
    }

    if (effectVar === 'noise') {
      const overLimit = effectAtPeak !== null && effectAtPeak > THRESHOLDS.NOISE_LIMIT;
      const overModerate = effectAtPeak !== null && effectAtPeak > THRESHOLDS.NOISE_MODERATE;
      const crossing = overLimit
        ? `averaging ${effectAtPeak.toFixed(0)} dB then — above your ${THRESHOLDS.NOISE_LIMIT} dB limit`
        : overModerate
        ? `averaging ${effectAtPeak.toFixed(0)} dB then — into the moderate range`
        : `though it's still staying within your usual noise range`;
      return {
        text: `${area} tends to get noticeably louder as the building fills up, especially around ${peakStr}, ${crossing}. ${overLimit ? `Noise is highest around ${peakStr}. Remind students to keep quiet at that hour.` : 'Worth keeping an eye on during that window.'}`,
        reasoning: `Occupancy correlates with noise in ${area}: r=${r.toFixed(2)}, p=${p.toFixed(3)}, n=${n}. Peak building traffic ~${peakStr}; average noise at that hour was ${effectAtPeak === null ? 'n/a' : effectAtPeak.toFixed(1) + ' dB'} against a ${THRESHOLDS.NOISE_MODERATE}/${THRESHOLDS.NOISE_LIMIT} dB moderate/limit threshold.`,
      };
    }

    if (effectVar === 'temperature') {
      const overLimit = effectAtPeak !== null && effectAtPeak > THRESHOLDS.TEMP_LIMIT;
      const crossing = overLimit
        ? `averaging ${effectAtPeak.toFixed(1)}°C then — above your ${THRESHOLDS.TEMP_LIMIT}°C limit`
        : `though it's staying within your usual range`;
      return {
        text: `Temperature in ${area} tends to climb as the building fills up, especially around ${peakStr}, ${crossing}. ${overLimit ? `Consider pre-cooling or increasing ventilation in ${area} shortly before ${peakStr}.` : 'Worth keeping an eye on during that window.'}`,
        reasoning: `Occupancy correlates with temperature in ${area}: r=${r.toFixed(2)}, p=${p.toFixed(3)}, n=${n}. Peak building traffic ~${peakStr}; average temperature at that hour was ${effectAtPeak === null ? 'n/a' : effectAtPeak.toFixed(1) + '°C'} against a ${THRESHOLDS.TEMP_LIMIT}°C limit.`,
      };
    }

    if (effectVar === 'humidity') {
      const outOfRange = effectAtPeak !== null && (effectAtPeak > THRESHOLDS.HUMIDITY_HIGH || effectAtPeak < THRESHOLDS.HUMIDITY_LOW);
      const label = effectAtPeak !== null && effectAtPeak > THRESHOLDS.HUMIDITY_HIGH ? 'humid' : 'dry';
      const crossing = outOfRange
        ? `averaging ${effectAtPeak.toFixed(0)}% then — outside the ${THRESHOLDS.HUMIDITY_LOW}-${THRESHOLDS.HUMIDITY_HIGH}% comfort range`
        : `though it's staying within a reasonable comfort range`;
      return {
        text: `Humidity in ${area} tends to shift ${direction === 'up' ? 'up' : 'down'} as the building fills up, especially around ${peakStr}, ${crossing}. ${outOfRange ? `Consider running a dehumidifier or ventilation in ${area} before ${peakStr} to stay ${label === 'humid' ? 'drier' : 'from drying out further'}.` : 'Worth keeping an eye on during that window.'}`,
        reasoning: `Occupancy correlates with humidity in ${area}: r=${r.toFixed(2)}, p=${p.toFixed(3)}, n=${n}. Peak building traffic ~${peakStr}; average humidity at that hour was ${effectAtPeak === null ? 'n/a' : effectAtPeak.toFixed(1) + '%'} against a ${THRESHOLDS.HUMIDITY_LOW}-${THRESHOLDS.HUMIDITY_HIGH}% comfort range.`,
      };
    }
  }

  // ---- Purely environmental pairs (no occupancy involved): lighter,
  // diagnostic-style suggestions rather than timed capacity actions, since
  // there's no "peak hour" story to tell here. ----
  if (key === 'humidity|temperature') {
    return {
      text: `Temperature and humidity in ${area} tend to move ${direction === 'up' ? 'together' : 'in opposite directions'}. If one drifts past its comfortable range, check the other too — they're rarely a coincidence in the same room.`,
      reasoning: `Temperature correlates with humidity in ${area}: r=${r.toFixed(2)}, p=${p.toFixed(3)}, n=${n}.`,
    };
  }
  if (key === 'noise|temperature' || key === 'humidity|noise') {
    const other = key === 'noise|temperature' ? 'temperature' : 'humidity';
    return {
      text: `Noise and ${other} in ${area} tend to move together. Not necessarily something to act on by itself, but if you're troubleshooting one, it's worth glancing at the other.`,
      reasoning: `Noise correlates with ${other} in ${area}: r=${r.toFixed(2)}, p=${p.toFixed(3)}, n=${n}.`,
    };
  }

  return null;
}

const PAIRS = [
  ['temperature', 'humidity'],
  ['temperature', 'noise'],
  ['temperature', 'occupancy'],
  ['humidity', 'noise'],
  ['humidity', 'occupancy'],
  ['noise', 'occupancy'],
];

async function computeCorrelations(start, end, area) {
  const buckets = await fetchHourlyBuckets(start, end, area);
  const entries = [...buckets.entries()];
  const rows = entries.map(([, row]) => row);

  const results = PAIRS.map(([varA, varB]) => {
    const pairs = rows
      .filter(row => row[varA] !== undefined && row[varB] !== undefined)
      .map(row => [row[varA], row[varB]]);
    const { r, n } = pearson(pairs);
    const p = r === null ? null : pValue(r, n);
    const verdict = plainVerdict(r, p, n);
    const recommendation = r === null ? null : generateRecommendation(varA, varB, r, p, n, area, entries);

    // One merged "details" block for the toggle: the stats, plus (when
    // there is one) the reasoning behind the recommendation - so there's
    // a single place to look, not two separate technical sections.
    let detail = technicalDetail(varA, varB, r, p, n);
    if (recommendation) detail += ` Recommendation basis: ${recommendation.reasoning}`;

    return {
      variableA: varA,
      variableB: varB,
      labelA: VARIABLES[varA].label,
      labelB: VARIABLES[varB].label,
      r: r === null ? null : Math.round(r * 1000) / 1000,
      p: p === null ? null : Math.round(p * 10000) / 10000,
      n,
      strength: r === null ? 'insufficient_data' : classifyStrength(r),
      significant: p !== null && p < 0.05 && n >= 8,
      // Plain-language fields for the staff-facing UI:
      verdictLabel: verdict.label,   // e.g. "Strong connection"
      verdictTone: verdict.tone,     // neutral | mild | strong -> drives badge color
      summary: plainSummary(varA, varB, r, p, n, area),   // one plain sentence
      recommendation: recommendation ? recommendation.text : null, // prescriptive suggestion, shown by default when present
      detail,                                              // stats + reasoning, behind a single "Show details" toggle
    };
  });

  return {
    area,
    start,
    end,
    hourlyBucketsUsed: rows.length,
    pairs: results,
  };
}

module.exports = {
  pearson,
  pValue,
  classifyStrength,
  computeCorrelations,
  VARIABLES,
};
