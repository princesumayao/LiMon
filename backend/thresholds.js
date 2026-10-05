// ---- Shared sensor thresholds ----
// Single source of truth for "what counts as too hot/loud/crowded/humid".
// Originally these lived only inside mqttSubscriber.js for the live
// notification system. Pulled out here so correlation/prescriptive
// analytics reads the exact same numbers instead of a second,
// independently-maintained copy that could quietly drift out of sync.
//
// HUMIDITY_LOW/HIGH are new - there was no humidity threshold anywhere in
// the system before this. 40-60% RH is a standard "comfortable and safe
// for paper/books" indoor range; treat this as a placeholder to confirm
// with your adviser/panel, not a measured value specific to your building.
//
// NOISE_MODERATE/NOISE_LIMIT - back to literal 50/60. A recalibration
// attempt against a phone SPL app was tried (see project notes/chat
// history) but the input data turned out too noisy to trust: the phone
// app has its own ~30dB measurement floor, test conditions varied between
// sessions, and idle readings started matching the sensor's disconnected/
// floating-pin behavior, suggesting a loose wiring connection was adding
// noise independent of anything acoustic. Reverted to the values that
// were already confirmed to behave sensibly in initial testing rather
// than ship a tighter, noise-sensitive band this close to defense.
// Worth revisiting with a firmer wiring connection and more controlled
// test conditions when there's time.

module.exports = {
  TEMP_LIMIT: 28.0,        // °C - above this, temperature notifications fire "above_limit"
  NOISE_MODERATE: 50,      // sensor's own scale (not literal dB - see note above)
  NOISE_LIMIT: 60,         // sensor's own scale (not literal dB - see note above)
  OCCUPANCY_MAX: 60,       // people - capacity used for %-full calculations
  HUMIDITY_LOW: 40,        // %RH - below this is "too dry"
  HUMIDITY_HIGH: 60,       // %RH - above this is "too humid"
};
