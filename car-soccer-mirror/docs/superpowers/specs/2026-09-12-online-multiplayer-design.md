# Online 1v1 multiplayer (design)

## Context

`car-soccer-mirror` is a personal, local-only reverse-engineering mirror of car-soccer.com, modified for personal learning/comfort features — nothing here is published or redistributed as the original site. The repo is now a local git repository (`git log` shows one commit, `first`).

The game already has a 1v1 mode against an AI opponent ("Nexto"-style bots, internally "seer"/"element", running via ONNX Runtime Web in a worker — see `assets/game-CEDHMqQk.js` class `GB`, `preloadAll()`/`decide()`). The goal here is to add a **real online 1v1 mode**: one player creates a room and gets a short code, a second player joins with that code, and they play against each other over the internet — hosted on the user's own OVH VPS (Node.js already installed; a domain name is available to point at it, but no reverse proxy/TLS yet).

This is a substantial feature touching client (new UI + a new network-driven opponent-control source), a new server component, and VPS deployment. It was brainstormed as one coherent design (the three pieces are tightly coupled around a single architectural decision — see below) rather than split into independent sub-projects, but the implementation plan should build and verify it in stages.

## Key existing-code findings that shape this design

- The physics engine (`PhysCoreX`, compiled to WebAssembly, embedded directly in `assets/game-CEDHMqQk.js`) runs **only in the browser, on the main thread**, at a **fixed 120 Hz tick rate** (`Xb = 120` at [game-CEDHMqQk.js:25562](../../../assets/game-CEDHMqQk.js)). Each tick: write each car's controls into the WASM memory buffer (`setControls(carIndex, controls)`, [game-CEDHMqQk.js:25514](../../../assets/game-CEDHMqQk.js)), then advance the simulation one step (`step(1)` → `_physics_step`, [game-CEDHMqQk.js:25528](../../../assets/game-CEDHMqQk.js)). WebAssembly's floating-point semantics are specified to be reproducible across compliant engines, which is what makes deterministic lockstep netcode viable here without touching the physics engine at all.
- **Kickoff can be randomized inside the WASM module itself**: `resetKickoff(e = -1)` → `_physics_resetKickoff(e)` ([game-CEDHMqQk.js:25531](../../../assets/game-CEDHMqQk.js)); `-1` means "pick internally" (presumably from a non-deterministic source). Left as-is, two independent clients would diverge at the very first kickoff. This must be replaced with an explicit, shared index for any networked match.
- The existing bot integration (`o.decide(n.state, Bt, Di, t.botTeam)`, [game-CEDHMqQk.js:39346](../../../assets/game-CEDHMqQk.js)) is **fire-and-forget**: it's called periodically (every `tickSkip` ticks), and in between calls the game keeps reusing the bot's last-known controls. That pattern is fine for an ML policy but is NOT safe to copy for networked play — reusing "last known" opponent input would let the two clients' simulations diverge. The network opponent-control source must instead only ever advance a tick once the real remote input for that tick has arrived.
- The existing fixed-timestep accumulator (`class Jb`, [game-CEDHMqQk.js:25565](../../../assets/game-CEDHMqQk.js)) already has "catch-up" logic for handling a backlog of due ticks (`gc = 12` max ticks per frame, dropped-tick tracking). This is directly reusable for the network case (waiting for a remote input, then catching up once it arrives), just driven by "input available?" instead of only wall-clock time.
- Existing error handling: when the bot stops responding, the game calls `he.showError(...)` and sets `a.state.paused = !0` ([game-CEDHMqQk.js:39348-39349](../../../assets/game-CEDHMqQk.js)). The multiplayer feature reuses this same mechanism for "opponent disconnected" / "desync detected" instead of building a new error UI.

## Explicitly out of scope for this design

