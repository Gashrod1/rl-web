import { quantiseControls, encodePacket, decodePacket } from "./input-codec.js";

function mulberry32(seed) {
    let t = seed >>> 0;
    return function () {
        t += 0x6D2B79F5;
        let r = Math.imul(t ^ (t >>> 15), 1 | t);
        r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
}

const NEUTRAL_CONTROLS = Object.freeze({
    throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0,
    jump: false, boost: false, handbrake: false
});

const TICK_MS = 1000 / 120;
// Rollback applies the local input on the tick it is sampled, so it needs no input
// delay at all. These constants remain only for the lockstep fallback path.
const DEFAULT_INPUT_DELAY = 24;
const MIN_INPUT_DELAY = 8;
const MAX_INPUT_DELAY = 40;
// Headroom above the measured round trip, so ordinary jitter doesn't stall the lockstep.
const INPUT_DELAY_MARGIN = 6;
// How many past inputs ride along in each packet. A dropped packet is covered by the
// next one, so a loss costs nothing instead of stalling the simulation.
const INPUT_REDUNDANCY = 4;
const PING_COUNT = 4;
const PING_INTERVAL_MS = 60;
// World units. The two clients simulate mirrored worlds, so only rotation-invariant
// scalars are comparable; anything past this means the simulations really drifted apart.
const DRIFT_TOLERANCE = 5;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class NetMatch {
    constructor(url) {
        this.url = url;
        this.ws = null;
        this.role = null;
        this.localCar = null;
        this.remoteCar = null;
        this.prng = null;
        this.localTick = 0;
        this.inputDelay = DEFAULT_INPUT_DELAY;
        this.rttMs = null;
        this.stalls = 0;
        this.driftEvents = 0;
        this.remoteInputs = new Map();
        this.localInputs = new Map();
        this.recentLocal = [];
        this.pingSamples = [];
        this.localDrift = new Map();
        this.remoteDrift = new Map();
        this.onCreated = null;
        this.onMatched = null;
        this.onReady = null;
        this.onError = null;
        this.onOpponentLeft = null;
        this.onDrift = null;
        this.onRemoteInput = null;
    }

    connect() {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(this.url);
            this.ws.binaryType = "arraybuffer";
            this.ws.addEventListener("open", () => resolve(), { once: true });
            this.ws.addEventListener("error", () => reject(new Error("Couldn't reach the multiplayer server.")), { once: true });
            this.ws.addEventListener("message", event => this._handleMessage(event));
            this.ws.addEventListener("close", () => {
                if (this.role) this.onOpponentLeft?.();
            });
        });
    }

    createRoom() {
        this.ws.send(JSON.stringify({ type: "create" }));
    }

    joinRoom(code) {
        this.ws.send(JSON.stringify({ type: "join", code: code.toUpperCase() }));
    }

    close() {
        this.role = null;
        this.ws?.close();
    }

    _handleMessage(event) {
        if (event.data instanceof ArrayBuffer) {
            const { newestTick, inputs } = decodePacket(event.data);
            const oldestTick = newestTick - inputs.length + 1;
            inputs.forEach((controls, i) => this.onRemoteInput?.(oldestTick + i, controls));
            return;
        }
        let message;
        try {
            message = JSON.parse(event.data);
        } catch {
            return;
        }
        if (message.type === "created") {
            this.role = "host";
            this.onCreated?.(message.code);
            return;
        }
        if (message.type === "matched") {
            this.role = message.role;
            this.localCar = this.role === "host" ? 0 : 1;
            this.remoteCar = this.role === "host" ? 1 : 0;
            this.onMatched?.(this.role);
            if (this.role === "host") this._runHostHandshake();
            return;
        }
        if (message.type === "error") {
            this.onError?.(message.reason);
            return;
        }
        if (message.type === "opponent-left") {
            this.onOpponentLeft?.();
            return;
        }
        if (message.type === "relay") {
            this._handleRelay(message.payload);
            return;
        }
    }

    // The host measures the peer-to-peer round trip, then picks an input delay both
    // clients use. Without it each tick would cost a full network trip (see qeOnline).
    async _runHostHandshake() {
        for (let i = 0; i < PING_COUNT; i++) {
            if (this.role !== "host") return;
            this._sendRelay({ kind: "ping", t: performance.now() });
            await sleep(PING_INTERVAL_MS);
        }
        await sleep(PING_INTERVAL_MS * 2);
        if (this.role !== "host") return;
        this.rttMs = this.pingSamples.length ? Math.min(...this.pingSamples) : null;
        this.inputDelay = this.rttMs === null
            ? DEFAULT_INPUT_DELAY
            : Math.min(MAX_INPUT_DELAY, Math.max(MIN_INPUT_DELAY, Math.ceil(this.rttMs / TICK_MS) + INPUT_DELAY_MARGIN));
        const seed = (Math.random() * 4294967296) >>> 0;
        this.prng = mulberry32(seed);
        this._sendRelay({ kind: "seed", value: seed, inputDelay: this.inputDelay, rttMs: this.rttMs });
        this.onReady?.();
    }

    _handleRelay(payload) {
        if (payload.kind === "ping") {
            this._sendRelay({ kind: "pong", t: payload.t });
            return;
        }
        if (payload.kind === "pong") {
            this.pingSamples.push(performance.now() - payload.t);
            return;
        }
        if (payload.kind === "seed") {
            this.prng = mulberry32(payload.value >>> 0);
            this.inputDelay = payload.inputDelay ?? DEFAULT_INPUT_DELAY;
            this.rttMs = payload.rttMs ?? null;
            this.onReady?.();
            return;
        }
        if (payload.kind === "input") {
            this.remoteInputs.set(payload.tick, payload.controls);
            return;
        }
        if (payload.kind === "drift") {
            this.remoteDrift.set(payload.tick, payload.values);
            this._checkDrift(payload.tick);
            return;
        }
    }

    _sendRelay(payload) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        this.ws.send(JSON.stringify({ type: "relay", payload }));
    }

    _checkDrift(tick) {
        const mine = this.localDrift.get(tick);
        const theirs = this.remoteDrift.get(tick);
        if (mine === undefined || theirs === undefined) return;
        this.localDrift.delete(tick);
        this.remoteDrift.delete(tick);
        const deltas = mine.map((value, i) => Math.abs(value - theirs[i]));
        const worst = Math.max(...deltas);
        if (worst > DRIFT_TOLERANCE) {
            this.driftEvents++;
            this.onDrift?.(tick, worst, deltas);
        }
    }

    // Sampled once per tick and applied `inputDelay` ticks later on both clients, so
    // each side always simulates a tick with the exact controls the other one used.
    sendLocalTick(tick, controls) {
        const target = tick + this.inputDelay;
        if (this.localInputs.has(target)) return;
        const snapshot = {
            throttle: controls.throttle,
            steer: controls.steer,
            pitch: controls.pitch,
            yaw: controls.yaw,
            roll: controls.roll,
            jump: controls.jump,
            boost: controls.boost,
            handbrake: controls.handbrake
        };
        this.localInputs.set(target, snapshot);
        this._sendRelay({ kind: "input", tick: target, controls: snapshot });
    }

    // Sends the input for `tick` plus the previous INPUT_REDUNDANCY-1 inputs, and
    // returns the quantised controls. The caller must feed the simulation that return
    // value, not the raw input: both sides have to step on identical numbers.
    sendRollbackInput(tick, controls) {
        const snapshot = quantiseControls(controls);
        this.recentLocal.push(snapshot);
        if (this.recentLocal.length > INPUT_REDUNDANCY) this.recentLocal.shift();
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(encodePacket(tick, this.recentLocal));
        }
        return snapshot;
    }

    getControlsForTick(tick) {
        if (tick < this.inputDelay) return NEUTRAL_CONTROLS;
        const controls = this.remoteInputs.get(tick);
        if (controls === undefined) {
            this.stalls++;
            return null;
        }
        this.remoteInputs.delete(tick);
        return controls;
    }

    getLocalControlsForTick(tick) {
        if (tick < this.inputDelay) return NEUTRAL_CONTROLS;
        const controls = this.localInputs.get(tick);
        this.localInputs.delete(tick);
        return controls ?? NEUTRAL_CONTROLS;
    }

    recordAndSendDrift(tick, values) {
        this.localDrift.set(tick, values);
        this._sendRelay({ kind: "drift", tick, values });
        this._checkDrift(tick);
    }

    nextKickoffIndex(variantIndices) {
        return variantIndices[Math.floor(this.prng() * variantIndices.length)];
    }
}
