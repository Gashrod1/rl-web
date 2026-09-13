import { loadPhysics } from "./helpers/load-physics.js";
import { RollbackSession } from "../assets/rollback.js";
import { quantiseControls } from "../assets/input-codec.js";

const localAt = tick => quantiseControls({
    throttle: Math.sin(tick / 37) > 0 ? 1 : -1,
    steer: Math.sin(tick / 23), pitch: Math.cos(tick / 41), yaw: 0, roll: 0,
    jump: tick % 53 === 0, boost: tick % 7 < 3, handbrake: false
});
const PATHOLOGICAL = process.argv[2] !== "realistic";

// Pathological: the opponent's input changes every single tick, so prediction
// by repetition is wrong almost always.
const pathologicalRemote = tick => quantiseControls({
    throttle: Math.cos(tick / 11) > 0 ? 1 : -1,
    steer: Math.sin(tick / 5), pitch: 0, yaw: Math.cos(tick / 9), roll: 0,
    jump: tick % 17 === 0, boost: tick % 3 === 0, handbrake: tick % 61 === 0
});

// Realistic: a human changes input a few times per second, not 120 times.
// Inputs are held for ~20 ticks (~6 changes/second), which is already brisk play.
const HOLD = 20;
const realisticRemote = tick => {
    const n = Math.floor(tick / HOLD);
    return quantiseControls({
        throttle: Math.cos(n / 3) > 0 ? 1 : -1,
        steer: Math.sin(n / 2), pitch: 0, yaw: 0, roll: 0,
        jump: n % 7 === 0, boost: n % 3 === 0, handbrake: false
    });
};
const remoteAt = tick => PATHOLOGICAL ? pathologicalRemote(tick) : realisticRemote(tick);

const sim = await loadPhysics();
const region = sim.calibrateSnapshotRange();
sim.resetKickoff(0);
console.log("region bytes:", ((region.end - region.start) / 1048576).toFixed(2), "MB");

const t = { save: 0, load: 0, step: 0, saveN: 0, loadN: 0, stepN: 0 };
const session = new RollbackSession({
    saveState: into => { const a = performance.now(); const r = sim.saveRegion(into); t.save += performance.now() - a; t.saveN++; return r; },
    loadState: s => { const a = performance.now(); sim.loadRegion(s); t.load += performance.now() - a; t.loadN++; },
    stepOne: (l, r) => {
        const a = performance.now();
        sim.setControls(0, l); sim.setControls(1, r); sim.step(1);
        t.step += performance.now() - a; t.stepN++;
    },
    maxPrediction: 16, snapshotInterval: 4
});

const TICKS = 2000;
const start = performance.now();
for (let tick = 0; tick < TICKS; tick++) {
    session.advance(localAt(tick));
    if (tick >= 3) session.receiveRemoteInput(tick - 3, remoteAt(tick - 3));
}
const total = performance.now() - start;

const ms = v => v.toFixed(1).padStart(8);
console.log(`total          ${ms(total)} ms  (${(total / TICKS).toFixed(4)} ms/tick)`);
console.log(`  saveRegion   ${ms(t.save)} ms  ${String(t.saveN).padStart(6)} calls  ${(t.save / t.saveN).toFixed(4)} ms each`);
console.log(`  loadRegion   ${ms(t.load)} ms  ${String(t.loadN).padStart(6)} calls  ${(t.load / t.loadN).toFixed(4)} ms each`);
console.log(`  step         ${ms(t.step)} ms  ${String(t.stepN).padStart(6)} calls  ${(t.step / t.stepN).toFixed(4)} ms each`);
console.log(`  bookkeeping  ${ms(total - t.save - t.load - t.step)} ms`);
console.log("stats", session.stats());
