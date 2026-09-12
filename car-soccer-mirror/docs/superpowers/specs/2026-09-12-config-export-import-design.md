# Export / Import config (key bindings + camera)

## Context

`car-soccer.com` is a client-side Vite/Three.js game with no backend. All user
preferences live in `localStorage`, split across several independent stores
(one per settings category: bindings, camera, graphics, audio, training,
theme, touch, plus a few machine-specific / non-portable ones like the
detected gamepad id, sponsor status, analytics consent).

Goal: let the user save their key bindings (keyboard + gamepad) and camera
settings to a file, and load that file back — so a personal setup can be
carried over to another PC. This is a personal, local-only modification of a
mirrored copy of the site (`./car-soccer-mirror`); nothing here is published
or redistributed.

Multiplayer was raised as a possible future direction but is explicitly out
of scope for this spec — it's a much larger, separate piece of work (netcode,
synchronizing the WASM physics kernel across clients) to be brainstormed on
its own later.

## Relevant existing code (game.beautified.js)

- `Zb = "car-soccer.input-bindings.v1"` — bindings store key.
- `F0 = Jn(Zb, P0, migrate)` at [game.beautified.js:26279](../../../beautified/game.beautified.js) —
  the bindings store. `F0.load()` reads+sanitizes, `F0.save(v)` persists.
  The `migrate` function already validates every binding entry (`cC`),
  clamps axis config (`zf`), and de-duplicates conflicting bindings — this is
  the exact logic we want import to go through.
- `tB = "car-soccer.camera-settings.v1"`, `jm = Jn(tB, () => ({...$s}), migrate)`
  around [game.beautified.js:35261](../../../beautified/game.beautified.js) — camera store,
  same `load`/`save` shape, migrate clamps every numeric field to its
  `min`/`max` (from `sB`/`fd`).
- Settings panel footer (shared across all tabs) at
  [game.beautified.js:35744-35755](../../../beautified/game.beautified.js):
  ```html
  <div class="title-block__actions">
    <button class="act" type="button" data-settings-defaults>Restore defaults</button>
    <button class="act act--primary" type="button" data-settings-close>Done</button>
  </div>
  ```
  This is where the new buttons go. Note `Restore defaults` is scoped to
  `this.activeTab` ([game.beautified.js:36250](../../../beautified/game.beautified.js)) — our feature is
  deliberately different: it always covers bindings + camera together,
  regardless of which tab is open.
- `this.setStatus(...)` — existing mechanism used elsewhere in the panel
  (e.g. "Camera restored to defaults.") for user-facing status messages.
  Reused here for both success and error feedback.

## Scope

In scope: `car-soccer.input-bindings.v1` (keyboard + gamepad bindings) and
`car-soccer.camera-settings.v1` only — matches the user's request ("touches
et caméra"). Touch-screen control layout (`car-soccer.touch-settings.v1`) is
a separate, mobile-only store and is explicitly excluded (ambiguous whether
"touches" meant that; scoped out to keep this simple — can be a follow-up).

Explicitly excluded, permanently: gamepad device id/index (machine-specific,
meaningless on another PC), sponsor/analytics status (not a preference).

## Design

### File format

A single JSON file, `car-soccer-config.json`:

```json
{
  "formatVersion": 1,
  "exportedAt": "2026-09-12T18:30:00.000Z",
  "bindings": { /* verbatim shape of the input-bindings.v1 store */ },
  "camera": { /* verbatim shape of the camera-settings.v1 store */ }
}
```

`formatVersion` is informational only (room to evolve later); import does
not hard-require it, it just checks for the presence of `bindings` and/or
`camera` keys.

### Export flow

Click "Export config" → read `F0.load()` and `jm.load()` (already-sanitized,
current in-memory-equivalent state) → build the JSON above → trigger a
standard browser download via `Blob` + a temporary `<a download>` link. No
user input, no risk, purely local.

### Import flow

1. Click "Import config" → opens a hidden `<input type="file" accept=".json,application/json">`.
2. Read the selected file as text, `JSON.parse` it.
   - Parse failure → status: "Invalid config file." Abort, nothing touched.
3. Check that the parsed object has at least one of `bindings` / `camera`.
   - Neither present → status: "This file doesn't contain any recognizable Car Soccer settings." Abort.
4. Native `confirm()`: "This will replace your current key bindings and camera settings. Continue?"
   - Cancelled → abort, nothing touched.
5. Apply, per present section, **by going through the existing store
   validation** rather than writing app state directly:
   - `localStorage.setItem(Zb, JSON.stringify(parsed.bindings))` then
     `const sanitized = F0.load()` (this re-parses from localStorage and
     runs the existing `migrate` sanitizer) then `F0.save(sanitized)` to
     persist the cleaned version back. Update live UI: assign
     `this.bindings = sanitized`, then call the same refresh path
     `restoreDefaults()` already uses for controls
     (`this.renderParts(); this.syncAxisControls();`).
   - Same pattern for camera via `tB`/`jm`, then
     `Object.assign(this.target, sanitized); this.syncCameraControls(); this.persistCamera();`.
   - This means a malformed or hand-edited file cannot corrupt the game
     state — every field is clamped/type-checked by the same code that
     already protects against corrupted `localStorage`.
6. Status message: "Config imported." — or, if only one section was present
   in the file, "Camera imported (no key bindings found in file)." /
   equivalent for the reverse case.

### Error handling summary

| Situation | Result |
|---|---|
| Unreadable file / invalid JSON | Status error, nothing applied |
| Valid JSON, no recognizable keys | Status error, nothing applied |
| User cancels the confirm dialog | Nothing applied |
| Only one of bindings/camera present | That section is imported, the other is left untouched, status message says so |
| Individual fields invalid inside a present section | Silently clamped/dropped by the existing store sanitizer (same behavior as a corrupted localStorage value today) |

## Testing plan

The mirror has no build step — `index.html` loads `assets/game-CEDHMqQk.js`
directly. Since `js-beautify` only reformats whitespace (no renaming), we
replace `assets/game-CEDHMqQk.js` with its beautified form so it can be
edited directly and stays the file actually served. Then:

1. Serve `./car-soccer-mirror` with a static file server.
2. Open it in the browser tool, open Settings, click "Export config",
   confirm the downloaded JSON has the expected `bindings`/`camera` shape.
3. Change a key binding and a camera value in the UI.
4. Click "Import config", pick the previously exported file, confirm the
   overwrite prompt, verify the UI reverts to the exported values.
5. Reload the page, verify the imported values persisted (i.e. actually
   landed in `localStorage`, not just in-memory).
6. Test error paths: import a non-JSON file, import a JSON file with neither
   key, import a file with only `camera`.

## Out of scope / future ideas

- Touch control layout export/import.
- Bundling all settings categories (graphics/audio/theme/training) — raised
  and deliberately deferred; can reuse the same pattern later if wanted.
- Multiplayer — separate, much larger effort; own future spec.
