import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("collision manifest lists 16 meshes", () => {
    const manifest = JSON.parse(readFileSync("assets/arena/collision/manifest.json", "utf8"));
    assert.equal(manifest.length, 16);
});
