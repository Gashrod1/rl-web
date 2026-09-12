# Config Export/Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add "Export config" / "Import config" buttons to the settings menu that save/restore key bindings + camera settings as a single JSON file.

**Architecture:** Two new buttons in the settings panel footer (shared across all tabs) call new `exportConfig()` / `importConfigFile()` methods on the existing `SettingsPanel` class (`class AB` in `assets/game-CEDHMqQk.js`). Export reads the two existing localStorage-backed stores (`F0` for bindings, `jm` for camera) and downloads them as one `.json` file. Import writes the uploaded JSON back into `localStorage` under the real store keys, then calls each store's own `.load()` — which re-runs the game's existing validation/sanitization — before applying the result to live UI state (`this.bindings`, `this.target`).

**Tech Stack:** Vanilla JS (ES modules), no framework, no bundler/build step in this mirror, no test runner. This project has no git repository — steps below use plain file edits, not commits. Verification is done by driving the actual page in the Claude Browser tool (no unit test framework exists for this reverse-engineered bundle).

**Design doc:** `docs/superpowers/specs/2026-09-12-config-export-import-design.md`

---

## Completion notes (2026-09-12)

All 5 tasks are done and verified (each independently re-verified by a fresh reviewer, not just the implementer's own claim). The feature works as designed: "Export config"/"Import config" in the settings footer, round-trips key bindings + camera settings through a real download/upload, persists across reload, and every error path (invalid JSON, unrecognized file, partial file, cancelled confirmation) behaves correctly.

Three things came up during execution that this plan didn't anticipate:

1. **The mirror was missing more than just the main bundle.** Beyond what Task 1 expected, the local mirror was also missing `game-sw.js`, `assets/ball/{ball.bin,albedo.png,normal.png,material-mask.png}`, `assets/golden-boost/{plume,turbulence,sparks}.png`, `assets/ort-wasm-simd-threaded-CxTQ5xH-.wasm`, and both bot AI models (`assets/bot/{seer,element}/policy.onnx`). All were re-downloaded from the live site the same way the original mirror was built. Without these, the game never got past its loading screen, so none of Tasks 1-5's browser-driven verification would have been possible at all.

2. **The game's boot sequence is gated on a service-worker integrity check that can't be satisfied locally.** `game-sw.js` verifies every asset (via SHA-256 hashes baked into a manifest) against `.pack` archives that aren't part of this mirror — and the main bundle's hash can never match once it's beautified anyway. The `KB(i)` function in `assets/game-CEDHMqQk.js` (~line 38783) was reduced to a documented no-op to bypass this for local testing; its now-orphaned helpers (`JB`, `gd`, `Tm`) were removed. This is a permanent characteristic of this local mirror now, not something to "fix" later — real offline/PWA support was never a goal here.

3. **`beautified/game.beautified.js` is a one-time snapshot, not a maintained mirror.** It was only used to promote `assets/game-CEDHMqQk.js` into an editable state in Task 1. Tasks 2-5 (correctly, per their own file lists) only ever edited `assets/game-CEDHMqQk.js` directly — `beautified/game.beautified.js` has been stale since Task 1 and that's expected, not a bug.

`assets/game-CEDHMqQk.js` is the current, authoritative, working copy of the game.

---

## Important note on line numbers

All line numbers below refer to `beautified/game.beautified.js` **as it exists right now** (39433 lines) — used here only as a map to locate the exact text. Task 1 makes `assets/game-CEDHMqQk.js` byte-for-byte identical to that file, so immediately after Task 1 the line numbers match in both files too. All edits in Tasks 2-4 are applied to `assets/game-CEDHMqQk.js` (the file `index.html` actually serves).

Every edit below is specified as an exact `old_string` → `new_string` pair, safe to apply with the `Edit` tool (or equivalent exact-match replace).

---

### Task 1: Promote the beautified bundle to be the served file, verify baseline

**Files:**
- Modify: `assets/game-CEDHMqQk.js` (replaced wholesale)
- No other files touched in this task

- [ ] **Step 1: Replace the served bundle with the beautified (whitespace-only) version**

```bash
cd "C:/Users/Gash/Documents/projet/car-soccer-mirror"
cp beautified/game.beautified.js assets/game-CEDHMqQk.js
```

- [ ] **Step 2: Confirm the file is valid JS and roughly the expected size**

```bash
node --check assets/game-CEDHMqQk.js && wc -l assets/game-CEDHMqQk.js
```

Expected: no output from `node --check` (means syntax is valid), and `wc -l` reports approximately `39433` (matches `beautified/game.beautified.js`).

- [ ] **Step 3: Serve the mirror locally**

Use the `mcp__Claude_Browser__preview_start` tool with a `.claude/launch.json` configuration. Create `.claude/launch.json` if it doesn't exist:

```json
{
  "version": "0.0.1",
  "configurations": [
    {
      "name": "car-soccer-mirror",
      "runtimeExecutable": "npx",
      "runtimeArgs": ["--yes", "serve", "-l", "5175", "."],
      "port": 5175
    }
  ]
}
```

Then call `preview_start` with `name: "car-soccer-mirror"`.

- [ ] **Step 4: Verify the game still loads and behaves exactly as before the swap**

In the Browser pane: navigate to the preview URL, wait ~2s, open the settings menu (click the settings/gear button), and confirm the "Camera", "Controls", "Graphics", "Audio", "Diagnostics", "Training" tabs and the existing "Restore defaults" / "Done" footer buttons are all present and clickable, exactly as before.

Expected: no console errors (check with `read_console_messages`, `onlyErrors: true` — expect an empty list), settings menu opens and closes normally.

---

### Task 2: Add the Export/Import buttons and hidden file input to the settings footer

**Files:**
- Modify: `assets/game-CEDHMqQk.js`

- [ ] **Step 1: Insert the two buttons and the hidden file input into the footer markup**

Find this exact block (the settings panel footer, inside the big template literal in `class AB`'s constructor):

```html
          <footer class="title-block">
            <div class="title-block__info">
              <a class="title-block__credit" href="https://x.com/xthomasms" target="_blank" rel="noopener noreferrer"
                 aria-label="Follow @xthomasms on X (opens in a new tab)">Made by @xthomasms <span aria-hidden="true">↗</span></a>
              <p class="title-block__status" data-el="status" role="status" aria-live="polite"></p>
            </div>
            <p class="pad-legend" data-el="padLegend" aria-hidden="true" hidden></p>
            <div class="title-block__actions">
              <button class="act" type="button" data-settings-defaults>Restore defaults</button>
              <button class="act act--primary" type="button" data-settings-close>Done</button>
            </div>
          </footer>
```

Replace it with:

```html
          <footer class="title-block">
            <div class="title-block__info">
              <a class="title-block__credit" href="https://x.com/xthomasms" target="_blank" rel="noopener noreferrer"
                 aria-label="Follow @xthomasms on X (opens in a new tab)">Made by @xthomasms <span aria-hidden="true">↗</span></a>
              <p class="title-block__status" data-el="status" role="status" aria-live="polite"></p>
            </div>
            <p class="pad-legend" data-el="padLegend" aria-hidden="true" hidden></p>
            <div class="title-block__actions">
              <button class="act" type="button" data-config-export>Export config</button>
              <button class="act" type="button" data-config-import>Import config</button>
              <input type="file" id="config-import-input" accept=".json,application/json" hidden>
              <button class="act" type="button" data-settings-defaults>Restore defaults</button>
              <button class="act act--primary" type="button" data-settings-close>Done</button>
            </div>
          </footer>
```

- [ ] **Step 2: Verify the file is still syntactically valid**

```bash
node --check "C:/Users/Gash/Documents/projet/car-soccer-mirror/assets/game-CEDHMqQk.js"
```

Expected: no output (valid).

- [ ] **Step 3: Verify the buttons render**

In the Browser pane, reload the preview, open Settings, and use `read_page` or `find` with query `"Export config"` and `"Import config"`. Expected: both buttons are found in the accessibility tree, inside the settings footer, next to "Restore defaults". Clicking them does nothing yet (no listeners wired) — that's expected at this point.

---

### Task 3: Implement and wire `exportConfig()`

**Files:**
- Modify: `assets/game-CEDHMqQk.js`

- [ ] **Step 1: Wire the click listener**

Find this exact text (the `data-settings-defaults` listener, immediately followed by the camera-setting listeners):

```js
this.overlay.querySelector("[data-settings-defaults]").addEventListener("click", () => this.restoreDefaults()), this.overlay.querySelectorAll("[data-camera-setting]").forEach(c => {
```

Replace it with:

```js
this.overlay.querySelector("[data-settings-defaults]").addEventListener("click", () => this.restoreDefaults()), this.overlay.querySelector("[data-config-export]").addEventListener("click", () => this.exportConfig()), this.overlay.querySelector("[data-config-import]").addEventListener("click", () => this.overlay.querySelector("#config-import-input").click()), this.overlay.querySelector("#config-import-input").addEventListener("change", c => this.importConfigFile(c.target.files[0])), this.overlay.querySelectorAll("[data-camera-setting]").forEach(c => {
```

- [ ] **Step 2: Add the `exportConfig()` method**

Find this exact text (the last two methods of `class AB`, right before the class closes):

```js
    persistCamera() {
        jm.save(this.target)
    }
    persistTraining() {
        _m.save(this.trainingTarget)
    }
}
```

Replace it with:

```js
    persistCamera() {
        jm.save(this.target)
    }
    persistTraining() {
        _m.save(this.trainingTarget)
    }
    exportConfig() {
        const payload = {
            formatVersion: 1,
            exportedAt: new Date().toISOString(),
            bindings: F0.load(),
            camera: jm.load()
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], {
            type: "application/json"
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "car-soccer-config.json";
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        this.setStatus("Config exported.")
    }
    async importConfigFile(e) {
        const input = this.overlay.querySelector("#config-import-input");
        if (!e) return;
        let parsed;
        try {
            const text = await e.text();
            parsed = JSON.parse(text)
        } catch {
            if (input) input.value = "";
            this.setStatus("Invalid config file.");
            return
        }
        if (input) input.value = "";
        const hasBindings = !!(parsed && typeof parsed == "object" && parsed.bindings && typeof parsed.bindings == "object");
        const hasCamera = !!(parsed && typeof parsed == "object" && parsed.camera && typeof parsed.camera == "object");
        if (!hasBindings && !hasCamera) {
            this.setStatus("This file doesn't contain any recognizable Car Soccer settings.");
            return
        }
        if (!window.confirm("This will replace your current key bindings and camera settings. Continue?")) return;
        if (hasBindings) {
            localStorage.setItem(Zb, JSON.stringify(parsed.bindings));
            const sanitized = F0.load();
            F0.save(sanitized);
            Object.assign(this.bindings, sanitized);
            this.renderParts();
            this.syncAxisControls();
            this.onBindingsChange(this.bindings)
        }
        if (hasCamera) {
            localStorage.setItem(tB, JSON.stringify(parsed.camera));
            const sanitized = jm.load();
            jm.save(sanitized);
            Object.assign(this.target, sanitized);
            this.syncCameraControls()
        }
        const message = hasBindings && hasCamera ? "Config imported." : hasBindings ? "Key bindings imported (no camera settings found in file)." : "Camera settings imported (no key bindings found in file).";
        this.setStatus(message)
    }
}
```

- [ ] **Step 3: Verify the file is still syntactically valid**

```bash
node --check "C:/Users/Gash/Documents/projet/car-soccer-mirror/assets/game-CEDHMqQk.js"
```

Expected: no output (valid).

- [ ] **Step 4: Verify export produces the right JSON shape**

In the Browser pane, reload the preview. Use `javascript_tool` to install a capture hook **before** clicking Export:

```js
window.__exportCapture = null;
const __origCreateObjectURL = URL.createObjectURL.bind(URL);
URL.createObjectURL = function(blob) {
  blob.text().then(t => { window.__exportCapture = t; });
  return __origCreateObjectURL(blob);
};
"hook installed"
```

Open Settings, click "Export config", then wait ~1s and read the capture:

```js
window.__exportCapture ? JSON.parse(window.__exportCapture) : null
```

Expected: an object with `formatVersion: 1`, an `exportedAt` ISO string, and `bindings` / `camera` objects whose shapes match `localStorage.getItem("car-soccer.input-bindings.v1")` / `localStorage.getItem("car-soccer.camera-settings.v1")` parsed directly. Also confirm the settings footer status text now reads "Config exported." (`read_page` on the `[data-el="status"]` element, or `get_page_text`).

---

### Task 4: Verify `importConfigFile()` applies and persists settings

**Files:**
- No file changes in this task (verification only — the method was already written in Task 3 Step 2)

- [ ] **Step 1: Change a camera value and a key binding manually, note the values**

In the Browser pane: open Settings → Camera tab, change the "Field of View" slider to a distinctive value (e.g. drag it to a value different from default, note the exact number shown). Then go to Controls tab and rebind "Jump" to a different key (e.g. `KeyJ`).

- [ ] **Step 2: Export the current (modified) config**

Click "Export config" using the same capture-hook technique as Task 3 Step 4. Save the captured JSON text to a variable for reuse:

```js
window.__savedConfig = window.__exportCapture;
JSON.parse(window.__savedConfig).camera.fov
```

Expected: the FOV value shown matches what was set in Step 1.

- [ ] **Step 3: Restore defaults for both tabs (to prove import actually changes things back)**

Open Settings → Camera tab → click "Restore defaults" (resets camera only, since it's tab-scoped). Switch to Controls tab → click "Restore defaults" (resets bindings). Confirm via `read_page` that Field of View is back to its default and Jump is back to its default key.

- [ ] **Step 4: Simulate picking the previously-exported file and confirm re-application**

Native file pickers can't be automated directly, so simulate the file selection via `DataTransfer` (a standard, well-supported technique for testing file inputs) and stub `window.confirm` for the duration of the test:

```js
window.confirm = () => true;
const dt = new DataTransfer();
dt.items.add(new File([window.__savedConfig], "car-soccer-config.json", { type: "application/json" }));
const input = document.querySelector("#config-import-input");
input.files = dt.files;
input.dispatchEvent(new Event("change", { bubbles: true }));
"dispatched"
```

Wait ~500ms, then verify:

```js
[
  JSON.parse(localStorage.getItem("car-soccer.camera-settings.v1")).fov,
  JSON.parse(localStorage.getItem("car-soccer.input-bindings.v1")).keyboard.jump
]
```

Expected: the FOV value matches Step 1's distinctive value, and the `jump` binding array includes the `KeyJ` binding set in Step 1. Also confirm (via `read_page` on the Camera tab's FOV slider/output and the Controls tab's Jump row) that the **visible UI** reflects the restored values immediately, without a page reload — and that the status line reads "Config imported."

- [ ] **Step 5: Verify persistence across a real reload**

Reload the page (`navigate` to the same URL). Open Settings → Camera tab and Controls tab again. Expected: FOV and Jump binding still show the imported (Step 1) values — proving they were actually written to `localStorage`, not just held in memory.

- [ ] **Step 6: Clean up the test hooks**

```js
delete window.__exportCapture;
delete window.__savedConfig;
```

(No need to restore `URL.createObjectURL` or `window.confirm` — they reset on the next page reload, which already happened in Step 5.)

---

### Task 5: Verify the error paths

**Files:**
- No file changes in this task (verification only)

- [ ] **Step 1: Invalid JSON**

```js
window.confirm = () => true;
const dt = new DataTransfer();
dt.items.add(new File(["not valid json {{{"], "bad.json", { type: "application/json" }));
const input = document.querySelector("#config-import-input");
input.files = dt.files;
input.dispatchEvent(new Event("change", { bubbles: true }));
"dispatched"
```

Wait ~300ms, then check the status text via `get_page_text` or `read_page`. Expected: "Invalid config file." No changes to any current bindings/camera values.

- [ ] **Step 2: Valid JSON, no recognizable keys**

```js
const dt = new DataTransfer();
dt.items.add(new File([JSON.stringify({ hello: "world" })], "unrelated.json", { type: "application/json" }));
const input = document.querySelector("#config-import-input");
input.files = dt.files;
input.dispatchEvent(new Event("change", { bubbles: true }));
"dispatched"
```

Wait ~300ms, check status text. Expected: "This file doesn't contain any recognizable Car Soccer settings."

- [ ] **Step 3: Partial file (camera only)**

```js
const dt = new DataTransfer();
dt.items.add(new File([JSON.stringify({ camera: { fov: 95 } })], "camera-only.json", { type: "application/json" }));
const input = document.querySelector("#config-import-input");
input.files = dt.files;
input.dispatchEvent(new Event("change", { bubbles: true }));
"dispatched"
```

Wait ~300ms, check status text and camera FOV. Expected: status reads "Camera settings imported (no key bindings found in file)." and `JSON.parse(localStorage.getItem("car-soccer.camera-settings.v1")).fov === 95`. The key bindings must be unchanged from before this step.

- [ ] **Step 4: Cancel the confirm dialog**

```js
window.confirm = () => false;
const dt = new DataTransfer();
dt.items.add(new File([JSON.stringify({ camera: { fov: 61 } })], "should-not-apply.json", { type: "application/json" }));
const input = document.querySelector("#config-import-input");
input.files = dt.files;
input.dispatchEvent(new Event("change", { bubbles: true }));
"dispatched"
```

Wait ~300ms, check camera FOV again. Expected: still `95` (from Step 3), unchanged — the cancelled confirm must abort before anything is written.

---

## Self-review notes

- Every task references exact file paths and exact `old_string`/`new_string` pairs — no "similar to Task N" shortcuts.
- No unit test framework exists in this static mirror, so verification throughout is browser-driven (DOM assertions, `localStorage` reads, monkey-patched `URL.createObjectURL`/`window.confirm` for testability) rather than `pytest`/`jest`-style tests. This matches how the rest of the reverse-engineered codebase is validated (there is no other option).
- Spec coverage check against `2026-09-12-config-export-import-design.md`: file format ✓ (Task 3), export flow ✓ (Task 3), import flow incl. confirm + partial-import + status messages ✓ (Task 4), error handling table ✓ (Task 5), testing plan (promote beautified file, serve locally, round-trip, reload persistence) ✓ (Tasks 1 and 4).
- Out of scope per the design doc, not attempted here: touch-layout export, bundling graphics/audio/theme/training, multiplayer.
