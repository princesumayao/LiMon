'use strict';

// ===== Auth guard =====
// Runs before anything else: confirms there's a valid session, fills in
// the real staff ID/role in the sidebar, hides admin-only sections from
// non-admins, and bounces to the login page if there's no session at
// all. The backend enforces the actual admin-only restriction on the
// settings write endpoint too - this part is just about what's shown,
// not the real access control (that lives server-side, since hiding a
// button in the browser is never real security by itself).
// Talks to whatever host the page itself was loaded from, on port 4000 -
// not a hardcoded 'localhost'. If this page is opened as
// http://localhost:3000/home, that resolves to http://localhost:4000 as
// before. But if it's opened from another device on the same network as
// http://192.168.1.23:3000/home (e.g. a student scanning the seat-map QR
// code), this now correctly points at http://192.168.1.23:4000 instead of
// each device trying to reach its own 'localhost', which doesn't exist.
const API_BASE_URL = `${window.location.protocol}//${window.location.hostname}:4000`;

// The API now requires a login on every data route, and the dashboard (port
// 3000) calls it cross-origin (port 4000), so every request must carry the
// session cookie. Wrapping fetch once here covers every call below. If a
// background GET comes back 401 (session expired / logged out elsewhere),
// send the user to the login page instead of showing a half-empty dashboard.
const _nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
    const res = await _nativeFetch(input, { credentials: 'include', ...init });
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const method = (init.method || 'GET').toUpperCase();
    if (res.status === 401 && method === 'GET' && url.startsWith(API_BASE_URL) && !url.includes('/api/me')) {
        window.location.href = '/login';
    }
    return res;
};

// A handful of CSV download links are still plain hardcoded
// href="http://localhost:4000/..." anchors in the HTML (simpler to write
// than wiring up JS for a static link) - rewritten here to the same
// dynamic host as everything else, for the same LAN-access reason.
document.querySelectorAll('a[href^="http://localhost:4000"]').forEach(a => {
    a.href = a.getAttribute('href').replace('http://localhost:4000', API_BASE_URL);
});

async function guardAndInitAuth() {
    try {
        const res = await fetch(`${API_BASE_URL}/api/me`, { credentials: 'include' });
        const data = await res.json();

        if (!data.loggedIn) {
            window.location.href = '/login';
            return;
        }

        const nameLabel = document.getElementById('user-name-label');
        const roleLabel = document.getElementById('user-role-label');
        const avatar = document.getElementById('user-avatar');
        const menuName = document.getElementById('user-menu-name');
        const menuRole = document.getElementById('user-menu-role');
        const menuAvatar = document.getElementById('user-menu-avatar');

        const displayName = data.full_name || data.staff_id;
        const roleText = data.role === 'admin' ? 'Administrator' : 'Staff';
        const initials = displayName.trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();

        if (nameLabel) nameLabel.textContent = displayName;
        if (roleLabel) roleLabel.textContent = roleText;
        if (avatar) avatar.textContent = initials;
        if (menuName) menuName.textContent = displayName;
        if (menuRole) menuRole.textContent = roleText;
        if (menuAvatar) menuAvatar.textContent = initials;

        const settingsCard = document.getElementById('sensor-log-settings-card');
        if (settingsCard) settingsCard.style.display = data.role === 'admin' ? '' : 'none';

        // Analytics (correlation + prescriptive recommendations) is a
        // supervisory tool, same tier as the settings card above - hidden
        // from staff accounts, not just the settings card. The "Insights"
        // group label above it is hidden too, since Analytics is the only
        // item in that group right now - otherwise staff would see a
        // floating section header with nothing under it. The backend
        // enforces this for real on /api/analytics/correlation (see
        // requireAdmin there); this is just what's shown.
        const analyticsNavItem = document.querySelector('.nav-item[data-page="analytics"]');
        if (analyticsNavItem) analyticsNavItem.style.display = data.role === 'admin' ? '' : 'none';
        const insightsGroupLabel = document.getElementById('nav-group-insights');
        if (insightsGroupLabel) insightsGroupLabel.style.display = data.role === 'admin' ? '' : 'none';
    } catch (err) {
        console.error('Auth check failed - is the backend running?', err);
        window.location.href = '/login';
    }
}
guardAndInitAuth();

// ===== User menu dropdown =====
const userMenuToggle = document.getElementById('user-menu-toggle');
const userMenuPopover = document.getElementById('user-menu-popover');

userMenuToggle?.addEventListener('click', (e) => {
    e.stopPropagation();
    userMenuPopover?.classList.toggle('open');
});

// Click anywhere outside the menu closes it.
document.addEventListener('click', (e) => {
    if (!userMenuPopover?.classList.contains('open')) return;
    if (userMenuPopover.contains(e.target) || userMenuToggle.contains(e.target)) return;
    userMenuPopover.classList.remove('open');
});

// Opening the dropdown and then deliberately clicking "Log Out" inside it
// is already enough intentional friction - no extra confirm() needed on
// top of that.
document.getElementById('logout-link')?.addEventListener('click', async () => {
    try {
        await fetch(`${API_BASE_URL}/api/logout`, { method: 'POST', credentials: 'include' });
    } catch (err) {
        console.error('Logout request failed', err);
    }
    window.location.href = '/login';
});

// ===== REAL DATA: Noise (Area A + Area B), pushed live over WebSocket =====
// Two areas are wired in for the prototype/testing setup. AREA_SUFFIX maps
// a sensor's "area" string to the id suffix used on that area's cards
// ("Area A" -> noise-a-value, "Area B" -> noise-b-value, etc). An area
// that isn't in this map (not expected right now, but harmless once the
// library-wide deployment adds more areas later) simply has no per-area
// card to update, but it still counts toward the dashboard-wide average
// below.
const AREA_SUFFIX = { 'Area A': 'a', 'Area B': 'b' };

// Mirrors backend/thresholds.js (NOISE_MODERATE / NOISE_LIMIT). Update
// BOTH files together if these ever change - see thresholds.js for why
// they're back at 50/60.
const NOISE_MODERATE = 50;
const NOISE_LIMIT = 60;

function noiseStatus(db) {
    if (db >= NOISE_LIMIT) {
        return { label: 'Above Limit', badgeClass: 'b-danger', color: 'var(--red)', barColor: 'linear-gradient(90deg,var(--red),#ff6b6b)' };
    }
    if (db >= NOISE_MODERATE) {
        return { label: 'Moderate', badgeClass: 'b-warn', color: 'var(--amber)', barColor: 'linear-gradient(90deg,var(--amber),#ffcc00)' };
    }
    return { label: 'Normal', badgeClass: 'b-ok', color: 'var(--green)', barColor: 'linear-gradient(90deg,var(--green),#4ade80)' };
}

// Updates just the one area's own card on the Noise Analytics page
// (noise-a-* or noise-b-*, depending on suffix). Does not touch the
// dashboard's combined "Noise Level" card - see updateDashboardNoiseCard().
function updateNoiseAreaUI(db, suffix) {
    const status = noiseStatus(db);

    const valueEl = document.getElementById(`noise-${suffix}-value`);
    if (valueEl) valueEl.textContent = db;

    const badgeEl = document.getElementById(`noise-${suffix}-badge`);
    if (badgeEl) {
        badgeEl.textContent = status.label;
        badgeEl.className = 'sc-badge ' + status.badgeClass;
    }

    const barFill = document.getElementById(`noise-${suffix}-bar-fill`);
    if (barFill) {
        barFill.style.width = Math.min(db, 100) + '%';
        barFill.style.background = status.barColor;
    }

    const barVal = document.getElementById(`noise-${suffix}-bar-val`);
    if (barVal) {
        barVal.textContent = db + ' dB';
        barVal.style.color = status.color;
    }

    // NOTE: the per-area chart line is intentionally NOT updated here.
    // Pushing a new chart point on every single reading (once a second)
    // makes the line look jittery and does a full re-render 60x/min for
    // no benefit. Instead we buffer readings and flush a 1-minute average
    // into the chart on an interval - see bufferNoiseReading() /
    // flushNoiseChart().
}

// Holds the most recent reading for every area we've heard from, so the
// dashboard's single "Noise Level" card can show one number that
// represents every area combined (the average), not just whichever area
// happened to update last.
const latestNoiseByArea = {};
const lastNoiseSeenAt = {};

function updateDashboardNoiseCard() {
    const values = Object.values(latestNoiseByArea);
    const liveNoiseEl = document.getElementById('live-noise');
    const dashBadge = document.getElementById('live-noise-badge');

    if (!values.length) {
        if (liveNoiseEl) liveNoiseEl.textContent = '--';
        if (dashBadge) { dashBadge.textContent = 'No Data'; dashBadge.className = 'sc-badge b-muted'; }
        return;
    }

    const avgDb = Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
    if (liveNoiseEl) liveNoiseEl.textContent = avgDb;

    // Badge reflects the loudest area right now, not the status of the
    // average - a quiet Area A shouldn't mask a genuinely loud Area B.
    const status = noiseStatus(Math.max(...values));
    if (dashBadge) {
        dashBadge.textContent = status.label;
        dashBadge.className = 'sc-badge ' + status.badgeClass;
    }
}

function updateNoiseUI(db, area, recordedAt) {
    db = Number(db);
    latestNoiseByArea[area] = db;
    lastNoiseSeenAt[area] = recordedAt ? new Date(recordedAt).getTime() : Date.now();
    const suffix = AREA_SUFFIX[area];
    if (suffix) updateNoiseAreaUI(db, suffix);
    updateDashboardNoiseCard();
}

// Get an initial value immediately on page load (WebSocket only delivers
// readings that arrive *after* connecting, so this fills the gap). Seeds
// every area present in the response, not just Area A, so Area B's card
// and the dashboard average are both correct as soon as the page loads.
async function fetchInitialNoise() {
    try {
        const res = await fetch(`${API_BASE_URL}/api/noise/latest`);
        const rows = await res.json();
        rows.forEach(row => updateNoiseUI(row.noise_db, row.area, row.recorded_at));
        checkSensorFreshness();
    } catch (err) {
        console.error('Failed to fetch initial noise data - is the backend running on port 4000?', err);
    }
}
// Reset every area's noise card to '--'/No Data before fetching anything,
// so a completely empty database (fresh install, or right after a reset)
// shows "no data yet" immediately instead of leaving the HTML file's
// hardcoded placeholder numbers on screen (markNoiseAreaOffline is defined
// further down, but function declarations are hoisted so this is safe).
Object.keys(AREA_SUFFIX).forEach(area => markNoiseAreaOffline(area));

fetchInitialNoise();

// Live WebSocket connection - backend pushes the instant a new MQTT reading
// arrives, so there's no polling delay at all
const socket = io(API_BASE_URL, { withCredentials: true });

socket.on('connect', () => {
    console.log('Connected live to backend via WebSocket');
});

socket.on('noise-update', (data) => {
    updateNoiseUI(data.noise_db, data.area, data.recorded_at);
    bufferNoiseReading(data.noise_db, data.area);
});

socket.on('disconnect', () => {
    console.warn('Lost WebSocket connection to backend, will auto-reconnect');
});

// ===== REAL DATA: Temperature & Humidity (Area A + Area B), pushed live over WebSocket =====
const TEMP_LIMIT = 28.0;
// Mirrors backend/thresholds.js HUMIDITY_LOW/HUMIDITY_HIGH - keep these two
// in sync if the comfort range ever changes.
const HUMIDITY_LOW = 40;
const HUMIDITY_HIGH = 60;

function tempStatus(temp) {
    if (temp > TEMP_LIMIT) return { label: 'Above Limit', badgeClass: 'b-danger' };
    return { label: 'Normal', badgeClass: 'b-ok' };
}

function humidStatus(humidity) {
    if (humidity < HUMIDITY_LOW) return { label: 'Too Dry', badgeClass: 'b-warn' };
    if (humidity > HUMIDITY_HIGH) return { label: 'Too Humid', badgeClass: 'b-warn' };
    return { label: 'Normal', badgeClass: 'b-ok' };
}

// Updates just the one area's own cards on the Environment Analytics page.
function updateEnvironmentAreaUI(temp, humidity, suffix) {
    const tStatus = tempStatus(temp);
    const hStatus = humidStatus(humidity);

    const tempValue = document.getElementById(`temp-${suffix}-value`);
    if (tempValue) tempValue.textContent = temp;

    const tempBadge = document.getElementById(`temp-${suffix}-badge`);
    if (tempBadge) {
        tempBadge.textContent = tStatus.label;
        tempBadge.className = 'sc-badge ' + tStatus.badgeClass;
    }

    const humidValue = document.getElementById(`humid-${suffix}-value`);
    if (humidValue) humidValue.textContent = humidity;

    const humidBadge = document.getElementById(`humid-${suffix}-badge`);
    if (humidBadge) {
        humidBadge.textContent = hStatus.label;
        humidBadge.className = 'sc-badge ' + hStatus.badgeClass;
    }
}

// Same idea as latestNoiseByArea: keeps the dashboard's combined
// Temperature/Humidity cards showing the average across every area,
// instead of only ever reflecting Area A.
const latestTempByArea = {};
const latestHumidByArea = {};
const lastEnvSeenAt = {};

function updateDashboardEnvironmentCard() {
    const temps = Object.values(latestTempByArea);
    const humids = Object.values(latestHumidByArea);

    const liveTempEl = document.getElementById('live-temp');
    const liveTempBadge = document.getElementById('live-temp-badge');
    if (!temps.length) {
        if (liveTempEl) liveTempEl.textContent = '--';
        if (liveTempBadge) { liveTempBadge.textContent = 'No Data'; liveTempBadge.className = 'sc-badge b-muted'; }
    } else {
        const avgTemp = Math.round((temps.reduce((a, b) => a + b, 0) / temps.length) * 10) / 10;
        if (liveTempEl) liveTempEl.textContent = avgTemp;
        // Badge reflects the hottest area right now, not the status of the
        // average - see the matching comment on updateDashboardNoiseCard.
        const worstTemp = tempStatus(Math.max(...temps));
        if (liveTempBadge) {
            liveTempBadge.textContent = worstTemp.label;
            liveTempBadge.className = 'sc-badge ' + worstTemp.badgeClass;
        }
    }

    const liveHumidEl = document.getElementById('live-humid');
    const liveHumidBadge = document.getElementById('live-humid-badge');
    if (!humids.length) {
        if (liveHumidEl) liveHumidEl.textContent = '--';
        if (liveHumidBadge) { liveHumidBadge.textContent = 'No Data'; liveHumidBadge.className = 'sc-badge b-muted'; }
    } else {
        const avgHumid = Math.round((humids.reduce((a, b) => a + b, 0) / humids.length) * 10) / 10;
        if (liveHumidEl) liveHumidEl.textContent = avgHumid;
        // Whichever area is furthest from the comfortable 40-60% range wins.
        const worstArea = humids.reduce((worst, h) =>
            Math.abs(h - 50) > Math.abs(worst - 50) ? h : worst, humids[0]);
        const worstHumid = humidStatus(worstArea);
        if (liveHumidBadge) {
            liveHumidBadge.textContent = worstHumid.label;
            liveHumidBadge.className = 'sc-badge ' + worstHumid.badgeClass;
        }
    }
}

