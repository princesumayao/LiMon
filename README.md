# LiMon — Run Guide (for me, on defense day)

Personal notes for getting everything running from a cold start. Written
so I don't have to remember any of this under pressure the morning of.

## What this actually is, running-wise

Two separate Node servers, plus MySQL and an MQTT broker underneath them:

| Piece | Port | What it does |
|---|---|---|
| **MySQL** | 3306 | Stores every reading, alert, and account |
| **MQTT broker** (e.g. Mosquitto) | 1883 | Sensors (or the simulators) publish here; the backend listens |
| **`backend/server.js`** | **4000** | The real API + MQTT subscriber + Socket.IO (live updates) |
| **`server.js`** (project root) | **3000** | Serves the actual pages: `/login`, `/home`, `/seats`, `/qr-tool` |

The dashboard page itself (port 3000) talks to the API (port 4000) from
the browser — both need to be running at the same time, always.

---

## 1. One-time setup (only needed once per machine)

```bash
# from the project root
npm install

cd backend
npm install
cd ..
```

### Install & start prerequisites
- **MySQL** — install it, make sure it's running (`mysql --version` to check it's on PATH).
- **MQTT broker** — I use Mosquitto. Install it and make sure it's running
  on `localhost:1883` (default config is fine). Without this running, no
  sensor data (real or simulated) reaches the app at all — the dashboard
  will just sit empty.

### Create the database
```bash
mysql -u root -p -e "CREATE DATABASE limon;"
mysql -u root -p limon < backend/schema.sql
```

### Environment variables
**Two separate `.env` files are needed** — one in `backend/`, one in the
project root — because the two servers are started from two different
folders, and `dotenv` only looks in whichever folder it's actually run
from.

`backend/.env`:
```
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=your_mysql_password
DB_NAME=limon
MQTT_BROKER_URL=mqtt://localhost:1883
SESSION_SECRET=limon-dev-secret-change-me
PORT=4000
```

Project-root `.env` (only `SESSION_SECRET` matters here — it's what lets
the root server's `/login`/`/home`/`/seats`/`/qr-tool` redirects correctly
read the session cookie the backend set):
```
SESSION_SECRET=limon-dev-secret-change-me
```
**Keep `SESSION_SECRET` identical in both files** (or just leave it unset
in both — there's a matching hardcoded fallback in `backend/auth.js` so it
still works without a `.env` at all, it just isn't something I'd want
running in production).

### Seed accounts
```bash
cd backend
node seedUsers.js
```
Creates `admin` / `admin123` (admin) and `staff1` / `staff123` (staff).
**Change these passwords before this is ever shown to anyone outside the
panel**, or at minimum right after the defense.

### (Optional) Seed demo history
If I want charts/reports/correlation analytics to have something
meaningful to show without waiting for real sensor data to accumulate:
```bash
cd backend
node seedDemoAnalyticsData.js
```

