# Physics Core Extraction & Measurement Gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the WASM physics engine out of the 2.3 MB game bundle into its own testable module, build a Node test harness around it, and measure whether WASM heap snapshotting is cheap enough for rollback netcode.

**Architecture:** Lines 20560-25562 of `assets/game-CEDHMqQk.js` (the Emscripten glue, the state-layout constants, and the `PhysicsSim` wrapper class) move verbatim into `assets/physics-core.js`, which the bundle then imports. Two small interface changes make the module runnable outside a browser: collision-mesh loading becomes injectable, and the Node branch imports `node:module` directly instead of a Vite shim that does not exist in this mirror. A Node harness then loads the module directly and measures heap snapshot cost.

**Tech Stack:** Plain ES modules, no build step (the mirror serves `assets/*.js` as-is). Tests use Node 22's built-in `node:test` runner — no dependencies.

**Scope:** This plan is Stages 0 and 1 of [the rollback netcode spec](../specs/2026-09-13-rollback-netcode-design.md). It deliberately stops at the measurement gate. The rollback engine itself (Stages 2-4) gets its own plan, written once the measurements are known, because the snapshot strategy depends on the numbers this plan produces.

**Success criterion for the whole plan:** `npm test` passes, the game still plays identically in the browser, and `docs/superpowers/measurements/2026-09-13-snapshot-cost.md` contains a go/no-go verdict on rollback.

---

## File Structure

| File | Responsibility |
|---|---|
| `assets/physics-core.js` | **New.** Emscripten glue (`createPhysicsModule`), state-layout constants (`ct`, `Ee`, `An`, …), and the `PhysicsSim` wrapper. The only module that touches WASM memory. |
| `assets/game-CEDHMqQk.js` | **Modified.** Loses 5003 lines, gains one `import`. No behaviour change. |
| `package.json` | **New.** Declares ES modules and the `test` script. No dependencies. |
| `tests/helpers/load-physics.js` | **New.** Boots `PhysicsSim` under Node, reading collision meshes from disk. |
| `tests/physics-core.test.js` | **New.** Smoke test + determinism test for the extracted module. |
| `tests/snapshot-cost.js` | **New.** Measurement script (not a test — it prints a report). |
| `docs/superpowers/measurements/2026-09-13-snapshot-cost.md` | **New.** The gate verdict. |

### Facts verified against the current code

These are established, not assumed. Do not re-derive them:

- `async function $b(i = {})` spans lines **20560-25416**. Its only reference to a bundle-level identifier is `B0` (line 20530), used solely in the Node branch.
- Lines **25417-25562** hold `uo`, `zb`, `Di`, `Zd`, `ct`, `An`, `Hf`, `k0`, `Zl`, `Ee`, `Vb`, and `class Wb`.
- `$b` is referenced exactly once outside its own definition: line 25487, inside `Wb.init()`.
- `Wb` is referenced exactly once outside the block: line 39103 (`n = new Wb`).
- Used outside the block, and therefore exported: `ct` (61×), `Ee` (115×), `An` (21×), `Di` (10×), `zb` (7×), `uo` (4×), `Zl` (4×), `Zd` (2×), `Vb` (1×), `Wb` (1×). `k0` and `Hf` are used only inside it and stay private.
- `v` (line 8) is the esbuild `__publicField` helper, used by `class Wb`. It is three lines and gets redefined locally in `physics-core.js` rather than imported.
- The WASM binary is a **string literal embedded in the glue**, not a separate `.wasm` file. Nothing needs to be fetched for the module itself.
- `assets/__vite-browser-external-BIHI7g3E.js` **does not exist** in this mirror. The Node branch is already broken; Task 3 fixes it.

---

## Task 1: Node test harness skeleton

**Files:**
- Create: `package.json`
- Create: `tests/smoke.test.js`

- [ ] **Step 1: Confirm the Node version**

```bash
node --version
```

Expected: `v22.x` or later. `node:test` and `--test` require Node 18+; this plan was written against v22.23.1.

- [ ] **Step 2: Write the failing test**

Create `tests/smoke.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("collision manifest lists 16 meshes", () => {
    const manifest = JSON.parse(readFileSync("assets/arena/collision/manifest.json", "utf8"));
    assert.equal(manifest.length, 16);
});
```

