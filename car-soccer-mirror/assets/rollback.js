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
