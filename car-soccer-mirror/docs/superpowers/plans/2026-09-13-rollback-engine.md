# Rollback Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace delay-based lockstep with rollback netcode so online 1v1 has zero local input lag.

**Architecture:** A dependency-injected `RollbackSession` predicts the opponent's input, simulates immediately, and resimulates from a heap snapshot when a prediction turns out wrong. Transport switches to binary frames carrying redundant inputs. The existing lockstep path stays behind a runtime flag.

**Tech Stack:** Plain ES modules, no build step. Tests use Node 22's `node:test`.

**Scope:** Stages 2-4 of [the rollback netcode spec](../specs/2026-09-13-rollback-netcode-design.md). Stages 0-1 are done — see [the measurement report](../measurements/2026-09-13-snapshot-cost.md).

---

## What the measurements changed

The [gate](../measurements/2026-09-13-snapshot-cost.md) passed with room to spare, and two numbers reshape the design:

- **`step()` costs 0.0071 ms.** Resimulating the whole 16-tick prediction window costs 0.11 ms — less than one full-heap snapshot. Resimulation is effectively free; snapshots are the expensive side.
- **A 16-slot per-tick ring would be 27 MB**, over budget. So: **snapshot every 4 ticks** into a 6-slot ring (~10 MB) and resimulate up to 3 extra ticks. Three times less memory for 0.02 ms more.

Only 17 of 258 heap pages ever mutate, spanning pages 0..26 **non-contiguously**, and a 36000-tick soak showed the set is stable from the first round. The range is therefore derived at runtime by calibration, never hardcoded.

## Deviation from the spec: the relay changes after all

The spec said the relay server needs no modification. That assumed payloads stay JSON. They should not: the relay does `JSON.parse` on every frame, at 120 Hz from two clients. Keeping JSON would mean base64-encoding the binary packet (29 bytes becomes 40 characters, plus JSON envelope), so the encoding would cost more than it saves.

Forwarding binary frames verbatim is **four lines** in `server.js` and removes both the base64 overhead and the parse. The cost is that the relay must be redeployed to the VPS alongside the client — which happens anyway.

## File Structure

| File | Responsibility |
|---|---|
| `assets/input-codec.js` | **New.** Quantise controls to 8-bit, encode/decode the binary packet. Pure functions. |
| `assets/rollback.js` | **New.** `RollbackSession`. Prediction, reconciliation, snapshot ring. Knows nothing about WASM or sockets. |
| `assets/physics-core.js` | **Modified.** Calibrate the mutable heap range; `saveRegion`/`loadRegion`. |
| `assets/net-match.js` | **Modified.** Binary transport, redundant inputs, no input delay. |
| `assets/game-CEDHMqQk.js` | **Modified.** `tickOnlineRollback`, presentation gated on confirmed ticks, netcode flag. |
| `multiplayer-server/server.js` | **Modified.** Forward binary frames verbatim. |
| `tests/input-codec.test.js`, `tests/rollback.test.js`, `tests/rollback-physics.test.js` | **New.** |

### Facts verified against the current code

- `tickOnline` is at **line 34320**; it is called from `Jb.update` (line 20564), which invokes the callback once per due tick and maintains `prevState`/`currState` for render interpolation. Rollback fits inside that contract — no stepper rewrite.
- The match state machine is `class PB` at **line 32860**. Its entire state is `this.state` (a flat object of primitives) plus `remaining`, `overtimeTicks`, `phaseTicks`, `clockStarted`. Save/restore is a shallow copy of five things.
- Local input is sampled at **line 34570** (`liveInput = Tn`) once per rendered frame, and read by `tickOnline` at line 34323.
- `qeOnline` (line 34290) performs the kickoff reset **and** the presentation resets (audio serials, ball trail, camera). Task 8 splits those.
- `PhysicsSim.saveState`/`loadState` (full heap) already exist and are proven by `tests/physics-core.test.js`. This plan adds a narrower region path beside them; it does not replace them.

---

## Task 1: Input quantisation and binary codec

Quantisation is a determinism hazard, not a bandwidth optimisation: if the local simulation is fed the raw float while the opponent's is fed the 8-bit value, the two worlds diverge slowly. This task makes the quantised value the *only* value either side ever sees.

**Files:**
- Create: `assets/input-codec.js`
- Create: `tests/input-codec.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/input-codec.test.js`:

```js
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
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm test
```

Expected: FAIL — `Cannot find module '../assets/input-codec.js'`.

- [ ] **Step 3: Write the implementation**

Create `assets/input-codec.js`:

