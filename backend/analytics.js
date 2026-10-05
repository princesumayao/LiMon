// Pearson correlation coefficient between two equal-length numeric
// arrays. Returns null if there isn't enough variation to compute one
// (e.g. every value is identical, which would divide by zero).
function pearsonCorrelation(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;

  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;

  let numerator = 0;
  let sumSqX = 0;
  let sumSqY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    numerator += dx * dy;
    sumSqX += dx * dx;
    sumSqY += dy * dy;
  }

  const denominator = Math.sqrt(sumSqX * sumSqY);
  if (denominator === 0) return null; // no variation in one of the variables
  return numerator / denominator;
}

// Rough, standard conventions for describing correlation strength -
// these thresholds are a common rule of thumb, not a hard scientific
// boundary, and are described that way in the interpretation text too.
function describeCorrelationStrength(r) {
  if (r === null) return { strength: 'undetermined', direction: 'none' };
  const abs = Math.abs(r);
  let strength;
  if (abs < 0.1) strength = 'negligible';
  else if (abs < 0.3) strength = 'weak';
  else if (abs < 0.5) strength = 'moderate';
  else if (abs < 0.7) strength = 'strong';
  else strength = 'very strong';
  const direction = r > 0 ? 'positive' : r < 0 ? 'negative' : 'none';
  return { strength, direction };
}

function buildCorrelationInterpretation({ area, sampleSize, r, strength, direction, hourly }) {
  const paragraphs = [];

  if (r === null || sampleSize < 5) {
    paragraphs.push(
      `Not enough daily data yet for ${area} to calculate a reliable correlation (${sampleSize} day${sampleSize === 1 ? '' : 's'} available, at least 5 recommended). This will become more accurate as more days of data are collected.`
    );
    return paragraphs;
  }

  const rRounded = r.toFixed(2);
  if (strength === 'negligible') {
    paragraphs.push(
      `Across ${sampleSize} days, daily foot traffic in ${area} showed no meaningful relationship with average noise levels (r = ${rRounded}). Noise in this area appears to be driven by something other than how many people pass through.`
    );
  } else if (direction === 'positive') {
    paragraphs.push(
      `Across ${sampleSize} days, ${area} showed a ${strength} positive correlation (r = ${rRounded}) between daily foot traffic and average noise level - on days with more entries, the area tended to be noisier.`
    );
  } else {
    paragraphs.push(
      `Across ${sampleSize} days, ${area} showed a ${strength} negative correlation (r = ${rRounded}) between daily foot traffic and average noise level - on days with more entries, the area was actually quieter on average. This is an unusual pattern worth double-checking against other factors (e.g. a change in policy, seating layout, or the time of year).`
    );
  }

  if (hourly && hourly.peakNoiseHour !== null && hourly.peakTrafficHour !== null) {
    const fmt = (h) => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'AM' : 'PM'}`;
    if (hourly.hoursAligned) {
      paragraphs.push(
        `By time of day, both noise and foot traffic tend to peak around the same time - roughly ${fmt(hourly.peakTrafficHour)}, supporting the idea that busier hours are also the noisier ones.`
      );
    } else {
      paragraphs.push(
        `By time of day, foot traffic peaks around ${fmt(hourly.peakTrafficHour)} while noise peaks around ${fmt(hourly.peakNoiseHour)} - these don't line up closely, so hour-to-hour, crowd size alone doesn't fully explain when it gets loud.`
      );
    }
  }

  return paragraphs;
}

module.exports = {
  pearsonCorrelation,
  describeCorrelationStrength,
  buildCorrelationInterpretation,
};
