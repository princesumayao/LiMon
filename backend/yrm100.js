/*
  yrm100.js - Protocol helper for the YRM100 UHF RFID module.

  The YRM100 is built on the Magic RF "M100" chipset, so it speaks the
  M100 serial protocol. Every message in both directions looks like this:

    BB | Type | Cmd | PL_MSB | PL_LSB | ...params... | Checksum | 7E
    ^^                                                            ^^
    header                                                        end

    Type     0x00 = command   (PC  -> module)
             0x01 = response  (module -> PC, "did your command work")
             0x02 = notice    (module -> PC, "here is a tag I found")
    PL       parameter length, big-endian, 2 bytes
    Checksum sum of every byte from Type through the last param, mod 256

  Default UART settings: 115200 baud, 8 data bits, no parity, 1 stop bit.

  This file has no dependencies and does no I/O - it only builds and
  parses bytes, so it can be reused by the test script, the MQTT bridge,
  or anything else later.
*/

// ---------------------------------------------------------------------
// Pre-built commands
// ---------------------------------------------------------------------
// These are fixed byte sequences straight from the module's protocol
// manual. They're hardcoded rather than generated because they never
// change, and having the literal bytes makes them easy to compare
// against the manual if something ever looks wrong.

const CMD = {
  // Ask the module to identify itself. This is the safest possible
  // command - it doesn't transmit any RF at all, it just reads a string
  // out of the module's firmware. Always test with this one first.
  HARDWARE_VERSION: Buffer.from([0xBB, 0x00, 0x03, 0x00, 0x01, 0x00, 0x04, 0x7E]),
  SOFTWARE_VERSION: Buffer.from([0xBB, 0x00, 0x03, 0x00, 0x01, 0x01, 0x05, 0x7E]),
  MANUFACTURER:     Buffer.from([0xBB, 0x00, 0x03, 0x00, 0x01, 0x02, 0x06, 0x7E]),

  // Read once, right now, and report whatever tag is in the field.
  SINGLE_POLL: Buffer.from([0xBB, 0x00, 0x22, 0x00, 0x00, 0x22, 0x7E]),

  // Read continuously. The 0x2710 is the number of read rounds to do
  // (10000 in decimal) - it's effectively "keep going until I say stop".
  MULTI_POLL: Buffer.from([0xBB, 0x00, 0x27, 0x00, 0x03, 0x22, 0x27, 0x10, 0x83, 0x7E]),

  // Stop a multi-poll. Send this before closing the port, otherwise the
  // module keeps transmitting RF into an idle serial connection.
  STOP_POLL: Buffer.from([0xBB, 0x00, 0x28, 0x00, 0x00, 0x28, 0x7E]),
};

/**
 * Builds the "set transmit power" command.
 *
 * Power is given in dBm and sent as hundredths of a dBm (so 20 dBm is
 * transmitted as 2000). Lower power = shorter read range, which is
 * genuinely useful here: at full power a UHF reader will happily read
 * tags sitting on a desk three metres away, which would make an entrance
 * gate count people who never actually walked through it.
 *
 * Valid range for this module is roughly 15-26 dBm.
 */
function setPowerCommand(dBm) {
  const hundredths = Math.round(dBm * 100);
  const params = [(hundredths >> 8) & 0xFF, hundredths & 0xFF];
  return buildFrame(0x00, 0xB6, params);
}

/**
 * Assembles a full frame from a command and its parameters, calculating
 * the checksum. Used for commands that take a runtime value (like power)
 * rather than being a fixed constant.
 */
function buildFrame(type, command, params = []) {
  const pl = params.length;
  const body = [type, command, (pl >> 8) & 0xFF, pl & 0xFF, ...params];
  const checksum = body.reduce((sum, b) => sum + b, 0) & 0xFF;
  return Buffer.from([0xBB, ...body, checksum, 0x7E]);
}

