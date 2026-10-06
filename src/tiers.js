// Issue #3 — the per-phrase difficulty-ladder PLANNER (`phrases[].tiers[]`).
//
// The host's master-difficulty slider reads `phrases[].levels[idx].notes` —
// every phrase LEVEL carries real note content, so sliding mastery down must
// show a SIMPLER chart, not the same notes repeated. The editor models those
// levels as a phrase's `tiers` array (its per-difficulty working copy):
// `{difficulty, notes, chords, anchors, handshapes}` in the editor note/shape
// system. On save, routes.py `_repopulate_phrase_levels` keeps the authored
// LOWER tiers verbatim and rebuilds the TOP tier (the max difficulty) from the
// flat chart's window slice, then strips `tiers` from the wire — the top tier
// IS the editable flat chart, and `levels[]` is the only per-tier data on disk.
//
// So "add a tier" means minting a rung BELOW the lowest authored one: the new
// tier's source content is the easiest existing tier's notes/chords (or the
// flat chart while the ladder is still empty — and also when the ladder holds
// a SINGLE tier, which is the top tier and therefore tracks the editable flat
// chart rather than its loaded copy), simplified by dropping chain
// members (hammer-on/pull-off), stripping lead techniques (bend/slide/tap) and
// bend curves, and cutting micro-sustains. This module PLANS that — pure, no
// `S`, no DOM, no imports — so the UI (and the tests) get a refusal-or-ladder
// answer without ever aliasing live editor state. Refusal meanings:
//
//   floor — a difficulty-0 tier already exists: the ladder bottoms out, there
//           is nothing easier to append (checked FIRST, ladder shape, before
//           any content guard).
//   empty — the source holds no notes and no chords at all.
//   wiped — simplification would remove every note and chord: a "simpler"
//           empty tier would blank the phrase's low-mastery slot.
//   noop  — the simplified content is identical to the source content: a new
//           difficulty would repeat the same chart. (Content is compared
//           deep-equal ignoring key order, with techniques objects synthesized
//           on the raw source first — so a chain member dropping out IS a
//           change, but an already-simplified phrase is a refusal, not a
//           duplicate tier.)
//
// Handshape tier shape mirrors the editor norm (src/chords.js
// `_normalizeHandshape` ↔ routes.py `_valid_handshape_dicts`):
// `{chord_id, start_time, end_time, arp}`, `chord_id` a non-negative int
// (anything less valid drops — a handshape is a reference INTO
// `<chordTemplates>`, so `-1` would be malformed), `arp` accepting the load
// alias `arpeggio` and wire-type-coerced.

// ── Contract constants ──────────────────────────────────────────────────────

// Chain members are MERELY the continuation of an earlier plain note; a low
// tier answers "what fret(s) do I press and when" which the anchor note
// already gives, so the continuation drops out entirely.
export const CHAIN_TECHNIQUES = Object.freeze(['hammer_on', 'pull_off']);

// Lead-only articulations that never survive a simplification. Their
// replacement values are the load-side defaults (routes.py `_note_tech_default`):
// bend → null (else a spurious bend), bend_intent → 0, slide targets → -1
// ("none" int sentinel), tap → false (bool fields coerce False when absent).
export const STRIP_TECHNIQUES = Object.freeze(['bend', 'bend_intent', 'slide_to', 'slide_unpitch_to', 'tap']);

const STRIP_DEFAULTS = Object.freeze({
    bend: null,
    bend_intent: 0,
    slide_to: -1,
    slide_unpitch_to: -1,
    tap: false,
});

// Degenerate-gap epsilon, the same one src/beats.js guards its tempo math
// with: a "span" of at most this many seconds is a float-noise duplicate beat,
// not a tempo anyone can play against.
const GAP_EPS = 1e-9;

// ── Small pure coercion helpers (mirrors of the backend's _safe_* family) ───

function _has(o, k) {
    return Object.prototype.hasOwnProperty.call(o, k);
}

// Number-or-numeric-string → finite number, else the default (chords.js
// `_wireFloat`): a hand-edited pack may spell "1.5" instead of 1.5, but an
// absent/null/non-numeric value means "use the default", not NaN.
function _wireFloat(v, dflt) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : dflt;
    if (typeof v === 'string' && v.trim() !== '') {
        const n = Number(v);
        if (Number.isFinite(n)) return n;
    }
    return dflt;
}

