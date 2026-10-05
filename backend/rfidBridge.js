/*
  rfidBridge.js - Real UHF hardware, in place of occupancySimulator.js.

  This publishes to the exact same MQTT topic ('limon/occupancy') with
  the exact same payload shape ({ area, epc, direction }) that the
  simulator uses, which is why nothing else in LiMon has to change: the
  subscriber, database, Socket.IO feed, dashboard and CSV export all
  carry on working identically. The only difference is that the EPCs are
  now real ones off real tags instead of randomly generated 'SIM...'
  strings.

  Run this INSTEAD of `npm run simulate:occupancy` - not alongside it,
  or the count will be fed from two sources at once.

  Setup:
    npm install serialport

  Usage:
    node rfidBridge.js COM5
    node rfidBridge.js /dev/ttyUSB0 --power 20

  ---------------------------------------------------------------------
  About direction (IN vs OUT)
  ---------------------------------------------------------------------
  A single reader physically cannot tell which way someone walked - it
  only knows a tag was nearby. Real gates solve this with two antennas
  and compare which fired first.

  With one reader, the honest approach is a toggle: the first time a tag
  is seen it counts as IN, the next time as OUT, alternating after that.
  For a library entrance this is actually reasonable, since people do
  genuinely alternate entering and leaving. It is a documented
  limitation, not a hidden bug - and it's worth stating plainly in the
  defense rather than being asked about it.

  The debounce below matters just as much. A tag held in the field is
  re-read many times per second; without debouncing, one person walking
  past would register as dozens of entries.
*/

const mqtt = require('mqtt');
const { SerialPort } = require('serialport');
const { CMD, setPowerCommand, FrameParser, decodeFrame } = require('./yrm100');
const db = require('./db');
require('dotenv').config();

const BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';
const AREA = process.env.RFID_AREA || 'Entrance';
const BAUD_RATE = 115200;

// How long the same tag is ignored after being counted. This needs to be
// longer than someone takes to walk through the gate, but shorter than
// the quickest realistic turnaround (stepping out and back in).
const DEBOUNCE_MS = Number(process.env.RFID_DEBOUNCE_MS) || 3000;

// Reads weaker than this are discarded. A tag across the room produces a
// weak read; one carried through the doorway produces a strong one. Use
// the signal numbers printed by rfidTest.js to pick a sensible value -
// note the scale is negative, so -50 is STRONGER than -70.
const RSSI_FLOOR = Number(process.env.RFID_RSSI_FLOOR) || -70;

const args = process.argv.slice(2);
const portPath = args.find((a) => !a.startsWith('--'));
const powerIndex = args.indexOf('--power');
const power = powerIndex !== -1 ? Number(args[powerIndex + 1]) : null;

if (!portPath) {
  console.error('Which serial port? e.g.  node rfidBridge.js COM5');
  console.error('Run `node rfidTest.js` with no arguments to list them.');
  process.exit(1);
}

// epc -> { lastSeen, lastDirection }
// This is the fast in-memory copy used for every raw read's debounce
// check - a busy field can generate dozens of reads per second, and
// hitting the database on every single one of those would be real load
// for no benefit. The database is the durable backup, loaded in here
// once at startup and written back to only when a crossing is actually
// confirmed (see handleTagRead below).
const tagState = new Map();

async function loadPersistedState() {
  try {
    const [rows] = await db.query('SELECT epc, last_seen, last_direction FROM rfid_tag_state');
    for (const row of rows) {
      tagState.set(row.epc, {
        lastSeen: new Date(row.last_seen).getTime(),
        lastDirection: row.last_direction,
      });
    }
    console.log(`Loaded ${rows.length} persisted tag state(s) from the database.`);
  } catch (err) {
    // Not fatal - worst case is the same blank-slate behavior as before
    // this change, so a DB hiccup here shouldn't block the reader from
    // starting up and still working for the rest of the session.
    console.warn('Could not load persisted tag state (continuing with none):', err.message);
  }
}

const client = mqtt.connect(BROKER_URL);
let mqttReady = false;

client.on('connect', () => {
  mqttReady = true;
  console.log('Connected to MQTT broker at', BROKER_URL);
});
client.on('error', (err) => console.error('MQTT error:', err.message));

const port = new SerialPort({ path: portPath, baudRate: BAUD_RATE }, (err) => {
  if (err) {
    console.error('Could not open', portPath + ':', err.message);
    process.exit(1);
  }
});

const parser = new FrameParser();

port.on('data', (chunk) => {
  for (const frame of parser.push(chunk)) {
    const msg = decodeFrame(frame);
    if (msg.kind === 'tag') handleTagRead(msg);
  }
});

port.on('error', (err) => console.error('Serial error:', err.message));

function handleTagRead({ epc, rssi }) {
  if (rssi < RSSI_FLOOR) return; // too far away to count as passing through

  const now = Date.now();
  const state = tagState.get(epc);

  if (state && now - state.lastSeen < DEBOUNCE_MS) {
    // Still the same pass through the gate - refresh the timer so the
    // debounce window only closes once the tag has genuinely left.
    state.lastSeen = now;
    return;
  }

  const direction = state && state.lastDirection === 'IN' ? 'OUT' : 'IN';
  tagState.set(epc, { lastSeen: now, lastDirection: direction });

  // Fire-and-forget: this happens once per confirmed crossing, same rate
  // as the MQTT publish just below, so it never adds load beyond what's
  // already happening. Errors are logged, not thrown - a failed DB write
  // still lets the read count for occupancy purposes; it only means a
  // restart right after this exact tag might not recall this update.
  db.query(
    'INSERT INTO rfid_tag_state (epc, last_seen, last_direction) VALUES (?, ?, ?) ' +
    'ON DUPLICATE KEY UPDATE last_seen = VALUES(last_seen), last_direction = VALUES(last_direction)',
    [epc, new Date(now), direction]
  ).catch((err) => console.warn('Could not persist tag state for', epc + ':', err.message));

  if (!mqttReady) {
    console.warn('Read', epc, 'but MQTT is not connected yet - dropping it.');
    return;
  }

  const payload = JSON.stringify({ area: AREA, epc, direction });
  client.publish('limon/occupancy', payload);
  console.log(`${direction.padEnd(3)}  ${epc}   signal ${rssi} dBm`);
}

// Start reading once the port is open.
port.on('open', async () => {
  console.log(`Reader open on ${portPath}. Area: "${AREA}".`);

  await loadPersistedState();

  if (power !== null) {
    port.write(setPowerCommand(power));
    await new Promise((r) => setTimeout(r, 400));
    console.log(`Transmit power set to ${power} dBm.`);
  }

  console.log(`Ignoring repeat reads within ${DEBOUNCE_MS}ms, and reads weaker than ${RSSI_FLOOR} dBm.`);
  console.log('Publishing to limon/occupancy. Ctrl+C to stop.\n');
  port.write(CMD.MULTI_POLL);
});

// CMD.MULTI_POLL only asks for 10000 read rounds before the module stops
// on its own - fine for a minute-long bench test, not for an entrance
// gate meant to run all day. Re-sending it well before that count could
// be reached keeps the reader continuously armed indefinitely.
const rearmInterval = setInterval(() => {
  port.write(CMD.MULTI_POLL);
}, 60000);

process.on('SIGINT', () => {
  console.log('\nStopping reader...');
  clearInterval(rearmInterval);
  port.write(CMD.STOP_POLL, () => {
    setTimeout(() => {
      port.close(() => {
        client.end(() => process.exit(0));
      });
    }, 300);
  });
});