function updateEnvironmentUI(temp, humidity, area, recordedAt) {
    temp = Number(temp);
    humidity = Number(humidity);
    latestTempByArea[area] = temp;
    latestHumidByArea[area] = humidity;
    lastEnvSeenAt[area] = recordedAt ? new Date(recordedAt).getTime() : Date.now();
    const suffix = AREA_SUFFIX[area];
    if (suffix) updateEnvironmentAreaUI(temp, humidity, suffix);
    updateDashboardEnvironmentCard();

    // Same reasoning as updateNoiseAreaUI: charts are updated on a 1-minute
    // buffer/average cycle, not on every raw reading. See
    // bufferEnvironmentReading() / flushEnvironmentCharts().
}

async function fetchInitialEnvironment() {
    try {
        const res = await fetch(`${API_BASE_URL}/api/environment/latest`);
        const rows = await res.json();
        rows.forEach(row => updateEnvironmentUI(row.temperature, row.humidity, row.area, row.recorded_at));
        checkSensorFreshness();
    } catch (err) {
        console.error('Failed to fetch initial environment data', err);
    }
}
// Same reasoning as the noise version above - reset before fetching, so
// an empty database renders as "no data yet" immediately.
Object.keys(AREA_SUFFIX).forEach(area => markEnvironmentAreaOffline(area));

fetchInitialEnvironment();

socket.on('environment-update', (data) => {
    updateEnvironmentUI(data.temperature, data.humidity, data.area, data.recorded_at);
    bufferEnvironmentReading(data.temperature, data.humidity, data.area);
});

// ===== Sensor freshness: show "--" instead of a frozen last reading =====
// Without this, a card just keeps showing whatever value it last received
// forever, even if that sensor lost power or dropped off the network
// hours ago - there is no visual difference between "quiet room" and
// "sensor is dead". These thresholds are a generous multiple of the
// firmware's own publish interval (NOISE_PUBLISH_INTERVAL_MS = 1000,
// ENV_PUBLISH_INTERVAL_MS = 5000 in the .ino), so normal network jitter
// never falsely flags a working sensor as offline.
const NOISE_STALE_MS = 8000;   // ~8x the 1s noise publish interval
const ENV_STALE_MS = 20000;    // ~4x the 5s temp/humidity publish interval

function markNoiseAreaOffline(area) {
    delete latestNoiseByArea[area];
    const suffix = AREA_SUFFIX[area];
    if (suffix) {
        const valueEl = document.getElementById(`noise-${suffix}-value`);
        if (valueEl) valueEl.textContent = '--';
        const badgeEl = document.getElementById(`noise-${suffix}-badge`);
        if (badgeEl) { badgeEl.textContent = 'No Data'; badgeEl.className = 'sc-badge b-muted'; }
        const barFill = document.getElementById(`noise-${suffix}-bar-fill`);
        if (barFill) barFill.style.width = '0%';
        const barVal = document.getElementById(`noise-${suffix}-bar-val`);
        if (barVal) barVal.textContent = '--';
    }
    updateDashboardNoiseCard();
}

function markEnvironmentAreaOffline(area) {
    delete latestTempByArea[area];
    delete latestHumidByArea[area];
    const suffix = AREA_SUFFIX[area];
    if (suffix) {
        const tempValue = document.getElementById(`temp-${suffix}-value`);
        if (tempValue) tempValue.textContent = '--';
        const tempBadge = document.getElementById(`temp-${suffix}-badge`);
        if (tempBadge) { tempBadge.textContent = 'No Data'; tempBadge.className = 'sc-badge b-muted'; }
        const humidValue = document.getElementById(`humid-${suffix}-value`);
        if (humidValue) humidValue.textContent = '--';
        const humidBadge = document.getElementById(`humid-${suffix}-badge`);
        if (humidBadge) { humidBadge.textContent = 'No Data'; humidBadge.className = 'sc-badge b-muted'; }
    }
    updateDashboardEnvironmentCard();
}

function checkSensorFreshness() {
    const now = Date.now();
    Object.keys(AREA_SUFFIX).forEach(area => {
        if (lastNoiseSeenAt[area] !== undefined && now - lastNoiseSeenAt[area] > NOISE_STALE_MS) {
            markNoiseAreaOffline(area);
            delete lastNoiseSeenAt[area]; // stop re-marking every tick; resumes once a fresh reading arrives
        }
        if (lastEnvSeenAt[area] !== undefined && now - lastEnvSeenAt[area] > ENV_STALE_MS) {
            markEnvironmentAreaOffline(area);
            delete lastEnvSeenAt[area];
        }
    });
}
setInterval(checkSensorFreshness, 3000);

// ===== REAL DATA: Occupancy, pushed live over WebSocket =====
function occupancyStatus(percentUsed) {
    if (percentUsed >= 90) return { label: 'Full', badgeClass: 'b-danger' };
    if (percentUsed >= 60) return { label: 'Busy', badgeClass: 'b-warn' };
    return { label: 'Available', badgeClass: 'b-ok' };
}

function updateOccupancyUI(current, max, percentUsed, entered, exited) {
    const status = occupancyStatus(percentUsed);

    const liveOccEl = document.getElementById('live-occ');
    if (liveOccEl) liveOccEl.textContent = current;

    const liveOccBadge = document.getElementById('live-occ-badge');
    if (liveOccBadge) {
        liveOccBadge.textContent = status.label;
        liveOccBadge.className = 'sc-badge ' + status.badgeClass;
    }

    const dashGaugeVal = document.getElementById('dash-gauge-val');
    if (dashGaugeVal) dashGaugeVal.textContent = current;
    const dashCapPct = document.getElementById('dash-capacity-pct');
    if (dashCapPct) dashCapPct.textContent = percentUsed + '%';
    const dashCapFill = document.getElementById('dash-cap-fill');
    if (dashCapFill) dashCapFill.style.width = Math.min(percentUsed, 100) + '%';

    const occGaugeVal = document.getElementById('occ-gauge-val');
    if (occGaugeVal) occGaugeVal.textContent = current;
    const occCapPct = document.getElementById('occ-capacity-pct');
    if (occCapPct) occCapPct.textContent = percentUsed + '%';
    const occCapFill = document.getElementById('occ-cap-fill');
    if (occCapFill) occCapFill.style.width = Math.min(percentUsed, 100) + '%';

    const occEnteredEl = document.getElementById('occ-entered');
    if (occEnteredEl) occEnteredEl.textContent = entered;
    const occExitedEl = document.getElementById('occ-exited');
    if (occExitedEl) occExitedEl.textContent = exited;

    // Clamp same as createGaugeChart: current can't be allowed to push
    // the "remaining" slice negative if a reading ever exceeds capacity.
    const pct = max ? Math.min(current / max, 1) : 0;
    if (typeof dashGaugeChart !== 'undefined' && dashGaugeChart) {
        dashGaugeChart.data.datasets[0].data = [pct, 1 - pct];
        dashGaugeChart.update();
    }
    if (typeof occGaugeChart !== 'undefined' && occGaugeChart) {
        occGaugeChart.data.datasets[0].data = [pct, 1 - pct];
        occGaugeChart.update();
    }

    bufferOccupancyReading(current);
}

async function fetchAndUpdateOccupancy() {
    try {
        const res = await fetch(`${API_BASE_URL}/api/occupancy/current`);
        const data = await res.json();
        updateOccupancyUI(data.current, data.max, data.percentUsed, data.entered, data.exited);
    } catch (err) {
        console.error('Failed to fetch occupancy data', err);
    }
}
fetchAndUpdateOccupancy();

socket.on('occupancy-update', fetchAndUpdateOccupancy);
setInterval(fetchAndUpdateOccupancy, 5000); // cheap query, cheap fallback in case a socket event is missed

// ===== Table Occupancy Map =====
// Renders a per-area grid of table cards from /api/tables/status - same
// endpoint the CS department's camera system will eventually post to
// instead of tableStatusSimulator.js, so this rendering code never needs
// to change when that swap happens.

// Local cache keyed by "area::table_label" so a socket update can patch
// just one cell instead of re-fetching/re-rendering the whole map.
let tableMapCache = {};
let tableMapLoaded = false;

function tableKey(area, table_label) {
    return `${area}::${table_label}`;
}

// Renders one table as a small rectangular "box" card: label, an
// occupied/total count, and a capacity bar - the same capacity-bar
// pattern already used for the overall occupancy gauge elsewhere in
// this dashboard (see .cap-bar-wrap / .cap-track / .cap-fill). This
// deliberately does NOT try to show which literal chair is taken -
// headcount-based detection can only report how many seats at a table
// are occupied, not which specific one - so the UI only ever claims a
// count/fraction, never a specific-seat identity.
// Two states only: a table is either Available (at least one open seat)
// or Full. The occupied/total count and the bar still show how close a
// table is to full - the color just answers "can I sit here?".
function tmCapBarColor(fraction) {
    return fraction >= 1 ? 'var(--red)' : 'var(--green)';
}

function buildTableUnitHtml(row) {
    const total = row.total_seats;
    const occupied = row.occupied_seats;
    const fraction = total > 0 ? occupied / total : 0;
    const pct = Math.round(fraction * 100);

    const isFull = occupied >= total;
    const countClass = isFull ? 'tm-count-full' : 'tm-count-empty';
    const barColor = tmCapBarColor(fraction);

    return `
      <div class="tm-table-unit" data-key="${tableKey(row.area, row.table_label)}">
        <div class="tm-table-box">
          <div class="tm-table-box-head">
            <div class="tm-table-label">${row.table_label}</div>
            <div class="tm-table-count ${countClass}">${occupied}/${total}</div>
          </div>
          <div class="tm-cap-track">
            <div class="tm-cap-fill" style="width:${pct}%;background:${barColor};"></div>
          </div>
        </div>
      </div>
    `;
}

function renderTableMap() {
    const body = document.getElementById('table-map-body');
    if (!body) return;

    const rows = Object.values(tableMapCache);
    if (!rows.length) {
        body.innerHTML = '<div class="table-map-empty" id="table-map-empty">No table data yet — waiting for the first status update.</div>';
        return;
    }

    // Group by area, keep tables in a stable, natural order within each area.
    const byArea = {};
    rows.forEach(r => {
        if (!byArea[r.area]) byArea[r.area] = [];
        byArea[r.area].push(r);
    });

    const areaNames = Object.keys(byArea).sort();
    body.innerHTML = areaNames.map(area => {
        const tables = byArea[area].sort((a, b) =>
            a.table_label.localeCompare(b.table_label, undefined, { numeric: true })
        );
        const occupiedSeats = tables.reduce((sum, t) => sum + t.occupied_seats, 0);
        const totalSeats = tables.reduce((sum, t) => sum + t.total_seats, 0);
        return `
          <div class="tm-area-block">
            <div class="tm-area-head">
              <div class="tm-area-name">${area}</div>
              <div class="tm-area-count">${occupiedSeats} / ${totalSeats} seats occupied</div>
            </div>
            <div class="tm-table-grid">
              ${tables.map(buildTableUnitHtml).join('')}
            </div>
          </div>
        `;
    }).join('');
}

async function fetchAndRenderTableMap() {
    try {
        const res = await fetch(`${API_BASE_URL}/api/tables/status`);
        const rows = await res.json();
        tableMapCache = {};
        rows.forEach(r => {
            tableMapCache[tableKey(r.area, r.table_label)] = r;
        });
        tableMapLoaded = true;
        renderTableMap();
    } catch (err) {
        console.error('Failed to fetch table occupancy map', err);
        const body = document.getElementById('table-map-body');
        if (body) body.innerHTML = '<div class="table-map-empty">Could not load table layout — is the backend running?</div>';
    }
}

// Updates the cache, re-renders the grid (cheap - it's a handful of
// cells), then flashes the one table unit that actually changed.
// (Previously also played a beep via Web Audio API - removed per request;
// the flash alone still communicates the change.)
function handleTableStatusUpdate(data) {
    const key = tableKey(data.area, data.table_label);
    tableMapCache[key] = data;

    if (!tableMapLoaded) return; // initial fetch hasn't landed yet - it'll pick this up

    renderTableMap();

    const body = document.getElementById('table-map-body');
    const freshUnit = body && body.querySelector(`.tm-table-unit[data-key="${CSS.escape(key)}"] .tm-table-box`);
    if (freshUnit) {
        freshUnit.classList.add('tm-seat-flash');
        setTimeout(() => freshUnit.classList.remove('tm-seat-flash'), 700);
    }
}

socket.on('table-status-update', handleTableStatusUpdate);

// ===== Chart update throttling =====
// Raw sensor readings arrive ~once/second, which is far too fast to plot
// directly - it makes the line charts look jittery/noisy and forces a
// full re-render every second for no real benefit. Instead we buffer the
// raw readings in memory and, once a minute, push a single averaged point
// onto each chart. The instant number/badge/bar UI above is unaffected -
// that still updates immediately on every reading.
const CHART_FLUSH_INTERVAL_MS = 60 * 1000; // 1 minute
const CHART_MAX_POINTS = 30; // keep the last 30 minutes on screen

// noiseChart/tempChart/humidChart each draw one line per area, in this
// order (matches dataset 0 = Area A, dataset 1 = Area B on those charts).
const AREA_ORDER = ['Area A', 'Area B'];

let noiseBufferByArea = { 'Area A': [], 'Area B': [] };
let tempBufferByArea = { 'Area A': [], 'Area B': [] };
let humidBufferByArea = { 'Area A': [], 'Area B': [] };
let occBuffer = [];

function bufferNoiseReading(db, area) {
    if (!noiseBufferByArea[area]) noiseBufferByArea[area] = [];
    noiseBufferByArea[area].push(db);
}

