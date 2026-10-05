// Local-calendar-date helpers.
//
// Date.prototype.toISOString() always converts to UTC first. In the
// Philippines (UTC+8) that means between 12:00 AM and 8:00 AM local time
// it returns YESTERDAY's date, and a local-midnight Date (e.g. the loop
// variable in backfillDailySummary.js) also comes out one day early.
// These helpers read the Date's own local year/month/day instead.

function localDateStr(d = new Date()) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// "YYYY-MM-DD" -> Date at LOCAL midnight (new Date('YYYY-MM-DD') would be UTC midnight).
function parseLocalDate(str) {
  const [y, m, d] = String(str).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}

module.exports = { localDateStr, parseLocalDate };