// Wire-style boolean coercion (chords.js `_safeWireBool` ↔ routes.py
// `_safe_bool`): native bool, 0/1, and the string spellings — never `!!`,
// else the string "false" would flip things on.
function _wireBool(v, dflt) {
    if (typeof v === 'boolean') return v;
    if (v === null || v === undefined) return dflt;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') {
        const s = v.trim().toLowerCase();
        if (s === 'true' || s === '1' || s === 'yes') return true;
        if (s === 'false' || s === '0' || s === 'no' || s === '') return false;
    }
    return dflt;
}

// A phrase/start_time coordinate: missing or unparseable treated as 0 — the
// same fallback routes.py reads `_safe_float(start_time, 0.0)` with, because a
// phrase with no start anchors at the song head rather than at nowhere.
function _startOrZero(v) {
    if (v === null || v === undefined) return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

// A phrase's declared wire `max_difficulty` — int, or null when the field is
// absent/garbage (fresh editor-created phrases carry none). The wire reader is
// strict on purpose: a numeric string is junk on this field, not a value.
function _declaredMaxDifficulty(p) {
    if (!p) return null;
    const d = p.max_difficulty;
    return Number.isInteger(d) && d >= 0 ? d : null;
}

// ── Phrase windows ──────────────────────────────────────────────────────────

// The phrase's content window in seconds: `[start of phrase i, start of
// phrase i+1)`, with the FIRST phrase extending back to -inf and the LAST
// forward to +inf (routes.py `_repopulate_phrase_levels` derives the same
// windows from `start_time`, never trusting a stored `end_time` that can drift
// after a tempo remap).
export function windowForPhrase(phrases, idx) {
    const list = Array.isArray(phrases) ? phrases : [];
    const p = list[idx];
    const q = list[idx + 1];
    return {
        t0: idx === 0 ? -Infinity : _startOrZero(p && p.start_time),
        t1: idx === list.length - 1 ? Infinity : _startOrZero(q && q.start_time),
    };
}

// Which phrase's window covers `time`? -1 only when the list is empty — with
// any phrase present the first/last infinite tails make every time match
// somewhere. Boundary equality belongs to the NEXT phrase (windows are
// half-open `[t0, t1)`), exactly as the backend slices notes on save.
export function findPhraseIndexAt(phrases, time) {
    const list = Array.isArray(phrases) ? phrases : [];
    for (let i = 0; i < list.length; i++) {
        const { t0, t1 } = windowForPhrase(list, i);
        if (time >= t0 && time < t1) return i;
    }
    return -1;
}

// Window-slice a timed list to `[t0, t1)`. Handshapes ride a different time
// key (`start_time`) than notes/chords/anchors (`time`), hence the parameter.
// Item REFERENCES are kept (no cloning) so a sliced window stays indexable
// against its source list; members that are not objects cannot carry a usable
// time key and drop.
export function sliceByWindow(items, t0, t1, timeKey = 'time') {
    const out = [];
    const list = Array.isArray(items) ? items : [];
    for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const v = Number(item[timeKey]);
        if (t0 <= v && v < t1) out.push(item);
    }
    return out;
}

// ── The beat grid → seconds bridge ──────────────────────────────────────────

// The local beat duration in seconds around `t`: the LAST beat at or before
// `t` spans until the next beat, and that gap's width IS the local tempo.
// Before the first beat (and past the last) the edge spans extend that grid's
// own local tempo — the same extrapolation src/beats.js beatOf/timeOf agree
// on. No pure beat-duration helper exists there (both converters return beat
// coordinates), so this re-implements the gap scan with beats.js's 1e-9
// degenerate-gap epsilon: a zero/negative span is float noise, not a tempo —
// skipped rather than returned. Fewer than 2 beat entries mean there is no
// tempo map at all (seconds-primary), so the answer is null.
export function beatSecondsAt(beats, t) {
    if (!Array.isArray(beats) || beats.length < 2 || !Number.isFinite(t)) return null;
    let first = null;   // first valid gap (grid edge → its tempo extrapolates out)
    let chosen = null;  // last valid gap whose left edge is <= t
    for (let i = 0; i + 1 < beats.length; i++) {
        const st = _wireFloat(beats[i] && beats[i].time, NaN);
        const en = _wireFloat(beats[i + 1] && beats[i + 1].time, NaN);
        if (!Number.isFinite(st) || !Number.isFinite(en)) continue;
        const span = en - st;
        if (!(span > GAP_EPS)) continue;
        if (!first) first = { span };
        if (st <= t) chosen = { span };
    }
    if (!first) return null;
    return (chosen || first).span;
}

