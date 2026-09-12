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
