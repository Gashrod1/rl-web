import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("assets/game-CEDHMqQk.js", "utf8");
const start = source.indexOf("class Jb {");
const Jb = source.slice(start, start + 2000);

test("the fixed-timestep stepper was found", () => {
    assert.ok(start > 0, "class Jb is missing from the bundle");
});

test("a stalled tick does not discard the accumulator", () => {
    assert.ok(!/!n\(\)\)\s*\{\s*this\.accumulator\s*=\s*0/.test(Jb),
        "the stall branch still zeroes the accumulator, so game time drifts behind real time");
});

test("the restored accumulator is capped", () => {
    // Without a cap, a long stall would queue hundreds of ticks and the simulation
    // would fast-forward through them in a single frame.
    const stall = Jb.slice(Jb.indexOf("!n()"), Jb.indexOf("!n()") + 600);
    assert.ok(/Math\.min\(/.test(stall), "the restored accumulator must be capped");
});