function bufferEnvironmentReading(temp, humidity, area) {
    if (!tempBufferByArea[area]) tempBufferByArea[area] = [];
    if (!humidBufferByArea[area]) humidBufferByArea[area] = [];
    tempBufferByArea[area].push(temp);
    humidBufferByArea[area].push(humidity);
}

function bufferOccupancyReading(current) {
    occBuffer.push(current);
}

function average(arr) {
    if (!arr.length) return null;
    const sum = arr.reduce((a, b) => a + b, 0);
    return Math.round((sum / arr.length) * 10) / 10; // 1 decimal place
}

function pushPoint(chart, datasetIndex, label, value) {
    if (!chart) return;
    const dataset = chart.data.datasets[datasetIndex];
    chart.data.labels.push(label);
    dataset.data.push(value);
    while (chart.data.labels.length > CHART_MAX_POINTS) {
        chart.data.labels.shift();
        chart.data.datasets.forEach(ds => ds.data.shift());
    }
    chart.update();
}

// Pushes one label plus one value per area (in AREA_ORDER order) onto a
// chart that draws one line per area. A null value leaves a gap in that
// area's line for this minute instead of guessing - e.g. Area B simply
// hasn't sent a reading yet.
function pushMultiAreaPoint(chart, label, valuesInOrder) {
    if (!chart) return;
    chart.data.labels.push(label);
    valuesInOrder.forEach((value, i) => {
        const dataset = chart.data.datasets[i];
        if (dataset) dataset.data.push(value);
    });
    while (chart.data.labels.length > CHART_MAX_POINTS) {
        chart.data.labels.shift();
        chart.data.datasets.forEach(ds => ds.data.shift());
    }
    chart.update();
}

function flushNoiseChart() {
    const label = new Date().toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' });
    const values = AREA_ORDER.map(area => {
        const avg = average(noiseBufferByArea[area] || []);
        noiseBufferByArea[area] = [];
        return avg;
    });
    if (values.every(v => v === null)) return; // no reading from either area this minute
    if (typeof noiseChart !== 'undefined' && noiseChart) {
        pushMultiAreaPoint(noiseChart, label, values);
    }
    const present = values.filter(v => v !== null);
    if (present.length && typeof sparkNoiseChart !== 'undefined' && sparkNoiseChart) {
        pushSparkPoint(sparkNoiseChart, sparkNoiseHistory, average(present));
    }
}

function flushEnvironmentCharts() {
    const label = new Date().toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' });
    const tempValues = AREA_ORDER.map(area => {
        const avg = average(tempBufferByArea[area] || []);
        tempBufferByArea[area] = [];
        return avg;
    });
    const humidValues = AREA_ORDER.map(area => {
        const avg = average(humidBufferByArea[area] || []);
        humidBufferByArea[area] = [];
        return avg;
    });
    if (tempValues.some(v => v !== null) && typeof tempChart !== 'undefined' && tempChart) {
        pushMultiAreaPoint(tempChart, label, tempValues);
    }
    if (humidValues.some(v => v !== null) && typeof humidChart !== 'undefined' && humidChart) {
        pushMultiAreaPoint(humidChart, label, humidValues);
    }
    const presentTemps = tempValues.filter(v => v !== null);
    if (presentTemps.length && typeof sparkTempChart !== 'undefined' && sparkTempChart) {
        pushSparkPoint(sparkTempChart, sparkTempHistory, average(presentTemps));
    }
    const presentHumids = humidValues.filter(v => v !== null);
    if (presentHumids.length && typeof sparkHumidChart !== 'undefined' && sparkHumidChart) {
        pushSparkPoint(sparkHumidChart, sparkHumidHistory, average(presentHumids));
    }
}

setInterval(flushNoiseChart, CHART_FLUSH_INTERVAL_MS);
setInterval(flushEnvironmentCharts, CHART_FLUSH_INTERVAL_MS);

function flushOccupancyChart() {
    const avg = average(occBuffer);
    occBuffer = [];
    if (avg === null) return;
    const label = new Date().toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' });
    if (typeof occChart !== 'undefined' && occChart) {
        pushPoint(occChart, 0, label, Math.round(avg));
    }
    if (typeof sparkOccChart !== 'undefined' && sparkOccChart) {
        pushSparkPoint(sparkOccChart, sparkOccHistory, Math.round(avg));
    }
}
setInterval(flushOccupancyChart, CHART_FLUSH_INTERVAL_MS);

// ===== REAL DATA: Notifications =====
// unreadThreshold is only passed on the full Notifications page (see
// fetchAndRenderNotificationsPage) so previously-read alerts render dimmed.
// The dashboard preview widget always passes null - dimming a 3-item
// "recent alerts" glance doesn't mean anything, so it's left alone.
function renderAlertRow(n, unreadThreshold = null) {
    const severity = n.severity === 'above_limit_pending' ? 'above_limit' : n.severity;
    const dotColor = severity === 'above_limit' ? 'var(--red)'
        : severity === 'moderate' ? 'var(--amber)' : 'var(--green)';
    const time = new Date(n.recorded_at).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' });
    const isRead = unreadThreshold !== null && new Date(n.recorded_at).getTime() <= unreadThreshold;
    const rowClass = isRead ? 'alert-row alert-row-read' : 'alert-row';

    return `<div class="${rowClass}">
        <div class="alert-dot" style="background:${dotColor}"></div>
        <div class="alert-text">
            <div class="alert-msg">${n.message}</div>
            <div class="alert-meta">Today, ${time} · ${n.area} Sensor</div>
        </div>
        <span class="alert-tag">${n.type}</span>
    </div>`;
}

// ---- Unread badge (read-state) ----
// "Read" just means "the staff member has opened the Notifications tab
// since this alert came in." We track a timestamp locally rather than
// touching the DB, since there's no multi-user login to key it off yet
// (see the accounts discussion in the reply for what changes once there is).
const NOTIF_LAST_SEEN_KEY = 'limon_notif_last_seen';

function getLastSeenNotifTime() {
    return parseInt(localStorage.getItem(NOTIF_LAST_SEEN_KEY) || '0', 10);
}

// Snapshot of "unread cutoff" for the CURRENT visit to the Notifications
// page. We deliberately don't use the live last-seen value while the page
// is open, otherwise every row would immediately dim itself the instant you
// opened the tab - dimming should reflect "read on a PREVIOUS visit."
let notifViewThreshold = getLastSeenNotifTime();

function markNotificationsAsRead() {
    notifViewThreshold = getLastSeenNotifTime(); // snapshot BEFORE overwriting
    localStorage.setItem(NOTIF_LAST_SEEN_KEY, String(Date.now()));
    const badge = document.querySelector('.nav-badge');
    if (badge) badge.style.display = 'none';
}

function updateNotifBadge(rows) {
    const badge = document.querySelector('.nav-badge');
    if (!badge) return;
    const lastSeen = getLastSeenNotifTime();
    const unreadCount = rows.filter(r => new Date(r.recorded_at).getTime() > lastSeen).length;

    if (unreadCount > 0) {
        badge.textContent = unreadCount > 99 ? '99+' : unreadCount;
        badge.style.display = '';
    } else {
        badge.style.display = 'none';
    }
}

// ---- Tab title / favicon badge + sound (visible even on another tab) ----
// A toast is DOM content inside this one tab - if staff switch to another
// tab or app, it's invisible until they click back, no matter how it's
// styled. These three cues are the closest a browser tab can get to
// "notify me even when I'm not looking at this tab" without a real OS
// notification (which needs HTTPS or localhost - see the comment above
// notificationsSupported() below):
//   - the tab TITLE changes (visible in the tab strip/taskbar without
//     switching to it)
//   - the FAVICON gets a red dot (same idea, visible at a glance)
//   - a short SOUND plays regardless of which tab is focused, as long as
//     this tab is still open somewhere
// None of this survives the tab being closed entirely - that's the one
// thing only a real OS notification can do, and only over HTTPS/localhost.
const ORIGINAL_TITLE = document.title;
let pendingAlertCount = 0;

function setFavicon(hasAlert) {
    let link = document.querySelector('link[rel="icon"]');
    if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
    }

    if (!hasAlert) {
        // Normal state: the actual brand favicon (public/favicon.svg) -
        // swap that one file for a real logo later and this, plus every
        // other page's <link> tag, picks it up automatically.
        link.type = 'image/svg+xml';
        link.href = '/favicon.svg';
        return;
    }

    // Alert state: a small canvas-drawn red dot overlay - distinct at a
    // glance from the normal icon, cleared automatically once staff
    // return to this tab (see clearAlertBadge() above).
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext('2d');
    ctx.beginPath();
    ctx.arc(16, 16, 14, 0, Math.PI * 2);
    ctx.fillStyle = '#ff3b30';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(16, 16, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();

    link.type = 'image/png';
    link.href = canvas.toDataURL('image/png');
}

function clearAlertBadge() {
    pendingAlertCount = 0;
    document.title = ORIGINAL_TITLE;
    setFavicon(false);
}

function flagAlertBadge() {
    pendingAlertCount += 1;
    document.title = `(${pendingAlertCount}) New Alert! · ${ORIGINAL_TITLE}`;
    setFavicon(true);
}

// Clears the badge once staff actually come back to this tab - matches
// how Gmail/Slack-style unread badges behave.
document.addEventListener('visibilitychange', () => {
    if (!document.hidden && pendingAlertCount > 0) clearAlertBadge();
});

let alertAudioCtx = null;
function playAlertTone() {
    try {
        alertAudioCtx = alertAudioCtx || new (window.AudioContext || window.webkitAudioContext)();
        const ctx = alertAudioCtx;
        [0, 0.16].forEach((delay, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.value = i === 0 ? 880 : 660; // distinct two-tone from the table-status beep
            const t = ctx.currentTime + delay;
            gain.gain.setValueAtTime(0.0001, t);
            gain.gain.exponentialRampToValueAtTime(0.09, t + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(t);
            osc.stop(t + 0.18);
        });
    } catch (err) {
        // Browsers can block audio before any interaction has happened on
        // the page yet - the title/favicon badge still gets through.
    }
}

setFavicon(false);

// ---- Desktop (browser) notifications for above-limit alerts ----
// A real toggle for the OS-level Notification API, on top of the
// always-on in-page toast (showInPageToast) which remains the one path
// guaranteed to work everywhere. This toggle is grayed out/locked in two
// situations that are true browser platform limits, not bugs here:
//  1. Browsers only allow REQUESTING permission from a real click, on a
//     "secure context" (https://, or literally "localhost") - blocked
//     outright on a plain http://192.168.x.x LAN address, which is how
//     most staff/teammates actually open this dashboard.
//  2. Chrome (and others) also suppress the permission prompt entirely in
//     Incognito/Private windows by default, regardless of #1 - this is
//     deliberate browser policy, not a bug in this app, and there's no
//     code-level way around it.
// Given that, the in-page toast below (showInPageToast) is still the only
// notification path that's guaranteed to work everywhere.
//
// The switch below is LiMon's own on/off preference, kept separate from
// the browser's permission. A page can't revoke a permission the browser
// already granted (only the browser's site settings can), but it CAN
// simply stop sending notifications - so "off" here means "granted, but
// LiMon won't fire any", and the choice is remembered in localStorage.
const DESKTOP_ALERTS_PREF_KEY = 'limon-desktop-alerts-enabled';

function desktopAlertsPreferred() {
    return localStorage.getItem(DESKTOP_ALERTS_PREF_KEY) === 'true';
}

function setDesktopAlertsPreferred(on) {
    localStorage.setItem(DESKTOP_ALERTS_PREF_KEY, on ? 'true' : 'false');
}

// True only when the browser allows it AND the user has it switched on.
function desktopAlertsActive() {
    return notificationsSupported()
        && Notification.permission === 'granted'
        && desktopAlertsPreferred();
}
function notificationsSupported() {
    return 'Notification' in window;
}

function isSecureEnoughForNotifications() {
    return window.isSecureContext || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
}

function updateNotifToggle() {
    const wrap = document.getElementById('notif-toggle-wrap');
    const input = document.getElementById('notif-toggle-input');
    const label = document.getElementById('notif-toggle-label');
    if (!wrap || !input) return;

    if (!notificationsSupported()) {
        wrap.classList.add('is-disabled');
        wrap.title = 'This browser does not support desktop alerts.';
        label.textContent = 'Desktop Alerts';
        input.checked = false;
        input.disabled = true;
        return;
    }
    if (!isSecureEnoughForNotifications()) {
        wrap.classList.add('is-disabled');
        wrap.title = 'Browsers block desktop alerts on plain http:// LAN addresses. Open this dashboard as http://localhost:<port> on the machine running the server to use this.';
        label.textContent = 'Desktop Alerts';
        input.checked = false;
        input.disabled = true;
        return;
    }
    if (Notification.permission === 'denied') {
        wrap.classList.add('is-disabled');
        wrap.title = "Blocked. Re-enable from your browser's site settings (the lock/info icon in the address bar), then reload.";
        label.textContent = 'Desktop Alerts';
        input.checked = false;
        input.disabled = true;
        return;
    }

    wrap.classList.remove('is-disabled');
    input.disabled = false;
    input.checked = desktopAlertsActive();
    wrap.title = input.checked
        ? 'On. Click to turn desktop alerts off.'
        : 'Turn on to also get a real desktop notification for above-limit alerts.';
}

document.getElementById('notif-toggle-input')?.addEventListener('change', (e) => {
    const wantsOn = e.target.checked;

    if (!wantsOn) {
        setDesktopAlertsPreferred(false);
        updateNotifToggle();
        return;
    }

    if (Notification.permission === 'granted') {
        // Browser already allowed it earlier - no prompt needed.
        setDesktopAlertsPreferred(true);
        updateNotifToggle();
        return;
    }

    // Must run directly inside this click-triggered handler, not on a
    // timer or on page load, or the browser silently ignores the request.
    Notification.requestPermission().then((result) => {
        setDesktopAlertsPreferred(result === 'granted');
        updateNotifToggle();
    });
});

updateNotifToggle();

let notifBaselineTime = null; // epoch ms; used by fireDesktopAlertsForNewRows below

// ---- In-page toast (the notification method that actually works on
// every device) ----
// No browser permission needed at all - this is plain DOM/CSS, so it's
// identical on the host PC, a teammate's laptop, or a phone opened over
// the LAN, regardless of the http:// secure-context restriction above.
function showInPageToast(title, body, onClick) {
    const stack = document.getElementById('toast-stack');
    if (!stack) return;

    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `
        <div class="toast-title">${title}</div>
        <div class="toast-body">${body}</div>
    `;

    const dismiss = () => {
        el.classList.add('toast-out');
        setTimeout(() => el.remove(), 260);
    };

    el.addEventListener('click', () => {
        if (onClick) onClick();
        dismiss();
    });

    stack.appendChild(el);
    setTimeout(dismiss, 6000);
}

function fireDesktopAlertsForNewRows(rows) {
    const sorted = [...rows].sort((a, b) => new Date(a.recorded_at) - new Date(b.recorded_at));
    if (!sorted.length) return;

    if (notifBaselineTime === null) {
        // First run after page load: don't re-notify for alerts that already
        // existed before this session started, only for new ones from here on.
        notifBaselineTime = new Date(sorted[sorted.length - 1].recorded_at).getTime();
    }

    notifBaselineTime = new Date(sorted[sorted.length - 1].recorded_at).getTime();
}

async function fetchAndRenderNotifications() {
    try {
        const res = await fetch(`${API_BASE_URL}/api/notifications`);
        const rows = await res.json();

        updateNotifBadge(rows);
        fireDesktopAlertsForNewRows(rows);

        const dashboardList = document.getElementById('dashboard-recent-alerts');
        if (dashboardList) {
            dashboardList.innerHTML = rows.length
                ? rows.slice(0, 3).map(n => renderAlertRow(n)).join('')
                : '<div style="padding:16px;color:var(--label-3);font-size:13px;">No alerts yet today.</div>';
        }
    } catch (err) {
        console.error('Failed to fetch notifications', err);
    }
}
fetchAndRenderNotifications();
setInterval(fetchAndRenderNotifications, 5000);

// ===== REAL DATA: Notifications page (paginated, fixed-height list) =====
// Keeps the card from growing forever as new alerts stack up - see
// public/css/style.css .alert-list-scroll + .pagination-bar.
const NOTIF_PAGE_SIZE = 8;
let notifCurrentPage = 1;
let notifTotalPages = 1;

async function fetchAndRenderNotificationsPage(page = notifCurrentPage) {
    const fullList = document.getElementById('notifications-alert-list');
    if (!fullList) return; // only relevant on the Notifications page

    try {
        const res = await fetch(`${API_BASE_URL}/api/notifications/paged?page=${page}&pageSize=${NOTIF_PAGE_SIZE}`);
        const data = await res.json();

        notifCurrentPage = data.page;
        notifTotalPages = data.totalPages;

        fullList.innerHTML = data.rows.length
            ? data.rows.map(n => renderAlertRow(n, notifViewThreshold)).join('')
            : '<div style="padding:16px;color:var(--label-3);font-size:13px;">No alerts yet today.</div>';

        const statusEl = document.getElementById('notif-page-status');
        if (statusEl) statusEl.textContent = `Page ${notifCurrentPage} of ${notifTotalPages}`;

        const prevBtn = document.getElementById('notif-prev-btn');
        const nextBtn = document.getElementById('notif-next-btn');
        if (prevBtn) prevBtn.disabled = notifCurrentPage <= 1;
        if (nextBtn) nextBtn.disabled = notifCurrentPage >= notifTotalPages;
    } catch (err) {
        console.error('Failed to fetch notifications page', err);
    }
}

function changeNotificationsPage(delta) {
    const target = notifCurrentPage + delta;
    if (target < 1 || target > notifTotalPages) return;
    fetchAndRenderNotificationsPage(target);
}

// Keep whichever page the user is viewing fresh, without resetting them to
// page 1 - fetchAndRenderNotificationsPage() defaults to notifCurrentPage.
setInterval(() => fetchAndRenderNotificationsPage(), 8000);

// ===== REAL DATA: Summary report (pure computed stats, no AI) =====
async function fetchAndRenderSummary() {
    try {
        const res = await fetch(`${API_BASE_URL}/api/summary/today`);
        const s = await res.json();

        const set = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = (val === null || val === undefined) ? '--' : val;
        };

        const friendly = s.friendly || {};

        set('dashboard-summary-overall', friendly.overall);
        set('dashboard-summary-noise', friendly.noise);
        set('dashboard-summary-temp', friendly.temperature);
        set('dashboard-summary-alerts', s.totalAlerts);

    } catch (err) {
        console.error('Failed to fetch summary report', err);
    }
}
fetchAndRenderSummary();
setInterval(fetchAndRenderSummary, 10000);