// ── Simplification primitives ───────────────────────────────────────────────

// The simplified NOTES for one tier. Ordered pipeline, purely functional over
// a deep clone:
//
//   1. chain members (`techniques.hammer_on` / `techniques.pull_off` truthy)
//      drop, counted `droppedChain` — they replay their anchor note;
//   2. on survivors, every present STRIP_TECHNIQUES key is replaced by its
//      load-side default (`STRIP_DEFAULTS`) and, whenever a bend key was
//      present, the bend CURVE (`techniques.bend_values`) is nulled too — a
//      curve without a bend value is meaningless, and the easy tier must not
//      ship curves either way. Ornaments (vibrato/tremolo/palm_mute/mute/
//      accent/…) are playability texture and ride along untouched. Counted
//      `stripped` (only notes that actually changed a value);
//   3. with a positive `minSustain`, survivors whose sustain is a POSITIVE
//      number below it drop, counted `droppedShort`. `sustain <= 0` notes are
//      KEPT: an unknown (≤ 0) duration is not a known-short one, and forcing
//      them out would gut the muted/percussive chart content.
//
// Every returned note carries a `techniques` object (synthesized {} when the
// input lacked one) so downstream diffing and the wire never see undefined.
export function deriveSimplifiedNotes(notes, opts = {}) {
    const minSustain = (opts && typeof opts === 'object') ? opts.minSustain : undefined;
    const list = Array.isArray(notes) ? notes : [];

    // Step 1 — chain members. Only object notes can carry a techniques dict;
    // non-object junk is skipped (never counted — it is not a chain member).
    const rawKept = [];
    let droppedChain = 0;
    for (const n of list) {
        if (!n || typeof n !== 'object') continue;
        const techs = n.techniques;
        const realDict = techs && typeof techs === 'object' && !Array.isArray(techs);
        if (realDict && (techs.hammer_on || techs.pull_off)) {
            droppedChain++;
            continue;
        }
        rawKept.push(n);
    }

    // Deep-clone ONCE, then all mutation below happens on clones — the input
    // list (and whatever it aliases, e.g. live editor notes) is never touched.
    const out = structuredClone(rawKept);
    let stripped = 0;
    for (const n of out) {
        // Every kept note must present a techniques dict for compare/wire.
        if (!n.techniques || typeof n.techniques !== 'object' || Array.isArray(n.techniques)) {
            n.techniques = {};
        }
        const techs = n.techniques;
        let touched = false;
        for (const k of STRIP_TECHNIQUES) {
            if (!_has(techs, k)) continue;
            if (techs[k] !== STRIP_DEFAULTS[k]) {
                techs[k] = STRIP_DEFAULTS[k];
                touched = true;
            }
        }
        // A present bend key (even already-default) forfeits the curve: the
        // former is the strip's own work, the latter a guaranteed-content
        // change, so both count.
        if (_has(techs, 'bend') && techs.bend_values !== null) {
            techs.bend_values = null;
            touched = true;
        }
        if (touched) stripped++;
    }

    // Step 3 — micro-sustains (only when a positive threshold was requested).
    let droppedShort = 0;
    if (typeof minSustain === 'number' && Number.isFinite(minSustain) && minSustain > 0) {
        const kept = [];
        for (const n of out) {
            const sus = Number(n.sustain);
            if (Number.isFinite(sus) && sus > 0 && sus < minSustain) {
                droppedShort++;
                continue;
            }
            kept.push(n);
        }
        return { notes: kept, droppedChain, stripped, droppedShort };
    }
    return { notes: out, droppedChain, stripped, droppedShort };
}

// The simplified CHORDS for one tier: chord instances survive with only their
// `high_density` flag flipped to false (the hard reality an easy tier can't
// express) — strings/frets/fn/member notes all verbatim. Non-object members
// drop; `thinned` counts only the actual flips.
export function deriveSimplifiedChords(chords) {
    const list = Array.isArray(chords) ? chords : [];
    const out = [];
    let thinned = 0;
    for (const c of list) {
        if (!c || typeof c !== 'object') continue;
        const clone = structuredClone(c);
        if (clone.high_density) {
            clone.high_density = false;
            thinned++;
        }
        out.push(clone);
    }
    return { chords: out, thinned };
}

