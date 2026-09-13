# WASM heap snapshot cost — measurement gate

Stage 1 of [the rollback netcode spec](../specs/2026-09-13-rollback-netcode-design.md).
This is the blocking measurement that decides whether rollback netcode is viable at all.

Measured on the developer machine (Windows 11, Node v22.23.1) with
`node tests/snapshot-cost.js` and `node tests/dirty-pages-soak.js`.

## Verdict: **PASS**

Snapshot + an 8-tick resimulation costs **0.163 ms**, which is **2.0%** of the 8.33 ms tick
budget at 120 Hz. The pass criterion was 1 ms. Rollback proceeds.

## Numbers

| Measurement | Value |
|---|---|
| WASM heap size | 16.1 MB (258 pages) |
| Pages that actually mutate | **17** (1088 KB) |
| Page span | 0..26 — **not contiguous** (17 of 27 pages in the span) |
| Full-heap snapshot | 1.057 ms |
| Mutable-range snapshot (span 0..26, 1.77 MB) | **0.107 ms** |
| Single `step()` | **0.0071 ms** |
| Snapshot + 8-tick resimulation | 0.163 ms (2.0% of budget) |

The headline surprise is how cheap `step()` is: **0.0071 ms**. Resimulating the entire 16-tick
prediction window costs 0.11 ms — less than a single full-heap snapshot. That inverts the
expected cost balance and changes the snapshot strategy (see below).

> **Correction, measured later against the assembled engine.** The figures in this table come
> from tight loops repeating one operation on a cache-hot buffer, and they are optimistic by
> roughly 3-5x compared with the same operations interleaved in a real tick. Measured inside
> `RollbackSession`: `saveRegion` 0.33 ms (not 0.107), `loadRegion` 0.43 ms, `step` 0.054 ms
> (not 0.0071). The **verdict is unchanged** — realistic play costs 0.20 ms/tick, 2.4% of budget
> — but the per-operation numbers above should not be quoted. See
> [the rollback verification report](2026-09-13-rollback-verification.md) for honest figures.

## The mutable page set is stable

The risk flagged in the spec was that a page-level dirty scan might miss a rarely-touched page,
which the rollback engine would then fail to restore. `tests/dirty-pages-soak.js` tests this
directly: 60 rounds x 600 ticks = **36000 ticks (5 minutes of game time)**, with randomised
throttle/steer/pitch/yaw/roll/jump/boost/handbrake, all 8 kickoff variants, goals polled every
tick, and boost pad pickups.

```
dirty page count after each round: 17,17,17,...,17   (60 rounds, never grew)
final dirty pages: 0,1,2,3,4,5,6,7,10,14,16,18,22,23,24,25,26
first round reached final count: 1
```

The set reached its final value in the **first** round and never grew again. Pages 27..257
(94% of the heap) are never written after initialisation — consistent with the expected
Emscripten layout of static data plus a frozen collision BVH.

## Consequences for the rollback plan

**1. Snapshot the contiguous span 0..26, not the 17-page list.**
1.77 MB versus 1.09 MB, for one `set()` on a subarray instead of 17 separate copies. The
measured 0.107 ms already reflects the span. Simplicity wins at this cost.

**2. Snapshot every 4 ticks, not every tick.** This is a change from the plan's assumption of a
per-tick ring, driven by the memory figure: a 16-slot per-tick ring would be **27 MB**, over the
8 MB budget. Since `step()` costs 0.0071 ms, the trade is lopsided in our favour:

| Strategy | Memory | Worst-case rollback |
|---|---|---|
| Every tick, 16 slots | 27.0 MB | 0.107 + 16 x 0.0071 = 0.221 ms |
| **Every 4 ticks, 5 slots** | **8.9 MB** | 0.107 + 19 x 0.0071 = **0.242 ms** |

Three times less memory for 0.02 ms more. Take the cadence.

**3. The dirty-page scan is a correctness requirement, not an optimisation.** It must run at
startup and derive the span from the live module rather than hardcoding pages 0..26 — those page
numbers are a property of this build of the WASM module, not a guarantee. Budget: the scan costs
one full-heap snapshot plus a compare, a few milliseconds, once.

**4. Keep a runtime guard.** Because correctness now depends on "pages outside the span never
change", the engine should verify that assumption periodically in development builds: snapshot
the out-of-span region once at match start, re-compare every few hundred ticks, and fail loudly
on a mismatch. The existing desync detector would eventually catch such a bug, but only after the
match had already gone wrong.

The full-heap fallback remains available if any of this proves fragile: 1.113 ms per snapshot,
13% of the tick budget, which is survivable but leaves little headroom for rendering.

## Post-extraction verification

The physics extraction (Stage 0) was verified not to change behaviour:

- `npm test` — 4 tests pass, including 1200-tick determinism across two separately instantiated
  WASM modules, and restore-plus-resimulate matching a straight-line run bit for bit over 60 ticks.
- Browser: the game loads with no `ReferenceError`, `assets/physics-core.js` is fetched (so the
  new bundle is live, not a service-worker cache), the simulation runs at 120/120 Hz with no
  dropped ticks or stalls, and the car responds to input. The only console errors are a 404 on
  `/api/sponsors` (pre-existing — this mirror has no backend) and a `Node.contains` TypeError
  caused by the synthetic keyboard event used for the test, not by the game.
### Online 1v1 verification

Tested locally rather than against the VPS, since the deployed instance runs the pre-extraction
build and would prove nothing about this change. The client gained a `?relay=<url>` query
parameter so it can be pointed at a local relay server; absent the parameter it behaves exactly
as before.

Setup: `node multiplayer-server/server.js` on port 8080, two browser tabs on
`http://localhost:5175/?relay=ws://localhost:8080`, one creating a room and the other joining
with the code.

Result:

```
tab 1: [online] Match starting {role: host,  rttMs: 1, inputDelayTicks: 8}
tab 2: [online] Match starting {role: guest, rttMs: 1, inputDelayTicks: 8}
```

Both cars driven simultaneously for roughly 20 seconds (~2400 ticks, so ~40 drift comparisons at
one per 60 ticks). **No `[online] Simulation drift` warning in either tab**, and the simulation
held 120/120 Hz throughout. Two independently instantiated WASM modules stayed in lockstep, which
is the property the extraction could plausibly have broken.

Incidentally: on localhost the RTT is 1 ms, so `inputDelay` lands on `MIN_INPUT_DELAY = 8` —
the floor, 67 ms. Even a zero-latency connection cannot currently go below that.
