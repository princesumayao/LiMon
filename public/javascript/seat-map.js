// Public seat-availability page. Deliberately separate from
// public/javascript/index.js rather than reusing it directly - this page
// has no login, no sidebar, and needs to keep working even if a phone's
// socket connection drops on flaky Wi-Fi, none of which applies to the
// staff dashboard.
const API_BASE_URL = `${window.location.protocol}//${window.location.hostname}:4000`;

let tableMapCache = {};
let tableMapLoaded = false;

function tableKey(area, table_label) {
    return `${area}::${table_label}`;
}

// Two states only: a table is either Available (at least one open seat)
// or Full. The occupied/total count and the bar still show how close a
// table is to full - the color just answers "can I sit here?".
function tmCapBarColor(fraction) {
    return fraction >= 1 ? 'var(--red)' : 'var(--green)';
}

// Same headcount-based reasoning as the staff dashboard's version: this
// can only ever report how many seats at a table are filled, never which
// specific chair - so the UI only ever claims a count/fraction.
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
        body.innerHTML = '<div class="table-map-empty">No table data available right now.</div>';
        return;
    }

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

    const stamp = document.getElementById('seatpage-updated');
    if (stamp) {
        stamp.textContent = 'Last updated ' + new Date().toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit' });
    }
}

async function fetchAndRenderTableMap() {
    try {
        const res = await fetch(`${API_BASE_URL}/api/tables/status`);
        if (!res.ok) throw new Error(`Request failed (${res.status})`);
        const rows = await res.json();
        tableMapCache = {};
        rows.forEach(r => {
            tableMapCache[tableKey(r.area, r.table_label)] = r;
        });
        tableMapLoaded = true;
        renderTableMap();
        setConnectionStatus(true);
    } catch (err) {
        console.error('Failed to fetch table occupancy map', err);
        setConnectionStatus(false);
        if (!tableMapLoaded) {
            const body = document.getElementById('table-map-body');
            if (body) body.innerHTML = '<div class="table-map-empty">Could not load the seat map. Check your Wi-Fi connection and try again.</div>';
        }
    }
}

function setConnectionStatus(isOnline) {
    const dot = document.getElementById('seatpage-live-dot');
    const text = document.getElementById('seatpage-status-text');
    if (!dot || !text) return;
    dot.classList.toggle('is-offline', !isOnline);
    text.textContent = isOnline ? 'Live' : 'Reconnecting…';
}

function handleTableStatusUpdate(data) {
    const key = tableKey(data.area, data.table_label);
    tableMapCache[key] = data;
    if (!tableMapLoaded) return;
    renderTableMap();

    const body = document.getElementById('table-map-body');
    const freshUnit = body && body.querySelector(`.tm-table-unit[data-key="${CSS.escape(key)}"] .tm-table-box`);
    if (freshUnit) {
        freshUnit.classList.add('tm-seat-flash');
        setTimeout(() => freshUnit.classList.remove('tm-seat-flash'), 700);
    }
}

// Live updates arrive over the socket the moment staff-side data changes.
// The 20s poll underneath it is just a safety net in case a phone's
// socket connection drops on flaky campus Wi-Fi and doesn't reconnect
// right away - it's cheap (one small GET) and keeps the page honest even
// if the push channel is having a bad moment.
const socket = io(API_BASE_URL, { reconnectionDelay: 2000 });
socket.on('connect', () => setConnectionStatus(true));
socket.on('disconnect', () => setConnectionStatus(false));
socket.on('table-status-update', handleTableStatusUpdate);

fetchAndRenderTableMap();
setInterval(fetchAndRenderTableMap, 20000);
