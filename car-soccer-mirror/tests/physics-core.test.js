import test from "node:test";
import assert from "node:assert/strict";
import { loadPhysics } from "./helpers/load-physics.js";
import { ct } from "../assets/physics-core.js";

test("physics boots under Node and exposes a state array", async () => {
    const sim = await loadPhysics();
    assert.ok(sim.state.length > 0, "state array should be non-empty");
    assert.equal(sim.state[ct.NUM_CARS], 2, "two cars should be configured");
});
