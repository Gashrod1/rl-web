import { loadPhysics } from "./helpers/load-physics.js";

const PAGE = 65536;

function scripted(tick, seed) {
    return {
        throttle: Math.sin((tick + seed) / 37) > 0 ? 1 : -1,
        steer: Math.sin((tick + seed) / 23),
        pitch: Math.cos((tick + seed) / 41),
        yaw: Math.sin((tick + seed) / 13),
        roll: Math.cos((tick + seed) / 17),
        jump: (tick + seed) % 53 === 0,
        boost: (tick + seed) % 7 < 3,
        handbrake: (tick + seed) % 101 === 0
    };
}

const sim = await loadPhysics();
sim.resetKickoff(0);
for (let t = 0; t < 120; t++) { sim.setControls(0, scripted(t, 0)); sim.setControls(1, scripted(t, 500)); sim.step(1); }

const before = sim.saveState();
const dirty = new Set();
function markDirty() {
    const now = sim.module.HEAPU8;
    for (let page = 0; page < now.length / PAGE; page++) {
        if (dirty.has(page)) continue;
        const s = page * PAGE, e = s + PAGE;
        for (let i = s; i < e; i++) if (now[i] !== before[i]) { dirty.add(page); break; }
    }
}

// 60 rounds x 600 ticks = 36000 ticks = 5 minutes of game time, with
// wildly varied inputs, every kickoff variant, goals and pad pickups.
const growth = [];
for (let round = 0; round < 60; round++) {
    sim.resetKickoff(round % 8);
    for (let t = 0; t < 600; t++) {
        sim.setControls(0, scripted(t, round * 137));
        sim.setControls(1, scripted(t, round * 271 + 500));
        sim.step(1);
        sim.pollGoal();
    }
    markDirty();
    growth.push(dirty.size);
}

const pages = [...dirty].sort((a, b) => a - b);
console.log("dirty page count after each round:", growth.join(","));
console.log("final dirty pages:", pages.join(","));
console.log("count:", pages.length, "span:", pages[0], "..", pages[pages.length - 1]);
console.log("heap pages:", sim.heapBytes / PAGE);
console.log("first round reached final count:", growth.indexOf(pages.length) + 1);
