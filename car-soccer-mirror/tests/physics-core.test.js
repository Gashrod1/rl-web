import test from "node:test";
import assert from "node:assert/strict";
import { loadPhysics } from "./helpers/load-physics.js";
import { ct } from "../assets/physics-core.js";

test("physics boots under Node and exposes a state array", async () => {
    const sim = await loadPhysics();
    assert.ok(sim.state.length > 0, "state array should be non-empty");
    assert.equal(sim.state[ct.NUM_CARS], 2, "two cars should be configured");
});

function scriptedInput(tick) {
    return {
        throttle: Math.sin(tick / 37) > 0 ? 1 : -1,
        steer: Math.sin(tick / 23),
        pitch: Math.cos(tick / 41),
        yaw: 0,
        roll: 0,
        jump: tick % 53 === 0,
        boost: tick % 7 < 3,
        handbrake: false
    };
}

async function runScript(ticks) {
    const sim = await loadPhysics();
    sim.resetKickoff(0);
    for (let tick = 0; tick < ticks; tick++) {
        sim.setControls(0, scriptedInput(tick));
        sim.setControls(1, scriptedInput(tick + 500));
        sim.step(1);
    }
    return Float32Array.from(sim.state);
}

test("two identical runs produce bit-identical state", async () => {
    const a = await runScript(1200);
    const b = await runScript(1200);
    assert.deepEqual(Array.from(a), Array.from(b), "simulation is not deterministic");
});