This is deliberately trivial: its job is to prove the runner is wired up before anything harder depends on it.

- [ ] **Step 3: Run it to verify it fails**

```bash
node --test tests/
```

Expected: FAIL — `Cannot use import statement outside a module`, because `package.json` does not exist yet.

- [ ] **Step 4: Create package.json**

Create `package.json` at the repo root:

```json
{
  "name": "car-soccer-mirror",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test tests/"
  }
}
```

`"type": "module"` is required so `tests/*.js` and `assets/physics-core.js` load as ES modules under Node. It does not affect how the browser loads the site — the mirror is served as static files and never reads `package.json`.

- [ ] **Step 5: Run the test to verify it passes**

```bash
npm test
```

Expected: PASS, `1 passing`.

- [ ] **Step 6: Commit**

```bash
git add package.json tests/smoke.test.js
git commit -m "Add Node test harness skeleton"
```

---

## Task 2: Extract the physics core (pure code move)

**Files:**
- Create: `assets/physics-core.js`
- Modify: `assets/game-CEDHMqQk.js` — remove lines 20560-25562, insert one import

This task changes **no logic**. If the extraction is correct, the game behaves bit-identically.

- [ ] **Step 1: Record a baseline for the file**

```bash
wc -l assets/game-CEDHMqQk.js
```

Expected: `39703`. Write the number down — Step 5 checks against it.

- [ ] **Step 2: Cut the block into the new module**

```bash
{
  echo '// Extracted verbatim from assets/game-CEDHMqQk.js lines 20560-25562.'
  echo '// The WASM physics engine, its state layout constants, and the PhysicsSim wrapper.'
  echo '// See docs/superpowers/specs/2026-09-13-rollback-netcode-design.md'
  echo ''
  echo 'var $g = Object.defineProperty;'
  echo 'var zg = (i, e, t) => e in i ? $g(i, e, { enumerable: !0, configurable: !0, writable: !0, value: t }) : i[e] = t;'
  echo 'var v = (i, e, t) => zg(i, typeof e != "symbol" ? e + "" : e, t);'
  echo ''
  sed -n '20560,25562p' assets/game-CEDHMqQk.js
  echo ''
  echo 'export { $b as createPhysicsModule, Wb as PhysicsSim, ct, Ee, An, Zl, uo, zb, Di, Zd, Vb };'
} > assets/physics-core.js
```

The three `var` lines at the top are a local copy of the esbuild `__publicField` helper from line 8 of the bundle, which `class Wb` uses. Copying three lines is cleaner than exporting an internal helper across a module boundary.

- [ ] **Step 3: Remove the block from the bundle and add the import**

```bash
python3 - <<'PY'
path = "assets/game-CEDHMqQk.js"
lines = open(path, encoding="utf-8", newline="").read().split("\n")
# 1-indexed 20560..25562 -> 0-indexed slice
assert lines[20559].startswith("async function $b("), lines[20559][:60]
assert lines[25561] == "}", repr(lines[25561])
imp = 'import { createPhysicsModule as $b, PhysicsSim as Wb, ct, Ee, An, Zl, uo, zb, Di, Zd, Vb } from "./physics-core.js";'
lines[20559:25562] = [imp]
open(path, "w", encoding="utf-8", newline="").write("\n".join(lines))
print("ok")
PY
```

The two `assert` lines are the safety net: if the line numbers have drifted, the script refuses to cut rather than mangling the bundle.

- [ ] **Step 4: Check both files parse**

```bash
node --check assets/physics-core.js && node --check assets/game-CEDHMqQk.js && echo "both parse"
```

Expected: `both parse`. A syntax error here means the cut landed on the wrong line — `git checkout assets/` and re-check the line numbers.

- [ ] **Step 5: Verify the line accounting**

```bash
wc -l assets/game-CEDHMqQk.js assets/physics-core.js
```

Expected: the bundle is `34701` lines (39703 − 5003 + 1), and `physics-core.js` is `5011` (5003 + 8 lines of header and export).

- [ ] **Step 6: Verify no identifier was left behind**

```bash
grep -c 'class Wb\|async function \$b' assets/game-CEDHMqQk.js
```

Expected: `0` — both definitions now live only in `physics-core.js`.