- Public matchmaking / quick-match queues — private room codes only.
- Reconnection after a disconnect — a dropped connection simply ends the match (v1).
- Any server-side anti-cheat — not meaningful for a casual 1v1-with-friends lockstep design; a compromised client could only cheat itself (e.g. fabricate its own inputs, which is no different from a human pressing impossible-fast keys — the physics still enforces real car limits) or observe game state early, neither of which this project needs to defend against.
- More than 2 players / other game modes (this only adds a 1v1 online mode, alongside — not replacing — the existing solo-vs-bot mode).

## Architecture

```
Client A (host)  <--wss://-->  VPS: Nginx (static files + TLS + reverse proxy)  <--wss://-->  Client B (guest)
                                        |
                                        v
                                Node relay server (room codes, message relay only — no physics)
```

Three components:

1. **Node relay server** (new, on the VPS): manages rooms (create/join by code) and relays messages between exactly two sockets in a room. It has zero knowledge of game physics — every in-match message is an opaque payload it just forwards to the other socket in the room.
2. **Nginx** (new config on the VPS): serves the game's static files directly (this repo's contents) and reverse-proxies one path (e.g. `/mp`) to the Node process for the WebSocket upgrade. Terminates TLS via Let's Encrypt/certbot on the user's domain, so the page loads over HTTPS and the WebSocket connects over WSS (required — a WSS connection is the only kind an HTTPS page is allowed to open).
3. **Client changes** (in `assets/game-CEDHMqQk.js`): a new "Play Online" menu screen, and a new network-backed opponent-control source that plugs into the same call site the bot currently uses, but with lockstep-correct waiting semantics instead of the bot's fire-and-forget pattern.

## Room lifecycle

1. Player A: "Play Online" → "Create room". Client opens a WebSocket to the relay server, sends `{type:"create"}`. Server generates a 6-character code (excluding visually ambiguous characters like `0`/`O`, `1`/`I`), creates an in-memory room, replies with the code. Client shows "Code: A3F9K2 — waiting for an opponent" with a Cancel button.
2. Player B: "Play Online" → "Join", enters the code, client sends `{type:"join", code:"A3F9K2"}`.
3. Once both sockets are in a room, the server marks it ready and tells both clients (`{type:"matched", role:"host"|"guest"}`). The creator (A) is "host" purely to break ties (below) — not a gameplay advantage; both clients run identical simulations.
4. The host generates a random 32-bit seed and sends it to the guest (relayed through the server). Both clients now configure their local simulation identically: same arena, same seed, teams assigned by role (host takes one team slot, guest the other, by a fixed convention — exact team/color mapping to be confirmed against the existing single-player team-assignment code during implementation), and start at tick 0.
5. During the match: each client sends its own per-tick controls; the server relays them verbatim to the other client. See "Tick synchronization" below.
6. Match end (goal limit reached, or a disconnect): the server tears down the room.

An empty room (creator waiting, nobody joined) expires after a few minutes to avoid accumulating stale rooms in memory. There is no persistence — a relay server restart drops all active rooms/matches (acceptable given no reconnection support).

## Tick synchronization (the core netcode mechanism)

Physics runs at 120 ticks/second on both clients. Each client only simulates tick N once it has **both** control sets for that tick: its own (always immediately available) and the opponent's (received over the network).