```js
// Controls travel as 8-bit quantised values. The local simulation is fed the same
// quantised value the opponent receives, so both worlds step on identical numbers --
// feeding the raw float locally would diverge the two simulations slowly.

const AXES = ["throttle", "steer", "pitch", "yaw", "roll"];
const FLAGS = ["jump", "boost", "handbrake"];
const BYTES_PER_INPUT = AXES.length + 1;
const HEADER_BYTES = 5; // uint32 newest tick + uint8 count

const toByte = value => Math.max(-127, Math.min(127, Math.round(value * 127)));
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
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test
```

Expected: PASS — 9 tests (4 existing + 5 new).

- [ ] **Step 5: Commit**

```bash
git add assets/input-codec.js tests/input-codec.test.js
git commit -m "Add 8-bit input quantisation and binary packet codec"
```

---

## Task 2: The rollback engine, against a fake simulation

The engine is tested against a trivial deterministic simulation first. A rollback bug there produces an obvious integer mismatch, with no WASM and no network in the picture — which is why this comes before Task 4.

**Files:**
- Create: `assets/rollback.js`
- Create: `tests/rollback.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/rollback.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { RollbackSession } from "../assets/rollback.js";

// A deterministic stand-in for the physics: state is a single integer, and every
// tick folds both players' throttle into it. Any rollback error shows up as a
// wrong number rather than a subtly wrong car position.
function fakeSim() {
    const sim = {
        value: 0,
        saveState: () => ({ value: sim.value }),
        loadState: s => { sim.value = s.value; },
        stepOne: (local, remote) => {
            sim.value = (sim.value * 31 + local.throttle * 7 + remote.throttle * 13) | 0;
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

const input = throttle => ({
    throttle, steer: 0, pitch: 0, yaw: 0, roll: 0,
    jump: false, boost: false, handbrake: false
});

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
        session.receiveRemoteInput(t, input(t % 5));
        assert.equal(session.advance(input(t % 3)), true);
    }
    assert.equal(session.stats().rollbacks, 0);
    assert.equal(sim.value, reference(t => input(t % 3), t => input(t % 5), 100));
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
    const localAt = t => input(t % 3);
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
    const session = makeSession(sim);
    const localAt = t => input(t % 3);
    const remoteAt = t => input(t % 4);

    for (let t = 0; t < 60; t++) session.advance(localAt(t));
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
    const localAt = t => input(t % 3);
    const remoteAt = t => input(t % 4);

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
    for (let t = 0; t < 30; t++) session.receiveRemoteInput(t, input(t % 4));
    for (let t = 0; t < 30; t++) session.advance(input(t % 3));
    assert.equal(session.stats().rollbacks, 0);
    assert.equal(session.confirmedTick, 29);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test
```

Expected: FAIL — `Cannot find module '../assets/rollback.js'`.

- [ ] **Step 3: Write the engine**

Create `assets/rollback.js`:

```js
import { controlsEqual } from "./input-codec.js";

const NEUTRAL = Object.freeze({
    throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0,
    jump: false, boost: false, handbrake: false
});

// Delay-based lockstep hides network latency by delaying your own input.
// Rollback hides it by guessing the opponent's: simulate immediately with a
// predicted input, and when the real one arrives, rewind and replay if the
// guess was wrong. Your own car therefore never lags.
export class RollbackSession {
    constructor({ saveState, loadState, stepOne, maxPrediction = 16, snapshotInterval = 4 }) {
        this._saveState = saveState;
        this._loadState = loadState;
        this._stepOne = stepOne;
        this.maxPrediction = maxPrediction;
        this.snapshotInterval = snapshotInterval;
        this.currentTick = 0;
        this.confirmedTick = -1;
        this._local = new Map();    // tick -> controls we used for ourselves
        this._remote = new Map();   // tick -> real opponent controls, from the network
        this._used = new Map();     // tick -> opponent controls we actually simulated
        this._snapshots = [];       // { tick, state }, oldest first
        this._rollbacks = 0;
        this._stalls = 0;
        this._resimulated = 0;
    }

    stats() {
        return {
            rollbacks: this._rollbacks,
            stalls: this._stalls,
            resimulatedTicks: this._resimulated,
            prediction: this.currentTick - 1 - this.confirmedTick
        };
    }

    receiveRemoteInput(tick, controls) {
        if (tick <= this.confirmedTick) return; // already settled; a duplicate
        this._remote.set(tick, controls);
    }

    // The opponent controls actually simulated for a tick, predicted or real.
    // The renderer needs these to drive the opponent car's visuals and audio.
    remoteControlsAt(tick) {
        return this._used.get(tick);
    }

    // The opponent's input for a tick we have not heard about: repeat their most
    // recent known input. At 120 Hz a car's controls rarely change tick to tick,
    // so this is right most of the time.
    _predict(tick) {
        const known = this._remote.get(tick);
        if (known !== undefined) return known;
        for (let t = tick - 1; t >= 0 && t >= tick - this.maxPrediction * 2; t--) {
            const earlier = this._remote.get(t);
            if (earlier !== undefined) return earlier;
        }
        return NEUTRAL;
    }

    _snapshotFor(tick) {
        let best = null;
        for (const entry of this._snapshots) {
            if (entry.tick <= tick && (best === null || entry.tick > best.tick)) best = entry;
        }
        return best;
    }

    _takeSnapshot() {
        if (this.currentTick % this.snapshotInterval !== 0) return;
        const keep = Math.ceil(this.maxPrediction / this.snapshotInterval) + 2;
        const recycled = this._snapshots.length >= keep ? this._snapshots.shift() : null;
        this._snapshots.push({
            tick: this.currentTick,
            state: this._saveState(recycled ? recycled.state : null)
        });
    }

    // Apply everything newly known about the opponent, rewinding if we guessed wrong.
    reconcile() {
        let mismatch = null;
        let tick = this.confirmedTick + 1;
        while (tick < this.currentTick) {
            const real = this._remote.get(tick);
            if (real === undefined) break;
            if (!controlsEqual(real, this._used.get(tick))) { mismatch = tick; break; }
            this.confirmedTick = tick;
            tick++;
        }
        if (mismatch === null) { this._forget(); return false; }

        const snapshot = this._snapshotFor(mismatch);
        if (snapshot === null) {
            // The ring does not reach back far enough. Bounded by maxPrediction, so
            // this means an invariant broke rather than a slow network.
            throw new Error(`rollback: no snapshot at or before tick ${mismatch}`);
        }

        this._loadState(snapshot.state);
        const target = this.currentTick;
        this.currentTick = snapshot.tick;
        this._snapshots = this._snapshots.filter(e => e.tick <= snapshot.tick);
        while (this.currentTick < target) {
            this._simulateOne(this._local.get(this.currentTick) ?? NEUTRAL);
            this._resimulated++;
        }
        this._rollbacks++;

        // Re-walk the confirmed cursor now that the used inputs are the real ones.
        tick = this.confirmedTick + 1;
        while (tick < this.currentTick && this._remote.has(tick)
               && controlsEqual(this._remote.get(tick), this._used.get(tick))) {
            this.confirmedTick = tick;
            tick++;
        }
        this._forget();
        return true;
    }

    _simulateOne(localControls) {
        const remoteControls = this._predict(this.currentTick);
        this._local.set(this.currentTick, localControls);
        this._used.set(this.currentTick, remoteControls);
        this._takeSnapshot();
        this._stepOne(localControls, remoteControls);
        this.currentTick++;
    }

    // Advance one tick. Returns false only when the opponent has fallen so far
    // behind that predicting further would make a rollback unaffordable.
    advance(localControls) {
        this.reconcile();
        if (this.currentTick - this.confirmedTick > this.maxPrediction) {
            this._stalls++;
            return false;
        }
        this._simulateOne(localControls);
        return true;
    }

    _forget() {
        const horizon = this.confirmedTick - this.maxPrediction - this.snapshotInterval * 2;
        if (horizon < 0) return;
        for (const map of [this._local, this._remote, this._used]) {
            for (const tick of map.keys()) if (tick < horizon) map.delete(tick);
        }
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test
```

Expected: PASS — 16 tests. If "a mispredicted tick is corrected" fails, print `sim.value` against the reference at each tick to find the first divergent tick; the bug is almost always in `_predict` using knowledge from the wrong point in time.

- [ ] **Step 5: Commit**

```bash
git add assets/rollback.js tests/rollback.test.js
git commit -m "Add RollbackSession engine with prediction and reconciliation"
```

---

## Task 3: Calibrate the mutable heap region

The measurement found only 17 of 258 pages ever change, spanning pages 0..26. Those numbers belong to this build of the WASM module, not to the design, so the engine derives them at runtime.

**Files:**
- Modify: `assets/physics-core.js`
- Modify: `tests/physics-core.test.js`

- [ ] **Step 1: Write the failing test**

Append to `tests/physics-core.test.js`:

```js
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
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test
```

Expected: FAIL — `sim.calibrateSnapshotRange is not a function`.

- [ ] **Step 3: Implement calibration and region snapshots**

In `assets/physics-core.js`, inside `class Wb`, add after `loadState(e)`:

```js
    // Only a small part of the heap changes once the arena is built -- the rest is
    // static data and the frozen collision BVH. Finding that part at runtime turns a
    // 16 MB copy into a ~2 MB one. The page numbers are a property of this build, so
    // they are measured rather than assumed.
    calibrateSnapshotRange({ steps = 400, marginPages = 8 } = {}) {
        const PAGE = 65536,
            e = this.saveState(),
            t = {
                throttle: 1, steer: .5, pitch: -.5, yaw: .25, roll: -.25,
                jump: !0, boost: !0, handbrake: !1
            };
        for (let l = 0; l < steps; l++) {
            this.setControls(0, t), this.setControls(1, t);
            if (l % 97 === 0) this.resetKickoff(l % 8 | 0);
            this.step(1), this.pollGoal()
        }
        const n = this.module.HEAPU8,
            r = n.length / PAGE;
        let s = -1,
            a = -1;
        for (let l = 0; l < r; l++) {
            const A = l * PAGE,
                c = A + PAGE;
            for (let h = A; h < c; h++)
                if (n[h] !== e[h]) {
                    s < 0 && (s = l), a = l;
                    break
                }
        }
        this.loadState(e);
        if (s < 0) throw new Error("Snapshot calibration found no mutable memory");
        const o = Math.max(0, s - marginPages),
            d = Math.min(r, a + 1 + marginPages);
        return this.snapshotRange = {
            start: o * PAGE,
            end: d * PAGE
        }, this.snapshotRange
    }
    saveRegion(into = null) {
        if (!this.snapshotRange) throw new Error("calibrateSnapshotRange() must run first");
        const {
            start: e,
            end: t
        } = this.snapshotRange, n = this.module.HEAPU8.subarray(e, t);
        if (into && into.length === n.length) return into.set(n), into;
        return n.slice()
    }
    loadRegion(e) {
        if (!this.snapshotRange) throw new Error("calibrateSnapshotRange() must run first");
        this.module.HEAPU8.set(e, this.snapshotRange.start),
            this.stateView = null, this.controlsView = null, this.viewView = null
    }
```

Then add `v(this, "snapshotRange", null);` to the constructor, alongside the other field declarations.

Three details worth noting:

- The margin of 8 pages on each side is cheap insurance. The soak found the dirty set stable from the first round, but a margin costs 0.5 MB and protects against a page the calibration workload happens not to touch.
- Calibration **perturbs the simulation on purpose** (it drives, collides and resets kickoffs to make pages dirty) and then restores the full-heap snapshot it took first. It must therefore run before a match starts, not during one.
- It throws rather than falling back if nothing is dirty. Silently snapshotting an empty region would produce a rollback that restores nothing, which would look like a physics bug much later.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test
```

Expected: PASS — 18 tests.

- [ ] **Step 5: Commit**

```bash
git add assets/physics-core.js tests/physics-core.test.js
git commit -m "Calibrate the mutable heap region for cheap snapshots"
```

---

## Task 4: The engine against the real physics

Task 2 proved the bookkeeping. This proves the whole thing against the real simulation, which is where a wrong assumption about WASM state would show up.

**Files:**
- Create: `tests/rollback-physics.test.js`

- [ ] **Step 1: Write the test**

Create `tests/rollback-physics.test.js`:

```js
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

