function mulberry32(seed) {
    let t = seed >>> 0;
    return function () {
        t += 0x6D2B79F5;
        let r = Math.imul(t ^ (t >>> 15), 1 | t);
        r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
}

export function fingerprintState(state) {
    let h1 = 0x811c9dc5, h2 = 0x811c9dc5;
    const view = new DataView(state.buffer, state.byteOffset, state.byteLength);
    for (let i = 0; i + 8 <= state.byteLength; i += 8) {
        const lo = view.getUint32(i, true);
        const hi = view.getUint32(i + 4, true);
        h1 = Math.imul(h1 ^ lo, 16777619) >>> 0;
        h2 = Math.imul(h2 ^ hi, 16777619) >>> 0;
    }
    return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

export class NetMatch {
    constructor(url) {
        this.url = url;
        this.ws = null;
        this.role = null;
        this.localCar = null;
        this.remoteCar = null;
        this.prng = null;
        this.localTick = 0;
        this.remoteInputs = new Map();
        this.localFingerprints = new Map();
        this.remoteFingerprints = new Map();
        this.onCreated = null;
        this.onMatched = null;
        this.onReady = null;
        this.onError = null;
        this.onOpponentLeft = null;
        this.onDesync = null;
    }

    connect() {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(this.url);
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
            if (this.role === "host") {
                const seed = (Math.random() * 4294967296) >>> 0;
                this.prng = mulberry32(seed);
                this._sendRelay({ kind: "seed", value: seed });
                this.onReady?.();
            }
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

    _handleRelay(payload) {
        if (payload.kind === "seed") {
            this.prng = mulberry32(payload.value >>> 0);
            this.onReady?.();
            return;
        }
        if (payload.kind === "input") {
            this.remoteInputs.set(payload.tick, payload.controls);
            return;
        }
        if (payload.kind === "fingerprint") {
            this.remoteFingerprints.set(payload.tick, payload.hash);
            this._checkFingerprint(payload.tick);
            return;
        }
    }

    _sendRelay(payload) {
        this.ws.send(JSON.stringify({ type: "relay", payload }));
    }

    _checkFingerprint(tick) {
        const mine = this.localFingerprints.get(tick);
        const theirs = this.remoteFingerprints.get(tick);
        if (mine === undefined || theirs === undefined) return;
        if (mine !== theirs) this.onDesync?.();
        this.localFingerprints.delete(tick);
        this.remoteFingerprints.delete(tick);
    }

    sendLocalTick(tick, controls) {
        this._sendRelay({
            kind: "input",
            tick,
            controls: {
                throttle: controls.throttle,
                steer: controls.steer,
                pitch: controls.pitch,
                yaw: controls.yaw,
                roll: controls.roll,
                jump: controls.jump,
                boost: controls.boost,
                handbrake: controls.handbrake
            }
        });
    }

    getControlsForTick(tick) {
        const controls = this.remoteInputs.get(tick);
        if (controls === undefined) return null;
        this.remoteInputs.delete(tick);
        return controls;
    }

    recordAndSendFingerprint(tick, hash) {
        this.localFingerprints.set(tick, hash);
        this._sendRelay({ kind: "fingerprint", tick, hash });
        this._checkFingerprint(tick);
    }

    nextKickoffIndex(variantIndices) {
        return variantIndices[Math.floor(this.prng() * variantIndices.length)];
    }
}
