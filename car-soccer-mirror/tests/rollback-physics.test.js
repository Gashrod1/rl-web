import test from "node:test";
import assert from "node:assert/strict";
import { loadPhysics } from "./helpers/load-physics.js";
import { RollbackSession } from "../assets/rollback.js";
import { quantiseControls } from "../assets/input-codec.js";

const localAt = tick => quantiseControls({
    throttle: Math.sin(tick / 37) > 0 ? 1 : -1,
    steer: Math.sin(tick / 23), pitch: Math.cos(tick / 41), yaw: 0, roll: 0,
    jump: tick % 53 === 0, boost: tick % 7 < 3, handbrake: false
});

// Changes often, so prediction-by-repetition fails frequently and forces rollbacks.
const remoteAt = tick => quantiseControls({
    throttle: Math.cos(tick / 11) > 0 ? 1 : -1,
    steer: Math.sin(tick / 5), pitch: 0, yaw: Math.cos(tick / 9), roll: 0,
    jump: tick % 17 === 0, boost: tick % 3 === 0, handbrake: tick % 61 === 0
});

const TICKS = 2000;

async function straightLine() {
    const sim = await loadPhysics();
    sim.resetKickoff(0);
    for (let tick = 0; tick < TICKS; tick++) {
        sim.setControls(0, localAt(tick));
        sim.setControls(1, remoteAt(tick));
        sim.step(1);
    }
    return Float32Array.from(sim.state);
}

async function rollbackSession() {
    const sim = await loadPhysics();
    sim.calibrateSnapshotRange();
    // Calibration perturbs then restores, so pin the kickoff after it for a clean start.
    sim.resetKickoff(0);

    const session = new RollbackSession({
        saveState: into => sim.saveRegion(into),
        loadState: state => sim.loadRegion(state),
        stepOne: (local, remote) => {
            sim.setControls(0, local);
            sim.setControls(1, remote);
            sim.step(1);
        },
        maxPrediction: 16,
        snapshotInterval: 4
    });
    return { sim, session };
}

test("rollback reproduces a straight-line simulation exactly", async () => {
    const expected = await straightLine();
    const { sim, session } = await rollbackSession();

    // Remote inputs arrive 3 ticks late, the realistic steady state at 31 ms RTT.
    const LATENCY = 3;
    for (let tick = 0; tick < TICKS; tick++) {
        assert.equal(session.advance(localAt(tick)), true, `stalled at tick ${tick}`);
        const arriving = tick - LATENCY;
        if (arriving >= 0) session.receiveRemoteInput(arriving, remoteAt(arriving));
    }
    for (let tick = TICKS - LATENCY; tick < TICKS; tick++) {
        session.receiveRemoteInput(tick, remoteAt(tick));
    }
    session.reconcile();

    assert.ok(session.stats().rollbacks > 50,
        `expected frequent mispredictions, got ${session.stats().rollbacks}`);
    assert.equal(session.confirmedTick, TICKS - 1);
    assert.deepEqual(Array.from(sim.state), Array.from(expected),
        "rollback simulation diverged from the straight-line run");
});

// A human changes input a few times per second, not 120 times. Held for ~20 ticks
// is already brisk play, and it is what the cost budget should actually be judged on.
const HOLD = 20;
const humanRemoteAt = tick => {
    const n = Math.floor(tick / HOLD);
    return quantiseControls({
        throttle: Math.cos(n / 3) > 0 ? 1 : -1,
        steer: Math.sin(n / 2), pitch: 0, yaw: 0, roll: 0,
        jump: n % 7 === 0, boost: n % 3 === 0, handbrake: false
    });
};

async function measureCost(remoteInputAt) {
    const { session } = await rollbackSession();
    const start = performance.now();
    for (let tick = 0; tick < TICKS; tick++) {
        session.advance(localAt(tick));
        if (tick >= 3) session.receiveRemoteInput(tick - 3, remoteInputAt(tick - 3));
    }
    return { perTick: (performance.now() - start) / TICKS, stats: session.stats() };
}

const BUDGET = 1000 / 120; // 8.33 ms

test("rollback cost is small under realistic input", async () => {
    const { perTick, stats } = await measureCost(humanRemoteAt);
    console.log(`    realistic: ${perTick.toFixed(4)} ms/tick, ` +
        `${stats.rollbacks} rollbacks, ${stats.resimulatedTicks} resimulated ticks`);
    assert.ok(stats.rollbacks < TICKS / 4,
        `human-rate input should mispredict rarely, got ${stats.rollbacks} rollbacks`);
    assert.ok(perTick < BUDGET / 8,
        `${perTick.toFixed(3)} ms/tick should stay under an eighth of the ${BUDGET.toFixed(2)} ms budget`);
});

test("rollback cost survives input that changes every tick", async () => {
    // Not reachable by a human -- this is the pathological ceiling, where prediction
    // by repetition is wrong on essentially every tick.
    const { perTick, stats } = await measureCost(remoteAt);
    console.log(`    pathological: ${perTick.toFixed(4)} ms/tick, ` +
        `${stats.rollbacks} rollbacks, ${stats.resimulatedTicks} resimulated ticks`);
    assert.ok(perTick < BUDGET / 3,
        `${perTick.toFixed(3)} ms/tick should stay under a third of the ${BUDGET.toFixed(2)} ms budget`);
});