// ===== REAL DATA: Reports page "Today's Summary" (per selected area) =====
// The dashboard summary above covers every area combined. This one follows
// the Area dropdown on the Reports page, so the labels and numbers always
// describe the same area. Occupancy is counted at the entrance, so it is
// the same no matter which area is picked.
// 'all' means no area filter (every area combined).
let reportSummaryAreaChoice = 'all';

async function fetchAndRenderReportSummary() {
    try {
        const area = reportSummaryAreaChoice;
        // No suffix when showing everything; "(Area A)" etc. only when filtered.
        const areaSuffix = area === 'all' ? '' : ` (${area})`;
        const query = area === 'all' ? '' : `?area=${encodeURIComponent(area)}`;
        const res = await fetch(`${API_BASE_URL}/api/summary/today${query}`);
        const s = await res.json();

        const set = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = (val === null || val === undefined) ? '--' : val;
        };
        const friendly = s.friendly || {};

        set('summary-noise-label', `Noise${areaSuffix}`);
        set('summary-temp-label', `Temperature${areaSuffix}`);
        set('summary-humid-label', `Humidity${areaSuffix}`);

        set('summary-noise-avg', s.noise.avg);
        set('summary-noise-min', s.noise.min);
        set('summary-noise-max', s.noise.max);
        set('summary-noise-count', s.noise.readingCount);

        set('summary-temp-avg', s.environment.avgTemp);
        set('summary-temp-min', s.environment.minTemp);
        set('summary-temp-max', s.environment.maxTemp);

        set('summary-humid-avg', s.environment.avgHumidity);
        set('summary-humid-min', s.environment.minHumidity);
        set('summary-humid-max', s.environment.maxHumidity);

        const occ = s.occupancy || {};
        set('summary-occ-current', occ.current);
        set('summary-occ-percent', occ.percentUsed);
        set('summary-occ-entered', occ.entered || 0);
        set('summary-occ-exited', occ.exited || 0);

        set('summary-alerts-total', s.totalAlerts);
        set('summary-alerts-moderate', s.alerts.moderate || 0);
        set('summary-alerts-above', s.alerts.above_limit || 0);

        if (s.friendly) {
            set('summary-overall-line', friendly.overall);
            set('summary-noise-line', friendly.noise);
            set('summary-temp-line', friendly.temperature);
            set('summary-humid-line', friendly.humidity);
            set('summary-occ-line', friendly.occupancy);
        }
    } catch (err) {
        console.error('Failed to fetch report summary', err);
    }
}
fetchAndRenderReportSummary();
setInterval(fetchAndRenderReportSummary, 10000);
document.getElementById('report-summary-area-tabs')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    reportSummaryAreaChoice = btn.dataset.area;
    document.querySelectorAll('#report-summary-area-tabs .seg-btn')
        .forEach(b => b.classList.toggle('active', b === btn));
    fetchAndRenderReportSummary();
});

// ===== Sensor log frequency (Settings card, Reports page) =====
async function fetchAndRenderSettings() {
    try {
        const res = await fetch(`${API_BASE_URL}/api/settings`);
        const data = await res.json();
        const select = document.getElementById('sensor-log-interval-select');
        if (select && data.sensor_log_interval_ms !== undefined) {
            select.value = String(data.sensor_log_interval_ms);
        }
    } catch (err) {
        console.error('Failed to fetch settings', err);
    }
}
fetchAndRenderSettings();

function wireSensorLogIntervalControl() {
    const select = document.getElementById('sensor-log-interval-select');
    const status = document.getElementById('settings-save-status');
    if (!select) return;

    select.addEventListener('change', async () => {
        const ms = parseInt(select.value, 10);
        status.textContent = 'Saving…';
        status.className = 'settings-save-status';
        try {
            const res = await fetch(`${API_BASE_URL}/api/settings/sensor-log-interval`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ sensor_log_interval_ms: ms }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                if (res.status === 401) throw new Error('Your session expired — please log in again.');
                if (res.status === 403) throw new Error('Only admin accounts can change this setting.');
                throw new Error(data.error || 'Request failed');
            }
            status.textContent = 'Saved';
            status.classList.add('saved');
            setTimeout(() => {
                status.textContent = '';
                status.className = 'settings-save-status';
            }, 2500);
        } catch (err) {
            console.error('Failed to save sensor log interval', err);
            status.textContent = err.message || 'Failed to save — is the backend running?';
            status.classList.add('error');
        }
    });
}
wireSensorLogIntervalControl();

// Keeps the dropdown in sync if the setting is changed from elsewhere
// (another open tab, or a future admin tool hitting the same endpoint).
socket.on('settings-update', (data) => {
    const select = document.getElementById('sensor-log-interval-select');
    if (select && data && data.sensor_log_interval_ms !== undefined) {
        select.value = String(data.sensor_log_interval_ms);
    }
});

// ===== Request a Report (Reports page: any single date + area, on demand) =====
// Nothing here runs until the person actually clicks Download - no polling,
// no background computation. The CSV link's href is rebuilt whenever the
// date/area changes so it's always pointed at exactly what's selected; the
// PDF is built the same way the other PDFs on this page are (fetch JSON,
// lay it out client-side with the shared PdfReport class), just from
// /api/reports/day instead of today's live summary.
function reportDayParams() {
    const date = document.getElementById('report-date-input').value;
    const area = document.getElementById('report-area-select').value;
    return { date, area };
}

function updateReportCsvLink() {
    const { date, area } = reportDayParams();
    const link = document.getElementById('report-download-csv-btn');
    if (!link || !date) return;
    link.href = `${API_BASE_URL}/api/export/day.csv?date=${date}&area=${encodeURIComponent(area)}`;
}

async function fetchReportDay(date, area) {
    const res = await fetch(`${API_BASE_URL}/api/reports/day?date=${date}&area=${encodeURIComponent(area)}`);
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    return res.json();
}

async function buildRequestedDayPdf() {
    const { date, area } = reportDayParams();
    if (!date) throw new Error('Pick a date first.');
    const data = await fetchReportDay(date, area);

    const report = new PdfReport(`${area} · ${date}`);
    report.addSectionTitle('Key Stats');

    if (!data.found) {
        report.addParagraphs([`No sensor readings were recorded for ${area} on ${date}.`]);
    } else {
        report.addStatRows([
            ['Average noise (dB)', displayOrDash(data.noise.avg)],
            ['Lowest / highest noise (dB)', `${displayOrDash(data.noise.min)} / ${displayOrDash(data.noise.max)}`],
            ['Noise readings', displayOrDash(data.noise.count)],
            ['Average temperature (°C)', displayOrDash(data.environment.avgTemp)],
            ['Lowest / highest temperature (°C)', `${displayOrDash(data.environment.minTemp)} / ${displayOrDash(data.environment.maxTemp)}`],
            ['Average humidity (%)', displayOrDash(data.environment.avgHumidity)],
            ['Lowest / highest humidity (%)', `${displayOrDash(data.environment.minHumidity)} / ${displayOrDash(data.environment.maxHumidity)}`],
            ['Environment readings', displayOrDash(data.environment.count)],
            ['Entered / exited', `${displayOrDash(data.occupancy.entered)} / ${displayOrDash(data.occupancy.exited)}`],
            ['Alerts (moderate / above limit)', `${displayOrDash(data.alerts.moderate)} / ${displayOrDash(data.alerts.above_limit)}`],
        ]);
    }

    report.save(`lemon_report_${date}_${area.replace(/\s+/g, '_')}.pdf`);
}

function initRequestReportCard() {
    const dateInput = document.getElementById('report-date-input');
    const areaSelect = document.getElementById('report-area-select');
    const pdfBtn = document.getElementById('report-download-pdf-btn');
    const status = document.getElementById('report-status-line');
    if (!dateInput) return;

    dateInput.value = todayStamp();
    dateInput.max = todayStamp(); // no reports for dates that haven't happened yet
    updateReportCsvLink();

    dateInput.addEventListener('change', updateReportCsvLink);
    areaSelect.addEventListener('change', updateReportCsvLink);

    pdfBtn.addEventListener('click', async () => {
        pdfBtn.disabled = true;
        pdfBtn.textContent = 'Generating…';
        status.textContent = '';
        try {
            await buildRequestedDayPdf();
        } catch (err) {
            console.error('Failed to build requested-day PDF', err);
            status.textContent = 'Could not generate that report. Check that the server is running.';
        } finally {
            pdfBtn.disabled = false;
            pdfBtn.textContent = 'Download PDF';
        }
    });
}
initRequestReportCard();

// ===== REAL DATA: Seed charts with today's actual history on first render =====
// The API returns every raw reading for today (potentially thousands, since
// sensors report ~once/second). Plotting each one directly would flood the
// chart and tank rendering performance, so we bucket them into one
// averaged point per minute first - matching the granularity the live
// flushNoiseChart()/flushEnvironmentCharts() functions use - and only keep
// the most recent CHART_MAX_POINTS buckets.
// Same bucketing idea used for every chart below, but keeps every area's
// readings on one shared minute timeline instead of collapsing them into
// a single series - needed for charts like noiseChart/tempChart/humidChart
// that draw one line per area. A minute where an area has no reading gets
// null for that area (a gap in its line), not a guess.
// Toggles the small "No live data" badge next to a chart's title. Accepts
// either a single series (array of numbers/nulls) or an array of series
// (one per area) - stale means EVERY series' most recent bucket is empty,
// not just one. A per-area chart with Area A offline but Area B reporting
// should NOT show this badge; only "nothing at all came in" should.
function setChartStaleBadge(badgeId, seriesOrSeriesList) {
    const el = document.getElementById(badgeId);
    if (!el) return;
    const seriesList = Array.isArray(seriesOrSeriesList[0]) || seriesOrSeriesList[0] === undefined
        ? seriesOrSeriesList
        : [seriesOrSeriesList];
    const isStale = seriesList.every(values => {
        if (!values || !values.length) return true;
        const last = values[values.length - 1];
        return last === null || last === undefined;
    });
    el.classList.toggle('show', isStale);
}