test("rollback reproduces a straight-line simulation exactly", async () => {
    const expected = await straightLine();

    const sim = await loadPhysics();
    sim.resetKickoff(0);
    sim.calibrateSnapshotRange();
    // Calibration perturbs then restores, so re-pin the kickoff for a clean start.
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

test("rollback cost stays within the tick budget", async () => {
    const sim = await loadPhysics();
    sim.resetKickoff(0);
    sim.calibrateSnapshotRange();
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

    const start = performance.now();
    for (let tick = 0; tick < TICKS; tick++) {
        session.advance(localAt(tick));
        if (tick >= 3) session.receiveRemoteInput(tick - 3, remoteAt(tick - 3));
    }
    const perTick = (performance.now() - start) / TICKS;

    assert.ok(perTick < 8.33 / 4,
        `${perTick.toFixed(3)} ms per tick should stay under a quarter of the 8.33 ms budget`);
});
```

- [ ] **Step 2: Run the tests**

```bash
npm test
```

Expected: PASS — 20 tests.

**If the first test fails, stop.** The engine is proven correct by Task 2, so a failure here means the physics has state the region snapshot does not capture. Diagnose by raising `marginPages` to cover the whole heap (`marginPages: 512`): if it then passes, calibration is missing pages; if it still fails, the state is outside linear memory and the design needs revisiting.

- [ ] **Step 3: Commit**

```bash
git add tests/rollback-physics.test.js
git commit -m "Prove rollback matches straight-line simulation on the real physics"
```

---

## Task 5: Save and restore the match state machine

Score, phase and clock are simulation state: a goal scored on a predicted tick must un-score if the prediction was wrong.

**Files:**
- Modify: `assets/game-CEDHMqQk.js` (add two methods to `class PB`, line 32860)
- Create: `tests/match-state.test.js`

- [ ] **Step 1: Extract nothing — test through a copy of the shape**

`class PB` lives in the bundle and is not exported, so the test asserts the contract rather than importing the class. Create `tests/match-state.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// PB is not exported from the bundle, so this asserts the save/restore methods exist
// and cover every mutable field. A field added to PB later without being added to
// snapshot() would silently fail to roll back, so the check is on the field list.
const source = readFileSync("assets/game-CEDHMqQk.js", "utf8");
const PB = source.slice(source.indexOf("class PB {"), source.indexOf("class PB {") + 4000);

test("PB has snapshot and restore", () => {
    assert.ok(/snapshot\(\)\s*\{/.test(PB), "PB.snapshot() is missing");
    assert.ok(/restore\(/.test(PB), "PB.restore() is missing");
});

test("PB.snapshot covers every mutable field", () => {
    const snapshot = PB.slice(PB.indexOf("snapshot()"), PB.indexOf("restore("));
    for (const field of ["state", "remaining", "overtimeTicks", "phaseTicks", "clockStarted"]) {
        assert.ok(snapshot.includes(field), `snapshot() does not capture "${field}"`);
    }
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test
```

Expected: FAIL — `PB.snapshot() is missing`.

- [ ] **Step 3: Add the methods**

In `assets/game-CEDHMqQk.js`, in `class PB`, add after `leave()`:

```js
    snapshot() {
        return {
            state: {
                ...this.state
            },
            remaining: this.remaining,
            overtimeTicks: this.overtimeTicks,
            phaseTicks: this.phaseTicks,
            clockStarted: this.clockStarted
        }
    }
    restore(e) {
        Object.assign(this.state, e.state), this.remaining = e.remaining,
            this.overtimeTicks = e.overtimeTicks, this.phaseTicks = e.phaseTicks,
            this.clockStarted = e.clockStarted
    }
```

`restore` uses `Object.assign` rather than replacing `this.state`, because the HUD holds a reference to that object (`he.update(a.state)`) and would otherwise keep rendering a detached copy.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test
```

Expected: PASS — 22 tests.

- [ ] **Step 5: Commit**

```bash
git add assets/game-CEDHMqQk.js tests/match-state.test.js
git commit -m "Add snapshot/restore to the match state machine"
```

---

## Task 6: Binary transport with redundant inputs

**Files:**
- Modify: `assets/net-match.js`
- Modify: `multiplayer-server/server.js`

- [ ] **Step 1: Forward binary frames in the relay**

In `multiplayer-server/server.js`, change the message handler signature and add a binary branch at the top:

```js
    ws.on("message", (data, isBinary) => {
        // In-match input packets are binary and opaque: forward them verbatim rather
        // than paying JSON.parse on every frame at 120 Hz from both clients.
        if (isBinary) {
            const room = rooms.get(ws.roomCode);
            if (!room || !room.guest) return;
            const other = ws.role === "host" ? room.guest : room.host;
            if (other && other.readyState === other.OPEN) {
                if (RELAY_DELAY_MS > 0) setTimeout(() => other.send(data, { binary: true }), RELAY_DELAY_MS);
                else other.send(data, { binary: true });
            }
            return;
        }

        let message;
```

Leave the rest of the handler unchanged. Room creation, joining and the JSON `relay` path (still used for the seed handshake and drift fingerprints) keep working exactly as before.

- [ ] **Step 2: Verify the relay still handles the JSON path**

```bash
node multiplayer-server/server.js &
node multiplayer-server/test/manual-test.js
```

Expected: the existing manual test still prints `created`, `matched` and the two relayed `hello` payloads. Stop the server afterwards.

- [ ] **Step 3: Rewrite the client transport**

In `assets/net-match.js`, add the import at the top:

```js
import { quantiseControls, encodePacket, decodePacket } from "./input-codec.js";
```

Replace the input-delay constants:

```js
const TICK_MS = 1000 / 120;
// Rollback needs no input delay: the local input is applied on the tick it is
// sampled. These remain only for the lockstep fallback path.
const DEFAULT_INPUT_DELAY = 24;
const MIN_INPUT_DELAY = 8;
const MAX_INPUT_DELAY = 40;
const INPUT_DELAY_MARGIN = 6;
// How many past inputs ride along in each packet. A dropped packet is covered by
// the next one, so a loss costs nothing instead of stalling the simulation.
const INPUT_REDUNDANCY = 4;
```

Set the socket to binary mode in `connect()`, immediately after constructing the WebSocket:

```js
            this.ws = new WebSocket(this.url);
            this.ws.binaryType = "arraybuffer";
```

Add a binary branch at the top of `_handleMessage`:

```js
    _handleMessage(event) {
        if (event.data instanceof ArrayBuffer) {
            const { newestTick, inputs } = decodePacket(event.data);
            const oldestTick = newestTick - inputs.length + 1;
            inputs.forEach((controls, i) => this.onRemoteInput?.(oldestTick + i, controls));
            return;
        }
        let message;
```

Add `this.onRemoteInput = null;` and `this.recentLocal = [];` to the constructor, then add the sender:

```js
    // Sends the input for `tick` plus the previous INPUT_REDUNDANCY-1 inputs.
    sendRollbackInput(tick, controls) {
        const snapshot = quantiseControls(controls);
        this.recentLocal.push(snapshot);
        if (this.recentLocal.length > INPUT_REDUNDANCY) this.recentLocal.shift();
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return snapshot;
        this.ws.send(encodePacket(tick, this.recentLocal));
        return snapshot;
    }
```

`sendRollbackInput` returns the quantised controls so the caller feeds the simulation the same value the opponent will receive. That return value is the determinism guarantee from Task 1 — the raw float must not reach the simulation.

Leave `sendLocalTick`, `getControlsForTick` and `getLocalControlsForTick` untouched: the lockstep fallback path still uses them.

- [ ] **Step 4: Verify nothing regressed**

```bash
npm test
```

Expected: PASS — 22 tests (this task adds no tests; Task 10 verifies the transport live).

- [ ] **Step 5: Commit**

```bash
git add assets/net-match.js multiplayer-server/server.js
git commit -m "Add binary transport with redundant inputs"
```

---

## Task 7: Wire the game to the rollback engine

**Files:**
- Modify: `assets/game-CEDHMqQk.js`

- [ ] **Step 1: Add the netcode flag**

Next to `ONLINE_SERVER_URL` (line 34275), add:

```js
    // The delay-based lockstep path stays available: if rollback misbehaves in a real
    // match, ?netcode=lockstep switches back without a rebuild or redeploy.
    const NETCODE_MODE = new URLSearchParams(location.search).get("netcode") === "lockstep" ? "lockstep" : "rollback";
```

- [ ] **Step 2: Import the engine**

Add to the import block at the top of the file, beside the `net-match.js` import:

```js
import { RollbackSession } from "./rollback.js";
```

- [ ] **Step 3: Declare the session and build it at match start**

Beside `netMatch = null;` (around line 34352), add:

```js
    let rollbackSession = null;
```

In `startOnlineMatch` (line 34344), after `n.configureCars("default", !0)` and before `a.start()`, add:

```js
        rollbackSession = null;
        if (NETCODE_MODE === "rollback") {
            n.calibrateSnapshotRange();
            rollbackSession = new RollbackSession({
                saveState: into => ({
                    heap: n.saveRegion(into ? into.heap : null),
                    match: a.snapshot()
                }),
                loadState: state => {
                    n.loadRegion(state.heap);
                    a.restore(state.match);
                },
                stepOne: (local, remote) => {
                    n.setControls(myCar, local);
                    n.setControls(foeCar, remote);
                    n.step(1);
                    const st = n.state;
                    a.tick({
                        goal: n.pollGoal(),
                        ballOnGround: n.ballOnGround,
                        kickoffTouched: Math.abs(st[ct.BALL]) + Math.abs(st[ct.BALL + 1]) > 1 || Math.hypot(st[ct.BALL + 12], st[ct.BALL + 13]) > 1
                    });
                },
                maxPrediction: 16,
                snapshotInterval: 4
            });
            netMatch.onRemoteInput = (tick, controls) => rollbackSession.receiveRemoteInput(tick, controls);
        }
```

The heap and the match state are saved and restored **together**, as one unit. Keeping them in separate rings would let them drift out of step after a rollback, which would show up as a score that disagrees with the simulation.

Note `stepOne` calls `a.tick()` but ignores its return value. Kickoff transitions are a presentation concern and are handled in Task 8, on confirmed ticks only.

- [ ] **Step 4: Add the rollback tick function**

Immediately after `tickOnline` (line 34338), add:

```js
    const tickOnlineRollback = () => {
        if (a.state.paused || a.state.phase === "ended" || u) return !1;
        const nm = netMatch,
            rs = rollbackSession,
            tick = rs.currentTick;
        // Quantise once, here: the value sent to the opponent and the value fed to the
        // local simulation must be the same, or the two worlds diverge slowly.
        const quantised = nm.sendRollbackInput(tick, liveInput);
        if (!rs.advance(quantised)) return !1;
        xe = quantised;
        A = rs.remoteControlsAt(tick) ?? A;
        if (rs.confirmedTick >= 0 && rs.confirmedTick % 60 === 0 && rs.confirmedTick !== lastDriftTick) {
            lastDriftTick = rs.confirmedTick;
            nm.recordAndSendDrift(rs.confirmedTick, onlineDriftValues())
        }
        return !0
    };
```

And declare the drift cursor beside `rollbackSession`:

```js
    let lastDriftTick = -1;
```

Drift fingerprints are taken on **confirmed** ticks only. Predicted state legitimately differs between the two clients, so fingerprinting the current tick would report a desync on every single comparison.

- [ ] **Step 5: Route the render loop through it**

At line 34632, change the tick-callback selection from:

```js
a.state.mode === "match" ? (netMatch ? tickOnline : Ye) : void 0
```

to:

```js
a.state.mode === "match" ? (netMatch ? (rollbackSession ? tickOnlineRollback : tickOnline) : Ye) : void 0
```

- [ ] **Step 6: Clear the session when the match ends**

In `endOnlineMatch` (line 34278), and in the `onLeave` handler (around line 34418), add `rollbackSession = null;` next to the existing `netMatch = null;`.

- [ ] **Step 7: Verify the game still loads**

```bash
node --check assets/game-CEDHMqQk.js && npm test
```

Expected: parses, 22 tests pass. Then load `http://localhost:5175` and confirm a solo match still plays — this task touched the shared render loop, so solo is a real regression risk.

- [ ] **Step 8: Commit**

```bash
git add assets/game-CEDHMqQk.js
git commit -m "Wire online play to the rollback engine behind a netcode flag"
```

---

## Task 8: Fire presentation effects only on confirmed ticks

Resimulation replays ticks that already happened. Anything with an effect outside the simulation — a sound, a trail reset, a camera reset — must not fire again during a replay.

**Files:**
- Modify: `assets/game-CEDHMqQk.js`

- [ ] **Step 1: Split the kickoff handler**

`qeOnline` (line 34290) currently does both the simulation reset and the presentation reset. The lockstep path still calls it (`tt && qeOnline()` in `tickOnline`), so it must keep working unchanged — split the halves out and leave `qeOnline` as their composition.

Change the leading statement of the existing `qeOnline` body from

```js
        n.resetKickoff(netMatch.nextKickoffIndex(KICKOFF_VARIANT_INDICES)), _(), p();
```

to

```js
        _(), p();
```

and rename the function to `qeOnlinePresentation`. Then add, immediately after it:

```js
    // Called from inside the rollback step, so it replays identically on a rewind.
    const qeOnlineSimulation = () => {
        n.resetKickoff(netMatch.nextKickoffIndex(KICKOFF_VARIANT_INDICES))
    };
    // The lockstep path does both halves back to back, exactly as before.
    const qeOnline = () => {
        qeOnlineSimulation(), qeOnlinePresentation()
    };
```

Declaration order matters here: all three are `const` arrow functions, so `qeOnline` must appear after the two it calls, and all three before `startOnlineMatch` (line 34344), which calls `qeOnline` at match start.

- [ ] **Step 2: Drive the kickoff from inside the step**

In the `stepOne` added in Task 7, capture the phase transition:

```js
                    if (a.tick({
                        goal: n.pollGoal(),
                        ballOnGround: n.ballOnGround,
                        kickoffTouched: Math.abs(st[ct.BALL]) + Math.abs(st[ct.BALL + 1]) > 1 || Math.hypot(st[ct.BALL + 12], st[ct.BALL + 13]) > 1
                    }) === "kickoff") qeOnlineSimulation();
```

The kickoff index comes from the shared PRNG, which advances once per kickoff. Because a kickoff only ever happens on a tick both clients simulate the same way, and because a rollback that crosses a kickoff replays it, the PRNG stays in step — but it does mean `nextKickoffIndex` must not be called anywhere else during a rollback match.

- [ ] **Step 3: Fire the presentation on confirmation**

In `tickOnlineRollback`, after the `advance` call, add:

```js
        if (rs.confirmedTick > lastPresentedTick) {
            if (a.state.phase === "kickoff" && lastPresentedPhase !== "kickoff") qeOnlinePresentation();
            lastPresentedPhase = a.state.phase;
            lastPresentedTick = rs.confirmedTick
        }
```

And declare the cursors beside `lastDriftTick`:

```js
    let lastPresentedTick = -1,
        lastPresentedPhase = null;
```

- [ ] **Step 4: Reset the cursors at match start**

In `startOnlineMatch`, beside `rollbackSession = null;`, add:

```js
        lastDriftTick = -1, lastPresentedTick = -1, lastPresentedPhase = null;
```

- [ ] **Step 5: Verify**

```bash
node --check assets/game-CEDHMqQk.js && npm test
```

Expected: parses, 22 tests pass. Live verification is Task 10 — audio correctness is exactly what the harness cannot check.

- [ ] **Step 6: Commit**

```bash
git add assets/game-CEDHMqQk.js
git commit -m "Fire kickoff presentation only on confirmed ticks"
```

---

## Task 9: Stop discarding accumulated time on a stall

`Jb.update` sets `this.accumulator = 0` when the tick callback returns false. Real time that has already elapsed is thrown away, so game time falls permanently behind wall-clock time — which inflates felt latency beyond the nominal figure.

**Files:**
- Modify: `assets/game-CEDHMqQk.js` (`class Jb`, line 20564)
- Create: `tests/stepper.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/stepper.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("assets/game-CEDHMqQk.js", "utf8");
const Jb = source.slice(source.indexOf("class Jb {"), source.indexOf("class Jb {") + 2000);

test("a stalled tick does not discard the accumulator", () => {
    assert.ok(!/!n\(\)\)\s*\{\s*this\.accumulator\s*=\s*0/.test(Jb),
        "the stall branch still zeroes the accumulator, so game time drifts behind real time");
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test
```

Expected: FAIL — the stall branch still zeroes the accumulator.

- [ ] **Step 3: Keep the leftover time**

In `class Jb`, find the stall branch inside `update`:

```js
                    if (this.prevState.set(this.currState), !n()) {
                        this.accumulator = 0;
                        break
                    }
```

Replace it with:

```js
                    if (this.prevState.set(this.currState), !n()) {
                        // Put back the time for the ticks we could not run, so game time
                        // keeps pace with real time once the stall clears. Capped, so a
                        // long stall does not queue a burst of catch-up ticks.
                        this.accumulator = Math.min(this.accumulator + (s - a) * ba, gc * ba);
                        break
                    }
```

The cap matters: without it, a five-second network hiccup would queue 600 ticks and the simulation would fast-forward through them in one frame. `gc` (12) is the same ceiling `update` already applies to catch-up.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test
```

Expected: PASS — 23 tests.

- [ ] **Step 5: Commit**

```bash
git add assets/game-CEDHMqQk.js tests/stepper.test.js
git commit -m "Keep accumulated time when a network stall skips a tick"
```

---

## Task 10: Live verification

**Files:** none modified — this is a verification task, then a report.

- [ ] **Step 1: Start the relay and the preview**

```bash
node multiplayer-server/server.js
```

```bash
npx --yes serve -l 5175 .
```

- [ ] **Step 2: Play a rollback match**

Two tabs on `http://localhost:5175/?relay=ws://localhost:8080`, one creating a room and the other joining.

Check:
1. `[online] Match starting` in both consoles.
2. **No `[online] Simulation drift` warning** after at least a minute of active play from both sides.
3. Score a goal: both tabs agree on the score and reset to kickoff together, and the kickoff sound plays once — not two or three times, which would mean presentation effects are firing on predicted ticks.
4. The input feels immediate — the whole point.

- [ ] **Step 3: Compare against lockstep**

Reload both tabs with `&netcode=lockstep` and play again. The input should feel noticeably heavier. This confirms the flag works, which is the rollback escape hatch.

- [ ] **Step 4: Test under real latency**

Restart the relay with an artificial one-way delay:

```bash
RELAY_DELAY_MS=40 node multiplayer-server/server.js
```

80 ms round trip is roughly double the real 31 ms, so the prediction window widens to ~10 ticks. Play again and check that local input still feels immediate, that the opponent's car is not visibly jittering, and that no drift warning appears.

- [ ] **Step 5: Write the report**

Create `docs/superpowers/measurements/2026-09-13-rollback-verification.md` recording, for each of the three configurations (rollback at 1 ms RTT, lockstep at 1 ms RTT, rollback at 80 ms RTT): drift warnings observed, rollbacks and stalls from `rollbackSession.stats()`, and a subjective note on input feel.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/measurements/2026-09-13-rollback-verification.md
git commit -m "Verify rollback netcode in live matches"
```

---

## Done criteria

- [ ] `npm test` passes with 23 tests.
- [ ] Rollback reproduces a straight-line 2000-tick physics simulation bit for bit, with 50+ rollbacks along the way.
- [ ] Per-tick cost stays under a quarter of the 8.33 ms budget.
- [ ] A live online match plays with no drift warning, at 1 ms and at 80 ms RTT.
- [ ] `?netcode=lockstep` still works as an escape hatch.
- [ ] Solo play is unaffected.

## What comes next

Nicknames — display the opponent's name above their car and in the scoreboard. Independent of this work and much smaller. Note that the online scoreboard currently shows `CLEMENT`, the solo bot's name, reused verbatim for a human opponent.
