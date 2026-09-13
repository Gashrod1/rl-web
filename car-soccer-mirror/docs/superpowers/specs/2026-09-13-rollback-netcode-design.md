# Rollback netcode for online 1v1 (design)

## Context

`car-soccer-mirror` is a personal, local-only reverse-engineering mirror of car-soccer.com.
Online 1v1 already works (see `2026-09-12-online-multiplayer-design.md`): a Node relay server
hands out room codes and forwards opaque payloads between two clients, which run a
**delay-based deterministic lockstep** simulation at 120 Hz.

The problem this design solves is **input lag**. Lockstep-with-delay works by holding your own
input for `inputDelay` ticks before applying it, so the matching packet has time to reach the
opponent. Measured on the deployed setup (`rl-web.gashrod.lol`, two clients, RTT 31 ms):

```
[online] Match starting { role: "host", rttMs: 31, inputDelayTicks: 10 }
```

10 ticks at 120 Hz = **83 ms of input lag**, felt on every input. The default fallback when the
ping handshake yields no samples is worse: `DEFAULT_INPUT_DELAY = 24` = 200 ms.

Local CPU contention was ruled out: two game instances running solo side by side on the same
machine are perfectly smooth. The 83 ms is structural, not a performance artifact.

The goal is **zero local input lag** — the car responds on the frame the key is pressed, as in
solo play. That requires replacing delay-based lockstep with **rollback netcode** (local
prediction + resimulation on correction), which is what Rocket League itself does.

## Scope

In scope: the netcode change and the refactoring and test infrastructure it requires.

Out of scope, deliberately:

- **Nicknames** (display the opponent's name above their car and in the scoreboard). Independent
  feature, no shared surface with the netcode. Gets its own spec.
- Relay server changes. The server forwards opaque payloads and needs no modification.
- Reconnection, matchmaking, anti-cheat — unchanged from the previous design.

## Key existing-code findings that shape this design

- The physics is an **Emscripten WASM module embedded in the game bundle**, at lines
  **20560-25416** of `assets/game-CEDHMqQk.js` (`async function $b`). It is self-contained: its
  only external reference is a Node-only `createRequire` branch never taken in a browser.
- **There is no `save`/`restore` export.** The exported surface is `_physics_init`,
  `_physics_step`, `_physics_resetKickoff`, `_physics_addCar`, `_physics_getStatePtr`,
  `_physics_getControlsPtr`, `_physics_clearGoalFlag`, `_physics_setUnlimitedBoost` and a few
  getters. State save/restore must therefore be done by **copying the WASM linear memory**
  (`module.HEAPU8`), which is fully accessible from JS.
- `state` (`class Wb`, line 25482) is a **read-only Float32Array view** over WASM memory, not a
  settable state. Writing to it would not restore the simulation — internal solver state
  (contacts, caches, PRNG) lives elsewhere in the heap. A full-heap copy is the only safe route.
- **No `Math.random` anywhere in the physics glue.** Whatever randomness `resetKickoff(-1)`
  uses is internal to the WASM heap, so a heap snapshot captures it. Determinism holds.
- `step()` reads controls from a fixed buffer written by `setControls()`, then advances.
  Resimulation is therefore just "rewrite controls, step again" — exactly what rollback needs.
- The fixed-timestep accumulator (`class Jb`, line 25566) sets `this.accumulator = 0` when the
  tick callback returns false (a network stall). Accumulated real time is **discarded**, so game
  time falls permanently behind wall-clock time and the N-tick delay costs more than N x 8.33 ms
  in practice. This inflates the felt lag beyond the nominal 83 ms and must be fixed.
- `sendLocalTick` sends **one JSON WebSocket message per tick, 120/s per client** (~150 bytes
  each). High overhead and a jitter source, which is what forces the large `INPUT_DELAY_MARGIN`.

## Architecture

```
assets/physics-core.js    NEW  Emscripten glue extracted verbatim from the bundle
                               (lines 20560-25416), plus snapshot/restore of the heap.

assets/rollback.js        NEW  Rollback engine. Pure logic, dependency-injected.
                               Knows nothing about WASM or WebSockets.

assets/net-match.js       MOD  Binary transport, redundant inputs, no mandatory input delay.

assets/game-CEDHMqQk.js   MOD  Imports physics-core; tickOnline drives rollback.js.

tests/                    NEW  Node test harness.
```

The load-bearing decision is **dependency injection into `rollback.js`**:

```js
new RollbackSession({ saveState, loadState, stepOne, maxPrediction })
```

The engine receives three functions and never touches the physics or the network directly. Tests
can therefore drive it with a trivial deterministic fake simulation (an integer accumulator),
where any rollback error produces an obvious mismatch, with no WASM and no network involved.
The same engine, with the real three functions, is what ships.

## Stage 0 - Extract the physics core

Pure code move: lines 20560-25416 to `assets/physics-core.js`, exported; the bundle imports it.
**No logic change whatsoever.**

Rationale beyond testability: the rollback work needs many iterations on physics-adjacent code,
and a focused 5000-line module is far more tractable than the same code buried in a 2.3 MB
bundle — for a human reader and for an agent editing it.

Acceptance: the game loads, a solo match plays normally, and the existing online mode still
works. Single isolated commit, revertible with `git revert`.

## Stage 1 - Measurement gate (blocking)

This is the unknown that decides whether rollback is viable at all. Measured in the Node harness:

1. **WASM heap size** after `init()` (expected: 16 MB, the Emscripten default).
2. **Actually-mutable range**: full snapshot, 100 `step()` calls, re-snapshot, page-by-page diff.
   The Emscripten heap is `[static data | frozen collision BVH | dynamic state]`; only the last
   part should change. Expected: tens of kilobytes. The scan must exercise kickoffs, goals, boost
   pad pickups and car-car collisions, not just straight-line driving, so that rarely-touched
   pages are not missed.
3. **Real cost** of copying that range, and cost of one `step()`.

**Pass criterion**: snapshot + 8-tick resimulation under ~1 ms, i.e. 12% of the 8.33 ms tick
budget; and a ring of `maxPrediction` snapshots under ~8 MB of memory.

**If it fails**, rollback is abandoned and the work falls back to tuning the existing lockstep
(smaller `INPUT_DELAY_MARGIN` and `MIN_INPUT_DELAY`, binary transport, redundant inputs,
accumulator fix), which lands around 50 ms. This is reported before a line of rollback code is
written. The Stage 2 transport work below is valuable in either outcome.

## Stage 2 - Transport

Changes to `assets/net-match.js`. The relay server is untouched.

- **No input delay.** `sendLocalTick` sends the current tick, not `tick + inputDelay`.
- **Redundant inputs**: each packet carries the **last 4 inputs**, not one. A dropped packet is
  covered by the next one, causing neither a stall nor a rollback. Free at this size, and it
  removes the main source of stutter.
- **Binary format**: ~28 bytes per packet instead of ~150 bytes of JSON. Less jitter, less load
  on the relay.
- **Fix the accumulator discard** in `class Jb` so game time stops drifting behind wall-clock
  time on a stall.

### Determinism hazard: input quantisation

The binary format quantises the analog axes (throttle, steer, pitch, yaw, roll) to 8-bit
integers. The local simulation must therefore be fed the **quantised** value too. Otherwise the
local sim uses `0.7314...` while the opponent's uses `0.73`, and the two worlds diverge slowly —
a bug that only surfaces after tens of seconds of play.

Quantisation happens **exactly once, at input sampling**, upstream of both the network path and
the local simulation path. This is an explicit test case in the harness.

## Stage 3 - Rollback engine

### Time model

| Cursor | Meaning |
|---|---|
| `currentTick` | The displayed tick. Advances with real time, **never waits for the network**. |
| `confirmedTick` | Last tick whose real opponent input is known. |
| `maxPrediction` | Maximum tolerated gap: 16 ticks (133 ms). Beyond it, stall as today. |

At 31 ms RTT one trip is ~2 ticks, so the steady-state prediction window is **2 to 4 ticks**
(17-33 ms). That shortness is what makes mispredictions invisible.

### Per-tick loop

1. Sample local input and apply it **immediately** to the current tick. *(This is where the
   83 ms goes away.)*
2. For the opponent: use their real input if known, otherwise **predict by repeating their last
   received input**. At 120 Hz a car's input rarely changes tick to tick, so this predicts
   correctly most of the time.
3. `step()`, then snapshot into a ring buffer of `maxPrediction` slots.

### Correction

When the opponent's real input for tick `T` arrives:

- **Matches the prediction** (the common case): `confirmedTick = T`. Nothing else, no cost.
- **Differs**: restore the snapshot for tick `T`, resimulate `T` -> `currentTick` with the
  corrected input, re-snapshotting along the way. Cost: `currentTick - T` steps, 2 to 4 in
  steady state.

A correction is **never** applied to the local car — the local input is always the one actually
given. Only the opponent's car can shift, by a few milliseconds of trajectory.

### Stalling

If the opponent's input falls more than `maxPrediction` ticks behind, stop advancing rather than
predicting further, exactly as the current implementation does. This bounds resimulation cost and
prevents a long unwind after a network hiccup.

## Stage 4 - Integration

### Simulation vs presentation

Resimulation replays ticks that have already been simulated. Anything with a side effect outside
the simulation must therefore not fire during resimulation.

The rule: **presentation effects fire only when `confirmedTick` advances past them, never on
predicted ticks.** This covers the serial counters read in `qeOnline` (`JUMP_SERIAL`,
`DODGE_SERIAL`, `DOUBLE_JUMP_SERIAL`, `WHEEL_IMPACT_SERIAL`, `BALL_HIT_SERIAL`,
`BALL_WORLD_IMPACT_SERIAL`), ball-trail resets, and camera resets.

Consequence: audio trails the visuals by the prediction window, 2-4 ticks. Inaudible, and it is
what every rollback implementation does.

Rendering keeps using the **predicted** current tick — that is the entire point of the design.

### Match state machine

`a.tick()` (score, phase, kickoff detection) is simulation state and must roll back with
everything else. It is a small JS object: save/restore alongside the heap snapshot. Goal and
kickoff **transitions** fire their effects only once confirmed, per the rule above.

`n.pollGoal()` clears the goal flag inside the WASM heap, so it is captured and restored by the
heap snapshot automatically — no special handling needed.

### Runtime fallback flag

The existing delay-based lockstep path **stays in the code**, behind a runtime flag. If rollback
misbehaves in a real match, switching back is immediate and requires no rebuild or redeploy.
This is the most direct regression safety net available and costs almost nothing to keep.

### Desync detection

`recordAndSendDrift` is kept, with fingerprints compared on **confirmed** ticks only (predicted
state legitimately differs between the two clients and would produce false positives).

## Testing

No automated test infrastructure exists today; verification has been manual. The core of this
plan is that rollback has a **self-checking invariant**:

> Simulating N ticks with rollback (restores and resimulations) must produce state **identical
> bit for bit** to simulating the same N ticks straight through.

That is checkable offline, with no network and no second machine.

Harness tests, in order of value:

1. **Engine against a fake sim.** `rollback.js` driven by a deterministic integer accumulator.
   Covers: correct prediction, misprediction and correction, out-of-order arrival, duplicate
   inputs, a packet lost then recovered by redundancy, and the `maxPrediction` stall.
2. **Engine against the real physics.** The invariant above, over a scripted input sequence of
   several thousand ticks with mispredictions injected at random ticks. Compares the full
   `state` array, not a subset.
3. **Quantisation determinism.** Two sessions fed the same raw inputs through the quantiser
   produce identical state — catches the Stage 2 hazard.
4. **Cost regression.** Asserts snapshot and resimulation cost stays within the Stage 1 budget.

Manual verification is retained for what the harness cannot cover: actual felt latency, visual
smoothness of the opponent car, and audio correctness.

## Risks

| Risk | Mitigation |
|---|---|
| Snapshot too expensive / mutable range too large | Stage 1 gate, before any rollback code. Fall back to lockstep tuning. |
| Extraction breaks the bundle | Pure move, no logic change, isolated commit, `git revert`. |
| Rollback bug corrupts a live match | Runtime flag falls back to lockstep instantly. |
| Slow divergence from quantisation | Dedicated harness test; desync detector as backstop. |
| Mutable-range scan misses a rarely-touched page | Scan exercises kickoffs, goals, pad pickups and car-car collisions, not just driving. |
