import test from "node:test";
import assert from "node:assert/strict";
import { RollbackSession } from "../assets/rollback.js";

// A deterministic stand-in for the physics: state is a single integer, and every
// tick folds both players' throttle into it. Any rollback error shows up as a
// wrong number rather than a subtly wrong car position.
//
// It folds in the *quantised* byte rather than the float, so the fake sim
// distinguishes exactly the inputs the wire distinguishes -- no more, no less.
const asByte = value => Math.round(value * 127);

function fakeSim() {
    const sim = {
        value: 0,
        saveState: () => ({ value: sim.value }),
        loadState: s => { sim.value = s.value; },
        stepOne: (local, remote) => {
            sim.value = (sim.value * 31 + asByte(local.throttle) * 7 + asByte(remote.throttle) * 13) | 0;
        }
    };
    return sim;
}

function makeSession(sim, options = {}) {
    return new RollbackSession({
        saveState: sim.saveState,
        loadState: sim.loadState,
        stepOne: sim.stepOne,
        maxPrediction: 16,
        snapshotInterval: 4,
        ...options
    });
}

// Throttle must stay within [-1, 1]: that is the range the wire encodes, and values
// outside it clamp to the same byte and become indistinguishable to controlsEqual.
const input = throttle => ({
    throttle, steer: 0, pitch: 0, yaw: 0, roll: 0,
    jump: false, boost: false, handbrake: false
});
const third = n => (n % 3) / 2;   // 0, 0.5, 1
const quarter = n => (n % 4) / 3; // 0, 1/3, 2/3, 1
const fifth = n => (n % 5) / 4;

// The reference: simulate straight through with every input known up front.
function reference(localAt, remoteAt, ticks) {
    const sim = fakeSim();
    for (let t = 0; t < ticks; t++) sim.stepOne(localAt(t), remoteAt(t));
    return sim.value;
}

test("with remote input always available, no rollback is needed", () => {
    const sim = fakeSim();
    const session = makeSession(sim);
    for (let t = 0; t < 100; t++) {
        session.receiveRemoteInput(t, input(fifth(t)));
        assert.equal(session.advance(input(third(t))), true);
    }
    assert.equal(session.stats().rollbacks, 0);
    assert.equal(sim.value, reference(t => input(third(t)), t => input(fifth(t)), 100));
});

test("a correct prediction confirms without rolling back", () => {
    const sim = fakeSim();
    const session = makeSession(sim);
    // The opponent holds the same input throughout, so repeating it always predicts right.
    for (let t = 0; t < 50; t++) {
        session.advance(input(1));
        session.receiveRemoteInput(t, input(0));
    }
    assert.equal(session.stats().rollbacks, 0);
});

test("a mispredicted tick is corrected to match a straight-line run", () => {
    const sim = fakeSim();
    const session = makeSession(sim);
    const localAt = t => input(third(t));
    const remoteAt = t => input(t % 7 === 0 ? 1 : 0); // changes often, so prediction fails often

    for (let t = 0; t < 200; t++) {
        session.advance(localAt(t));
        // Remote input arrives 3 ticks late -- the prediction window.
        if (t >= 3) session.receiveRemoteInput(t - 3, remoteAt(t - 3));
    }
    // Deliver the tail so everything can be confirmed.
    for (let t = 197; t < 200; t++) session.receiveRemoteInput(t, remoteAt(t));
    session.reconcile();

    assert.ok(session.stats().rollbacks > 0, "this input pattern should mispredict");
    assert.equal(session.confirmedTick, 199);
    assert.equal(sim.value, reference(localAt, remoteAt, 200),
        "rolled-back simulation diverged from the straight-line run");
});

test("out-of-order and duplicate arrivals are handled", () => {
    const sim = fakeSim();
    // This test deliberately runs 60 ticks with nothing arriving, to reorder the
    // whole match at once. The window is widened so the stall guard -- exercised
    // by its own test below -- does not cut the run short.
    const session = makeSession(sim, { maxPrediction: 64 });
    const localAt = t => input(third(t));
    const remoteAt = t => input(quarter(t));

    for (let t = 0; t < 60; t++) {
        assert.equal(session.advance(localAt(t)), true, `stalled at tick ${t}`);
    }
    // Deliver backwards, with every input sent twice.
    for (let t = 59; t >= 0; t--) {
        session.receiveRemoteInput(t, remoteAt(t));
        session.receiveRemoteInput(t, remoteAt(t));
    }
    session.reconcile();

    assert.equal(session.confirmedTick, 59);
    assert.equal(sim.value, reference(localAt, remoteAt, 60));
});

test("a lost packet recovered by redundancy does not stall", () => {
    const sim = fakeSim();
    const session = makeSession(sim);
    const localAt = t => input(third(t));
    const remoteAt = t => input(quarter(t));

    for (let t = 0; t < 100; t++) {
        assert.equal(session.advance(localAt(t)), true, `stalled at tick ${t}`);
        // Every third packet is "lost", but each packet carries the last 4 inputs,
        // so the next one still delivers what the lost one held.
        if (t >= 2 && t % 3 !== 0) {
            for (let k = Math.max(0, t - 5); k <= t - 2; k++) {
                session.receiveRemoteInput(k, remoteAt(k));
            }
        }
    }
    for (let t = 90; t < 100; t++) session.receiveRemoteInput(t, remoteAt(t));
    session.reconcile();
    assert.equal(sim.value, reference(localAt, remoteAt, 100));
});

test("advance stalls once the prediction window is exhausted", () => {
    const sim = fakeSim();
    const session = makeSession(sim);
    for (let t = 0; t < 16; t++) {
        assert.equal(session.advance(input(1)), true, `should not stall at tick ${t}`);
    }
    assert.equal(session.advance(input(1)), false, "should stall past maxPrediction");
    assert.equal(session.stats().stalls, 1);

    // Once the opponent catches up, it resumes.
    for (let t = 0; t < 16; t++) session.receiveRemoteInput(t, input(0));
    assert.equal(session.advance(input(1)), true);
});

test("remote input arriving before we simulate the tick needs no prediction", () => {
    const sim = fakeSim();
    const session = makeSession(sim);
    for (let t = 0; t < 30; t++) session.receiveRemoteInput(t, input(quarter(t)));
    for (let t = 0; t < 30; t++) session.advance(input(third(t)));
    session.reconcile();
    assert.equal(session.stats().rollbacks, 0);
    assert.equal(session.confirmedTick, 29);
});
