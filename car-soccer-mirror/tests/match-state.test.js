import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// PB is not exported from the bundle, so this asserts the save/restore methods exist
// and cover every mutable field. A field added to PB later without being added to
// snapshot() would silently fail to roll back, so the check is on the field list.
const source = readFileSync("assets/game-CEDHMqQk.js", "utf8");
const start = source.indexOf("class PB {");
const PB = source.slice(start, start + 4000);

test("the match state machine was found", () => {
    assert.ok(start > 0, "class PB is missing from the bundle");
});

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

test("PB.restore assigns into the existing state object", () => {
    const restore = PB.slice(PB.indexOf("restore("), PB.indexOf("restore(") + 400);
    // The HUD holds a reference to this.state; replacing the object would leave it
    // rendering a detached copy forever.
    assert.ok(/Object\.assign\(this\.state/.test(restore),
        "restore() must Object.assign into this.state, not replace it");
});
