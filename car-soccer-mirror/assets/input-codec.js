// Controls travel as 8-bit quantised values. The local simulation is fed the same
// quantised value the opponent receives, so both worlds step on identical numbers --
// feeding the raw float locally would diverge the two simulations slowly.

const AXES = ["throttle", "steer", "pitch", "yaw", "roll"];
const FLAGS = ["jump", "boost", "handbrake"];
const BYTES_PER_INPUT = AXES.length + 1;
const HEADER_BYTES = 5; // uint32 newest tick + uint8 count

// The `| 0` is not decoration: it normalises -0 to 0, so a value quantised locally
// and the same value decoded off the wire compare equal instead of differing by sign.
const toByte = value => Math.max(-127, Math.min(127, Math.round(value * 127))) | 0;
const fromByte = byte => byte / 127;

export function quantiseControls(controls) {
    const out = {};
    for (const axis of AXES) out[axis] = fromByte(toByte(controls[axis] ?? 0));
    for (const flag of FLAGS) out[flag] = !!controls[flag];
    return out;
}

export function controlsEqual(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    for (const axis of AXES) if (toByte(a[axis]) !== toByte(b[axis])) return false;
    for (const flag of FLAGS) if (!!a[flag] !== !!b[flag]) return false;
    return true;
}

// inputs[inputs.length - 1] is the input for newestTick; earlier entries are the
// immediately preceding ticks. Sending several covers a dropped packet without a
// retransmit, which is what lets the prediction window stay small.
export function encodePacket(newestTick, inputs) {
    const buffer = new ArrayBuffer(HEADER_BYTES + inputs.length * BYTES_PER_INPUT);
    const view = new DataView(buffer);
    view.setUint32(0, newestTick >>> 0);
    view.setUint8(4, inputs.length);
    let offset = HEADER_BYTES;
    for (const input of inputs) {
        for (const axis of AXES) view.setInt8(offset++, toByte(input[axis] ?? 0));
        let flags = 0;
        FLAGS.forEach((flag, bit) => { if (input[flag]) flags |= 1 << bit; });
        view.setUint8(offset++, flags);
    }
    return buffer;
}

export function decodePacket(buffer) {
    const view = new DataView(buffer);
    const newestTick = view.getUint32(0);
    const count = view.getUint8(4);
    const inputs = [];
    let offset = HEADER_BYTES;
    for (let i = 0; i < count; i++) {
        const input = {};
        for (const axis of AXES) input[axis] = fromByte(view.getInt8(offset++));
        const flags = view.getUint8(offset++);
        FLAGS.forEach((flag, bit) => { input[flag] = (flags & (1 << bit)) !== 0; });
        inputs.push(input);
    }
    return { newestTick, inputs };
}

export const INPUT_AXES = AXES;
export const INPUT_FLAGS = FLAGS;
