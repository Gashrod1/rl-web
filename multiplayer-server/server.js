import { WebSocketServer } from "ws";
import { randomInt } from "crypto";

const PORT = Number(process.env.PORT) || 8080;
// Local testing only: adds a one-way delay to relayed messages so a machine running
// both clients still behaves like two machines on a real connection.
const RELAY_DELAY_MS = Number(process.env.RELAY_DELAY_MS) || 0;
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
            if (RELAY_DELAY_MS > 0) setTimeout(() => send(other, { type: "relay", payload: message.payload }), RELAY_DELAY_MS);
            else send(other, { type: "relay", payload: message.payload });
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