// ── Structural equality (key order free) ────────────────────────────────────

// Plain (JSON-ish) deep equality, ignoring key order — the noop guard's
// basis. Arrays compare elementwise, objects as same-own-key-set dicts;
// Object.is handles the NaN corner so a junk NaN can't make every compare
// unequal. Editor tier content is exactly objects/arrays/numbers/strings/
// bools/null, so anything richer is out of contract on both sides.
export function _deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
        return Object.is(a, b);
    }
    const aArr = Array.isArray(a);
    const bArr = Array.isArray(b);
    if (aArr !== bArr) return false;
    if (aArr) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (!_deepEqual(a[i], b[i])) return false;
        }
        return true;
    }
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
        if (!_has(b, k) || !_deepEqual(a[k], b[k])) return false;
    }
    return true;
}

// Normalize one candidate handshape dict into the tier shape
// `{chord_id, start_time, end_time, arp}` — mirrors chords.js
// `_normalizeHandshape` (numeric-string tolerance, end>=start clamp, arp/
// arpeggio alias through the wire bool) PLUS the backend's hard drop for a
// chord_id below 0 (`_valid_handshape_dicts` — a handshape references a chord
// template, so -1 would emit a malformed handshape). Junk/missing keys drop
// the whole entry: one bad handshape can't cost the tier.
function _normalizeTierHandshape(hs) {
    if (!hs || typeof hs !== 'object') return null;
    const cid = Math.trunc(_wireFloat(hs.chord_id, NaN));
    if (!Number.isFinite(cid) || cid < 0) return null;
    let st = _wireFloat(hs.start_time, 0);
    let et = _wireFloat(hs.end_time, st);
    if (st < 0) st = 0;
    if (et < st) et = st;
    const rawArp = (hs.arp !== undefined) ? hs.arp
        : (hs.arpeggio !== undefined) ? hs.arpeggio : false;
    return { chord_id: cid, start_time: st, end_time: et, arp: _wireBool(rawArp, false) };
}

function _normalizeHandshapes(hsList) {
    const out = [];
    const list = Array.isArray(hsList) ? hsList : [];
    for (const hs of list) {
        const norm = _normalizeTierHandshape(hs);
        if (norm) out.push(norm);
    }
    return out;
}

// Copy a list for storage: keep the object members, deep-cloned. Used for the
// pass-through content (anchors, and the full-chart stub) so a planned tier
// never aliases live editor state — the edit-undo commands mutate notes in
// place, and a shared reference would let an edit rewrite saved history.
function _clonedObjectMembers(list) {
    const out = [];
    const src = Array.isArray(list) ? list : [];
    for (const it of src) {
        if (!it || typeof it !== 'object') continue;
        out.push(structuredClone(it));
    }
    return out;
}

// The noop guard's note-side clone: deep clone, synthesize an empty techniques
// dict when absent, and materialize `bend_values: null` whenever a bend key is
// present. The SAME normalization every note gets in deriveSimplifiedNotes —
// applying it to BOTH sides is what makes an already-simplified phrase compare
// equal (the strip's bend_values key-set materialization, alone, is not a
// content difference) while a dropped chain member or a real value change
// still reads as a difference.
function _prepCompareNote(n) {
    const c = structuredClone(n);
    if (!c || typeof c !== 'object') return c;
    if (!c.techniques || typeof c.techniques !== 'object' || Array.isArray(c.techniques)) {
        c.techniques = {};
    }
    if (_has(c.techniques, 'bend') && c.techniques.bend_values !== null) {
        c.techniques.bend_values = null;
    }
    return c;
}

function _noteListEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (!_deepEqual(_prepCompareNote(a[i]), _prepCompareNote(b[i]))) return false;
    }
    return true;
}

// An authored-ladder entry: `{difficulty, tier}`, first per difficulty wins
// (routes.py `_phrase_tiers_by_difficulty`), ascending by difficulty.
function _tiersByDifficulty(tiers) {
    const out = [];
    const list = Array.isArray(tiers) ? tiers : [];
    for (const tier of list) {
        if (!tier || typeof tier !== 'object') continue;
        const d = tier.difficulty;
        if (!Number.isInteger(d) || d < 0) continue;
        if (out.some(e => e.difficulty === d)) continue;
        out.push({ difficulty: d, tier });
    }
    out.sort((a, b) => a.difficulty - b.difficulty);
    return out;
}