// Builds the last `maxPoints` one-minute slots ending at the current
// minute (not the last minute that happened to have data). This is what
// keeps the chart's x-axis moving in real time even while sensors are
// unplugged/offline - without it, the timeline just freezes at whatever
// minute the last real reading came in.
function buildMinuteGrid(maxPoints) {
    const now = new Date();
    now.setSeconds(0, 0);
    const keys = [];
    for (let i = maxPoints - 1; i >= 0; i--) {
        keys.push(now.getTime() - i * 60000);
    }
    return keys;
}

function bucketByMinuteMultiArea(rows, valueKey, areas) {
    const buckets = new Map(); // minute key -> { area: [values] }
    for (const row of rows) {
        if (!areas.includes(row.area)) continue;
        const d = new Date(row.recorded_at);
        d.setSeconds(0, 0);
        const key = d.getTime();
        if (!buckets.has(key)) buckets.set(key, {});
        const bucket = buckets.get(key);
        if (!bucket[row.area]) bucket[row.area] = [];
        bucket[row.area].push(Number(row[valueKey]));
    }
    const recentKeys = buildMinuteGrid(CHART_MAX_POINTS);
    const labels = recentKeys.map(k =>
        new Date(k).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' })
    );
    const seriesByArea = {};
    areas.forEach(area => {
        seriesByArea[area] = recentKeys.map(k => {
            const vals = buckets.get(k) && buckets.get(k)[area];
            return vals ? average(vals) : null;
        });
    });
    return { labels, seriesByArea };
}

async function seedNoiseChartWithReal() {
    try {
        const res = await fetch(`${API_BASE_URL}/api/noise/today`);
        const rows = await res.json();
        if (!noiseChart) return;

        const { labels, seriesByArea } = bucketByMinuteMultiArea(rows, 'noise_db', AREA_ORDER);
        noiseChart.data.labels = labels;
        AREA_ORDER.forEach((area, i) => {
            if (noiseChart.data.datasets[i]) noiseChart.data.datasets[i].data = seriesByArea[area];
        });
        noiseChart.update();
        setChartStaleBadge('noise-stale-badge', AREA_ORDER.map(area => seriesByArea[area]));
    } catch (err) {
        console.error('Failed to seed noise chart with real data', err);
    }
}

async function seedTempChartWithReal() {
    try {
        const res = await fetch(`${API_BASE_URL}/api/environment/today`);
        const rows = await res.json();

        if (tempChart) {
            const { labels, seriesByArea } = bucketByMinuteMultiArea(rows, 'temperature', AREA_ORDER);
            tempChart.data.labels = labels;
            AREA_ORDER.forEach((area, i) => {
                if (tempChart.data.datasets[i]) tempChart.data.datasets[i].data = seriesByArea[area];
            });
            tempChart.update();
            setChartStaleBadge('temp-stale-badge', AREA_ORDER.map(area => seriesByArea[area]));
        }
        if (humidChart) {
            const { labels, seriesByArea } = bucketByMinuteMultiArea(rows, 'humidity', AREA_ORDER);
            humidChart.data.labels = labels;
            AREA_ORDER.forEach((area, i) => {
                if (humidChart.data.datasets[i]) humidChart.data.datasets[i].data = seriesByArea[area];
            });
            humidChart.update();
            setChartStaleBadge('humid-stale-badge', AREA_ORDER.map(area => seriesByArea[area]));
        }
    } catch (err) {
        console.error('Failed to seed temp/humidity charts with real data', err);
    }
}

// Occupancy is a running count (IN=+1, OUT=-1), not an averaged value like
// noise/temp - so instead of averaging within each minute bucket, we take
// the ending count for that minute (the cumulative total after all events
// in that bucket have been applied).
async function seedOccupancyChartWithReal() {
    try {
        const res = await fetch(`${API_BASE_URL}/api/occupancy/today`);
        const rows = await res.json();
        if (!occChart) return;

        const sorted = [...rows].sort((a, b) => new Date(a.recorded_at) - new Date(b.recorded_at));

        let running = 0;
        const buckets = new Map(); // minute key -> running count at end of that minute
        for (const row of sorted) {
            running += row.direction === 'IN' ? 1 : -1;
            const d = new Date(row.recorded_at);
            d.setSeconds(0, 0);
            buckets.set(d.getTime(), running);
        }

        const recentKeys = buildMinuteGrid(CHART_MAX_POINTS);
        occChart.data.labels = recentKeys.map(k =>
            new Date(k).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' })
        );
        // Unlike noise/temp, a minute with no IN/OUT events isn't "no
        // reading" - it just means the count didn't change, so carry the
        // last known running total forward instead of leaving a gap.
        let lastKnown = 0;
        occChart.data.datasets[0].data = recentKeys.map(k => {
            if (buckets.has(k)) lastKnown = buckets.get(k);
            return Math.max(lastKnown, 0);
        });
        occChart.update();
    } catch (err) {
        console.error('Failed to seed occupancy chart with real data', err);
    }
}

// SIDEBAR TOGE
const sidebar = document.querySelector('.sidebar');
const menuBtn = document.getElementById('menu-btn');

function toggleSidebar() {
    sidebar.classList.toggle('collapsed');
    menuBtn.classList.toggle('open');
}

menuBtn.addEventListener('click', toggleSidebar);

// NAVI
const PAGE_TITLES = {
    dashboard: 'Dashboard',
    noise: 'Noise Levels',
    environment: 'Environment',
    occupancy: 'Occupancy',
    alerts: 'Notifications',
    reports: 'Reports',
    analytics: 'Analytics'
};

function navigate(pageId) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const page = document.getElementById('page-' + pageId);
    if (page) page.classList.add('active');

    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    const navItem = document.querySelector(`.nav-item[data-page="${pageId}"]`);
    if (navItem) navItem.classList.add('active');

    document.getElementById('topbar-title').textContent = PAGE_TITLES[pageId] || pageId;

    if (pageId === 'noise') {
        renderNoiseChart();
        seedNoiseChartWithReal();
    }
    if (pageId === 'environment') {
        renderTempChart();
        renderHumidChart();
        seedTempChartWithReal();
    }
    if (pageId === 'occupancy') {
        renderOccChart();
        renderOccGauge();
        seedOccupancyChartWithReal();
        fetchAndUpdateOccupancy();
        fetchAndRenderTableMap();
    }
    if (pageId === 'alerts') {
        markNotificationsAsRead();
        notifCurrentPage = 1;
        fetchAndRenderNotificationsPage(1);
    }
    if (pageId === 'analytics') {
        initAnalyticsPage();
    }
}

document.querySelectorAll('.nav-item[data-page]').forEach(item => {
    item.addEventListener('click', () => navigate(item.dataset.page));
});

// REAL TIME TIKTOKCLOCK
function updateClock() {
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-PH', {
        weekday: 'short',
        month: 'short',
        day: 'numeric'
    });
    const timeStr = now.toLocaleTimeString('en-PH', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });

    const liveTime = document.getElementById('live-time');
    const footerTime = document.getElementById('footer-time');

    if (liveTime) liveTime.textContent = `${dateStr}  ·  ${timeStr}`;
    if (footerTime) footerTime.textContent = 'v1.0.0 · AY 2025–2026';
}

updateClock();
setInterval(updateClock, 1000);

// CHARTJS
Chart.defaults.font.family = "'Inter', -apple-system, sans-serif";
Chart.defaults.font.size = 11;
Chart.defaults.color = 'rgba(60,60,67,0.55)';
Chart.defaults.plugins.legend.display = true;
Chart.defaults.plugins.legend.labels.boxWidth = 10;
Chart.defaults.plugins.legend.labels.boxHeight = 10;
Chart.defaults.plugins.legend.labels.borderRadius = 3;
Chart.defaults.plugins.legend.labels.useBorderRadius = true;
Chart.defaults.plugins.legend.labels.padding = 14;
Chart.defaults.plugins.tooltip.backgroundColor = 'rgba(255,255,255,0.96)';
Chart.defaults.plugins.tooltip.titleColor = '#1c1c1e';
Chart.defaults.plugins.tooltip.bodyColor = 'rgba(60,60,67,0.8)';
Chart.defaults.plugins.tooltip.borderColor = 'rgba(60,60,67,0.10)';
Chart.defaults.plugins.tooltip.borderWidth = 1;
Chart.defaults.plugins.tooltip.cornerRadius = 10;
Chart.defaults.plugins.tooltip.padding = 10;

// ===== Chart color palette =====
// Single place to customize every line/legend-dot color used across the
// dashboard's charts. Change a hex here and it updates the line, its point
// markers, its fill gradient, and its legend dot everywhere it's used.
const CHART_COLORS = {
    areaA: '#0D2148',        // navy   - primary series (noise Area A, temp Area A, humidity Area A, occupancy)
    areaB: '#2E9BF0',        // blue   - secondary series (Area B)
    temperature: '#F2A93B',  // amber  - used to contrast against noise (navy) on the dashboard trend chart
};

