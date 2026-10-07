# Agent Instructions — Arrangement Editor plugin

This is the `editor` plugin for the feedBack DAW (repo `get-flashbacks/feedBack-plugin-editor`,
plugin id `editor`). It is a DAW-style timeline note editor: import (audio + Guitar Pro +
MIDI + XML + sync sidecars), chart notes on a beat-primary tempo map, mix, save, export.

## Commands

```bash
npm test                              # node --test — globs tests/*.test.{js,mjs}
node --test tests/loop_ab.test.js    # a single JS suite (fast, headless)
npm run lint                          # npx --yes eslint@9.39.4 src tests
python -m pytest                      # backend suites in tests/test_*.py
```

## The two things that trip up newcomers

- **No `node_modules`, ever.** The desktop bundler copies this whole directory
  into the packaged app (stripping only `.git`), so a `devDependency` would ship
  into the app. That is why `npm run lint` shells out to a pinned `npx eslint`
  instead of installing. Do not run `npm install`/`npm ci`.
- **ESLint `no-undef` with `{ typeof: true }` is a correctness gate, not style.**
  It catches identifiers left behind by module moves, including the `typeof x`
  reads that fail silently (`typeof undeclared` is `'undefined'`, no error).
  The config also keeps a hand-written `BROWSER` global list — adding a new
  browser global to `src/` without listing it in `eslint.config.mjs` fails lint.

## Testing conventions

- Suites are `tests/*.test.{js,mjs}` (real-import ESM); `node --test` matches the
  `.test.` segment, so shared fixtures like `tests/_history_env.mjs` and
  `tests/__init__.py` are **not** picked up — do not name a fixture `*.test.*`.
- Seed the real `S` (`Object.assign`, never reassign), stub only the DOM slice you
  need (`tests/_history_env.mjs` is the template). Never stub the subject under test.
- Round-trip every command: `exec` → `rollback` (deep-equal to original) → `redo`.
- Adversarial inputs; a stateful change needs a test that fails without it.
- Older suites slice `@pure:` blocks out of the source text with `new Function` —
  when touching code they cover, keep new exported helpers `typeof`-guarded so
  those environments stay clean, and prefer moving them to real imports.

## Frontend architecture

- `src/main.js` is the real entry; `screen.js` is a thin stub. `src/` is ~50 ES
  modules (`"type": "module"` in `src/package.json`).
- `src/state.js` exports `S`, the single mutable state object. Never reassign `S`
  — only its properties (`Object.assign` in tests).
- **Every mutation goes through `S.history`** (`src/history.js`) as a command with
  `exec`/`rollback`. `editGen` is bumped once per committed edit; memos over note
  data key on it.
- `src/host.js` breaks import cycles — extracted modules reach the few `main.js`
  callbacks they need through one hook table. Anything `main.js` *reassigns*
  (`draw`, etc.) must be wired as a thunk — check
  `grep -nE '^[[:space:]]*<name> = ' src/main.js` before adding a hook.
- `src/beats.js` is the **single time converter** (`beatOf`/`timeOf`). Beat coords
  are truth; seconds are derived. `TempoMapCmd` recomputes seconds from beats,
  `TempoGridCmd` re-lifts beats from seconds.
- **Placement purity**: `src/region.js`'s `_trackPlacementPure` is the one
  composed-placement expression (global `audioShift` + source offset + track
  `offsetSec`). Every placement site must resolve through it; a hand-rolled
  two-term sum is a missed site (pinned by `tests/track_offset.test.mjs`).
- Modules **must degrade under node** (no DOM, no host): inert defaults, no
  import-time side effects — that is how the test suites work.
- **Global listeners/timers must register via `host.addGlobalListener`** so the
  teardown registry (`window.__editorScreenTeardown`) cleans them up across host
  re-injection. Unregistered listeners leak.
- **Kind inference drives a part's view**: keys > drums > bass > guitar, with the
  `KEYS_PATTERN` (`/^(keys|piano|keyboard|synth)/i`) start-anchored ("Electric
  Piano" is NOT a keys name).
- Transient per-note UI marks live in module `WeakSet`s, not note fields (an
  underscore field leaks into the save body).

## Backend (`routes.py`)

FastAPI; `_sessions` dict keyed by session id, each owning an unpacked working
dir. `/build` is the only path that mutates the user's DLC dir — saves go to the
session working dir. `tests/conftest.py` puts the plugin dir on `sys.path`; the
`pytest` suite needs `fastapi`/`pyyaml` installed in the runtime image.
`_NOTE_TECH_FIELDS` in `routes.py` is the single source of truth for
authorable note techniques — new ones go there, not ad-hoc lists. When editor and
host disagree on a field, the feedpak spec wins. `routes.py` changes need a
server restart; frontend edits show on refresh.

## Workflow

- Conventional commits: `<type>(<scope>): <subject>` — `<type>` ∈
  `feat|fix|docs|test|chore`, `<scope>` examples: `structure`, `editor`,
  `security`. Merge commits land as `Merge pull request #N from <branch>`.
- Branch naming: `feat/<issue-desc>` or `kilo/<desc>`. **One PR per issue**;
  reference the issue number in the commit, e.g. `(#41)`.
- `CHANGELOG.md` follows Keep a Changelog (categories: Security, Added,
  Changed, Fixed) under `[Unreleased]`. Add an entry with every user-facing or
  API-affecting change.
- The spec workflow lives in `.specify/` (speckit skills + templates +
  constitution at `.specify/memory/constitution.md`).

## Repo layout (high signal)

- `src/state.js` — `S`; `src/audio.js` — playback + placement; `src/region.js`
  — region/track model; `src/region-commands.js` — edit commands;
  `src/beats.js` — tempo/time; `src/lanes.js` + `src/geometry.js` — layout;
  `src/input.js` — keyboard; `src/mouse.js` — pointer; `src/shortcuts.js` —
  keybind profiles; `src/create.js` / `src/file-ops.js` — load/save; `src/main.js`
  — orchestration.
- `routes.py` (large) — FastAPI. `goplayalong.py` — GoPlayAlong sidecar parser.
- `plugin.json` — manifest (`scriptType: "module"`, `styles: "assets/v3-theme.css"`,
  `settings.server_files: ["editor_cache/"]`); `screen.html`/`screen.js` — shell.
- This repo and routes.py are huge — don't read whole files; `grep` / read with
  offsets. `node --test` runs fast; `pytest` is slower.