### Clean slate before defense day
Every "today" query (occupancy, Today's Summary, dashboard charts) reads
by calendar date, so leftover test data from earlier testing (simulators,
repeated RFID tag waves, `demoHumiditySpike.js`) doesn't disappear on its
own — it keeps accumulating and can make live numbers look wrong or stuck
(this is what caused occupancy to sit at 0 even with a real tag read: too
many leftover OUT events from earlier testing had piled up, so the real
IN couldn't push the total above the clamp-at-zero floor). Right before
the actual demo, clear it out:
```bash
cd backend
npm run reset:today
```
Wipes only **today's** rows in `occupancy_events`, `noise_readings`,
`environment_readings`, and `notifications` — users, settings, and past
days are untouched. **Don't run this once the panel is watching**, only
right before you start.

---

## 2. Every time I want to run it

### Quick way (one click)
Make sure MySQL and Mosquitto are running (both normally start with
Windows as services), then double-click:
- **`Start LiMon.vbs`** for the real thing (real sensors / RFID) — runs
  silently, no console window, just opens the browser.
- **`Start LiMon (Demo Simulators).vbs`** to also run the fake occupancy
  and table-seat simulators, for when the hardware isn't connected.
- The matching `.bat` files do the exact same thing but leave a visible
  terminal window open — useful if something goes wrong and I need to see
  the logs/errors directly.

It installs packages on the first run, warns if MySQL or MQTT isn't up,
starts the backend (4000) and the pages (3000), and opens the login page.
Closing the terminal (or Task Manager > End Task on `node.exe` for the
`.vbs` versions, since they hide their window) stops everything. From a
terminal, the same thing is `npm run all` or `npm run demo`. **Don't use
the demo one with real hardware**, since fake and real data would mix.

### Manual way (three terminals) (or three tabs), from the project root each time:

**Terminal 1 — backend (API + MQTT + Socket.IO)**
```bash
cd backend
npm start
```
Should print `LiMon backend listening on port 4000`.

**Terminal 2 — root server (the actual pages)**
```bash
npm start
```
Should print `Server is running on port 3000`.

**Terminal 3 — sensor data**, since hardware isn't wired up yet:
```bash
cd backend
npm run simulate:occupancy    # fake entrance IN/OUT events
npm run simulate:tables       # fake per-table seat counts
```
(Two more terminals if I want both running at once, or just background
them with `&`.) `testPublish.js` also exists for a simple noise/temp/
humidity stream if I need that specifically:
```bash
node testPublish.js
```

**To reliably trigger a humidity alert live during defense**, without
waiting for the room to actually get humid: `demoHumiditySpike.js`
publishes a fake, ramping humidity reading on the same MQTT topic
(`limon/environment`) the real ESP32 uses, so the dashboard/alert/
analytics pipeline reacts exactly like it would to a real reading. It
does not touch the firmware or sensors — the real board keeps publishing
too, and real data resumes right after the script finishes.
```bash
cd backend
npm run demo:humidity
# or with options:
npm run demo:humidity -- --area "Area B" --target 68 --seconds 20
```
See the comment at the top of `backend/demoHumiditySpike.js` for all the
flags. This is a demo-only override — if a panelist asks, be upfront that
it's a scripted trigger, not the live sensor (see Section 4 below on why
this exists and what's actually configured vs. placeholder right now).

Then open **`http://localhost:3000`** (or `/login`) in the browser.

---

## 3. Defense-day specific: LAN access for the QR code / phones

The seat-map QR code and student-facing page only work for other devices
(a panelist's or my own phone) if the dashboard is opened by **IP
address**, not `localhost`. This matters because:
- `localhost` only ever resolves to the exact machine it's typed on — a
  phone scanning a QR code with "localhost" in it is trying to reach
  itself, not my laptop.
- Real OS-level "Desktop Alerts" notifications are also blocked by the
  browser over a plain `http://` LAN address (a browser security rule),
  so I should expect the notification toggle to be grayed out unless I'm
  on `localhost` specifically.

**Steps:**
1. Find this machine's LAN IP: `ipconfig` (Windows) → look for **IPv4
   Address** under whichever adapter is actually connected to the venue's
   Wi-Fi. Something like `192.168.1.23`.
2. Open the dashboard as `http://192.168.1.23:3000/home` — not
   `localhost` — on my own laptop too, so everything (QR tool, share
   links) reflects the right address from the start.
3. **Test with an actual second phone before the defense**, not just
   assumption. Some networks (especially "Guest" Wi-Fi) have client
   isolation turned on, which silently blocks devices from reaching each
   other even on the same network — if that's the case here, the QR code
   won't work at all no matter how correct the IP is, and I'd need a
   different network (a personal hotspot, most likely) for that
   part of the demo.
4. Windows Firewall may prompt "Allow Node.js through firewall?" the
   first time — say yes for **Private networks**, or LAN devices get
   silently blocked.
5. To generate/print the actual QR (for a poster or the Facebook post),
   log in and visit **`/qr-tool`** — it's deliberately not linked
   anywhere in the dashboard nav, so this URL is the only way to reach it.
   Re-visit it and reprint if the network ever changes, since a printed
   QR code freezes whatever IP was current the moment it was generated.

---

## 4. Physical setup & hardware placement — current status

Written so I (or anyone/anything else picking this project up later) knows
what's actually decided vs. still a placeholder, without re-deriving it
from scratch. This is about the physical build, not the software.

### Sensor placement goal
Design intent: one sensor unit (noise + temp/humidity) sits in the
**middle of a cluster of ~4 tables**, and when it detects a noise-limit
breach, the LEDs on **all 4 surrounding tables** light up together as the
visible alert — not just a dashboard notification.

### Current scope for the Oct 8 defense
- **Two physical stations only** (Area A, Area B). This is intentional —
  it's enough to prove the concept works across more than one area
  without needing to fully instrument the whole library.
- **Wired for now, not wireless.** Each sensor's center unit is wired
  directly to its own 4 surrounding table LEDs. A fully wireless LED
  setup (each table's LED as its own WiFi/MQTT node) was considered and
  is a reasonable **future improvement**, but rebuilding the LED trigger
  path this close to defense adds a new failure mode (LED nodes losing
  WiFi) for something the panel isn't actually testing on Oct 8. Revisit
  post-defense if pursuing this further.
- **Trip-hazard mitigation**: tables are placed close together, so wires
  from the center sensor to each table must be routed along table
  edges/legs (tape or a cable channel), never straight across the open
  walking gap between tables. This is physical setup work, not code —
  just noting it here so it isn't forgotten before the defense.

### WiFi / broker configuration — now dynamic, no re-upload needed
`firmware/LiMon_ESP32_SoundTemp/LiMon_ESP32_SoundTemp.ino` uses the
**WiFiManager** library so the WiFi network, password, area name, and
MQTT broker IP are all set from a phone the first time each board powers
on (it opens its own "LiMon-Setup" WiFi network with a config page),
instead of being hardcoded and requiring a re-upload every time it moves
to a different laptop/network. Settings persist on the board across power
cycles. Full details and recovery steps (what to do if the broker becomes
unreachable, how to force the setup page open again) are in the comment
block at the top of that `.ino` file. **Requires the `WiFiManager` library
(by tzapu) installed in Arduino IDE — not yet bench-tested on real
hardware**, so test this once before relying on it for defense.

### Humidity threshold — placeholder, not adviser-confirmed
`backend/thresholds.js` defines `HUMIDITY_LOW: 40` / `HUMIDITY_HIGH: 60`
(%RH). This is a **generic indoor comfort range**, not a number measured
or confirmed for this specific library. It exists so the humidity
alert/analytics pipeline has something to demonstrate. **Decision needed:
confirm the real range with the adviser/panel**, or state during defense
that it's a placeholder pending calibration — either is fine, but it
should be a conscious answer, not a surprise if asked.

### Areas (Area A / Area B) — intentionally fixed, not admin-editable
The list of areas is currently hardcoded across the frontend, backend
queries, and firmware (`DEVICE_AREA` / the WiFiManager "Area name"
field) — there is **no admin UI to add/rename areas**, on purpose. Adding
an area today would let staff create one with no real sensor behind it,
since each area is tied to actual installed hardware. If asked about this
in defense: areas are hardware-backed by design, and a settings page for
managing them is scoped as future work once hardware provisioning
supports it (e.g. an `areas` table + admin CRUD page) — not something
cut for lack of time.

---

## 5. Quick troubleshooting

| Symptom | Likely cause |
|---|---|
| Dashboard loads but shows no data at all | MQTT broker isn't running, or no simulator/hardware is publishing |
| "Cannot connect to database" on startup | MySQL isn't running, or `backend/.env` credentials are wrong |
| Changes I just made don't show up in the browser | Browser cache — hard refresh (Ctrl+Shift+R). The CSS/JS `<script>` tags have a `?v=` cache-buster; bump it if a change still won't show |
| QR code scans but the phone can't load the page | Wrong IP was used, phone isn't on the same Wi-Fi, or the network has client isolation on |
| Logged in on my laptop but `/login` still shows the form on the phone | Sessions are per-browser/per-device — that's expected, each device logs in separately |
| "Desktop Alerts" toggle is grayed out | Expected on anything that isn't `localhost` or `https://`, and always grayed out in Incognito/Private windows — this is the browser's own restriction, not a bug |
| Analytics page nav item / correlation data missing for `staff1` | Expected — Analytics is admin-only by design, log in as `admin` to see it |

---

## 6. Logo / branding note

`public/favicon.svg` is a placeholder "LM" monogram (a full "LiMon" text
wordmark isn't legible at actual browser-tab size, so I went with a
monogram for now). **To swap in a real logo later**: just replace that one
file, keeping the same filename — every page already points at it, so
nothing else needs to change.
