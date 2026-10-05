/*
  rfidTest.js - Standalone bench test for the YRM100 reader.

  This deliberately touches nothing else in LiMon. No database, no MQTT,
  no dashboard. Its only job is to answer one question: does this reader
  actually work? Keeping it isolated means that if something fails, the
  cause is the hardware or the serial port - it can't be the rest of the
  system, because the rest of the system isn't running.

  Setup:
    npm install serialport

  Usage:
    node rfidTest.js                 # list available serial ports
    node rfidTest.js COM5            # Windows
    node rfidTest.js /dev/ttyUSB0    # Linux / Mac
    node rfidTest.js COM5 --power 20 # cap transmit power at 20 dBm

  Press Ctrl+C to stop; the script sends a proper stop command before it
  exits so the module isn't left transmitting.
*/

const { SerialPort } = require('serialport');
const { CMD, setPowerCommand, FrameParser, decodeFrame } = require('./yrm100');

const BAUD_RATE = 115200;

// ---------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------
// Every line is prefixed with elapsed run time (mm:ss since the script
// started) rather than wall-clock time, since "it died at 03:40 in" is
// what you actually need to know to compare runs - wall clock just
// makes you do the subtraction yourself.

const startedAt = Date.now();

function elapsed() {
  const s = Math.floor((Date.now() - startedAt) / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function log(...args) {
  console.log(`[${elapsed()}]`, ...args);
}

const args = process.argv.slice(2);
const portPath = args.find((a) => !a.startsWith('--'));
const powerIndex = args.indexOf('--power');
const power = powerIndex !== -1 ? Number(args[powerIndex + 1]) : null;

// ---------------------------------------------------------------------
// Port discovery
// ---------------------------------------------------------------------
// Running with no arguments just lists what's plugged in. This is the
// fastest way to confirm the operating system can even see the reader -
// if it doesn't appear here, it's a driver or cable problem and nothing
// further in this script will work.

async function listPorts() {
  const ports = await SerialPort.list();

  if (ports.length === 0) {
    console.log('No serial ports found at all.');
    console.log('The reader is either not plugged in, or its USB-serial driver');
    console.log('is missing (these boards usually need CH340 or CP210x drivers).');
    return;
  }

  console.log('Serial ports currently available:\n');
  for (const p of ports) {
    const label = [p.manufacturer, p.friendlyName].filter(Boolean).join(' - ');
    console.log(`  ${p.path.padEnd(16)} ${label || '(no description)'}`);
  }
  console.log('\nRe-run with the port name, e.g.:  node rfidTest.js ' + ports[0].path);
}

// ---------------------------------------------------------------------
// The actual test
// ---------------------------------------------------------------------

async function runTest(path) {
  log(`Opening ${path} at ${BAUD_RATE} baud...`);

  const port = new SerialPort({ path, baudRate: BAUD_RATE }, (err) => {
    if (err) {
      console.error('Could not open the port:', err.message);
      console.error('\nUsually this means the port name is wrong, or something');
      console.error('else already has it open (a serial monitor, the vendor demo');
      console.error('app, or another copy of this script still running).');
      process.exit(1);
    }
  });

  const parser = new FrameParser();
  const seen = new Map(); // epc -> { count, bestRssi, firstSeen }
  let handshakeDone = false;

  // Updated on every single byte received, regardless of whether it
  // parses into a full frame yet. This is the true "is anything coming
  // from the module at all" signal, separate from "is a tag in front of
  // it right now" - the two get confused if you only look at tag logs.
  let lastByteAt = Date.now();

  port.on('data', (chunk) => {
    lastByteAt = Date.now();

    for (const frame of parser.push(chunk)) {
      const msg = decodeFrame(frame);

      if (msg.kind === 'version') {
        log('  Module replied:', msg.text || '(empty string)');
        handshakeDone = true;
      } else if (msg.kind === 'tag') {
        const entry = seen.get(msg.epc) || { count: 0, bestRssi: -999, firstSeen: Date.now() };
        entry.count += 1;
        entry.bestRssi = Math.max(entry.bestRssi, msg.rssi);
        seen.set(msg.epc, entry);

        // Only announce a tag the first time, then keep a running count.
        // A tag sitting in the field gets re-read dozens of times per
        // second, so printing every single read would be unreadable.
        if (entry.count === 1) {
          log(`  NEW TAG  ${msg.epc}   signal ${msg.rssi} dBm`);
        } else if (entry.count % 25 === 0) {
          log(`   ...${msg.epc} read ${entry.count}x (best signal ${entry.bestRssi} dBm)`);
        }
      } else if (msg.kind === 'error') {
        log('  Module error:', msg.message);
      }
      // 'no-tag' is ignored on purpose - during continuous polling with
      // nothing in front of the antenna it fires constantly and means
      // nothing is wrong.
    }
  });

  port.on('error', (err) => console.error('Serial error:', err.message));

  // --- Step 1: handshake, no RF involved -----------------------------
  log('STEP 1 - Asking the module to identify itself (no RF transmitted).');
  port.write(CMD.HARDWARE_VERSION);
  await wait(400);
  port.write(CMD.SOFTWARE_VERSION);
  await wait(600);

  if (!handshakeDone) {
    log('\n  No reply from the module.\n');
    console.log('  The port opened fine, so the cable and driver are OK - the');
    console.log('  module just is not answering. Most likely causes, in order:');
    console.log('    - Module is not actually powered (check for a power LED)');
    console.log('    - EN pin is pulled low, holding the module disabled');
    console.log('    - TX/RX are swapped (they cross over: module TX -> other RX)');
    console.log('    - Different baud rate (some units ship at 9600)\n');
    port.close();
    return;
  }

  // --- Step 2: optional power limit ----------------------------------
  if (power !== null) {
    log(`STEP 2 - Limiting transmit power to ${power} dBm.`);
    port.write(setPowerCommand(power));
    await wait(400);
  }

  // --- Step 3: continuous read ---------------------------------------
  log('STEP 3 - Continuous reading is now ON.');
  console.log('Hold a UHF tag near the antenna. Start by touching the tag to');
  console.log('the antenna face, then slowly pull it away to find the range.');
  console.log('Ctrl+C when you are done.\n');
  port.write(CMD.MULTI_POLL);

  // --- Heartbeat --------------------------------------------------------
  // Prints every 30s regardless of tag activity, so a long idle run
  // still leaves a timestamped trail. If it stops printing altogether,
  // the process itself died or hung - that's a different problem from
  // the module going quiet, and this makes the two easy to tell apart.
  const heartbeat = setInterval(() => {
    const silentFor = Math.round((Date.now() - lastByteAt) / 1000);
    if (silentFor >= 20) {
      log(`Still running. No bytes from the module in ${silentFor}s - if a tag is genuinely near the antenna and still nothing arrives, this is the moment it stopped responding.`);
    } else {
      log('Still running. Module is actively sending data.');
    }
  }, 30000);

  // --- Keep-alive re-poll -----------------------------------------------
  // CMD.MULTI_POLL asks the module to do 10000 read rounds, then it stops
  // on its own - that finite count is exactly what was cutting reads off
  // during long sessions, not a hardware fault. Re-sending the same
  // command well before 10000 rounds could realistically be reached
  // resets that counter, so the module never actually gets there.
  const rearm = setInterval(() => {
    port.write(CMD.MULTI_POLL);
    log('Re-armed continuous polling (resets the 10000-round counter before it can run out).');
  }, 60000);

  // --- Clean shutdown -------------------------------------------------
  process.on('SIGINT', () => {
    clearInterval(heartbeat);
    clearInterval(rearm);
    log('Stopping the reader...');
    port.write(CMD.STOP_POLL, () => {
      setTimeout(() => {
        printSummary(seen);
        port.close(() => process.exit(0));
      }, 300);
    });
  });
}

function printSummary(seen) {
  console.log('\n--- Summary -------------------------------------------------');
  if (seen.size === 0) {
    console.log('No tags were read.');
    console.log('\nIf the module answered in step 1 but never read a tag, the');
    console.log('serial side is fine and the problem is RF. Check that:');
    console.log('  - The antenna is actually connected');
    console.log('  - Your tags are UHF (860-960 MHz), not 13.56 MHz NFC cards');
    console.log('  - The tag is not stuck to metal or resting on liquid');
    console.log('  - You tried touching the tag directly onto the antenna');
  } else {
    console.log(`${seen.size} distinct tag(s) read:\n`);
    for (const [epc, e] of seen) {
      console.log(`  ${epc}`);
      console.log(`     read ${e.count} times, best signal ${e.bestRssi} dBm`);
    }
    console.log('\nThe reader works. Those EPC strings are the unique IDs you');
    console.log('would map to library members.');
  }
  console.log('-------------------------------------------------------------');
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

if (!portPath) {
  listPorts();
} else {
  runTest(portPath);
}