- [ ] **Step 7: Verify the game still runs in the browser**

Start the preview server and load the game:

```bash
npx --yes serve -l 5175 .
```

Open `http://localhost:5175`, then check:
1. The game loads with no console error (especially no `ReferenceError`, which is what an unresolved cross-boundary identifier would produce).
2. A solo match against the bot plays normally — drive, boost, jump, score a goal.

A `ReferenceError: X is not defined` here means the moved block referenced a bundle-level identifier not accounted for in the facts list. Add it to the local header in `physics-core.js` the way `v` was handled, or export it from the bundle — do not guess; read the failing line.

- [ ] **Step 8: Commit**

```bash
git add assets/physics-core.js assets/game-CEDHMqQk.js
git commit -m "Extract WASM physics core into assets/physics-core.js"
```

---

## Task 3: Make the physics core loadable under Node

**Files:**
- Modify: `assets/physics-core.js` (two edits)
- Create: `tests/helpers/load-physics.js`
- Create: `tests/physics-core.test.js`

Two things stop the module booting outside a browser: the Node branch imports a Vite shim that does not exist in this mirror, and `init()` fetches collision meshes over HTTP.

- [ ] **Step 1: Write the failing test**

Create `tests/helpers/load-physics.js`:

```js
import { readFile } from "node:fs/promises";
import { PhysicsSim } from "../../assets/physics-core.js";

const COLLISION_DIR = "assets/arena/collision";

export async function loadPhysics() {
    const sim = new PhysicsSim();
    await sim.init(async name => {
        const buf = await readFile(`${COLLISION_DIR}/${name}`);
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    });
    sim.configureCars("default", true);
    return sim;
}
```

The `buf.buffer.slice(...)` is not incidental: `readFile` returns a Buffer that is a **view into a shared pool**, so `buf.buffer` is much larger than the file. Slicing to the view's own bounds is what makes it a correct standalone `ArrayBuffer`.

Create `tests/physics-core.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { loadPhysics } from "./helpers/load-physics.js";
import { ct } from "../assets/physics-core.js";

test("physics boots under Node and exposes a state array", async () => {
    const sim = await loadPhysics();
    assert.ok(sim.state.length > 0, "state array should be non-empty");
    assert.equal(sim.state[ct.NUM_CARS], 2, "two cars should be configured");
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm test
```

Expected: FAIL — `Cannot find module './__vite-browser-external-BIHI7g3E.js'`.

- [ ] **Step 3: Replace the Vite shim with a direct node:module import**

In `assets/physics-core.js`, find this (it is inside `createPhysicsModule`, near the top):

```js
        const {
            createRequire: f
        } = await B0(() => import("./__vite-browser-external-BIHI7g3E.js"), []);
```

Replace it with:

```js
        const {
            createRequire: f
        } = await import("node:module");
```

`B0` was Vite's dynamic-import helper wrapping a browser-external stub. The stub is not present in this mirror, so this branch could never have worked; importing `node:module` directly is what the helper resolved to under Node anyway. The browser never takes this branch (it is guarded by a `process.versions.node` check), so browser behaviour is unchanged.

- [ ] **Step 4: Run the test again**

```bash
npm test
```

Expected: still FAIL, but now with a `fetch` error on `/assets/arena/collision/manifest.json` — progress, and it confirms the previous fix landed.

- [ ] **Step 5: Make collision-mesh loading injectable**