// Emit an existing tier verbatim, with the content keys guaranteed to be
// arrays (the five-key tier contract) so a stray legacy tier can't break the
// ladder shape downstream.
function _copyTier(t) {
    const copy = structuredClone(t);
    for (const k of ['notes', 'chords', 'anchors', 'handshapes']) {
        if (!Array.isArray(copy[k])) copy[k] = [];
    }
    return copy;
}

// ── The planner ─────────────────────────────────────────────────────────────

// Plan one "simplify" run for `phrase` over the already window-sliced flat
// content `window = {notes, chords, anchors, handshapes}` (editor shape) with
// `opts = {minSustain}` (may be null/absent). Pure: never mutates the inputs;
// everything in the result is a fresh deep clone the caller can store.
//
// Returns either:
//   {tiers, maxDifficulty, addedDifficulty, srcNoteCount, keptNoteCount,
//    droppedChain, stripped, droppedShort, thinned} — the ladder to store, or
//   {error, message} — a refusal (`floor|empty|wiped|noop`), never a throw.
//
// The new rung's source content is the EASIEST existing tier's notes/chords —
// except when the ladder holds a SINGLE tier. That lone tier is the TOP tier,
// which the save path rebuilds from the editable flat chart on every save
// (`_authored_phrase_levels` re-slices the max-difficulty rung from the flat
// lists), so the tier's loaded copy goes stale the moment the user edits the
// chart. Sourcing from the live window slice keeps the derived rung current
// (and below, the lone tier re-emits above it with the window's chart content
// for the same reason). With NO tiers at all the source is likewise the flat
// chart slice. With no existing tiers the ladder is a fresh [0=simplified,
// 1=full-chart-copy] pair (maxDifficulty 1, or the phrase's DECLARED wire
// `max_difficulty` when larger); with a lone top tier the new rung lands at
// `minDifficulty - 1` (never 0 here — the floor guard answered first) and the
// floor's own rung re-emits above it from the same window; with a real ladder
// the new rung lands at `minDifficulty - 1` above the untouched ladder.
export function planTierSimplification(phrase, window, opts) {
    const p = (phrase && typeof phrase === 'object') ? phrase : {};
    const win = (window && typeof window === 'object') ? window : {};
    const minSustain = (opts && typeof opts === 'object') ? opts.minSustain : undefined;

    // Ladder shape first (check order is contractual): a difficulty-0 tier
    // means the phrase is already fully simplified — answer before even
    // reading content, or an already-bottomed-out phrase would (mis)report a
    // content verdict for a ladder it can't act on.
    const ladder = _tiersByDifficulty(p.tiers);
    if (ladder.some(e => e.difficulty === 0)) {
        return {
            error: 'floor',
            message: 'This phrase already has an authored difficulty-0 (floor) tier,'
                + ' so the simplification ladder already bottoms out.',
        };
    }

    // A lone tier is the top tier: source notes/chords from the live flat
    // chart, not the tier's loaded copy (see the planner docblock). Only the
    // SOURCE comes from the window — the lone tier itself rides on (rebuilt
    // from the same chart on save).
    const fromTier = ladder.length > 0;   // an authored ladder exists…
    const easiestIsTop = fromTier && ladder.length === 1;   // …but a lone tier is the top tier…
    const easiest = fromTier && !easiestIsTop ? ladder[0].tier : null;   // …else the flat chart

    // SOURCE content (raw, pre-simplification), fall back to the window's
    // lists when there is no source tier (or the tier lacks them).
    const rawNotes = easiest !== null && Array.isArray(easiest.notes)
        ? easiest.notes
        : (Array.isArray(win.notes) ? win.notes : []);
    const rawChords = easiest !== null && Array.isArray(easiest.chords)
        ? easiest.chords
        : (Array.isArray(win.chords) ? win.chords : []);

    if (rawNotes.length === 0 && rawChords.length === 0) {
        return {
            error: 'empty',
            message: 'This phrase has no notes or chords in its window to simplify.',
        };
    }

    // Anchors/handshapes for the NEW rung: the source tier's own lists when it
    // carries them (fall back to the window's otherwise), else the window's
    // own — handshapes normalized to the tier shape either way. A lone top
    // tier has no source role, so its anchors/handshapes fall back to the
    // window's here (same as the fresh ladder).
    const rawAnchors = (easiest !== null && Array.isArray(easiest.anchors))
        ? easiest.anchors
        : (Array.isArray(win.anchors) ? win.anchors : []);
    const rawHandshapes = (easiest !== null && Array.isArray(easiest.handshapes))
        ? easiest.handshapes
        : (Array.isArray(win.handshapes) ? win.handshapes : []);

    const simpNotes = deriveSimplifiedNotes(rawNotes, { minSustain });
    const simpChords = deriveSimplifiedChords(rawChords);

    if (simpNotes.notes.length === 0 && simpChords.chords.length === 0) {
        return {
            error: 'wiped',
            message: 'Simplifying this phrase would remove every note and chord from it,'
                + ' so no easier tier can be built.',
        };
    }

    const srcNoteCount = rawNotes.length;

    if (_noteListEqual(simpNotes.notes, rawNotes)
        && _deepEqual(simpChords.chords, rawChords.filter(c => c && typeof c === 'object'))) {
        return {
            error: 'noop',
            message: 'Simplifying this phrase changes nothing — the simplified content'
                + ' is identical to what the phrase already holds.',
        };
    }

    const handshapes = _normalizeHandshapes(rawHandshapes);
    const anchors = _clonedObjectMembers(rawAnchors);

    if (!fromTier || easiestIsTop) {
        // Fresh ladder — or a lone top tier gaining its first authored lower
        // rung: [simplified below, full chart verbatim at (its) top]. The top
        // rung is the editable flat chart copy — the pair the save path will
        // slice/keep verbatim; the content is cloned so each tier owns it.
        // The new rung lands one below the ladder floor (0 for a fresh ladder,
        // min − 1 for a lone top tier at min > 0 — never a difficulty-0 floor
        // here, the floor guard answered first).
        const floorDifficulty = easiestIsTop ? ladder[0].difficulty : 1;
        const target = floorDifficulty - 1;   // ≥ 0: floor guard passed (fresh: 1−1)
        const maxDifficulty = Math.max(floorDifficulty, _declaredMaxDifficulty(p) || 0);
        return {
            tiers: [
                {
                    difficulty: target,
                    notes: simpNotes.notes,
                    chords: simpChords.chords,
                    anchors,
                    handshapes,
                },
                {
                    difficulty: floorDifficulty,
                    notes: _clonedObjectMembers(win.notes),
                    chords: _clonedObjectMembers(win.chords),
                    anchors: _clonedObjectMembers(win.anchors),
                    handshapes: handshapes.map(hs => structuredClone(hs)),
                },
            ],
            maxDifficulty,
            addedDifficulty: target,
            srcNoteCount,
            keptNoteCount: simpNotes.notes.length,
            droppedChain: simpNotes.droppedChain,
            stripped: simpNotes.stripped,
            droppedShort: simpNotes.droppedShort,
            thinned: simpChords.thinned,
        };
    }

    // Existing ladder: insert the rung one difficulty below the current floor.
    const target = ladder[0].difficulty - 1;   // ≥ 0: the floor guard passed
    const newTier = {
        difficulty: target,
        notes: simpNotes.notes,
        chords: simpChords.chords,
        anchors,
        handshapes,
    };
    // Clone (and shape-normalize) the authored tiers, splice in the new rung,
    // keep the ladder ascending by difficulty.
    const tiers = ladder.map(e => _copyTier(e.tier));
    const insertAt = tiers.findIndex(e => e.difficulty > target);
    if (insertAt < 0) tiers.push(newTier);
    else tiers.splice(insertAt, 0, newTier);

    let top = 0;
    for (const t of tiers) top = Math.max(top, t.difficulty);
    const declared = _declaredMaxDifficulty(p);
    return {
        tiers,
        maxDifficulty: Math.max(top, declared === null ? top : declared),
        addedDifficulty: target,
        srcNoteCount,
        keptNoteCount: simpNotes.notes.length,
        droppedChain: simpNotes.droppedChain,
        stripped: simpNotes.stripped,
        droppedShort: simpNotes.droppedShort,
        thinned: simpChords.thinned,
    };
}
