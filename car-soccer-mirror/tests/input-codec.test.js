import test from "node:test";
import assert from "node:assert/strict";
import { quantiseControls, encodePacket, decodePacket, controlsEqual } from "../assets/input-codec.js";

const sample = {
    throttle: 0.7314159, steer: -0.42, pitch: 1, yaw: -1, roll: 0,
    jump: true, boost: false, handbrake: true
};

test("quantising is idempotent", () => {
    const once = quantiseControls(sample);
    const twice = quantiseControls(once);
    assert.deepEqual(twice, once, "quantise(quantise(x)) must equal quantise(x)");
});

test("quantising preserves the extremes exactly", () => {
    const q = quantiseControls({ ...sample, throttle: 1, steer: -1, pitch: 0 });
    assert.equal(q.throttle, 1);
    assert.equal(q.steer, -1);
    assert.equal(q.pitch, 0);
});

test("a packet round-trips through encode and decode", () => {
    const inputs = [0, 1, 2, 3].map(i => quantiseControls({
        ...sample, throttle: i / 3, steer: -i / 3, jump: i % 2 === 0
    }));
    const decoded = decodePacket(encodePacket(1000, inputs));
    assert.equal(decoded.newestTick, 1000);
    assert.equal(decoded.inputs.length, 4);
    // inputs[last] is the newest, at newestTick; earlier entries are earlier ticks.
    assert.deepEqual(decoded.inputs, inputs);
});

test("a packet is small", () => {
    const inputs = [0, 1, 2, 3].map(() => quantiseControls(sample));
    assert.ok(encodePacket(1000, inputs).byteLength <= 32,
        "packet should fit in 32 bytes, not ~150 of JSON");
});

test("controlsEqual distinguishes what the wire distinguishes", () => {
    const a = quantiseControls(sample);
    assert.ok(controlsEqual(a, quantiseControls(sample)));
    assert.ok(!controlsEqual(a, quantiseControls({ ...sample, boost: true })));
    // Below the quantisation step, two raw values are the same input.
    assert.ok(controlsEqual(quantiseControls({ ...sample, throttle: 0.5 }),
        quantiseControls({ ...sample, throttle: 0.5001 })));
});