function hexToRgba(hex, alpha) {
    const clean = hex.replace('#', '');
    const r = parseInt(clean.substring(0, 2), 16);
    const g = parseInt(clean.substring(2, 4), 16);
    const b = parseInt(clean.substring(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}

// fake data for chartjs
const LABELS_7 = ['7AM', '8AM', '9AM', '10AM', '11AM', '12PM', '1PM', '2PM', '3PM', '4PM', '5PM'];

// dashboard trend
const trendCtx = document.getElementById('trendChart').getContext('2d');
const noiseGradient = trendCtx.createLinearGradient(0, 0, 0, 200);
noiseGradient.addColorStop(0, hexToRgba(CHART_COLORS.areaA, 0.12));
noiseGradient.addColorStop(1, hexToRgba(CHART_COLORS.areaA, 0));

const tempGradient = trendCtx.createLinearGradient(0, 0, 0, 200);
tempGradient.addColorStop(0, hexToRgba(CHART_COLORS.temperature, 0.12));
tempGradient.addColorStop(1, hexToRgba(CHART_COLORS.temperature, 0));

const trendChart = new Chart(trendCtx, {
    type: 'line',
    data: {
        labels: [],
        datasets: [
            {
                label: 'Noise (dB)',
                data: [],
                borderColor: CHART_COLORS.areaA,
                backgroundColor: noiseGradient,
                pointRadius: 3,
                pointHoverRadius: 5,
                fill: true,
                borderWidth: 2,
                pointBackgroundColor: CHART_COLORS.areaA,
                pointBorderColor: '#fff',
                pointBorderWidth: 1.5
            },
            {
                label: 'Temperature (°C)',
                data: [],
                borderColor: CHART_COLORS.temperature,
                backgroundColor: tempGradient,
                tension: 0.4,
                pointRadius: 3,
                pointHoverRadius: 5,
                fill: true,
                borderWidth: 2,
                pointBackgroundColor: CHART_COLORS.temperature,
                pointBorderColor: '#fff',
                pointBorderWidth: 1.5,
                yAxisID: 'y2',
                borderDash: [5, 3]
            }
        ]
    },
    options: {
        responsive: true,
        maintainAspectRatio: true,
        interaction: { mode: 'index', intersect: false },
        scales: {
            x: {
                grid: { color: 'rgba(60,60,67,0.06)', drawTicks: false },
                border: { display: false },
                ticks: { padding: 6 }
            },
            y: {
                grid: { color: 'rgba(60,60,67,0.06)', drawTicks: false },
                border: { display: false },
                ticks: { padding: 8 },
                title: { display: true, text: 'Noise Level (dB)', font: { size: 10 } }
            },
            y2: {
                position: 'right',
                grid: { display: false },
                border: { display: false },
                ticks: { padding: 8 },
                title: { display: true, text: 'Temperature (°C)', font: { size: 10 } }
            }
        },
        plugins: { legend: { position: 'top', align: 'end' } }
    }
});

// ===== REAL DATA: Dashboard trend chart (Today/Week tabs) =====
// Same bucketing idea as bucketByMinuteMultiArea, but collapsed to one
// combined series instead of one line per area - this chart is meant to
// read as "the whole library" at a glance, not area-by-area (that detail
// lives on the Noise/Environment pages' own per-area charts).
function bucketByMinuteCombined(rows, valueKey) {
    const buckets = new Map();
    for (const row of rows) {
        const d = new Date(row.recorded_at);
        d.setSeconds(0, 0);
        const key = d.getTime();
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(Number(row[valueKey]));
    }
    const recentKeys = buildMinuteGrid(CHART_MAX_POINTS);
    return {
        labels: recentKeys.map(k => new Date(k).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' })),
        // No rows for a minute -> null (a gap in the line), not a guess.
        // Deliberately NOT 0: 0 dB / 0°C would read as a real (and alarming)
        // measurement instead of "sensor didn't report".
        values: recentKeys.map(k => buckets.has(k) ? average(buckets.get(k)) : null)
    };
}

// Cached so switching tabs back and forth doesn't refetch/rebucket on
// every click - only the periodic refresh (today) or a cache miss (week)
// hits the network again.
let dashboardTrendTodayCache = null;
let dashboardTrendWeekCache = null;

async function seedDashboardTrendToday() {
    try {
        const [noiseRes, envRes] = await Promise.all([
            fetch(`${API_BASE_URL}/api/noise/today`),
            fetch(`${API_BASE_URL}/api/environment/today`),
        ]);
        const noiseRows = await noiseRes.json();
        const envRows = await envRes.json();

        const noiseBucketed = bucketByMinuteCombined(noiseRows, 'noise_db');
        const tempBucketed = bucketByMinuteCombined(envRows, 'temperature');
        // Both series share one x-axis. They're sampled from the same
        // real-world clock, so whichever bucketing produced more minute
        // buckets is the more complete timeline to label the axis with.
        const labels = noiseBucketed.labels.length >= tempBucketed.labels.length
            ? noiseBucketed.labels : tempBucketed.labels;

        dashboardTrendTodayCache = { labels, noiseValues: noiseBucketed.values, tempValues: tempBucketed.values, spanGaps: false };
        if (document.querySelector('.trend-tab.active')?.dataset.set !== 'week') {
            renderDashboardTrend(dashboardTrendTodayCache);
        }
    } catch (err) {
        console.error('Failed to load dashboard trend (today)', err);
    }
}

// mysql2 returns DATE columns as JS Date objects, not strings, so
// summary_date needs to be normalized before it's usable as a lookup key
// (comparing a Date to a "YYYY-MM-DD" string directly would just never
// match). Uses the Date's own local year/month/day getters rather than
// toISOString() (which is UTC) - the Philippines is UTC+8, so going
// through UTC here would shift every date back by one.
function toDateKey(value) {
    if (value instanceof Date) {
        const yyyy = value.getFullYear();
        const mm = String(value.getMonth() + 1).padStart(2, '0');
        const dd = String(value.getDate()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd}`;
    }
    return String(value).slice(0, 10); // already a string (e.g. dateStrings:true is set) - just trim any time part
}

// Week data is daily, but today's point is rolled up on demand by the server,
// so re-fetch every few minutes instead of caching forever (otherwise today's
// point stays frozen at whatever it was when the tab was first opened).
const WEEK_CACHE_TTL_MS = 5 * 60 * 1000;
let dashboardTrendWeekFetchedAt = 0;

let dashboardTrendWeekInFlight = null;

function seedDashboardTrendWeek(forceRefresh = false) {
    if (dashboardTrendWeekCache && !forceRefresh && Date.now() - dashboardTrendWeekFetchedAt < WEEK_CACHE_TTL_MS) {
        return Promise.resolve(dashboardTrendWeekCache);
    }
    // Prefetch on page load and a tab click can overlap - share one request.
    if (!dashboardTrendWeekInFlight) {
        dashboardTrendWeekInFlight = loadDashboardTrendWeek().finally(() => { dashboardTrendWeekInFlight = null; });
    }
    return dashboardTrendWeekInFlight;
}

async function loadDashboardTrendWeek() {
    try {
        const end = todayStamp();
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - 6);
        const start = toDateKey(startDate); // local date (toISOString is UTC and can be a day off in UTC+8)

        const res = await fetch(`${API_BASE_URL}/api/reports/range?start=${start}&end=${end}`);
        const data = await res.json();

        // daily_summary has one row per area per day - average across
        // whichever areas reported that day into a single combined point,
        // same idea as bucketByMinuteCombined above but at day granularity.
        const byDate = {};
        (data.days || []).forEach(row => {
            const dateKey = toDateKey(row.summary_date);
            if (!byDate[dateKey]) byDate[dateKey] = { noise: [], temp: [] };
            if (row.avg_noise_db !== null && row.avg_noise_db !== undefined) byDate[dateKey].noise.push(Number(row.avg_noise_db));
            if (row.avg_temperature !== null && row.avg_temperature !== undefined) byDate[dateKey].temp.push(Number(row.avg_temperature));
        });

        const todayLocal = toDateKey(new Date());
        const dateKeys = [];
        for (let d = new Date(startDate); toDateKey(d) <= todayLocal; d.setDate(d.getDate() + 1)) {
            dateKeys.push(toDateKey(d));
        }

        // "Thu 24" rather than just "Thu" - the window is a rolling 7 days, so on a Monday the
        // first point is last week's Tuesday and a bare weekday name is ambiguous.
        const labels = dateKeys.map(k => {
            const d = new Date(`${k}T00:00:00`);
            return `${d.toLocaleDateString('en-PH', { weekday: 'short' })} ${d.getDate()}`;
        });
        const noiseValues = dateKeys.map(k => (byDate[k] && byDate[k].noise.length) ? average(byDate[k].noise) : null);
        const tempValues = dateKeys.map(k => (byDate[k] && byDate[k].temp.length) ? average(byDate[k].temp) : null);

        // spanGaps: a day with no rolled-up data shouldn't break the line into
        // isolated dots - connect across it. (Not used for the Today view, where
        // a gap means the sensor really was offline.)
        dashboardTrendWeekCache = { labels, noiseValues, tempValues, spanGaps: true };
        dashboardTrendWeekFetchedAt = Date.now();
        return dashboardTrendWeekCache;
    } catch (err) {
        console.error('Failed to load dashboard trend (week)', err);
        return dashboardTrendWeekCache; // stale copy (or null) is better than a blank chart
    }
}

function clearDashboardTrend() {
    trendChart.data.labels = [];
    trendChart.data.datasets[0].data = [];
    trendChart.data.datasets[1].data = [];
    trendChart.update();
    document.getElementById('trend-stale-badge')?.classList.remove('show'); // "no data yet" while loading isn't a stale sensor
}

function renderDashboardTrend(bucketed) {
    if (!bucketed) return;
    trendChart.data.labels = bucketed.labels;
    trendChart.data.datasets[0].data = bucketed.noiseValues;
    trendChart.data.datasets[1].data = bucketed.tempValues;
    trendChart.data.datasets[0].spanGaps = !!bucketed.spanGaps;
    trendChart.data.datasets[1].spanGaps = !!bucketed.spanGaps;
    trendChart.update();
    setChartStaleBadge('trend-stale-badge', bucketed.noiseValues);
}

seedDashboardTrendToday();
// Warm the Week data in the background so the tab is (usually) instant when
// clicked. Nothing is rendered here - the Today tab stays on screen.
seedDashboardTrendWeek();
// Today's chart is live, so keep it refreshed at the same 1-minute
// granularity the buckets themselves use. The Week tab is daily
// granularity and only changes once a day (after the nightly rollup), so
// it doesn't need this - see the cache in seedDashboardTrendWeek().
setInterval(seedDashboardTrendToday, 60000);

document.querySelectorAll('.trend-tab').forEach(btn => {
    btn.addEventListener('click', async () => {
        document.querySelectorAll('.trend-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        if (btn.dataset.set === 'week') {
            // Never leave Today's data sitting under the Week tab while the
            // request is in flight: show the cached week right away if we
            // have one, otherwise blank the chart until the data arrives.
            if (dashboardTrendWeekCache) renderDashboardTrend(dashboardTrendWeekCache);
            else clearDashboardTrend();

            const week = await seedDashboardTrendWeek();
            // The person may have switched back to Today while we waited.
            if (document.querySelector('.trend-tab.active')?.dataset.set === 'week') {
                renderDashboardTrend(week);
            }
        } else {
            renderDashboardTrend(dashboardTrendTodayCache);
        }
    });
});

// noise chart trend
let noiseChart = null;

function renderNoiseChart() {
    if (noiseChart) return;

    const ctx = document.getElementById('noiseChart').getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 0, 180);
    gradient.addColorStop(0, hexToRgba(CHART_COLORS.areaA, 0.12));
    gradient.addColorStop(1, hexToRgba(CHART_COLORS.areaA, 0));

    noiseChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                {
                    label: 'Area A',
                    data: [],
                    borderColor: CHART_COLORS.areaA,
                    backgroundColor: gradient,
                    tension: 0.4,
                    fill: true,
                    borderWidth: 2,
                    pointRadius: 3,
                    pointHoverRadius: 5,
                    pointBackgroundColor: CHART_COLORS.areaA,
                    pointBorderColor: '#fff',
                    pointBorderWidth: 1.5
                },
                {
                    label: 'Area B',
                    data: [],
                    borderColor: CHART_COLORS.areaB,
                    backgroundColor: hexToRgba(CHART_COLORS.areaB, 0.06),
                    tension: 0.4,
                    fill: true,
                    borderWidth: 2,
                    pointRadius: 3,
                    pointHoverRadius: 5,
                    pointBackgroundColor: CHART_COLORS.areaB,
                    pointBorderColor: '#fff',
                    pointBorderWidth: 1.5
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            interaction: { mode: 'index', intersect: false },
            scales: {
                x: {
                    grid: { color: 'rgba(60,60,67,0.06)', drawTicks: false },
                    border: { display: false },
                    ticks: { padding: 6 }
                },
                y: {
                    grid: { color: 'rgba(60,60,67,0.06)', drawTicks: false },
                    border: { display: false },
                    ticks: { padding: 8 },
                    title: { display: true, text: 'dB', font: { size: 10 } }
                }
            },
            plugins: { legend: { position: 'top', align: 'end' } }
        }
    });
}

// temp chart trend
let tempChart = null;

function renderTempChart() {
    if (tempChart) return;

    const ctx = document.getElementById('tempChart').getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 0, 180);
    gradient.addColorStop(0, hexToRgba(CHART_COLORS.areaA, 0.12));
    gradient.addColorStop(1, hexToRgba(CHART_COLORS.areaA, 0));

    tempChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                {
                    label: 'Area A',
                    data: [],
                    borderColor: CHART_COLORS.areaA,
                    backgroundColor: gradient,
                    tension: 0.4,
                    fill: true,
                    borderWidth: 2,
                    pointRadius: 3,
                    pointHoverRadius: 5,
                    pointBackgroundColor: CHART_COLORS.areaA,
                    pointBorderColor: '#fff',
                    pointBorderWidth: 1.5
                },
                {
                    label: 'Area B',
                    data: [],
                    borderColor: CHART_COLORS.areaB,
                    backgroundColor: hexToRgba(CHART_COLORS.areaB, 0.05),
                    tension: 0.4,
                    fill: true,
                    borderWidth: 2,
                    pointRadius: 3,
                    pointHoverRadius: 5,
                    pointBackgroundColor: CHART_COLORS.areaB,
                    pointBorderColor: '#fff',
                    pointBorderWidth: 1.5
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            interaction: { mode: 'index', intersect: false },
            scales: {
                x: {
                    grid: { color: 'rgba(60,60,67,0.06)', drawTicks: false },
                    border: { display: false },
                    ticks: { padding: 6 }
                },
                y: {
                    grid: { color: 'rgba(60,60,67,0.06)', drawTicks: false },
                    border: { display: false },
                    ticks: { padding: 8 },
                    title: { display: true, text: '°C', font: { size: 10 } }
                }
            },
            plugins: { legend: { position: 'top', align: 'end' } }
        }
    });
}

// humid chart trend
let humidChart = null;

function renderHumidChart() {
    if (humidChart) return;

    const ctx = document.getElementById('humidChart').getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 0, 180);
    gradient.addColorStop(0, hexToRgba(CHART_COLORS.areaA, 0.10));
    gradient.addColorStop(1, hexToRgba(CHART_COLORS.areaA, 0));

    humidChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                {
                    label: 'Area A',
                    data: [],
                    borderColor: CHART_COLORS.areaA,
                    backgroundColor: gradient,
                    tension: 0.4,
                    fill: true,
                    borderWidth: 2,
                    pointRadius: 3,
                    pointHoverRadius: 5,
                    pointBackgroundColor: CHART_COLORS.areaA,
                    pointBorderColor: '#fff',
                    pointBorderWidth: 1.5
                },
                {
                    label: 'Area B',
                    data: [],
                    borderColor: CHART_COLORS.areaB,
                    backgroundColor: hexToRgba(CHART_COLORS.areaB, 0.05),
                    tension: 0.4,
                    fill: true,
                    borderWidth: 2,
                    pointRadius: 3,
                    pointHoverRadius: 5,
                    pointBackgroundColor: CHART_COLORS.areaB,
                    pointBorderColor: '#fff',
                    pointBorderWidth: 1.5
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            interaction: { mode: 'index', intersect: false },
            scales: {
                x: {
                    grid: { color: 'rgba(60,60,67,0.06)', drawTicks: false },
                    border: { display: false },
                    ticks: { padding: 6 }
                },
                y: {
                    grid: { color: 'rgba(60,60,67,0.06)', drawTicks: false },
                    border: { display: false },
                    ticks: { padding: 8 },
                    title: { display: true, text: '%', font: { size: 10 } }
                }
            },
            plugins: { legend: { position: 'top', align: 'end' } }
        }
    });
}

// occupancy chart trend
let occChart = null;

function renderOccChart() {
    if (occChart) return;

    const ctx = document.getElementById('occChart').getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 0, 200);
    gradient.addColorStop(0, hexToRgba(CHART_COLORS.areaA, 0.13));
    gradient.addColorStop(1, hexToRgba(CHART_COLORS.areaA, 0));

    occChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                {
                    label: 'People Inside',
                    data: [],
                    borderColor: CHART_COLORS.areaA,
                    backgroundColor: gradient,
                    tension: 0.4,
                    fill: true,
                    borderWidth: 2.5,
                    pointRadius: 3,
                    pointHoverRadius: 5,
                    pointBackgroundColor: CHART_COLORS.areaA,
                    pointBorderColor: '#fff',
                    pointBorderWidth: 1.5
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            interaction: { mode: 'index', intersect: false },
            scales: {
                x: {
                    grid: { color: 'rgba(60,60,67,0.06)', drawTicks: false },
                    border: { display: false },
                    ticks: { padding: 6 }
                },
                y: {
                    grid: { color: 'rgba(60,60,67,0.06)', drawTicks: false },
                    border: { display: false },
                    ticks: { padding: 8 },
                    // suggestedMax (not a hard max) so the axis still
                    // starts at 60 for a normal day, but auto-extends if a
                    // reading ever comes in above capacity instead of
                    // silently clipping those points off the top of the
                    // chart where they can't be seen at all.
                    suggestedMax: 60,
                    title: { display: true, text: 'People', font: { size: 10 } }
                }
            },
            plugins: { legend: { display: false } }
        }
    });
}

// circowl chart for occ
function createGaugeChart(canvasId, current, max) {
    const ctx = document.getElementById(canvasId).getContext('2d');
    // Clamp to 1 - if a reading ever comes in above capacity, the "empty"
    // slice would otherwise go negative, which a doughnut chart can't draw
    // (it either breaks or silently renders as a full/empty circle).
    const percentage = Math.min(current / max, 1);

    return new Chart(ctx, {
        type: 'doughnut',
        data: {
            datasets: [{
                data: [percentage, 1 - percentage],
                backgroundColor: ['rgba(13,33,72,0.85)', 'rgba(60,60,67,0.08)'],
                borderWidth: 0,
                hoverOffset: 0
            }]
        },
        options: {
            responsive: false,
            cutout: '74%',
            rotation: -90,
            circumference: 360,
            animation: { animateRotate: true, duration: 800, easing: 'easeOutQuart' },
            plugins: { legend: { display: false }, tooltip: { enabled: false } }
        }
    });
}

let dashGaugeChart = createGaugeChart('gaugeChartDash', 37, 60);

let occGaugeChart = null;

function renderOccGauge() {
    if (occGaugeChart) return;
    occGaugeChart = createGaugeChart('gaugeChartOcc', 37, 60);
}

// Sparklines for ui cards
function createSparkline(canvasId, data) {
    const ctx = document.getElementById(canvasId).getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 0, 40);
    gradient.addColorStop(0, 'rgba(13,33,72,0.10)');
    gradient.addColorStop(1, 'rgba(13,33,72,0)');

    return new Chart(ctx, {
        type: 'line',
        data: {
            labels: data.map((_, i) => i),
            datasets: [{
                data,
                borderColor: 'rgba(13,33,72,0.45)',
                backgroundColor: gradient,
                borderWidth: 1.6,
                tension: 0.4,
                fill: true,
                pointRadius: 0,
                pointHoverRadius: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 600, easing: 'easeOutQuart' },
            plugins: { legend: { display: false }, tooltip: { enabled: false } },
            scales: {
                x: { display: false },
                y: { display: false }
            },
            layout: { padding: 0 }
        }
    });
}

const sparkNoiseChart = createSparkline('spark-noise', []);
const sparkTempChart = createSparkline('spark-temp', []);
const sparkHumidChart = createSparkline('spark-humid', []);
const sparkOccChart = createSparkline('spark-occ', []);

const SPARK_HISTORY_LEN = 15;
let sparkNoiseHistory = [];
let sparkTempHistory = [];
let sparkHumidHistory = [];
let sparkOccHistory = [];

function renderSparkline(chart, history) {
    chart.data.labels = history.map((_, i) => i);
    chart.data.datasets[0].data = history;
    chart.update();
}

function pushSparkPoint(chart, history, value) {
    if (value === null || value === undefined || Number.isNaN(value)) return;
    history.push(value);
    while (history.length > SPARK_HISTORY_LEN) history.shift();
    renderSparkline(chart, history);
}

// Seed all four sparklines with real recent history right away, instead
// of waiting a full minute for the first live flush to arrive. Reuses the
// same combined (all-areas) buckets the dashboard trend chart computes.
async function seedSparklines() {
    try {
        const [noiseRes, envRes, occRes] = await Promise.all([
            fetch(`${API_BASE_URL}/api/noise/today`),
            fetch(`${API_BASE_URL}/api/environment/today`),
            fetch(`${API_BASE_URL}/api/occupancy/today`),
        ]);
        const noiseRows = await noiseRes.json();
        const envRows = await envRes.json();
        const occRows = await occRes.json();

        if (noiseRows.length) {
            const { values } = bucketByMinuteCombined(noiseRows, 'noise_db');
            sparkNoiseHistory = values.filter(v => v !== null).slice(-SPARK_HISTORY_LEN);
            renderSparkline(sparkNoiseChart, sparkNoiseHistory);
        }
        if (envRows.length) {
            sparkTempHistory = bucketByMinuteCombined(envRows, 'temperature').values.filter(v => v !== null).slice(-SPARK_HISTORY_LEN);
            sparkHumidHistory = bucketByMinuteCombined(envRows, 'humidity').values.filter(v => v !== null).slice(-SPARK_HISTORY_LEN);
            renderSparkline(sparkTempChart, sparkTempHistory);
            renderSparkline(sparkHumidChart, sparkHumidHistory);
        }
        if (occRows.length) {
            const sorted = [...occRows].sort((a, b) => new Date(a.recorded_at) - new Date(b.recorded_at));
            let running = 0;
            const points = sorted.map(row => {
                running += row.direction === 'IN' ? 1 : -1;
                return Math.max(running, 0);
            });
            sparkOccHistory = points.slice(-SPARK_HISTORY_LEN);
            renderSparkline(sparkOccChart, sparkOccHistory);
        }
    } catch (err) {
        console.error('Failed to seed sparklines with real data', err);
    }
}
seedSparklines();


// initialized icon by lucide
function initializeLucideIcons() {
    if (typeof lucide !== 'undefined') {
        lucide.createIcons();
        console.log('✓ Lucide icons initialized');
        return true;
    }
    return false;
}

if (!initializeLucideIcons()) {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeLucideIcons);
    } else {
        setTimeout(initializeLucideIcons, 100);
    }
}

socket.on('notification-confirmed', (data) => {
    fetchAndRenderNotifications();
    fetchAndRenderNotificationsPage();

    if (data.type !== 'NOISE') return;

    // Universal path: works on every device, no permission needed. Also
    // flags the tab title/favicon and plays a sound if this tab isn't
    // currently focused - the closest a browser tab can get to "notify me
    // even when I'm on another tab" without an OS-level notification.
    showInPageToast('Noise Exceeds its Limit', `${data.message} · ${data.area} Sensor`, () => navigate('alerts'));
    playAlertTone();
    if (document.hidden) flagAlertBadge();

    // Bonus path: fires an actual OS-level notification too, but only if
    // the browser allows it AND the Desktop Alerts switch is on.
    if (!desktopAlertsActive()) return;

    const toast = new Notification('Notification: Noise Exceeds its Limit', {
        body: `${data.message} · ${data.area} Sensor`,
        tag: `${data.area}-${data.type}-${Date.now()}`,
    });

    toast.onclick = () => {
        window.focus();
        navigate('alerts');
        toast.close();
    };
});

// ===== PDF Report Export =====
// Builds polished PDFs entirely in the browser: pulls today's computed
// stats from the API, then grabs the already-rendered Chart.js canvases as
// PNGs (chart.toBase64Image()) and drops them into the document. No
// server-side rendering (Puppeteer etc.) needed since the charts already
// exist client-side. `PdfReport` below is the shared layout engine so the
// full report and the per-page (Noise/Environment/Occupancy/Notifications)
// reports all look like the same document family instead of five one-offs.

// jsPDF only ships Helvetica/Times/Courier - there's no way to pull in the
// app's actual "Inter" web font without pre-converting a font file into
// jsPDF's own format ahead of time (a build step, not something to fetch
// live). Helvetica is the closest built-in match to a plain business
// document.
//
// Deliberately plain/black-and-white: no brand color, no accent bars,
// no shaded/zebra rows. Just black text, one gray for secondary text,
// and thin gray rules - the kind of formatting a printed report or a
// Word-exported document would use, not a colorful app screenshot.
const PDF_THEME = {
    ink: [20, 20, 22],
    muted: [96, 96, 100],
    rule: [200, 200, 204],
    footer: [140, 140, 144],
};

function displayOrDash(value) {
    return (value === null || value === undefined || value === '') ? '--' : value;
}

function waitFrame() {
    return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

// Captures a chart as a PNG for embedding in a PDF, by rendering it into a
// brand-new, throwaway Chart.js instance rather than resizing/toggling the
// live on-screen chart in place.
//
// Why not just resize the live chart and resize it back (the previous
// approach)? Every noise/temp/humidity/occupancy chart lives on its own
// page, and this app hides inactive pages with `display:none` (see .page
// in style.css) - but every PDF button lives on the Reports page, so
// whichever chart is being captured is almost always sitting in a hidden
// container at that exact moment. Chart.js's parameterless resize()
// measures the container's on-screen size to restore it afterward, and a
// display:none container measures as 0x0 - permanently wrecking the live
// chart's internal size after the very first capture. That matches the
// reported bug exactly: the first PDF's chart renders fine, every one
// after it comes out blank, because the "restore" step corrupted it.
//
// Rendering into a separate, temporary canvas sidesteps this completely:
// it's positioned off-screen (NOT display:none, so the browser still gives
// it a real, measurable layout size, which Chart.js needs to render at
// all) and is destroyed immediately after, so it can never leave the real,
// visible chart in a bad state, no matter how many reports get generated
// in a row or which page happens to be active at the time.
async function captureChartImage(chart, width = 900, height = 440, onlyIndexes = null) {
    if (!chart) return null;

    const host = document.createElement('div');
    host.style.position = 'fixed';
    host.style.top = '0';
    host.style.left = '-99999px';
    host.style.width = `${width}px`;
    host.style.height = `${height}px`;
    document.body.appendChild(host);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    host.appendChild(canvas);

    let tempChart = null;
    try {
        // Only the requested datasets (e.g. just Area A) go into the temp
        // chart at all, rather than including everything and hiding some -
        // that also means the legend only lists what's actually shown.
        const datasets = chart.data.datasets
            .map((ds) => ({ ...ds, data: [...ds.data] }))
            .filter((_, i) => !onlyIndexes || onlyIndexes.includes(i));

        tempChart = new Chart(canvas.getContext('2d'), {
            type: chart.config.type,
            data: {
                labels: [...chart.data.labels],
                datasets,
            },
            options: {
                ...chart.options,
                responsive: false,
                maintainAspectRatio: false,
                animation: false,
                plugins: { ...chart.options.plugins, legend: { position: 'top', align: 'end' } },
            },
        });

        await waitFrame();
        return tempChart.toBase64Image('image/png', 1);
    } finally {
        if (tempChart) tempChart.destroy();
        document.body.removeChild(host);
    }
}

class PdfReport {
    constructor(subtitle) {
        if (!window.jspdf) throw new Error('jsPDF failed to load');
        const { jsPDF } = window.jspdf;
        this.doc = new jsPDF({ unit: 'pt', format: 'a4' });
        this.pageWidth = this.doc.internal.pageSize.getWidth();
        this.pageHeight = this.doc.internal.pageSize.getHeight();
        this.margin = 48;
        this.y = this.margin;
        this._drawHeader(subtitle);
    }

    _drawHeader(subtitle) {
        const { doc, margin, pageWidth } = this;

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(16);
        doc.setTextColor(...PDF_THEME.ink);
        doc.text('Lemon Library Monitoring System', margin, margin + 14);

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10.5);
        doc.setTextColor(...PDF_THEME.muted);
        doc.text(subtitle, margin, margin + 30);

        doc.setFontSize(9);
        doc.setTextColor(...PDF_THEME.footer);
        const stamp = `Generated ${new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' })} (PHT)`;
        doc.text(stamp, pageWidth - margin, margin + 14, { align: 'right' });

        doc.setDrawColor(...PDF_THEME.rule);
        doc.setLineWidth(0.75);
        doc.line(margin, margin + 42, pageWidth - margin, margin + 42);

        this.y = margin + 64;
    }

    ensureSpace(height) {
        if (this.y + height > this.pageHeight - this.margin - 22) {
            this.doc.addPage();
            this.y = this.margin;
        }
    }

    addSectionTitle(text) {
        this.ensureSpace(24);
        const { doc, margin } = this;
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11.5);
        doc.setTextColor(...PDF_THEME.ink);
        doc.text(text.toUpperCase(), margin, this.y);
        this.y += 18;
    }

    addParagraphs(lines) {
        const { doc, margin, pageWidth } = this;
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10.5);
        doc.setTextColor(...PDF_THEME.ink);
        lines.filter(Boolean).forEach(line => {
            const wrapped = doc.splitTextToSize(line, pageWidth - margin * 2);
            this.ensureSpace(wrapped.length * 14 + 6);
            doc.text(wrapped, margin, this.y);
            this.y += wrapped.length * 14 + 6;
        });
        this.y += 6;
    }

    addStatRows(rows) {
        const { doc, margin, pageWidth } = this;
        this.ensureSpace(rows.length * 18 + 10);
        doc.setFontSize(10);
        rows.forEach(([label, value]) => {
            doc.setFont('helvetica', 'normal');
            doc.setTextColor(...PDF_THEME.muted);
            doc.text(label, margin, this.y);
            doc.setFont('helvetica', 'bold');
            doc.setTextColor(...PDF_THEME.ink);
            doc.text(String(displayOrDash(value)), pageWidth - margin, this.y, { align: 'right' });
            this.y += 18;
        });
        this.y += 10;
    }

    async addChart(chart, title, onlyIndexes = null) {
        if (!chart) return;
        const img = await captureChartImage(chart, 900, 440, onlyIndexes);
        if (!img) return;

        const imgWidth = this.pageWidth - this.margin * 2;
        const imgHeight = imgWidth * (440 / 900);

        this.ensureSpace(imgHeight + 40);
        const { doc, margin } = this;

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10.5);
        doc.setTextColor(...PDF_THEME.ink);
        doc.text(title, margin, this.y);
        this.y += 10;

        doc.setDrawColor(...PDF_THEME.rule);
        doc.setLineWidth(0.5);
        doc.rect(margin, this.y, imgWidth, imgHeight);
        doc.addImage(img, 'PNG', margin, this.y, imgWidth, imgHeight);
        this.y += imgHeight + 22;
    }

    save(filename) {
        const { doc, pageWidth, pageHeight } = this;
        const pageCount = doc.internal.getNumberOfPages();
        for (let p = 1; p <= pageCount; p++) {
            doc.setPage(p);
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(8.5);
            doc.setTextColor(...PDF_THEME.footer);
            doc.text(`Page ${p} of ${pageCount}`, pageWidth / 2, pageHeight - 20, { align: 'center' });
        }
        doc.save(filename);
    }
}

async function fetchSummary(area = 'all') {
    const query = area === 'all' ? '' : `?area=${encodeURIComponent(area)}`;
    const res = await fetch(`${API_BASE_URL}/api/summary/today${query}`);
    return res.json();
}

async function fetchOccupancySnapshot() {
    const res = await fetch(`${API_BASE_URL}/api/occupancy/current`);
    return res.json();
}

async function fetchNotificationsToday() {
    const res = await fetch(`${API_BASE_URL}/api/notifications`);
    return res.json();
}

function todayStamp() {
    return toDateKey(new Date()); // local date, not UTC (see toDateKey)
}

// ---- Full report (Reports page) ----
// This is the report behind the "Download Full PDF" button, which sits
// directly under the Today's Summary area tabs - so it needs to follow
// reportSummaryAreaChoice exactly like the on-screen summary does.
// Occupancy is counted at the entrance (not per-area), so its chart and
// stats stay combined regardless of which area is selected.
async function buildFullReportPdf() {
    renderNoiseChart();
    renderTempChart();
    renderHumidChart();
    renderOccChart();

    const area = reportSummaryAreaChoice;
    const [summary] = await Promise.all([
        fetchSummary(area),
        seedNoiseChartWithReal(),
        seedTempChartWithReal(),
        seedOccupancyChartWithReal(),
    ]);
    const friendly = summary.friendly || {};
    const areaLabel = area === 'all' ? 'Area A / B' : area;
    const onlyIndexes = area === 'all' ? null : [AREA_ORDER.indexOf(area)];

    const report = new PdfReport(`Daily Report${area === 'all' ? '' : ` · ${area}`} · ${summary.date || todayStamp()}`);

    report.addSectionTitle('Summary');
    report.addParagraphs([friendly.overall, friendly.noise, friendly.temperature, friendly.humidity, friendly.occupancy]);

    report.addSectionTitle('Key Stats');
    report.addStatRows([
        ['Noise (avg / min / max)', `${displayOrDash(summary.noise.avg)} / ${displayOrDash(summary.noise.min)} / ${displayOrDash(summary.noise.max)} dB`],
        ['Temperature (avg / min / max)', `${displayOrDash(summary.environment.avgTemp)} / ${displayOrDash(summary.environment.minTemp)} / ${displayOrDash(summary.environment.maxTemp)} °C`],
        ['Humidity (avg / min / max)', `${displayOrDash(summary.environment.avgHumidity)} / ${displayOrDash(summary.environment.minHumidity)} / ${displayOrDash(summary.environment.maxHumidity)} %`],
        ['Occupancy (current / capacity)', `${displayOrDash(summary.occupancy?.current)} / ${displayOrDash(summary.occupancy?.max)} (${displayOrDash(summary.occupancy?.percentUsed)}%)`],
        ['Occupancy (entries / exits today)', `${displayOrDash(summary.occupancy?.entered)} / ${displayOrDash(summary.occupancy?.exited)}`],
        ['Total alerts today', `${summary.totalAlerts} (moderate: ${summary.alerts.moderate || 0}, above limit: ${summary.alerts.above_limit || 0})`],
    ]);

    report.addSectionTitle('Charts');
    await report.addChart(noiseChart, `Noise Levels — ${areaLabel}`, onlyIndexes);
    await report.addChart(tempChart, `Temperature — ${areaLabel}`, onlyIndexes);
    await report.addChart(humidChart, `Humidity — ${areaLabel}`, onlyIndexes);
    await report.addChart(occChart, 'Occupancy');

    const fileSuffix = area === 'all' ? '' : `_${area.replace(/\s+/g, '').toLowerCase()}`;
    report.save(`lemon_daily_report${fileSuffix}_${summary.date || todayStamp()}.pdf`);
}

// ---- Noise-only report ----
// Follows reportSummaryAreaChoice (the same Area tabs used by the
// on-screen Today's Summary), so the report you download matches whatever
// you had selected - "all" gives the combined view with both area lines,
// picking one area filters the stats AND shows just that area's line.
async function buildNoisePdf() {
    renderNoiseChart();
    const area = reportSummaryAreaChoice;
    const [summary] = await Promise.all([fetchSummary(area), seedNoiseChartWithReal()]);

    const areaLabel = area === 'all' ? 'Area A / B' : area;
    const report = new PdfReport(`Noise Report${area === 'all' ? '' : ` · ${area}`} · ${summary.date || todayStamp()}`);
    report.addSectionTitle('Summary');
    report.addParagraphs([summary.friendly && summary.friendly.noise]);

    report.addSectionTitle('Key Stats');
    report.addStatRows([
        ['Average noise (dB)', displayOrDash(summary.noise.avg)],
        ['Lowest noise (dB)', displayOrDash(summary.noise.min)],
        ['Highest noise (dB)', displayOrDash(summary.noise.max)],
        ['Readings today', displayOrDash(summary.noise.readingCount)],
    ]);

    report.addSectionTitle('Noise Levels');
    const onlyIndexes = area === 'all' ? null : [AREA_ORDER.indexOf(area)];
    await report.addChart(noiseChart, `${areaLabel} — Today`, onlyIndexes);

    const fileSuffix = area === 'all' ? '' : `_${area.replace(/\s+/g, '').toLowerCase()}`;
    report.save(`lemon_noise_report${fileSuffix}_${summary.date || todayStamp()}.pdf`);
}

// ---- Environment-only report (temperature + humidity) ----
async function buildEnvironmentPdf() {
    renderTempChart();
    renderHumidChart();
    const area = reportSummaryAreaChoice;
    const [summary] = await Promise.all([fetchSummary(area), seedTempChartWithReal()]);

    const areaLabel = area === 'all' ? 'Area A / B' : area;
    const report = new PdfReport(`Environment Report${area === 'all' ? '' : ` · ${area}`} · ${summary.date || todayStamp()}`);
    report.addSectionTitle('Summary');
    report.addParagraphs([summary.friendly && summary.friendly.temperature]);

    report.addSectionTitle('Key Stats');
    report.addStatRows([
        ['Average temperature (°C)', displayOrDash(summary.environment.avgTemp)],
        ['Lowest / highest temperature (°C)', `${displayOrDash(summary.environment.minTemp)} / ${displayOrDash(summary.environment.maxTemp)}`],
        ['Average humidity (%)', displayOrDash(summary.environment.avgHumidity)],
        ['Lowest / highest humidity (%)', `${displayOrDash(summary.environment.minHumidity)} / ${displayOrDash(summary.environment.maxHumidity)}`],
        ['Readings today', displayOrDash(summary.environment.readingCount)],
    ]);

    report.addSectionTitle('Charts');
    const onlyIndexes = area === 'all' ? null : [AREA_ORDER.indexOf(area)];
    await report.addChart(tempChart, `Temperature — ${areaLabel}`, onlyIndexes);
    await report.addChart(humidChart, `Humidity — ${areaLabel}`, onlyIndexes);

    const fileSuffix = area === 'all' ? '' : `_${area.replace(/\s+/g, '').toLowerCase()}`;
    report.save(`lemon_environment_report${fileSuffix}_${summary.date || todayStamp()}.pdf`);
}

// ---- Occupancy-only report ----
async function buildOccupancyPdf() {
    renderOccChart();
    const [snapshot] = await Promise.all([fetchOccupancySnapshot(), seedOccupancyChartWithReal()]);

    const report = new PdfReport(`Occupancy Report · ${todayStamp()}`);
    report.addSectionTitle('Key Stats');
    report.addStatRows([
        ['Current occupancy', `${displayOrDash(snapshot.current)} / ${displayOrDash(snapshot.max)} max`],
        ['Capacity used', `${displayOrDash(snapshot.percentUsed)}%`],
        ['Entered today', displayOrDash(snapshot.entered)],
        ['Exited today', displayOrDash(snapshot.exited)],
    ]);

    report.addSectionTitle('Occupancy Over Time');
    await report.addChart(occChart, 'People Inside — Today');

    report.save(`lemon_occupancy_report_${todayStamp()}.pdf`);
}

// ---- Notifications-only report (table, no chart) ----
async function buildNotificationsPdf() {
    const notifications = await fetchNotificationsToday();

    const report = new PdfReport(`Notifications Report · ${todayStamp()}`);
    report.addSectionTitle(`Today's Notifications (${notifications.length})`);

    if (!notifications.length) {
        report.addParagraphs(['No notifications recorded yet today.']);
    } else {
        report.addStatRows(
            notifications.map(n => [
                `${n.area} · ${n.type} · ${new Date(n.recorded_at).toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit' })}`,
                `${n.severity}${n.message ? ' — ' + n.message : ''}`,
            ])
        );
    }

    report.save(`lemon_notifications_report_${todayStamp()}.pdf`);
}

// Wires a header/report button to a PDF-building function, with a shared
// disabled/"Generating…" state and error handling so each button doesn't
// need to repeat this boilerplate.
function wirePdfButton(btnId, buildFn, idleLabel) {
    const btn = document.getElementById(btnId);
    if (!btn) return;

    btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'Generating…';
        try {
            await buildFn();
        } catch (err) {
            console.error(`Failed to generate PDF (${btnId})`, err);
            alert('Could not generate the PDF. Check the console for details.');
        } finally {
            btn.disabled = false;
            btn.textContent = idleLabel;
        }
    });
}

