# Rollback netcode — verification

Stages 2-4 of [the rollback netcode spec](../specs/2026-09-13-rollback-netcode-design.md),
built per [the rollback engine plan](../plans/2026-09-13-rollback-engine.md).

## Automated: 28 tests, all passing

The load-bearing one:

> **Rollback reproduces a straight-line simulation exactly.** 2000 ticks of the real WASM
> physics, with remote input arriving 3 ticks late and **1996 rollbacks** along the way, end in
> state identical **bit for bit** to simulating the same inputs straight through.

Supporting coverage: `RollbackSession` against a deterministic fake simulation (correct
prediction, misprediction and correction, out-of-order and duplicate arrivals, a lost packet
recovered by redundancy, the prediction-window stall); heap region calibration and restore;
1200-tick physics determinism across two separately instantiated WASM modules; input
quantisation idempotence and packet round-trip.

## Cost, measured honestly

Per-tick cost inside the assembled engine, not in a tight loop:

| Scenario | Rollbacks / 2000 ticks | Cost per tick | Share of the 8.33 ms budget |
|---|---|---|---|
| **Realistic** (input held ~20 ticks, ~6 changes/second) | 100 (5%) | **0.20 ms** | **2.4%** |
| Pathological (input changes every tick) | 1996 (99.8%) | 1.49 ms | 18% |

The pathological row is a synthetic ceiling — a human cannot change input 120 times a second —
and it still leaves 82% of the budget.

Breakdown at the pathological ceiling (2.19 MB region):

| | per call | calls | total |
|---|---|---|---|
| `saveRegion` | 0.355 ms | 3993 | 1417 ms |
| `loadRegion` | 0.425 ms | 1996 | 848 ms |
| `step` | 0.054 ms | 12978 | 760 ms |
| bookkeeping | | | 66 ms |

### Two corrections to earlier estimates

1. **The Stage 1 per-operation figures were optimistic by 3-5x.** They came from tight loops
   repeating one operation on a cache-hot buffer. Interleaved in a real tick, `saveRegion` costs
   0.33 ms rather than 0.107, and `step` 0.054 ms rather than 0.0071. The Stage 1 verdict is
   unchanged, but those numbers should not be quoted.
2. **Snapshot buffers had to be pooled.** A rollback discards the snapshots after its rewind
   point, and the next saves each allocated a fresh ~2 MB buffer — roughly 4.8 GB of garbage over
   the pathological run. Garbage collection, not the memory copy, was the dominant cost:
   2.02 → 1.49 ms/tick once the buffers are recycled.

## Live matches

Two browser tabs against a local relay, one creating a room and the other joining.

### Rollback at ~1 ms RTT (localhost)

```
[online] Match starting {role: host,  rttMs: 1, inputDelayTicks: 8, netcode: rollback}
[online] Match starting {role: guest, rttMs: 1, inputDelayTicks: 8, netcode: rollback}
```

- Roughly two minutes of continuous play with both cars driving.
- **Two goals scored.** Both tabs agreed on the score (0-2) and on the clock (4:47), to the
  second, throughout — so the match state machine rolls back in step with the physics, and the
  goal → kickoff transition survives a rewind.
- **No `[online] Simulation drift` warning** in either tab.
- `sim rate 120/120 Hz`, `stalls none`, `sim 0.08-0.36 ms` per frame.

### Rollback at 92 ms RTT (`RELAY_DELAY_MS=40`)

Roughly triple the real deployed RTT of 31 ms.

```
[online] Match starting {role: host, rttMs: 92, inputDelayTicks: 18, netcode: rollback}
```

- A goal scored; both tabs agreed on score and clock (4:53).
- **No drift warning.** `sim rate 120/120 Hz`, `sim 0.32 ms`, **1 stall** across the whole match.

One stall at 92 ms is the expected shape: the 16-tick prediction window is 133 ms, so it covers
this RTT with margin and only an occasional jitter spike exceeds it.

### Lockstep escape hatch

```
[online] Match starting {role: host, rttMs: 3, inputDelayTicks: 8, netcode: lockstep}
```

`?netcode=lockstep` still plays a full match — a goal was scored, both tabs agreed on score and
clock, no drift. Switching back needs no rebuild and no redeploy.

## What is not verified here

- **Felt latency.** No measurement here establishes how the game *feels*; that is the whole point
  of the change and only a human who knows the game can judge it. The structural claim is
  narrower and solid: the local input now reaches the simulation on the tick it is sampled,
  where it previously waited 8 to 10 ticks (67-83 ms).
- **Audio on a rewind.** Kickoff sounds fire on confirmation rather than on prediction, and the
  code path was exercised (two goals, two kickoffs), but nobody listened to the result. Worth a
  deliberate check in a real match: a kickoff sound that fires two or three times would mean
  presentation effects are leaking onto predicted ticks.
- **Real-network conditions.** `RELAY_DELAY_MS` adds latency but not jitter or packet loss.
  Redundant inputs are covered by a unit test; they have not faced a real lossy link.

## Deployment note

The relay server changed — it now forwards binary frames. **Both the client and
`multiplayer-server/server.js` must be redeployed together.** A new client against an old relay
would have its input packets silently dropped, and the match would stall immediately.
