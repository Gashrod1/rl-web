# Online 1v1 Multiplayer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a player create a private online room (with a short join code) and play a real 1v1 match against another player over the internet, hosted on the user's own OVH VPS.

**Architecture:** Deterministic lockstep. Each client runs the existing physics simulation locally (unchanged), just like today's vs-bot mode — but the opponent's per-tick controls come from the network instead of an ONNX bot. A small Node relay server on the VPS only handles room codes and forwards opaque messages between the two players; it never runs game physics. A new client-side ES module (`assets/net-match.js`) owns the WebSocket connection, room protocol, a shared-seed PRNG (for kickoff variants), per-tick input buffering, and a periodic state-fingerprint exchange that ends the match if the two simulations ever disagree.

**Tech Stack:** Plain WebSockets (`ws` npm package) on the server; a small hand-written client-side network module (no client dependency added — this project has no bundler, so the client stays vanilla ES modules loaded directly by the browser). Nginx + Let's Encrypt/certbot for TLS + static hosting; systemd to run the Node process.

**Design doc:** `docs/superpowers/specs/2026-09-12-online-multiplayer-design.md`

---

## Design refinement discovered while planning (read this first)

The design doc describes a deliberate fixed **input-delay buffer** (~4-6 ticks) to hide network latency. While mapping the exact tick loop (see "Key existing-code findings" below), a simpler mechanism that achieves the same goal emerged and is used instead: **a client simply doesn't advance a physics tick until the opponent's input for that tick has arrived; if it's not there yet, it waits and catches up once it lands** (reusing the game's own existing catch-up logic for handling frame drops — see `class Jb`). With no artificial buffer, this self-stabilizes to roughly track real network latency automatically, and is significantly simpler to implement correctly than a real lookahead buffer. The end result (never let the two simulations use different inputs for the same tick) is identical to what the design doc asked for — this only changes *how* that's achieved. Flagging this explicitly since it's a real (if small) deviation from the written design.

---

## Key existing-code findings (context for every task below)