wirePdfButton('download-pdf-report-btn', buildFullReportPdf, 'Download Full PDF');
wirePdfButton('download-noise-pdf-btn', buildNoisePdf, 'Download PDF');
wirePdfButton('download-environment-pdf-btn', buildEnvironmentPdf, 'Download PDF');
wirePdfButton('download-occupancy-pdf-btn', buildOccupancyPdf, 'Download PDF');
wirePdfButton('download-notifications-pdf-btn', buildNotificationsPdf, 'Download PDF');
// ==================== CORRELATION ANALYTICS ====================
// Fetches Pearson correlation results from /api/analytics/correlation and
// renders one card per variable pair. Default date range is the last 7
// days so there's a reasonable chance of having enough hourly buckets even
// early in the project, before falling back to "not enough data" cards.

let analyticsInitialized = false;

function formatDateInput(d) {
    return toDateKey(d); // local date, not UTC
}

function initAnalyticsPage() {
    const startInput = document.getElementById('corr-start-date');
    const endInput = document.getElementById('corr-end-date');
    const runBtn = document.getElementById('corr-run-btn');

    if (!analyticsInitialized) {
        const today = new Date();
        const weekAgo = new Date();
        weekAgo.setDate(today.getDate() - 6);
        startInput.value = formatDateInput(weekAgo);
        endInput.value = formatDateInput(today);

        runBtn.addEventListener('click', runCorrelationAnalysis);
        analyticsInitialized = true;

        // Results only ever appear after the person explicitly taps "Run
        // Analysis" - no auto-run on page load, so the page doesn't show
        // stale/default-range results before they've asked for anything.
    }
}

