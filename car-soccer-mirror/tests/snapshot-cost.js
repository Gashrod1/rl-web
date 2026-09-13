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