All line numbers refer to `assets/game-CEDHMqQk.js` as it exists right now (this is the file `index.html` actually serves — it's kept in a readable, non-minified state from earlier work on this project, so exact-string edits are reliable).

- **Physics wrapper** `class Wb` ([game-CEDHMqQk.js:25460-25561](../../../assets/game-CEDHMqQk.js)): `setControls(carIndex, controls)` writes one car's controls into WASM memory; `step(n)` advances the sim; `resetKickoff(e = -1)` resets the ball/cars for a kickoff (`-1` = pick internally/randomly — this must be replaced with an explicit shared index for online play, see Task 1); `state` is the raw physics state buffer; `getPads()`, `pollGoal()`, `ballOnGround` are also exposed.
- **Fixed-timestep driver** `class Jb` ([game-CEDHMqQk.js:25565-25611](../../../assets/game-CEDHMqQk.js)): `update(now, frameFn, tickFn)` is called once per animation frame. It calls `frameFn()` once, then calls `tickFn()` zero or more times (once per due 120Hz tick). If `tickFn()` returns `false`, the whole batch aborts and the accumulator resets to 0 — this is exactly the "pause because opponent input for this tick hasn't arrived yet" behavior we need, already built in.
- **The match setup + tick loop** all lives inside one big function `async function e7()` ([game-CEDHMqQk.js:38997-39467](../../../assets/game-CEDHMqQk.js)). Relevant pieces, in the order they appear:
  - `39004-39013`: local setup — `n = new Wb` (physics wrapper), `r = n.addCar(...)` (**local player's car-slot index**, always `0` for a solo/bot match), `s = new Jb(n)` (the ticker), `a = new PB` (match-state/scoreboard, has `.tick({...})`, `.start()`, `.leave()`, `.state.mode`/`.state.phase`/`.state.paused`), `o = new GB(...)` (the bot manager — untouched, still used for vs-bot matches).
  - `39024-39030`: `A` = current opponent controls object (bot's cached decision); `c`/`h`/`d`/`u` = bot-specific bookkeeping (tick-skip counter, busy flag, generation counter, hard-stop flag). **`u` is the flag that fully halts match simulation on an unrecoverable opponent error — the online mode reuses this exact flag for "opponent disconnected"/"desync detected".**
  - `39046`: `B = new Yb(S)` — the local keyboard/mouse input reader; its `read()` returns `{throttle, steer, pitch, yaw, roll, jump, boost, handbrake}`. Same shape from the gamepad (`mC`) and touch (`SC`) readers.
  - `39067-39071`: the block of shared `let` state for all the corner-tab panels (`ue` = Garage panel, `he` = Play/bot panel, `ve` = sponsors panel, `Ce` = status panel, `vt` = render driver) — this is where the plan adds its own two new variables.
  - `39093-39095`: `He(name, isOpening)` — the "only one overlay open at a time" coordinator. Every panel's open/close calls `He("car", ...)`, `He("match", ...)`, etc., and `He` hides every *other* named panel. **The online panel must participate in this same list.**
  - `39155-39174`: `qe` — the kickoff/goal-reset closure used by the bot match. Calls `n.resetKickoff()` with no argument (i.e. `-1`, non-deterministic). The online mode needs its own version, `qeOnline`, that passes an explicit shared index instead.
  - `39176-39196`: `he = new bB(Jt, {...})` — construction of the existing Play/bot panel, showing the exact options-object shape (`onOpenChange`, `onStart`, `onLeave`, etc.) and how `n.configureCars(...)`/`a.start()`/`qe()` get called together to actually start a match. The plan's online panel mirrors this shape.
  - `39306-39367`: the actual per-frame/per-tick closures — `Je` (runs once per frame: reads local input into `Tn`, assigns it to outer variable **`xe`**, calls `n.setControls(r, Tn)` for the *local* car), `kt` (bot-only: fires an async re-decide), `Ye` (runs once per due physics tick for vs-bot matches: applies the bot's cached controls to the *opponent* car-slot `Di` (`= 1`), steps the physics, reports the tick to `a.tick({...})`, triggers `qe()` on a kickoff). **`xe` is the exact variable holding "my current local controls" that the online mode's per-tick send needs to read.**
  - `39400`: the render loop calls `s.update(Y, Je, a.state.mode === "match" ? Ye : void 0)` — **this is the one line that decides which tick-callback runs**. The plan changes it to pick `tickOnline` instead of `Ye` when an online match is active, leaving the vs-bot path (`Ye`) completely untouched.
- **Error/pause pattern**: there is no separate error-handling class. `he.showError(message)` (`bB.showError`, [game-CEDHMqQk.js:37088-37090](../../../assets/game-CEDHMqQk.js)) just sets an error string and re-renders/opens the Play panel; the actual "stop simulating" is done by the caller setting `u = !0` (checked at the top of `Ye`/`tickOnline`). The online panel gets its own `showError` method (same idea, different panel), and online mode reuses the same `u` flag.
- **No existing networking code**: confirmed zero occurrences of `WebSocket`/`RTCPeerConnection`/`ws://`/`wss://` anywhere in `assets/game-CEDHMqQk.js`.
- **Repo layout**: the actual git repository root is `C:\Users\Gash\Documents\projet` (parent of `car-soccer-mirror`, which is itself just a tracked subfolder — a mirrored static site plus this project's patches). There is no `package.json` or `server/` folder anywhere yet. The new relay server gets its own sibling folder, `C:\Users\Gash\Documents\projet\multiplayer-server\`, so the static-mirror folder stays exactly that.

---

## File structure

- Create: `C:\Users\Gash\Documents\projet\multiplayer-server\package.json`
- Create: `C:\Users\Gash\Documents\projet\multiplayer-server\server.js` — the whole relay server (room codes + message relay; no game logic).
- Create: `C:\Users\Gash\Documents\projet\multiplayer-server\test\manual-test.js` — a standalone Node script to exercise the relay server without a browser.
- Create: `C:\Users\Gash\Documents\projet\car-soccer-mirror\assets\net-match.js` — the `NetMatch` class + `fingerprintState()` helper. All networking/lockstep logic lives here, in isolation from the giant game bundle.
- Modify: `C:\Users\Gash\Documents\projet\car-soccer-mirror\assets\game-CEDHMqQk.js` — one new import, one new panel class (`OnlinePanel`), and a handful of small, precisely-located edits to wire it into the existing match loop.
- Create: `C:\Users\Gash\Documents\projet\car-soccer-mirror\docs\deployment\vps-setup.md` — the exact commands for the user to run on their own VPS (Task 13).

---

### Task 1: Determine the valid kickoff-variant index range

**Files:**
- Modify (temporarily): `assets/game-CEDHMqQk.js`

The physics module's `resetKickoff(e = -1)` presumably accepts a specific variant index when `e >= 0`, but nothing in the existing game ever passes anything but the default. We need to know the valid range before writing the shared-seed kickoff logic (Task 9).

- [ ] **Step 1: Add a temporary debug hook**

Find this exact line:
```js
    n.resetKickoff();
    const s = new Jb(n),
```
Replace it with:
```js
    n.resetKickoff();
    window.__kickoffDebug = { sim: n, ticker: null };
    const s = new Jb(n),
```

Then find:
```js
    B.onSettingsToggle = fe, ut.addEventListener("click", fe), Jt.querySelector(".hud-tools").appendChild(ut), Jt.querySelector("#settings-button").setAttribute("title", "Settings"), Jt.addEventListener("pointerdown", Y => {
```
and insert one line directly before it:
```js
    window.__kickoffDebug.ticker = s;
    B.onSettingsToggle = fe, ut.addEventListener("click", fe), Jt.querySelector(".hud-tools").appendChild(ut), Jt.querySelector("#settings-button").setAttribute("title", "Settings"), Jt.addEventListener("pointerdown", Y => {
```

- [ ] **Step 2: Serve the game locally and open it in the Browser tool**

Reuse the existing local static server (`.claude/launch.json`, config `car-soccer-mirror`, port 5175 — created in an earlier session). Start it if not already running (`preview_start` with `name: "car-soccer-mirror"`), navigate to `http://localhost:5175`, and wait for the game to finish booting (~15-30s).

- [ ] **Step 3: Start any match so cars/ball are on the field**

Click "Play", start a match against either bot (any difficulty). Once you can see the car and ball on the field, you're ready to test.

- [ ] **Step 4: Probe increasing kickoff indices, screenshotting each**

Run this via `javascript_tool` for each value of `k` from `0` up to `9` (one call per value, so you can screenshot between each):
```js
window.__kickoffDebug.sim.resetKickoff(k);
window.__kickoffDebug.ticker.sync();
"reset with k=" + k
```
(replace the literal `k` with `0`, then `1`, then `2`, ... each time), taking a screenshot after each call. Record which car/ball spawn arrangement each index produces.

- [ ] **Step 5: Determine the count and record it**

Compare the screenshots. The valid variant count is the number of *distinct* arrangements before they start repeating (e.g. if indices 0-3 each look different but index 4 looks identical to index 0, the count is 4). Write down this number — call it `N` — you'll use it as a literal integer in Task 9.

If instead every index (including clearly out-of-range ones like `50`) produces some *plausible-looking but not obviously cyclic* arrangement with no error and no visible pattern, that means the parameter probably isn't a small enumerated "variant index" the way we assumed. If that happens: **stop and report this back before continuing to Task 9** — the kickoff-sync approach would need to be redesigned (e.g. picking from a small fixed set of indices we choose ourselves, like `0-3`, rather than the module's own full range), which is a design question, not something to guess at silently.

- [ ] **Step 6: Remove the temporary debug hook**

Revert both edits from Step 1 (delete the `window.__kickoffDebug = ...` line and the `window.__kickoffDebug.ticker = s;` line), restoring the file to its pre-Task-1 state. Run:
```bash
node --check "C:/Users/Gash/Documents/projet/car-soccer-mirror/assets/game-CEDHMqQk.js"
```
Expected: no output.

---

### Task 2: Scaffold the relay server project

**Files:**
- Create: `C:\Users\Gash\Documents\projet\multiplayer-server\package.json`

- [ ] **Step 1: Create the directory and package.json**

```bash
mkdir -p "C:/Users/Gash/Documents/projet/multiplayer-server"
```

Write `C:\Users\Gash\Documents\projet\multiplayer-server\package.json`:
```json
{
  "name": "car-soccer-relay",
  "version": "1.0.0",
  "description": "Room-code + message relay server for Car Soccer online 1v1 matches. Never runs game physics.",
  "type": "module",
  "private": true,
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "ws": "^8.18.0"
  }
}
```

- [ ] **Step 2: Install dependencies**

```bash
cd "C:/Users/Gash/Documents/projet/multiplayer-server" && npm install
```

Expected: `ws` installed, `node_modules/` and `package-lock.json` created, no errors.

---

### Task 3: Implement the relay server

**Files:**
- Create: `C:\Users\Gash\Documents\projet\multiplayer-server\server.js`

- [ ] **Step 1: Write the server**

```js
import { WebSocketServer } from "ws";
import { randomInt } from "crypto";

const PORT = Number(process.env.PORT) || 8080;
const ROOM_CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I
const ROOM_CODE_LENGTH = 6;
const ROOM_EXPIRY_MS = 5 * 60 * 1000;

const rooms = new Map(); // code -> { host, guest, expiryTimer }

function generateCode() {
    let code;
    do {
        code = Array.from({ length: ROOM_CODE_LENGTH }, () => ROOM_CODE_CHARS[randomInt(ROOM_CODE_CHARS.length)]).join("");
    } while (rooms.has(code));
    return code;
}

function send(ws, message) {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function closeRoom(code) {
    const room = rooms.get(code);
    if (!room) return;
    if (room.expiryTimer) clearTimeout(room.expiryTimer);
    rooms.delete(code);
}

const wss = new WebSocketServer({ port: PORT });

wss.on("connection", ws => {
    ws.roomCode = null;
    ws.role = null;

    ws.on("message", data => {
        let message;
        try {
            message = JSON.parse(data.toString());
        } catch {
            send(ws, { type: "error", reason: "invalid_message" });
            return;
        }

        if (message.type === "create") {
            const code = generateCode();
            const expiryTimer = setTimeout(() => {
                const room = rooms.get(code);
                if (room && !room.guest) {
                    send(room.host, { type: "error", reason: "room_expired" });
                    closeRoom(code);
                }
            }, ROOM_EXPIRY_MS);
            rooms.set(code, { host: ws, guest: null, expiryTimer });
            ws.roomCode = code;
            ws.role = "host";
            send(ws, { type: "created", code });
            return;
        }

        if (message.type === "join") {
            const code = typeof message.code === "string" ? message.code.toUpperCase() : "";
            const room = rooms.get(code);
            if (!room) {
                send(ws, { type: "error", reason: "invalid_code" });
                return;
            }
            if (room.guest) {
                send(ws, { type: "error", reason: "room_full" });
                return;
            }
            if (room.expiryTimer) clearTimeout(room.expiryTimer);
            room.expiryTimer = null;
            room.guest = ws;
            ws.roomCode = code;
            ws.role = "guest";
            send(room.host, { type: "matched", role: "host" });
            send(room.guest, { type: "matched", role: "guest" });
            return;
        }

        if (message.type === "relay") {
            const room = rooms.get(ws.roomCode);
            if (!room || !room.guest) return;
            const other = ws.role === "host" ? room.guest : room.host;
            send(other, { type: "relay", payload: message.payload });
            return;
        }
    });

    ws.on("close", () => {
        if (!ws.roomCode) return;
        const room = rooms.get(ws.roomCode);
        if (!room) return;
        const other = ws.role === "host" ? room.guest : room.host;
        send(other, { type: "opponent-left" });
        closeRoom(ws.roomCode);
    });
});

console.log(`Relay server listening on port ${PORT}`);
```

- [ ] **Step 2: Verify it starts cleanly**

```bash
cd "C:/Users/Gash/Documents/projet/multiplayer-server" && timeout 3 node server.js
```
Expected: prints `Relay server listening on port 8080` and exits after the timeout (no crash/stack trace).

---

### Task 4: Manual test of the relay server (no browser)

**Files:**
- Create: `C:\Users\Gash\Documents\projet\multiplayer-server\test\manual-test.js`

- [ ] **Step 1: Write the test script**

```js
import { WebSocket } from "ws";

const URL = process.env.RELAY_URL || "ws://localhost:8080";

function connect(label) {
    const ws = new WebSocket(URL);
    ws.on("open", () => console.log(`[${label}] connected`));
    ws.on("message", data => console.log(`[${label}] received`, data.toString()));
    ws.on("close", () => console.log(`[${label}] closed`));
    return ws;
}

const host = connect("host");
let guest;

host.on("open", () => host.send(JSON.stringify({ type: "create" })));

host.on("message", raw => {
    const msg = JSON.parse(raw.toString());
    if (msg.type !== "created") return;
    console.log(`[test] room code is ${msg.code}`);
    guest = connect("guest");
    guest.on("open", () => guest.send(JSON.stringify({ type: "join", code: msg.code })));
    guest.on("message", raw2 => {
        const msg2 = JSON.parse(raw2.toString());
        if (msg2.type !== "matched") return;
        host.send(JSON.stringify({ type: "relay", payload: { hello: "from host" } }));
        guest.send(JSON.stringify({ type: "relay", payload: { hello: "from guest" } }));
        setTimeout(() => { host.close(); guest.close(); }, 500);
    });
});
```

- [ ] **Step 2: Run the relay server and the test script together**

```bash
cd "C:/Users/Gash/Documents/projet/multiplayer-server" && node server.js &
sleep 1
node test/manual-test.js
```

Expected output includes, in some order: both `connected` lines, `[test] room code is XXXXXX` (6 uppercase letters/digits, no `0/O/1/I`), `[host] received {"type":"matched","role":"host"}`, `[guest] received {"type":"matched","role":"guest"}`, `[guest] received {"type":"relay","payload":{"hello":"from host"}}`, `[host] received {"type":"relay","payload":{"hello":"from guest"}}`, then both `closed` lines.

- [ ] **Step 3: Stop the background server**

```bash
kill %1 2>/dev/null || true
```

---

### Task 5: `NetMatch` — connection, room protocol, shared seed

**Files:**
- Create: `C:\Users\Gash\Documents\projet\car-soccer-mirror\assets\net-match.js`

Note on `onMatched` vs. `onReady`: both players receive `{type:"matched"}` from the server at roughly the same time, but only the **host** can generate the shared seed at that exact moment (it makes it up itself) — the **guest** must wait for the host's seed to actually arrive over the network first. If the game started the match as soon as `onMatched` fired, the guest would try to use `netMatch.prng` before it's ever been set. `onMatched` fires for both roles immediately (informational — e.g. for UI feedback); `onReady` fires only once `prng` is guaranteed to be set (immediately, for the host; after the seed relay arrives, for the guest). The match must only actually start on `onReady`, never on `onMatched`.

Note on `nextKickoffIndex`: Task 1's investigation found that `resetKickoff(e)` does **not** map `e = 0, 1, 2, ...` to sequential distinct arrangements — it hashes `e` into a small fixed set of buckets (5 distinct arrangements were found, reachable via specific indices, not a contiguous range, and some indices collide onto the same arrangement as others). So `nextKickoffIndex` takes an array of **known-good, pre-verified indices** (one per distinct arrangement) and picks one by index into that array — never a raw `seed % count` passed straight to `resetKickoff`, which would under- or over-represent arrangements. The actual array (from Task 1's findings) is supplied in Task 9.

- [ ] **Step 1: Write the module**

```js
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
```

- [ ] **Step 2: Verify syntax**

```bash
node --check "C:/Users/Gash/Documents/projet/car-soccer-mirror/assets/net-match.js"
```
Expected: no output.

---

### Task 6: Wire the game's import + the online panel's variables

**Files:**
- Modify: `assets/game-CEDHMqQk.js`

- [ ] **Step 1: Add the import**

Find this exact text:
```js
} from "./privacy-BBT5bqib.js";
```
Replace with:
```js
} from "./privacy-BBT5bqib.js";
import { NetMatch, fingerprintState } from "./net-match.js";
```

- [ ] **Step 2: Add the two new module-level state variables**

Find this exact block:
```js
    let X = !1,
        se = !1,
        ce = !1,
        ue, he, ve, Ce = null,
        vt;
```
Replace with:
```js
    let X = !1,
        se = !1,
        ce = !1,
        ue, he, ve, Ce = null,
        vt, netMatch = null, onlinePanel = null;
```

- [ ] **Step 3: Verify syntax**

```bash
node --check "C:/Users/Gash/Documents/projet/car-soccer-mirror/assets/game-CEDHMqQk.js"
```
Expected: no output.

---

### Task 7: The `OnlinePanel` UI class

**Files:**
- Modify: `assets/game-CEDHMqQk.js`

- [ ] **Step 1: Insert the new class**

Find this exact line:
```js
async function e7() {
```
Insert the following class definition immediately **before** it (so `async function e7() {` still starts the very next line):
```js
class OnlinePanel {
    constructor(root, options) {
        this.options = options;
        this.openState = !1;
        this.view = "menu";
        this.code = "";
        this.errorMessage = "";
        root.insertAdjacentHTML("beforeend", `
      <button id="online-button" class="car-tab" type="button"
              aria-label="Play online" title="Play online" aria-haspopup="dialog">
        <span class="car-tab__copy">
          <span class="car-tab__label">Play Online</span>
        </span>
      </button>

      <div id="online-overlay" class="car-overlay" hidden aria-hidden="true">
        <section class="car-dialog" role="dialog" aria-modal="true" aria-labelledby="online-dialog-title">
          <header class="car-dialog__head">
            <div>
              <h2 id="online-dialog-title">Play Online</h2>
            </div>
            <button class="sheet-head__close" type="button" data-online-close aria-label="Close">&times;</button>
          </header>

          <div class="car-dialog__body">
            <div data-online-view="menu">
              <button type="button" class="act act--primary" data-online-create>Create a room</button>
              <button type="button" class="act" data-online-join-open>Join with a code</button>
            </div>

            <div data-online-view="join" hidden>
              <label for="online-code-input">Room code</label>
              <input id="online-code-input" type="text" maxlength="6" autocomplete="off"
                     data-online-code-input placeholder="ABC123">
              <button type="button" class="act act--primary" data-online-join-submit>Join</button>
              <button type="button" class="act" data-online-back>Back</button>
            </div>

            <div data-online-view="waiting" hidden>
              <p>Room code:</p>
              <p class="online-code" data-online-code-display></p>
              <p>Waiting for an opponent&hellip;</p>
              <button type="button" class="act" data-online-cancel>Cancel</button>
            </div>

            <p class="match-panel__error" data-online-error hidden></p>
          </div>
        </section>
      </div>
    `);
        this.tab = root.querySelector("#online-button");
        this.overlay = root.querySelector("#online-overlay");
        this.body = this.overlay.querySelector(".car-dialog__body");
        this.codeInput = this.overlay.querySelector("[data-online-code-input]");
        this.codeDisplay = this.overlay.querySelector("[data-online-code-display]");
        this.errorEl = this.overlay.querySelector("[data-online-error]");
        this.tab.addEventListener("click", () => this.openState ? this.hide() : this.show());
        this.overlay.querySelector("[data-online-close]").addEventListener("click", () => this.hide());
        this.overlay.addEventListener("mousedown", e => {
            if (e.target === this.overlay) this.hide()
        });
        this.overlay.querySelector("[data-online-create]").addEventListener("click", () => this.options.onCreate());
        this.overlay.querySelector("[data-online-join-open]").addEventListener("click", () => this.setView("join"));
        this.overlay.querySelector("[data-online-back]").addEventListener("click", () => this.setView("menu"));
        this.overlay.querySelector("[data-online-join-submit]").addEventListener("click", () => {
            this.options.onJoin(this.codeInput.value.trim())
        });
        this.overlay.querySelector("[data-online-cancel]").addEventListener("click", () => this.options.onCancel());
        this.render()
    }
    setView(e) {
        this.view = e, this.errorMessage = "", this.render()
    }
    showWaiting(e) {
        this.code = e, this.setView("waiting")
    }
    showError(e) {
        this.errorMessage = e, this.render()
    }
    render() {
        for (const e of this.body.querySelectorAll("[data-online-view]")) e.hidden = e.dataset.onlineView !== this.view;
        this.codeDisplay.textContent = this.code, this.errorEl.hidden = !this.errorMessage, this.errorEl.textContent = this.errorMessage
    }
    get isOpen() {
        return this.openState
    }
    show() {
        this.openState = !0, this.overlay.hidden = !1, this.overlay.setAttribute("aria-hidden", "false"), this.options.onOpenChange(!0), requestAnimationFrame(() => this.overlay.classList.add("is-open"))
    }
    hide() {
        this.openState = !1, this.overlay.classList.remove("is-open"), this.overlay.setAttribute("aria-hidden", "true"), this.options.onOpenChange(!1), window.setTimeout(() => {
            this.openState || (this.overlay.hidden = !0)
        }, 180)
    }
}
```
(Every other panel in this file that shares the `car-overlay` CSS class — e.g. `class yB`, the Garage panel — toggles an `is-open` class via `requestAnimationFrame` on show and removes it on hide, deferring `hidden = true` by 180ms to match the CSS's `.18s` opacity transition. `.car-overlay` starts at `opacity: 0`; without this, the panel would be functionally invisible — present in the DOM and blocking clicks, but never actually rendered visible. This was caught by code review and is reflected in the code above.)

- [ ] **Step 2: Verify syntax**

```bash
node --check "C:/Users/Gash/Documents/projet/car-soccer-mirror/assets/game-CEDHMqQk.js"
```
Expected: no output.

- [ ] **Step 3: Verify the class is reachable (no browser needed yet)**

```bash
node -e "
const fs = require('fs');
const src = fs.readFileSync('C:/Users/Gash/Documents/projet/car-soccer-mirror/assets/game-CEDHMqQk.js', 'utf8');
const idx = src.indexOf('class OnlinePanel');
const asyncIdx = src.indexOf('async function e7()');
console.log('OnlinePanel found:', idx !== -1, '| appears before e7:', idx !== -1 && idx < asyncIdx);
"
```
Expected: `OnlinePanel found: true | appears before e7: true`

---

### Task 8: Instantiate the panel and wire it into the overlay-exclusivity system

**Files:**
- Modify: `assets/game-CEDHMqQk.js`

- [ ] **Step 1: Add "online" to the mutual-exclusion list in `He`**

Find this exact text:
```js
        He = (Y, tt) => {
            tt ? (W.add(Y), Y !== "settings" && Xe.hide(), Y !== "car" && (ue == null || ue.hide()), Y !== "match" && (he == null || he.hide()), Y !== "sponsors" && (ve == null || ve.hide()), Y !== "status" && (Ce == null || Ce.hideDetails(!1))) : (W.delete(Y), ce = !0), ge()
        },
```
Replace with:
```js
        He = (Y, tt) => {
            tt ? (W.add(Y), Y !== "settings" && Xe.hide(), Y !== "car" && (ue == null || ue.hide()), Y !== "match" && (he == null || he.hide()), Y !== "sponsors" && (ve == null || ve.hide()), Y !== "status" && (Ce == null || Ce.hideDetails(!1)), Y !== "online" && (onlinePanel == null || onlinePanel.hide())) : (W.delete(Y), ce = !0), ge()
        },
```

- [ ] **Step 2: Instantiate `OnlinePanel` and the room-creation/join handlers**

Find this exact text:
```js
        }), m[0] = Y[tt + Ee.BALL_HIT_SERIAL], m[1] = Y[ct.NUM_CARS] > 1 ? Y[tt + An + Ee.BALL_HIT_SERIAL] : 0, I.resetBallTrail(), n.resetView(), s.sync()
    };
    he = new bB(Jt, {
```
Replace with:
```js
        }), m[0] = Y[tt + Ee.BALL_HIT_SERIAL], m[1] = Y[ct.NUM_CARS] > 1 ? Y[tt + An + Ee.BALL_HIT_SERIAL] : 0, I.resetBallTrail(), n.resetView(), s.sync()
    };
    const ONLINE_SERVER_URL = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/mp";
    const endOnlineMatch = errorText => {
        u = !0, a.state.paused = !0, netMatch = null, onlinePanel.showError(errorText), onlinePanel.show()
    };
    const qeOnline = () => {
        n.resetKickoff(netMatch.nextKickoffIndex(KICKOFF_VARIANT_INDICES)), _(), p();
        const Y = n.state,
            tt = ct.CARS + r * An;
        J.update(0, Y[tt + Ee.FLIP_RESET_SERIAL], !1), j.update({
            jumpSerial: Y[tt + Ee.JUMP_SERIAL],
            dodgeSerial: Y[tt + Ee.DODGE_SERIAL],
            doubleJumpSerial: Y[tt + Ee.DOUBLE_JUMP_SERIAL],
            wheelImpactSerial: Y[tt + Ee.WHEEL_IMPACT_SERIAL],
            wheelImpactSpeed: 0,
            audible: !1
        }), g.update({
            carSerial: Y[tt + Ee.BALL_HIT_SERIAL] + (Y[ct.NUM_CARS] > 1 ? Y[tt + An + Ee.BALL_HIT_SERIAL] : 0),
            carSpeed: 0,
            worldSerial: Y[tt + Ee.BALL_WORLD_IMPACT_SERIAL],
            worldSpeed: 0,
            worldSurface: 0,
            worldPan: 0,
            audible: !1
        }), m[0] = Y[tt + Ee.BALL_HIT_SERIAL], m[1] = Y[ct.NUM_CARS] > 1 ? Y[tt + An + Ee.BALL_HIT_SERIAL] : 0, I.resetBallTrail(), n.resetView(), s.sync()
    };
    const tickOnline = () => {
        if (a.state.paused || a.state.phase === "ended" || u) return !1;
        if (a.state.phase === "playing") {
            const Y = netMatch.getControlsForTick(netMatch.localTick);
            if (Y === null) return !1;
            A = Y, netMatch.sendLocalTick(netMatch.localTick, xe), n.setControls(Di, A), n.step(1);
            const tt = n.state,
                gn = a.tick({
                    goal: n.pollGoal(),
                    ballOnGround: n.ballOnGround,
                    kickoffTouched: Math.abs(tt[ct.BALL]) + Math.abs(tt[ct.BALL + 1]) > 1 || Math.hypot(tt[ct.BALL + 12], tt[ct.BALL + 13]) > 1
                }) === "kickoff";
            netMatch.localTick % 60 === 0 && netMatch.recordAndSendFingerprint(netMatch.localTick, fingerprintState(n.state)), netMatch.localTick++, gn && qeOnline()
        } else a.tick() === "kickoff" && qeOnline();
        return !0
    };
    const startOnlineMatch = () => {
        n.configureCars(i === "flat-car" ? "flat" : "default", !0), n.setUnlimitedBoost(!1), u = !1, a.start(), qeOnline(), onlinePanel.hide()
    };
    netMatch = null;
    onlinePanel = new OnlinePanel(Jt, {
        onOpenChange: Y => He("online", Y),
        onCreate: async () => {
            const nm = new NetMatch(ONLINE_SERVER_URL);
            netMatch = nm;
            nm.onError = Y => {
                onlinePanel.showError(Y === "room_expired" ? "This room expired, create a new one." : "Something went wrong. Please try again.")
            };
            nm.onOpponentLeft = () => endOnlineMatch("Opponent disconnected.");
            nm.onDesync = () => endOnlineMatch("Desync detected. Match stopped.");
            nm.onCreated = Y => onlinePanel.showWaiting(Y);
            nm.onReady = () => startOnlineMatch();
            try {
                await nm.connect()
            } catch (Y) {
                onlinePanel.showError(Y instanceof Error ? Y.message : "Couldn't reach the multiplayer server.");
                netMatch = null;
                return
            }
            nm.createRoom()
        },
        onJoin: async Y => {
            if (!Y) {
                onlinePanel.showError("Enter a room code.");
                return
            }
            const nm = new NetMatch(ONLINE_SERVER_URL);
            netMatch = nm;
            nm.onError = tt => {
                onlinePanel.showError(tt === "invalid_code" ? "Invalid code." : tt === "room_full" ? "This room is full." : "Something went wrong. Please try again.")
            };
            nm.onOpponentLeft = () => endOnlineMatch("Opponent disconnected.");
            nm.onDesync = () => endOnlineMatch("Desync detected. Match stopped.");
            nm.onReady = () => startOnlineMatch();
            try {
                await nm.connect()
            } catch (tt) {
                onlinePanel.showError(tt instanceof Error ? tt.message : "Couldn't reach the multiplayer server.");
                netMatch = null;
                return
            }
            nm.joinRoom(Y)
        },
        onCancel: () => {
            netMatch == null || netMatch.close(), netMatch = null, onlinePanel.setView("menu")
        }
    });
    he = new bB(Jt, {
```

Note: `KICKOFF_VARIANT_INDICES` above is used but not yet declared — Task 9 adds its declaration using the indices found in Task 1. This is intentional ordering (Task 8 wires the shape, Task 9 supplies the one constant Task 1 discovered); `node --check` in this task will still pass because `const`/function bodies aren't evaluated until called, only parsed.

- [ ] **Step 3: Verify syntax**

```bash
node --check "C:/Users/Gash/Documents/projet/car-soccer-mirror/assets/game-CEDHMqQk.js"
```
Expected: no output.

---

### Task 9: Declare `KICKOFF_VARIANT_INDICES` and hook the render loop

**Files:**
- Modify: `assets/game-CEDHMqQk.js`

- [ ] **Step 1: Declare the constant using Task 1's finding**

Task 1 found that `resetKickoff(e)` hashes `e` into 5 distinct arrangements, not a contiguous `0..N-1` range, and empirically verified these 5 specific indices each reliably reach one distinct arrangement: `0` (arrangement A), `2` (B), `3` (C), `5` (D), `7` (E).

Find this exact line (added by Task 6, Step 2):
```js
        vt, netMatch = null, onlinePanel = null;
```
Replace it with:
```js
        vt, netMatch = null, onlinePanel = null;
    const KICKOFF_VARIANT_INDICES = [0, 2, 3, 5, 7];
```

- [ ] **Step 2: Route the render loop to `tickOnline` when a match is online**

Find this exact text:
```js
        pt = Y, a.state.paused = a.state.mode === "match" && (X || W.size > 0 || document.hidden || !document.hasFocus() || u), a.state.paused || a.state.mode === "match" && a.state.phase === "ended" ? (Je(), s.sync(Y)) : s.update(Y, Je, a.state.mode === "match" ? Ye : void 0), a.state.mode === "freeplay" && n.pollGoal() !== 0 && !U.disableGoalReset && (n.resetKickoff(), _(), s.sync(Y), I.resetBallTrail()), he.update(a.state), Jt.dataset.gameMode !== a.state.mode && (Jt.dataset.gameMode = a.state.mode, P.setMatchActive(a.state.mode === "match")), Ue.mark();
```
Replace with:
```js
        pt = Y, a.state.paused = a.state.mode === "match" && (X || W.size > 0 || document.hidden || !document.hasFocus() || u), a.state.paused || a.state.mode === "match" && a.state.phase === "ended" ? (Je(), s.sync(Y)) : s.update(Y, Je, a.state.mode === "match" ? (netMatch ? tickOnline : Ye) : void 0), a.state.mode === "freeplay" && n.pollGoal() !== 0 && !U.disableGoalReset && (n.resetKickoff(), _(), s.sync(Y), I.resetBallTrail()), he.update(a.state), Jt.dataset.gameMode !== a.state.mode && (Jt.dataset.gameMode = a.state.mode, P.setMatchActive(a.state.mode === "match")), Ue.mark();
```

- [ ] **Step 3: Make leaving the Play (bot) panel also clean up an online match**

Find this exact text:
```js
        onLeave: () => {
            p(), a.leave(), u = !1, n.configureCars(i === "flat-car" ? "flat" : "default", !1, e), n.setUnlimitedBoost(U.boostOption === "unlimited"), qe(), he.update(a.state)
        }
```
Replace with:
```js
        onLeave: () => {
            netMatch == null || netMatch.close(), netMatch = null, p(), a.leave(), u = !1, n.configureCars(i === "flat-car" ? "flat" : "default", !1, e), n.setUnlimitedBoost(U.boostOption === "unlimited"), qe(), he.update(a.state)
        }
```
(This only matters if a player leaves an online match via the *existing* Play panel's "leave" button, which will still be reachable since both panels share the same match state — this keeps `netMatch` from lingering as a stale, connected socket.)

- [ ] **Step 4: Verify syntax**

```bash
node --check "C:/Users/Gash/Documents/projet/car-soccer-mirror/assets/game-CEDHMqQk.js"
```
Expected: no output.

- [ ] **Step 5: Verify the "Play Online" button renders**

Reload the locally-served game (preview `car-soccer-mirror`, port 5175), wait for boot, and use `find` with query `"Play online"`. Expected: `button "Play online"` found in the accessibility tree. Click it — expected: the panel opens showing "Create a room" / "Join with a code", with no console errors.

---

### Task 10: End-to-end local test — full match, two browser tabs

**Completion notes:** This test caught a real bug: `tickOnline` (Task 8) only called `netMatch.sendLocalTick(...)` *after* confirming it had already received the opponent's input for the same tick — since both clients run identical logic, neither would ever send first, and the match hung forever waiting for input that was never sent. Fixed by sending unconditionally before checking for the opponent's input (`assets/game-CEDHMqQk.js`, inside `tickOnline`). Separately (not a code bug): the game's own "unfocused/hidden tab" pause logic (`document.hidden`/`document.hasFocus()` checks already in the render loop, there for a good reason — auto-pausing when you alt-tab away) makes it impossible to run two *real-time* rAF-driven tabs at once in a single automated browser pane, since only one tab can hold OS-level focus/visibility at a time. Verified the fix by manually driving the tick loop (bypassing `requestAnimationFrame`) with `document.hidden`/`hasFocus` temporarily stubbed for the test — confirmed 390+ ticks with no desync, matching phase/score on both sides, before reverting all temporary test instrumentation. A real two-*visible*-window test (or two physical machines) remains the more natural way to verify this by eye; the manual-pump method above is a reasonable substitute when only one browser pane can be foregrounded at a time.

**Files:**
- No file changes in this task (verification only)

- [ ] **Step 1: Run the relay server locally**

```bash
cd "C:/Users/Gash/Documents/projet/multiplayer-server" && PORT=8080 node server.js &
```

- [ ] **Step 2: Temporarily point the client at the local relay server**

Since the local game is served over plain HTTP (`http://localhost:5175`), `ONLINE_SERVER_URL` (defined in Task 8) already resolves to `ws://localhost:5175/mp` — but nothing is listening there. For this local test only, temporarily change the constant to point straight at the relay server's own port:

Find:
```js
    const ONLINE_SERVER_URL = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/mp";
```
Temporarily replace with:
```js
    const ONLINE_SERVER_URL = "ws://localhost:8080";
```
(Revert this back to the original line at the end of this task — it's only for local testing before the Nginx reverse-proxy from Task 13 exists.)

- [ ] **Step 3: Open two tabs, create and join a room**

In the Browser tool: open the game in one tab (`tabs_create`), and in a second tab (`tabs_create` again). In tab 1, wait for boot, click "Play Online" → "Create a room", note the displayed code. In tab 2, wait for boot, click "Play Online" → "Join with a code", enter that code, click Join.

Expected: both tabs' Online panels close and the match starts (car + ball visible, HUD shows the match is running) within a couple of seconds of each other.

- [ ] **Step 4: Play through a goal and verify both tabs agree**

Drive tab 1's car into the ball hard enough to score (or wait for a natural bounce-in). After a goal, both tabs should show the score incrementing and both should show the *same* kickoff spawn arrangement for the restart (the key test for the shared-seed mechanism — if the two arrangements differ, the seed exchange or `nextKickoffIndex` is broken).

- [ ] **Step 5: Revert the temporary URL override and stop the local relay server**

Restore:
```js
    const ONLINE_SERVER_URL = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/mp";
```
```bash
kill %1 2>/dev/null || true
```

---

### Task 11: Verify the desync safety net

**Completion notes:** Verified successfully (no permanent code changes, as expected). Armed the flag on the host only, then drove both clients through the tick where the corrupted fingerprint landed. Both sides independently detected the mismatch and showed "Desync detected. Match stopped." with `netMatch` torn down and the match paused — exactly as designed. One test-harness-only wrinkle, not a product bug: continuing to manually pump frames (the `document.hidden`/`hasFocus` workaround from Task 10) after the match had already ended raced against the real (throttled but not fully stopped) background render loop and threw once on `netMatch.localTick`, since `tickOnline` isn't meant to be re-entered by two independent drivers. This can't happen in normal play (only the real render loop ever calls `tickOnline`) and required no fix.

**Files:**
- No permanent file changes (a deliberate temporary break, reverted at the end)

- [ ] **Step 1: Temporarily make the fingerprint corruptible on demand**

Find this exact method in `assets/net-match.js`:
```js
    recordAndSendFingerprint(tick, hash) {
        this.localFingerprints.set(tick, hash);
        this._sendRelay({ kind: "fingerprint", tick, hash });
        this._checkFingerprint(tick);
    }
```
Temporarily replace with:
```js
    recordAndSendFingerprint(tick, hash) {
        if (window.__forceDesyncOnce) {
            hash = "0";
            window.__forceDesyncOnce = false
        }
        this.localFingerprints.set(tick, hash);
        this._sendRelay({ kind: "fingerprint", tick, hash });
        this._checkFingerprint(tick);
    }
```
This is a no-op change for normal play (`window.__forceDesyncOnce` is `undefined`/falsy unless a test deliberately sets it) — it only exists so a test can flip one flag from devtools instead of editing code mid-match.

- [ ] **Step 2: Reproduce with both tabs, then force one to lie**

Repeat Task 10 Steps 1-3 (local relay server running, `ONLINE_SERVER_URL` temporarily pointed at `ws://localhost:8080`, two tabs matched and playing — both tabs load the file from Step 1, so both have the flag available, but only one will actually use it). Once the match is confirmed running in both tabs, in **one tab only**, run via `javascript_tool`:
```js
window.__forceDesyncOnce = true;
"armed"
```

- [ ] **Step 3: Confirm the error fires in both tabs**

Within a couple of seconds, both tabs should show "Desync detected. Match stopped." (via `onlinePanel.showError`) and stop simulating (`u = !0`). Confirm via `get_page_text` on each tab.

- [ ] **Step 4: Revert the temporary corruption**

Restore `recordAndSendFingerprint` in `assets/net-match.js` to the version from Task 5, Step 1 (no `window.__forceDesyncOnce` check). Run:
```bash
node --check "C:/Users/Gash/Documents/projet/car-soccer-mirror/assets/net-match.js"
```
Expected: no output.

---

### Task 12: Verify disconnect handling

**Completion notes:** Verified successfully, first try, no code changes needed. Created a room, joined it, then closed the guest tab. Within ~2 seconds the host tab's page text showed exactly "Opponent disconnected." This path doesn't depend on the physics tick loop at all (the WebSocket `close` event fires and updates the DOM synchronously), so it wasn't affected by the render-loop/page-visibility complication noted in Tasks 10-11.

**Files:**
- No file changes in this task (verification only)

- [ ] **Step 1: Start a match, then close one side**

Repeat Task 10 Steps 1-3 (local relay server + temporary `ONLINE_SERVER_URL` override + two tabs matched and playing).

- [ ] **Step 2: Close one tab mid-match**

Use `tabs_close` on one of the two tabs while the match is running.

- [ ] **Step 3: Confirm the remaining tab shows the right error**

In the remaining tab, within a second or two, `get_page_text` should show "Opponent disconnected." and the match should be stopped (no further scoring, car/ball frozen).

- [ ] **Step 4: Revert the temporary URL override and stop the local relay server**

Same as Task 10 Step 5.

---

### Task 13: VPS deployment (commands for the user to run)

**Files:**
- Create: `C:\Users\Gash\Documents\projet\car-soccer-mirror\docs\deployment\vps-setup.md`

This task produces a document with exact commands. The user runs these themselves on their OVH VPS (Ubuntu/Debian assumed — adjust package manager commands if the VPS runs a different distribution) after Tasks 1-12 are complete and committed.

- [ ] **Step 1: Write the deployment doc**

```markdown
# VPS deployment — Car Soccer online multiplayer

Run these on the VPS itself (SSH in first). Replace `your-domain.example.com` with your actual domain, and `/opt/car-soccer` with wherever you want the checkout to live.

## 1. Clone the repo

\`\`\`bash
sudo mkdir -p /opt/car-soccer
sudo chown $USER:$USER /opt/car-soccer
git clone <your-repo-url> /opt/car-soccer
cd /opt/car-soccer
\`\`\`

## 2. Install and start the relay server

\`\`\`bash
cd /opt/car-soccer/multiplayer-server
npm install --omit=dev
\`\`\`

Create the systemd unit `/etc/systemd/system/car-soccer-relay.service`:

\`\`\`ini
[Unit]
Description=Car Soccer online multiplayer relay server
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/car-soccer/multiplayer-server
ExecStart=/usr/bin/node server.js
Environment=PORT=8080
Restart=on-failure
RestartSec=2
User=www-data

[Install]
WantedBy=multi-user.target
\`\`\`

\`\`\`bash
sudo systemctl daemon-reload
sudo systemctl enable --now car-soccer-relay
sudo systemctl status car-soccer-relay
\`\`\`
Expected: `active (running)`.

## 3. Install Nginx and certbot

\`\`\`bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
\`\`\`

## 4. Nginx site config

Create `/etc/nginx/sites-available/car-soccer`:

\`\`\`nginx
server {
    listen 80;
    server_name your-domain.example.com;

    root /opt/car-soccer/car-soccer-mirror;
    index index.html;

    location /mp {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }

    location / {
        try_files $uri $uri/ =404;
    }
}
\`\`\`

\`\`\`bash
sudo ln -s /etc/nginx/sites-available/car-soccer /etc/nginx/sites-enabled/car-soccer
sudo nginx -t
sudo systemctl reload nginx
\`\`\`
Expected: `nginx -t` reports `syntax is ok` / `test is successful`.

## 5. Get a TLS certificate

\`\`\`bash
sudo certbot --nginx -d your-domain.example.com
\`\`\`
Follow the prompts (email address, agree to terms). Certbot edits the Nginx config in place to add the `listen 443 ssl` block and redirect HTTP → HTTPS, and sets up auto-renewal.

## 6. Verify

Visit `https://your-domain.example.com` in a browser — the game should load with a valid padlock (no certificate warning). Open the browser's network/console tools and confirm a "Play Online" → "Create a room" attempt opens a `wss://your-domain.example.com/mp` connection successfully (no mixed-content or connection errors).

## Redeploying after a code change

\`\`\`bash
cd /opt/car-soccer
git pull
sudo systemctl restart car-soccer-relay
\`\`\`
(Static file changes need no restart — Nginx serves them directly. Only relay-server changes need the `systemctl restart`.)
```

- [ ] **Step 2: Commit the deployment doc**

```bash
cd "C:/Users/Gash/Documents/projet" && git add car-soccer-mirror/docs/deployment/vps-setup.md
git commit -m "Add VPS deployment instructions for online multiplayer"
```

---

## Self-review notes

- **Spec coverage**: room create/join/codes (Tasks 3-4, 7-8), shared-seed kickoff sync (Tasks 1, 5, 9), per-tick lockstep + catch-up reuse (Task 8's `tickOnline`, using the existing `Jb` return-false-to-stall behavior — no new buffering code needed), desync fingerprint safety net (Task 5, 11), disconnect handling (Task 5's `onOpponentLeft`, Task 12), "Play Online" UI reusing the existing overlay/panel pattern (Task 7), VPS deployment with Nginx/TLS/systemd (Task 13). Explicitly-out-of-scope items from the design (reconnection, public matchmaking, server-side physics) have no tasks, correctly.
- **Placeholder scan**: Task 9's `KICKOFF_VARIANT_INDICES` originally depended on Task 1's not-yet-run finding; Task 1 has since actually been executed (during implementation) and found 5 distinct arrangements reachable via indices `[0, 2, 3, 5, 7]` — not a plain contiguous range as first assumed. Task 9 and `NetMatch.nextKickoffIndex` (Task 5) were updated to use this exact array rather than a `count`, so there is no remaining placeholder anywhere in the plan.
- **Type/name consistency checked**: `netMatch`/`onlinePanel` (Task 6) match their use in Tasks 7-9; `NetMatch`/`fingerprintState` imported in Task 6 match the exports written in Task 5; `A`, `xe`, `Di`, `r`, `u`, `qe`/`qeOnline`, `Ye`/`tickOnline`, `n`, `s`, `a` all match their definitions in the existing code (verified against direct reads of the current file, not paraphrased); `NetMatch`'s methods (`connect`, `createRoom`, `joinRoom`, `close`, `getControlsForTick`, `sendLocalTick`, `recordAndSendFingerprint`, `nextKickoffIndex`) are used identically in Task 8 to how they're defined in Task 5.
- **Correctness bug caught and fixed during this review**: the first draft started the online match as soon as either player received `{type:"matched"}`. That's wrong for the guest — the shared seed is generated by the host *after* the host itself processes `"matched"`, then travels host → server → guest, which is strictly later than the server's own `"matched"` message to the guest. The guest would have called `nextKickoffIndex()` on a `null` PRNG. Fixed by splitting `onMatched` (fires immediately for both, informational only) from a new `onReady` (fires only once the seed is actually known — immediately for the host, on seed arrival for the guest); only `onReady` is wired to actually start the match (Task 8).
- **Edit-anchor verification**: every `old_string` block used across Tasks 1 and 6-9 was mechanically checked against the actual current `assets/game-CEDHMqQk.js` (not just eyeballed) — all are present verbatim and, where uniqueness matters for a safe exact-match edit, occur exactly once in the file. The one anchor that correctly does *not* yet exist in the current file (`vt, netMatch = null, onlinePanel = null;`, targeted by Task 9) is the text Task 6 introduces — expected, since Task 9 runs after Task 6.

## Post-deployment bug: focus/visibility pause froze online matches

Found after the first real cross-machine test (two separate people, deployed to the VPS): the match matched correctly (room code, seed exchange) but neither player could move after the countdown, and each player's opponent car was never rendered.

Root cause: the render loop's pause condition (`a.state.paused = a.state.mode === "match" && (X || W.size > 0 || document.hidden || !document.hasFocus() || u)`) already existed for solo/bot play — it auto-pauses the match if the tab is backgrounded or the browser window loses OS focus (e.g. alt-tabbing to a voice-chat app to talk to the friend you're playing with, which does **not** hide the tab, just moves focus away from it). That's reasonable for solo play, but in online lockstep, if *either* player's client pauses, it stops sending new tick input entirely — and since both clients wait for each other's input every tick, one player losing focus freezes *both* players. This was never tested during Tasks 1-13 because the automated two-tab test environment made the same visibility/focus condition true for *entirely different, environment-specific reasons* (documented in Tasks 10-11) — that masked the fact that this behavior needed to be different for online matches specifically, since it was never isolated as its own variable.

Fix: for online matches only (`netMatch` truthy), the pause condition now ignores `document.hidden`/`!document.hasFocus()` — only an open overlay (`W.size > 0`), cursor-browsing mode (`X`), or the hard-stop flag (`u`, opponent-disconnected/desync) can still pause an online match. Solo/bot play is unaffected (verified: forcing `document.hasFocus()` false during a bot match still pauses it correctly). Verified the fix directly: with the browser pane's tab genuinely `document.hidden`/unfocused (no JS-level override applied at all, unlike every other test in this plan), an online match now reaches `phase: "playing"`, keeps ticking, `paused` stays `false`, and the opponent car renders at its kickoff position — none of which happened before this fix under the same conditions.

## Second post-deployment bug: real desync after the focus fix

After deploying the focus fix above, a second real cross-machine test (two separate people, again on the VPS) got further than before — the match started and ran for a while — but then hit a genuine "Desync detected. Match stopped." Both players confirmed they had picked the *same* car in the Garage, which ruled out the most likely suspect found during code review while investigating this:

**Found and fixed regardless (a real, separate latent bug):** `startOnlineMatch` called `n.configureCars(i === "flat-car" ? "flat" : "default", !0)` — `i` is `pd.load().carVisual`, the *local* player's own Garage preference, read independently by each client. `configureCars` uses this same value to compute team/spawn-side assignment for *both* cars via `Zd(e === "flat")` (`Zd(true) = {playerTeam:0, botTeam:1}`, `Zd(false) = {playerTeam:1, botTeam:0}`). Since each client calls this with its *own* `i`, two players with different individual Garage choices (specifically, one on `"flat-car"` and the other not) end up with their two cars assigned to *opposite* sides of the field in each other's simulation — i.e. the physical arrangement itself differs between the two clients from the very first kickoff, guaranteed to diverge. Fixed by hardcoding `"default"` for the team-assignment call in online matches, decoupling it from each player's individual cosmetic preference (matches how the opponent's car model was *already* always forced to `"default"` regardless of mode). This does mean the local player's own car always renders as the default model during an online match, same as the opponent already did — a minor, acceptable cosmetic trade-off for correctness.

This fix does not explain the reported incident specifically (same car on both sides, per the user), so it doesn't yet have a confirmed root cause. Rather than guess further, added real diagnostics instead: `NetMatch._checkFingerprint` now logs the mismatching tick and both hash values (`console.warn`) whenever a desync fires, and the game keeps a rolling log of the last 20 `blur`/`focus`/`visibilitychange` events (type, timestamp, `document.hidden`/`hasFocus()` at the time) that gets logged alongside the mismatch — directly testing the user's own hypothesis that losing window focus might be involved, with real data, next time this happens. Verified the logging itself fires correctly using the same forced-corruption technique as Task 11.

**Open question, not yet resolved:** why the fingerprint mismatch occurred in a same-car match. Next occurrence should have console output (tick, both hashes, recent focus events) to work from instead of guessing.

## Third post-deployment update: filter-proof diagnostics + a crash found while verifying them

After the diagnostics above shipped, the user hit another desync but reported **no console output at all** in DevTools (F12), despite the on-screen "Desync detected" message firing from the exact same code path that logs it. The most likely explanation: DevTools' Console panel has a per-level filter, and its "Warnings" toggle is unchecked by default in some profiles/versions — which would silently hide `console.warn` output specifically while leaving other message types visible. `console.error` is not subject to that filter and is not typically disabled. The user also reported the match stuttering "like 10fps" a couple seconds before the desync, a subjective impression worth quantifying with real numbers instead of guessing.

Two changes:
- `NetMatch._checkFingerprint`'s mismatch log switched from `console.warn` to `console.error` (`assets/net-match.js`), so it can no longer be hidden by the Warnings filter.
- A rolling buffer of the last 180 raw frame-delta-ms samples (`frameTimeLog`, pushed once per frame at the top of the render loop) is now included in the `onDesync` handler's logged object as `recentFrameTimesMs: frameTimeLog.slice(-60)`, alongside the existing `recentFocusEvents` — giving direct, objective data on whether a real frame-rate stall preceded the desync, rather than relying on subjective impression.

**Real bug found and fixed while verifying this with the forced-mismatch technique:** `tickOnline` reads the closure variable `netMatch` several times per call, including *after* it calls `recordAndSendFingerprint`. But when the mismatch is detected on the *sending* side (i.e. the local client's own fingerprint check finds the remote hash already available and differs), `onDesync` fires synchronously inside that same call chain and nulls `netMatch` via `endOnlineMatch`. Control then returns to the rest of the same `tickOnline` statement, which dereferences the now-null `netMatch` (`netMatch.localTick++`) and throws an uncaught `TypeError`. The on-screen error message still displayed correctly (it's shown before the crash point), but the crash itself is an uncaught exception — and would have been silent in the console under the very same Warnings-filter theory being fixed here, since an uncaught error is a different, non-filterable log level, but easy to miss if not specifically looking for it, and left the tick handler's own cleanup (`localTick++`, kickoff restart) skipped. Fixed by capturing `netMatch` into a local `nm` at the top of `tickOnline` and guarding the post-fingerprint-check statements with `if (netMatch === nm)`, so a desync that fires mid-tick cleanly short-circuits the rest of that tick instead of dereferencing a nulled-out match object. Reproduced the crash first (via the existing `window.__forceDesyncOnce` test hook plus two live browser tabs), then verified the fix resolves it: after the fix, forcing a mismatch on the sending side ends the match (`paused: true`, `netMatch: null`) with no uncaught exception, and the new `console.error`/`recentFrameTimesMs` diagnostics both appear correctly in the console.

**Still open:** the root cause of the original same-car desync report. This update makes the next occurrence's console output impossible to miss and adds real frame-timing data to correlate against — still pending a real recurrence to analyze.

## Final whole-feature review (after all 13 tasks)

A holistic review across the finished feature (not re-litigating individual tasks) found one real issue, now fixed: **`endOnlineMatch` never closed the WebSocket** before nulling `netMatch` — both the opponent-disconnect and desync-detected paths leaked an open socket to the relay server on every match end that went through them (`onCancel`/`onLeave` already did this correctly; `endOnlineMatch` was the one path that didn't). Fixed to match the existing `netMatch == null || netMatch.close(), netMatch = null` idiom already used elsewhere.

Three minor, accepted-as-is items from that review (consistent with this project's stated scope — casual friends-only v1, no reconnection, no anti-abuse):
- `NetMatch.localCar`/`remoteCar` are computed but never read by the game bundle, which hardcodes the equivalent `r`/`Di` constants instead — correct today only because the two conventions happen to agree (host/guest ↔ slot 0/1), not because they're wired together. Harmless, but worth knowing if either convention ever changes independently.
- No heartbeat distinguishes "opponent's tab is backgrounded/paused" from "opponent is gone" — an alt-tabbed player silently freezes their opponent's game with no error on either side. Acceptable for this project's scope; not fixed.
- The in-match opponent-name HUD label shows the bot's cached name (e.g. "Element") during online matches — cosmetic leftover from reusing the existing match HUD verbatim. Not fixed.