// Tone -> badge/dot color class. Kept separate from statistical "strength"
// (negligible/weak/moderate/...) since staff see the plain verdict, not
// the stats term.
function corrBadgeClass(tone) {
    return 'corr-badge-tone-' + tone;
}

function corrDotClass(tone) {
    return 'corr-tab-dot-' + tone;
}

let corrCardIdCounter = 0;
let corrPairsCache = [];
let corrActiveTab = 0;

// Builds the tab bar (one pill per pair, dot shows its verdict at a
// glance) and the single content panel for whichever tab is active.
function renderCorrTabs() {
    const tabbar = document.getElementById('corr-tabbar');
    const panel = document.getElementById('corr-panel');
    if (!tabbar || !panel) return;

    tabbar.innerHTML = corrPairsCache.map((pair, i) => `
        <button type="button" class="seg-btn corr-tab${i === corrActiveTab ? ' active' : ''}" data-tab-index="${i}">
            <span class="corr-tab-dot ${corrDotClass(pair.verdictTone)}"></span>
            ${pair.labelA} &amp; ${pair.labelB}
        </button>
    `).join('');

    tabbar.querySelectorAll('.corr-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            corrActiveTab = parseInt(btn.dataset.tabIndex, 10);
            renderCorrTabs();
        });
    });

    const pair = corrPairsCache[corrActiveTab];
    const cardId = 'corr-details-' + (corrCardIdCounter++);

    const recommendationHtml = pair.recommendation
        ? `<div class="corr-recommendation">
             <span class="corr-recommendation-label">Suggested action</span>
             <div class="corr-recommendation-text">${pair.recommendation}</div>
           </div>`
        : '';

    panel.innerHTML = `
        <div class="corr-panel-head">
            <div class="corr-pair-title">${pair.labelA} & ${pair.labelB}</div>
            <span class="corr-badge ${corrBadgeClass(pair.verdictTone)}">${pair.verdictLabel}</span>
        </div>
        <div class="corr-summary">${pair.summary}</div>
        ${recommendationHtml}
        <button type="button" class="corr-toggle-btn" data-target="${cardId}">Show details</button>
        <div class="corr-detail" id="${cardId}" hidden>${pair.detail}</div>
    `;
    // Re-trigger the fade-in even when switching tabs on an already-loaded
    // panel (removing/re-adding the class restarts a CSS animation).
    panel.classList.remove('corr-panel');
    void panel.offsetWidth;
    panel.classList.add('corr-panel');

    const toggleBtn = panel.querySelector('.corr-toggle-btn');
    const detailEl = panel.querySelector('.corr-detail');
    toggleBtn.addEventListener('click', () => {
        const isHidden = detailEl.hasAttribute('hidden');
        if (isHidden) {
            detailEl.removeAttribute('hidden');
            toggleBtn.textContent = 'Hide details';
        } else {
            detailEl.setAttribute('hidden', '');
            toggleBtn.textContent = 'Show details';
        }
    });
}

async function runCorrelationAnalysis() {
    const area = document.getElementById('corr-area-select').value;
    const start = document.getElementById('corr-start-date').value;
    const end = document.getElementById('corr-end-date').value;
    const runBtn = document.getElementById('corr-run-btn');
    const metaLine = document.getElementById('corr-meta-line');
    const tabbar = document.getElementById('corr-tabbar');
    const panel = document.getElementById('corr-panel');

    if (!start || !end) return;

    runBtn.disabled = true;
    runBtn.textContent = 'Running…';
    metaLine.classList.remove('analytics-meta-fade');
    metaLine.textContent = 'Analyzing readings…';

    // Fade the old panel out first, then swap content once the fade
    // finishes - avoids the old result vanishing and the new one appearing
    // in the same instant, which is what made this feel abrupt before.
    panel.classList.add('analytics-grid-fading');
    await new Promise(resolve => setTimeout(resolve, panel.children.length ? 180 : 0));
    tabbar.innerHTML = '';
    panel.innerHTML = '';
    panel.classList.remove('analytics-grid-fading');

    try {
        const res = await fetch(
            `${API_BASE_URL}/api/analytics/correlation?start=${start}&end=${end}&area=${encodeURIComponent(area)}`,
            { credentials: 'include' }
        );
        if (res.status === 403) {
            panel.innerHTML = '<div class="analytics-empty analytics-fade-in">Analytics is available to admin accounts only.</div>';
            metaLine.textContent = '';
            return;
        }
        if (!res.ok) throw new Error(`Request failed (${res.status})`);
        const data = await res.json();

        if (!data.pairs || !data.pairs.length || data.hourlyBucketsUsed === 0) {
            panel.innerHTML = '<div class="analytics-empty analytics-fade-in">No sensor readings found for this area and date range yet.</div>';
            metaLine.textContent = `${area} · ${start} to ${end} · 0 hourly readings`;
            metaLine.classList.add('analytics-meta-fade');
            return;
        }

        corrPairsCache = data.pairs;
        corrActiveTab = 0;
        renderCorrTabs();
        metaLine.textContent = `${area} · ${start} to ${end} · built from ${data.hourlyBucketsUsed} hourly reading${data.hourlyBucketsUsed === 1 ? '' : 's'}`;
        metaLine.classList.add('analytics-meta-fade');
    } catch (err) {
        console.error('Correlation analytics fetch failed', err);
        panel.innerHTML = '<div class="analytics-empty analytics-fade-in">Could not load correlation analytics. Check that the server is running.</div>';
        metaLine.textContent = 'Error loading analytics.';
        metaLine.classList.add('analytics-meta-fade');
    } finally {
        runBtn.disabled = false;
        runBtn.textContent = 'Run Analysis';
    }
}