// ---------------------------------------------------------------------
// Streaming frame parser
// ---------------------------------------------------------------------
// Serial data arrives in arbitrary chunks - a single read can hand you
// half a frame, or three frames stuck together. So we accumulate bytes
// in a buffer and only pull out frames once we have a complete one.

class FrameParser {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  /**
   * Feed in newly received bytes; get back an array of complete frames.
   * Anything incomplete stays in the buffer for the next call.
   */
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames = [];

    while (true) {
      // Discard any garbage before the next header byte. This is what
      // lets the parser recover if it ever starts mid-frame (e.g. the
      // module was already mid-transmission when we opened the port).
      const start = this.buffer.indexOf(0xBB);
      if (start === -1) {
        this.buffer = Buffer.alloc(0);
        break;
      }
      if (start > 0) this.buffer = this.buffer.subarray(start);

      // Need at least the header through the length field to know how
      // long this frame is going to be.
      if (this.buffer.length < 5) break;

      const pl = (this.buffer[3] << 8) | this.buffer[4];
      const frameLength = 7 + pl; // header + type + cmd + 2 len + params + checksum + end

      if (this.buffer.length < frameLength) break; // rest hasn't arrived yet

      const frame = this.buffer.subarray(0, frameLength);
      this.buffer = this.buffer.subarray(frameLength);

      // Sanity-check the end byte. If it's wrong we were misaligned, so
      // skip this header byte and let the loop resynchronise.
      if (frame[frameLength - 1] !== 0x7E) {
        this.buffer = Buffer.concat([frame.subarray(1), this.buffer]);
        continue;
      }

      frames.push(Buffer.from(frame));
    }

    return frames;
  }
}

/**
 * Turns a raw frame into something meaningful.
 *
 * Returns an object with a `kind` field:
 *   'tag'     - a tag was read; includes epc, rssi, pc
 *   'version' - a version/manufacturer string response
 *   'no-tag'  - polled but nothing was in the field (completely normal)
 *   'error'   - the module reported a problem
 *   'other'   - a valid frame we don't specifically care about
 */
function decodeFrame(frame) {
  const type = frame[1];
  const command = frame[2];
  const pl = (frame[3] << 8) | frame[4];
  const params = frame.subarray(5, 5 + pl);

  // Verify the checksum. A bad checksum usually means a wiring or baud
  // rate problem rather than a protocol problem.
  const expected = frame.subarray(1, 5 + pl).reduce((s, b) => s + b, 0) & 0xFF;
  if (expected !== frame[5 + pl]) {
    return { kind: 'error', message: 'Checksum mismatch - check baud rate and wiring', raw: frame };
  }

  // Tag notice frame: RSSI (1 byte) + PC (2) + EPC (variable) + CRC (2)
  if (type === 0x02 && (command === 0x22 || command === 0x27)) {
    const rssiRaw = params[0];
    const epcBytes = params.subarray(3, pl - 2);
    return {
      kind: 'tag',
      // RSSI comes back as a signed byte; more negative = weaker signal.
      rssi: rssiRaw > 127 ? rssiRaw - 256 : rssiRaw,
      pc: params.subarray(1, 3).toString('hex').toUpperCase(),
      epc: epcBytes.toString('hex').toUpperCase(),
      raw: frame,
    };
  }

  if (type === 0x01 && command === 0x03) {
    // params[0] is which version was asked for; the rest is ASCII text.
    return { kind: 'version', text: params.subarray(1).toString('ascii').trim(), raw: frame };
  }

  if (type === 0x01 && command === 0xFF) {
    // 0x15 specifically means "polled, found nothing" - not a fault.
    if (params[0] === 0x15) return { kind: 'no-tag', raw: frame };
    return { kind: 'error', message: `Module error code 0x${params[0].toString(16)}`, raw: frame };
  }

  return { kind: 'other', type, command, params, raw: frame };
}

module.exports = { CMD, buildFrame, setPowerCommand, FrameParser, decodeFrame };