- **Input delay**: each client delays applying its own controls by a small fixed number of ticks (~4-6 ticks, ~35-50ms at 120Hz) before treating them as "due" for simulation. This gives the corresponding network packet time to reach the opponent before they need it. With both players geographically close (assumed ~10-40ms ping), this comfortably avoids visible stutter in normal conditions.
- **Late packet handling**: if the opponent's input for a tick hasn't arrived when needed, the client pauses (holds the last rendered state) until it arrives, then replays the backlog of due ticks in one burst to catch up — reusing the existing catch-up logic in `class Jb` ([game-CEDHMqQk.js:25588-25599](../../../assets/game-CEDHMqQk.js)), adapted to be gated on "opponent input available" rather than purely on wall-clock time.
- **Shared randomness**: the one shared seed exchanged at match start feeds a small deterministic PRNG (implemented identically in JS on both clients) used to pick each kickoff's variant index, avoiding a network round-trip at every goal.
- **Desync safety net**: every ~60 ticks (twice a second), each client computes a lightweight fingerprint of authoritative state (ball + both cars' positions/velocities) and sends it to the other (relayed by the server). If two fingerprints for the same tick don't match, the match ends immediately with a clear "Desync detected" error rather than letting the two clients silently show different game states. This is a safety net, not expected to trigger in normal operation — a mismatch indicates either a physics-determinism bug or dropped-message corruption, both worth surfacing loudly rather than ignoring.

## Client integration

- New "Play Online" screen from the main menu (alongside the existing Garage/Play entries), independent of the existing bot-select screen (bot mode is untouched). Two actions: "Create room" (shows the code + waiting state + Cancel) and "Join" (code entry field + Join button, with clear inline errors: "Invalid code", "This room is full", "Can't reach the server").
- Once matched and the seed is exchanged, the match reuses the **existing** 1v1 game screen, HUD, controls, rendering, and arena setup verbatim. The only change: at the exact call site where the code today calls `bot.decide(...)` to get the opponent's controls, a networked match instead reads from the new network opponent-control source (same shape/role, different data source, same tick-loop shell).
- No new in-match HUD beyond, optionally, a small unobtrusive connection indicator — not required for v1.
- End-of-match / errors reuse the existing `showError(...)` + pause mechanism the bot-disconnect path already uses, with new messages: "Opponent disconnected." / "Desync detected. Match stopped."

## Server & deployment

- **Relay server**: a small Node process (the `ws` package), no database — rooms live in an in-memory `Map<code, Room>`. Sufficient for casual 1v1s between friends; a server restart drops in-progress matches (acceptable, no reconnection support planned).
- **Nginx**: serves this repo's static files directly (more efficient for the large binary assets — 3D models, audio — than proxying them through Node), and reverse-proxies one path (e.g. `/mp`) to the Node process for the WebSocket upgrade. Also terminates TLS via Let's Encrypt (certbot) on the user's domain.
- **Process management**: the Node relay runs as a systemd service (auto-start on boot, auto-restart on crash) — standard for a small always-on VPS service.
- **Deployment mechanics**: the local project is now a git repo; the implementation plan will include the steps to get it onto the VPS (clone/pull) and restart the service after an update. No CI/CD needed for a personal project at this scale.

## Error handling

| Situation | Behavior |
|---|---|
| Can't reach the relay server on connect | Inline error, can retry |
| Invalid / unknown room code on join | "Invalid code" |
| Room already has 2 players | "This room is full" |
| Room expired (nobody joined in time) | "This room expired, create a new one" |
| Opponent disconnects mid-match | Match stops, "Opponent disconnected.", back to menu |
| Desync fingerprint mismatch | Match stops, "Desync detected. Match stopped.", back to menu |
| Local connection drops mid-match | Same as opponent-disconnect handling, from the local client's side |

## Testing plan

- Server-only functional tests (create/join/full-room/expiry) without even loading the game.
- End-to-end test with **two tabs in the Claude Browser tool** against the game served locally + the relay server running locally: create a room in one tab, join from the other, play through a few exchanges, and specifically verify both tabs agree after a goal (i.e. after a randomized kickoff — the key test for the shared-seed mechanism).
- Deliberately break determinism once (e.g. force one client to ignore the shared seed) to confirm the desync safety net actually fires and shows the right error, then remove that deliberate break.
- After deployment: a real test from the user's own two devices (or with a friend) against the public domain over HTTPS/WSS — local/multi-tab testing cannot substitute for this final check (real internet latency, real TLS certificate, real cross-machine WASM execution).

## Open risk to flag

The single biggest risk to this whole design is an undiscovered source of non-determinism inside the client bundle that isn't the already-identified kickoff RNG (e.g., another `Math.random()` call reachable during a match, or a timing-dependent branch in the surrounding JS glue around the WASM calls). The desync safety net exists specifically to catch this class of bug loudly (end the match with a clear error) rather than let it silently produce two different game states — but finding and fixing the root cause of any such bug, if one turns up, is not fully scoped here and may need its own follow-up investigation.
