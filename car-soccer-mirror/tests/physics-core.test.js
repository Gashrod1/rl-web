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

test("restoring a snapshot rewinds the simulation exactly", async () => {
    const sim = await loadPhysics();
    sim.resetKickoff(0);

    for (let tick = 0; tick < 240; tick++) {
        sim.setControls(0, scriptedInput(tick));
        sim.setControls(1, scriptedInput(tick + 500));
        sim.step(1);
    }

    const snapshot = sim.saveState();
    const atSnapshot = Float32Array.from(sim.state);

    // Run 60 ticks with *different* inputs, so the state genuinely diverges.
    for (let tick = 240; tick < 300; tick++) {
        sim.setControls(0, scriptedInput(tick + 999));
        sim.setControls(1, scriptedInput(tick));
        sim.step(1);
    }
    assert.notDeepEqual(Array.from(sim.state), Array.from(atSnapshot),
        "60 ticks with different inputs should have changed the state");

    sim.loadState(snapshot);
    assert.deepEqual(Array.from(sim.state), Array.from(atSnapshot),
        "restore did not rewind the visible state");

    // The real test: resimulating from the restored state must reproduce
    // the original continuation bit for bit.
    const replay = [];
    for (let tick = 240; tick < 300; tick++) {
        sim.setControls(0, scriptedInput(tick));
        sim.setControls(1, scriptedInput(tick + 500));
        sim.step(1);
        replay.push(Float32Array.from(sim.state));
    }

    const reference = await loadPhysics();
    reference.resetKickoff(0);
    const expected = [];
    for (let tick = 0; tick < 300; tick++) {
        reference.setControls(0, scriptedInput(tick));
        reference.setControls(1, scriptedInput(tick + 500));
        reference.step(1);
        if (tick >= 240) expected.push(Float32Array.from(reference.state));
    }

    for (let i = 0; i < expected.length; i++) {
        assert.deepEqual(Array.from(replay[i]), Array.from(expected[i]),
            `resimulated tick ${240 + i} diverged from the straight-line run`);
    }
});

test("calibration finds a mutable region and leaves the simulation untouched", async () => {
    const sim = await loadPhysics();
    sim.resetKickoff(0);
    for (let tick = 0; tick < 120; tick++) {
        sim.setControls(0, scriptedInput(tick));
        sim.setControls(1, scriptedInput(tick + 500));
        sim.step(1);
    }
    const before = Float32Array.from(sim.state);

    const region = sim.calibrateSnapshotRange();

    assert.ok(region.end > region.start, "region should be non-empty");
    assert.ok(region.end - region.start < sim.heapBytes / 2,
        "region should be much smaller than the whole heap");
    assert.deepEqual(Array.from(sim.state), Array.from(before),
        "calibration must restore the simulation it perturbed");
});

test("region snapshots rewind as well as full-heap ones", async () => {
    const sim = await loadPhysics();
    sim.resetKickoff(0);
    sim.calibrateSnapshotRange();
    for (let tick = 0; tick < 240; tick++) {
        sim.setControls(0, scriptedInput(tick));
        sim.setControls(1, scriptedInput(tick + 500));
        sim.step(1);
    }

    const region = sim.saveRegion();
    const replay = [];
    for (let tick = 240; tick < 300; tick++) {
        sim.setControls(0, scriptedInput(tick));
        sim.setControls(1, scriptedInput(tick + 500));
        sim.step(1);
        replay.push(Float32Array.from(sim.state));
    }

    sim.loadRegion(region);
    for (let tick = 240; tick < 300; tick++) {
        sim.setControls(0, scriptedInput(tick));
        sim.setControls(1, scriptedInput(tick + 500));
        sim.step(1);
        assert.deepEqual(Array.from(sim.state), Array.from(replay[tick - 240]),
            `region-restored resimulation diverged at tick ${tick}`);
    }
});
