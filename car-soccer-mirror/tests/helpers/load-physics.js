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