In `assets/physics-core.js`, find the start of `PhysicsSim.init` (`class Wb`'s `async init()`):

```js
    async init() {
        this.module = await $b();
        const e = await (await fetch("/assets/arena/collision/manifest.json")).json(),
            t = await Promise.all(e.map(async l => new Uint8Array(await (await fetch(`/assets/arena/collision/${l}`)).arrayBuffer()))),
```

Replace those four lines with:

```js
    async init(loadAsset = fetchCollisionAsset) {
        this.module = await $b();
        const e = JSON.parse(new TextDecoder().decode(await loadAsset("manifest.json"))),
            t = await Promise.all(e.map(async l => new Uint8Array(await loadAsset(l)))),
```

Leave the rest of `init()` untouched.

Then add this function immediately **above** `class Wb`:

```js
const fetchCollisionAsset = async name =>
    (await fetch(`/assets/arena/collision/${name}`)).arrayBuffer();
```

The default argument preserves the existing browser call site exactly: `new Wb().init()` still fetches over HTTP from the same paths.

- [ ] **Step 6: Run the test to verify it passes**

```bash
npm test
```

Expected: PASS, `2 passing`.

- [ ] **Step 7: Re-verify the browser still works**

Reload `http://localhost:5175` and play a solo match. Expected: identical to Task 2 Step 7. This matters because Step 5 touched a real call path, not just a dead Node branch.

- [ ] **Step 8: Commit**

```bash
git add assets/physics-core.js tests/helpers/load-physics.js tests/physics-core.test.js
git commit -m "Make physics core loadable under Node"
```

---

## Task 4: Prove the simulation is deterministic

Rollback is worthless if `step()` is not reproducible. This test is the foundation everything else rests on, and it is cheap to write now.

**Files:**
- Modify: `tests/physics-core.test.js`

- [ ] **Step 1: Write the failing test**

Append to `tests/physics-core.test.js`:

```js
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
```

`resetKickoff(0)` pins the kickoff variant to an explicit index. Calling it with the default `-1` lets the WASM module pick internally, which would make the two runs incomparable.

1200 ticks is 10 seconds of game time — long enough for both cars to collide with the ball, the walls and each other, so the test exercises the contact solver rather than just free driving.

- [ ] **Step 2: Run it**

```bash
npm test
```

Expected: PASS. Two separately-instantiated WASM modules, fed identical inputs, must end in identical state.

**If this fails, stop and report it.** It means the physics has a non-deterministic input the spec did not account for, and rollback — as well as the *existing* lockstep netcode — cannot be correct. Diagnose before continuing: log the first differing index and map it back through `ct`/`Ee` to identify which quantity diverged.

- [ ] **Step 3: Commit**

```bash
git add tests/physics-core.test.js
git commit -m "Add physics determinism test"
```

---

## Task 5: Snapshot and restore the WASM heap

**Files:**
- Modify: `assets/physics-core.js` (add three methods to `PhysicsSim`)
- Modify: `tests/physics-core.test.js`

- [ ] **Step 1: Write the failing test**

Append to `tests/physics-core.test.js`:

```js
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
```

The last loop is the invariant the whole rollback design rests on: **restore + resimulate must equal simulate straight through**. Checking only that `loadState` rewinds the visible `state` array would not prove it — internal solver state lives elsewhere in the heap, and a restore that missed it would pass the cheap check and fail here.

- [ ] **Step 2: Run it to verify it fails**

```bash
npm test
```

Expected: FAIL — `sim.saveState is not a function`.

- [ ] **Step 3: Add the snapshot methods**

In `assets/physics-core.js`, inside `class Wb`, add these three methods after `step(e)`:

```js
    get heapBytes() {
        return this.module.HEAPU8.length
    }
    saveState(into = null) {
        const e = this.module.HEAPU8;
        if (into && into.length === e.length) return into.set(e), into;
        return e.slice()
    }
    loadState(e) {
        this.module.HEAPU8.set(e), this.stateView = null, this.controlsView = null, this.viewView = null
    }
```

Two details that are easy to get wrong:

- `saveState` takes an optional destination buffer so the rollback engine can reuse a preallocated ring instead of allocating 16 MB per tick. `slice()` is the convenience path for tests.
- `loadState` nulls the three cached typed-array views. `HEAPU8.set` does not detach the buffer, so the views would still be valid — but nulling them is what keeps this correct if the heap ever grows (`_emscripten_resize_heap` replaces the buffer, and a stale view would then silently read the wrong memory).

This is the deliberately naive full-heap implementation. Task 6 measures what it costs; narrowing it to the mutable range is the rollback plan's job, not this one's.

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm test
```

Expected: PASS, `4 passing`.

- [ ] **Step 5: Commit**

```bash
git add assets/physics-core.js tests/physics-core.test.js
git commit -m "Add WASM heap snapshot/restore to PhysicsSim"
```

---

## Task 6: Measure the snapshot cost (the gate)

**Files:**
- Create: `tests/snapshot-cost.js`
- Create: `docs/superpowers/measurements/2026-09-13-snapshot-cost.md`

This is a measurement script, not a test — it prints a report and asserts nothing.

- [ ] **Step 1: Write the measurement script**

Create `tests/snapshot-cost.js`:

```js
import { loadPhysics } from "./helpers/load-physics.js";

const PAGE = 65536;          // WASM page size
const PREDICTION_WINDOW = 16; // ring slots the rollback engine would need

function scripted(tick) {
    return {
        throttle: Math.sin(tick / 37) > 0 ? 1 : -1,
        steer: Math.sin(tick / 23),
        pitch: Math.cos(tick / 41),
        yaw: 0, roll: 0,
        jump: tick % 53 === 0,
        boost: tick % 7 < 3,
        handbrake: false
    };
}

const sim = await loadPhysics();
sim.resetKickoff(0);

// Warm up: reach a steady state before measuring anything.
for (let tick = 0; tick < 120; tick++) {
    sim.setControls(0, scripted(tick));
    sim.setControls(1, scripted(tick + 500));
    sim.step(1);
}

console.log(`heap size: ${(sim.heapBytes / 1048576).toFixed(1)} MB (${sim.heapBytes / PAGE} pages)`);

// --- Which pages actually change? ---
// Exercise everything that can touch memory: driving, collisions, kickoffs,
// goals and boost pad pickups. A page missed here would be a page the rollback
// engine fails to restore, so breadth matters more than duration.
const before = sim.saveState();
const dirty = new Set();

function markDirty() {
    const now = sim.module.HEAPU8;
    for (let page = 0; page < now.length / PAGE; page++) {
        if (dirty.has(page)) continue;
        const start = page * PAGE, end = start + PAGE;
        for (let i = start; i < end; i++) {
            if (now[i] !== before[i]) { dirty.add(page); break; }
        }
    }
}

for (let round = 0; round < 8; round++) {
    sim.resetKickoff(round % 4);
    for (let tick = 0; tick < 400; tick++) {
        sim.setControls(0, scripted(tick + round * 97));
        sim.setControls(1, scripted(tick + round * 31 + 500));
        sim.step(1);
        sim.pollGoal();
    }
    markDirty();
}

const pages = [...dirty].sort((a, b) => a - b);
const mutableBytes = pages.length * PAGE;
console.log(`mutable pages: ${pages.length} / ${sim.heapBytes / PAGE}` +
    ` = ${(mutableBytes / 1024).toFixed(0)} KB`);
console.log(`page range: ${pages[0]}..${pages[pages.length - 1]}` +
    ` (contiguous: ${pages.length === pages[pages.length - 1] - pages[0] + 1})`);

// --- What does it cost? ---
function timeIt(label, iterations, fn) {
    fn(); // discard the first run (JIT warm-up)
    const t0 = performance.now();
    for (let i = 0; i < iterations; i++) fn();
    const perOp = (performance.now() - t0) / iterations;
    console.log(`${label}: ${perOp.toFixed(4)} ms`);
    return perOp;
}

const fullBuf = new Uint8Array(sim.heapBytes);
const rangeStart = pages[0] * PAGE;
const rangeEnd = (pages[pages.length - 1] + 1) * PAGE;
const rangeBuf = new Uint8Array(rangeEnd - rangeStart);

const fullCost = timeIt("full-heap snapshot", 200, () => fullBuf.set(sim.module.HEAPU8));
const rangeCost = timeIt("mutable-range snapshot", 200,
    () => rangeBuf.set(sim.module.HEAPU8.subarray(rangeStart, rangeEnd)));
const stepCost = timeIt("single step()", 500, () => sim.step(1));

// --- The verdict ---
const budget = 1000 / 120;          // 8.33 ms per tick
const worst = rangeCost + 8 * stepCost; // snapshot + an 8-tick resimulation
console.log(`\ntick budget: ${budget.toFixed(2)} ms`);
console.log(`snapshot + 8-tick resim: ${worst.toFixed(3)} ms` +
    ` (${(worst / budget * 100).toFixed(1)}% of budget)`);
console.log(`ring of ${PREDICTION_WINDOW} snapshots:` +
    ` ${(PREDICTION_WINDOW * (rangeEnd - rangeStart) / 1048576).toFixed(1)} MB`);
console.log(`\nVERDICT: ${worst < 1 ? "PASS" : "FAIL"}` +
    ` (pass criterion: under 1 ms)`);
console.log(`full-heap fallback would be ${(fullCost + 8 * stepCost).toFixed(3)} ms`);
```

- [ ] **Step 2: Run it**

```bash
node tests/snapshot-cost.js
```

Expected output shape (numbers will differ):

```
heap size: 16.0 MB (256 pages)
mutable pages: 3 / 256 = 192 KB
page range: 12..14 (contiguous: true)
full-heap snapshot: 1.4210 ms
mutable-range snapshot: 0.0180 ms
single step(): 0.0400 ms
...
VERDICT: PASS (pass criterion: under 1 ms)
```

- [ ] **Step 3: Write the measurement report**

Create `docs/superpowers/measurements/2026-09-13-snapshot-cost.md` and record: the actual numbers from Step 2, whether the mutable page range is contiguous, and the verdict.

Then state the consequence explicitly, using the real numbers:

- **PASS** → the rollback plan proceeds, and the snapshot ring is sized against the measured mutable range.
- **PASS only with the mutable-range optimisation** (full-heap is too slow, range is fine) → the rollback plan must treat the dirty-page scan as a correctness requirement, not an optimisation, and re-run it on every startup rather than hardcoding page numbers.
- **FAIL** → rollback is abandoned. Report this before writing any rollback code, and fall back to the lockstep tuning path in the spec (~50 ms).

Do not paper over a marginal result. A snapshot that costs 40% of the tick budget is a FAIL even though it "works" — it leaves no headroom for the rendering the same frame has to do.

- [ ] **Step 4: Commit**

```bash
git add tests/snapshot-cost.js docs/superpowers/measurements/2026-09-13-snapshot-cost.md
git commit -m "Measure WASM heap snapshot cost for rollback netcode"
```

---

## Task 7: Verify no regression in the online path

The extraction touched a module the online netcode depends on. This confirms the existing multiplayer still works before the next plan starts changing it.

**Files:** none modified — this is a verification task.

- [ ] **Step 1: Start the relay server**

```bash
node ../multiplayer-server/server.js
```

Expected: `Relay server listening on port 8080`.

- [ ] **Step 2: Play an online match against yourself**

Open two browser windows on the deployed instance (`rl-web.gashrod.lol`) or locally. Create a room in one, join with the code in the other.

Check:
1. `[online] Match starting` appears in both consoles with a plausible `rttMs`.
2. Both cars move, the ball is in the same place in both windows.
3. Score a goal — both windows agree on the score and reset to kickoff together.
4. **No `[online] Simulation drift` warning** appears in either console. This is the important one: a drift warning after the extraction would mean the code move changed simulation behaviour.

- [ ] **Step 3: Record the result**

Append a "Post-extraction verification" section to `docs/superpowers/measurements/2026-09-13-snapshot-cost.md` noting that online play was confirmed drift-free, with the observed RTT and match duration.

If drift **does** appear, do not continue to the rollback plan. `git bisect` across the four commits from this plan — the culprit is almost certainly Task 3 Step 5 (the `init()` signature change), since it is the only edit that touched a live browser code path.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/measurements/2026-09-13-snapshot-cost.md
git commit -m "Verify online play is unaffected by the physics extraction"
```

---

## Done criteria

- [ ] `npm test` passes with 4 tests.
- [ ] The game loads and a solo match plays normally in the browser.
- [ ] An online 1v1 match plays with no drift warning.
- [ ] `docs/superpowers/measurements/2026-09-13-snapshot-cost.md` contains a PASS or FAIL verdict with real numbers.
- [ ] `assets/game-CEDHMqQk.js` is ~5000 lines shorter and imports `./physics-core.js`.

## What comes next

On PASS, the follow-up plan implements Stages 2-4 of the spec: binary transport with redundant inputs, the `RollbackSession` engine, and integration with the presentation layer. It is written **after** this plan runs, because the snapshot strategy depends on the numbers Task 6 produces.

On FAIL, the follow-up plan is the lockstep tuning path instead: smaller `INPUT_DELAY_MARGIN` and `MIN_INPUT_DELAY`, binary transport, redundant inputs, and the accumulator fix — landing around 50 ms rather than zero.
