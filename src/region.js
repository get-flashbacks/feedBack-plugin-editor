// ════════════════════════════════════════════════════════════════════
// Region model — a track's content as placeable blocks on the timeline.
//
// A region is a WINDOW, never a copy. A notation/MIDI region windows the
// arrangement's ONE `notes[]` array by beat (it must never own a private
// note-bag — that would fork `note.beat`-as-truth); an audio region points
// into immutable media (a beat-grid start plus an in/out trim in the file's
// own seconds, never time-stretched). This is the data model + migration
// layer only (PR 1): every track resolves to a SINGLE default full-span
// region until a later PR creates bounded ones, so nothing about rendering,
// playback, or /build changes yet.
//
// Region shape (all fields optional except id):
//   { id, startBeat, lenBeat, srcIn?, srcOut?, name?, muted? }
//     - startBeat : grid position in beats (truth; derives seconds via timeOf)
//     - lenBeat   : notation window length in beats; null = to end of content
//     - srcIn/Out : audio trim into the immutable media, in the file's SECONDS
//                   (present only on trimmed audio regions)
//     - name/muted: optional label / per-region mute
//
// The default region — startBeat 0, no length, no trim — represents the whole
// track content implicitly, so it needs neither the source duration nor the
// note extent to synthesize. A track whose only region is the default persists
// as NO `regions` key, so untouched packs stay byte-identical (mirrors the
// track-session "default tree → no manifest key" rule).
// ════════════════════════════════════════════════════════════════════

export const DEFAULT_REGION_ID = 'region:1';
const MAX_REGIONS = 200;

function _regionIdPure(value) {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim();
    return trimmed.length > 0 && trimmed.length <= 160 ? trimmed : '';
}
function _nonNegNumPure(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}
function _posNumOrNullPure(value) {
    if (value == null) return null;
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
}

// The implicit full-span region: start at beat 0, no length (runs to the end
// of the underlying content). Type-agnostic — audio and notation share it
// until a trim/split creates a bounded region.
export function _defaultRegionPure() {
    return { id: DEFAULT_REGION_ID, startBeat: 0, lenBeat: null };
}

// Validate one persisted region into a determinate shape, or null if unusable.
// Optional fields are emitted ONLY when meaningfully set, so a default region
// normalizes back to exactly `{ id, startBeat: 0, lenBeat: null }`.
export function _regionNormalizePure(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = _regionIdPure(raw.id);
    if (!id) return null;
    const out = { id, startBeat: _nonNegNumPure(raw.startBeat, 0), lenBeat: _posNumOrNullPure(raw.lenBeat) };
    // Audio trim: present as a pair when either endpoint is set. srcIn defaults
    // to 0; srcOut is kept only when it lies strictly after srcIn, else null
    // ("to end of media") — a degenerate window must never invert.
    if (raw.srcIn != null || raw.srcOut != null) {
        const srcIn = _nonNegNumPure(raw.srcIn, 0);
        const srcOut = _posNumOrNullPure(raw.srcOut);
        out.srcIn = srcIn;
        out.srcOut = srcOut != null && srcOut > srcIn ? srcOut : null;
    }
    if (typeof raw.name === 'string' && raw.name.trim()) out.name = raw.name.trim().slice(0, 120);
    if (raw.muted === true) out.muted = true;
    return out;
}

// Normalize a persisted regions[]: validate each, drop the unusable, dedupe by
// id, sort by startBeat (then id for a stable order). Idempotent.
export function _trackRegionsNormalizePure(raw) {
    const list = Array.isArray(raw) ? raw : [];
    const out = [];
    const seen = new Set();
    for (const item of list.slice(0, MAX_REGIONS)) {
        const region = _regionNormalizePure(item);
        if (!region || seen.has(region.id)) continue;
        seen.add(region.id);
        out.push(region);
    }
    out.sort((a, b) => a.startBeat - b.startBeat || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return out;
}

// Is this regions[] just the implicit default — absent/empty, or a lone
// full-span region with no trim/label/mute? A default set persists as NO
// `regions` key so untouched packs stay byte-identical across saves.
export function _regionsAreDefaultPure(raw) {
    const norm = _trackRegionsNormalizePure(raw);
    if (norm.length === 0) return true;
    if (norm.length !== 1) return false;
    const r = norm[0];
    return r.startBeat === 0 && r.lenBeat == null && r.srcIn == null && r.srcOut == null
        && r.name == null && r.muted == null;
}

// The EFFECTIVE regions of a track: its persisted set, or one default full-span
// region when it has none. This is the migration seam — an old pack (no
// `regions`) resolves to exactly one full region per track, identical to today.
export function _trackRegionsResolvePure(raw) {
    const norm = _trackRegionsNormalizePure(raw);
    return norm.length ? norm : [_defaultRegionPure()];
}

// The next free `region:N` id for a track, given its persisted regions[] (or
// absent). N is one past the highest numeric suffix in use, and the implicit
// default (DEFAULT_REGION_ID = `region:1`) is always counted even when it isn't
// persisted — so a placed region never collides with it. A fresh track (no
// regions) yields `region:2`. Non-numeric ids don't participate in the count.
export function _nextRegionIdPure(raw) {
    let max = 1;                       // DEFAULT_REGION_ID occupies region:1
    for (const region of _trackRegionsNormalizePure(raw)) {
        const m = /^region:(\d+)$/.exec(region.id);
        if (m) { const n = Number(m[1]); if (n > max) max = n; }
    }
    return 'region:' + (max + 1);
}

// Membership predicate: does a beat fall inside the region's window? startBeat
// inclusive, startBeat+lenBeat exclusive; lenBeat null = open to the end of
// content. This is the primitive a later move/trim command uses to select "the
// notes this region owns" — without ever copying them out of the one notes[].
export function _regionContainsBeatPure(region, beat) {
    if (!region || typeof region !== 'object') return false;
    const b = Number(beat);
    if (!Number.isFinite(b)) return false;
    const start = Number(region.startBeat) || 0;
    if (b < start) return false;
    if (region.lenBeat == null) return true;
    const len = Number(region.lenBeat);
    if (!Number.isFinite(len) || len <= 0) return true;
    return b < start + len;
}

// ── Track placement (the per-track time offset) ───────────────────────
// A track can be nudged in time independently of the whole song. The value is
// SECONDS and lives on the track row inside the `editor_track_session`
// manifest EXTENSION key — an `editor_`-prefixed key this editor owns, so
// feedpak-spec §5.1 gains no top-level key and §1.2/§10's preserve-what-you-
// don't-understand rule covers it. It is a PLACEMENT, not a content edit: no
// sample and no note ever moves, which is what makes it non-destructive and
// makes undo a matter of putting one field back.
//
// It composes with the other placement terms instead of replacing them:
//
//   global  S.audioShift      one value for the whole audio group (src/state.js)
//   source  row.sourceOffset  per stem, baked into the manifest
//   track   row.offsetSec     THIS offset — per track
//
// A track's placement is the SUM, so moving one track (or the global shift)
// leaves the other two exactly where they were. `_trackPlacementPure` is the
// one expression every placement site resolves through — audio.js (playback)
// and parts-view.js (render) both call it, so the two can't drift apart.
//
// Only an AUDIO row carries one. A folder has no timeline of its own, and a
// transcription track's placement is already expressed — and already
// persisted, and already undoable — by its `regions[]`, which MoveRegionCmd
// moves. Giving it a second, seconds-based axis on top would leave "where is
// this content?" with two answers.

// One placement term as a finite number of seconds, else 0. The
// `Number.isFinite` guard is load-bearing, not paranoia: NaN and ±Infinity both
// sail through `Number()` (and both are truthy, so `|| 0` won't catch them) and
// would then poison every position derived from the sum. Same guard the backend
// `_coerce_audio_shift` / `_coerce_track_offset` apply on the way in.
export function _placementSecPure(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

// A track's audio placement in chart seconds: the global shift, the source's own
// offset and the track's offset, ADDED. Any one of them may be absent/garbage —
// it contributes 0 and the rest stand.
//
// The SUM is finite-checked too, not just each term: three individually finite
// values can still overflow to Infinity (1e308 + 1e308 + 1e308), and an Infinity
// placement would flow straight into `timeToX()` and `node.start(when)`. An
// overflowing offset is treated like any other garbage — 0 — rather than being
// allowed to poison every position derived from it.
export function _trackPlacementPure(audioShift, sourceOffset, trackOffset) {
    const sum = _placementSecPure(audioShift) + _placementSecPure(sourceOffset) + _placementSecPure(trackOffset);
    return Number.isFinite(sum) ? sum : 0;
}

/* @pure:audio-track-ends:start */
// The furthest chart-second an AUDIO track's content can reach: its composed
// placement (the SAME three-term sum `_trackPlacementPure`) plus its source's
// decoded buffer length, maximized across every audio row.
//
// This is what lets the timeline bound — and so the scroll clamp and the
// playback tail — follow a track nudged past the master's end, instead of
// always reading the global `audioShift` alone (the gap #48 tracks). Negative
// placements crop the front but, matching `_audioTimelineDurationPure`'s
// rule, never shrink the bound below the source's own length.
//
// `sourceDurations` is a Map<sourceId, bufferSeconds> (or a plain object) of
// every DECODED source's length; a source that has not decoded yet contributes
// 0 — the master always has (it is S.audioBuffer), so a nudged master track is
// always bounded, and a stem is bounded once its buffer is decoded.
export function _audioTrackEndsPure(audioShift, rows, sources, sourceDurations) {
    const durById = sourceDurations instanceof Map
        ? sourceDurations
        : new Map(Object.entries(sourceDurations || {}));
    const srcById = new Map((Array.isArray(sources) ? sources : [])
        .map((s) => [s && s.id, s]));
    let max = 0;
    for (const track of (Array.isArray(rows) ? rows : [])) {
        if (!track || track.type !== 'audio') continue;
        const src = srcById.get(track.sourceId);
        const sourceOffset = src ? _placementSecPure(src.offset) : 0;
        const placement = _trackPlacementPure(audioShift, sourceOffset, _placementSecPure(track.offsetSec));
        const dur = _placementSecPure(durById.get(track.sourceId));
        if (!(dur > 0)) continue;             // an un-decoded source contributes no length
        const end = dur + Math.max(0, placement);
        if (Number.isFinite(end) && end > max) max = end;
    }
    return max;
}
/* @pure:audio-track-ends:end */

// ── Layout (for drawing a region as a block on a track lane) ──────────

// The region's TIME span on the timeline, given its lane's content extent
// [contentStart, contentEnd] in seconds. A full-span region (no length, no
// audio trim, at beat 0) spans the whole content; a bounded notation region
// spans [beatToTime(startBeat), beatToTime(startBeat+lenBeat)]. Bounded regions
// arrive with the move/trim PRs — today every region is full-span, so this
// resolves to the content extent, but the bounded path is here so the renderer
// needs no change when they land. `beatToTime` is the beats.js `timeOf`.
export function _regionTimeSpanPure(region, contentStart, contentEnd, beatToTime) {
    const c0 = Number.isFinite(Number(contentStart)) ? Number(contentStart) : 0;
    const c1 = Number.isFinite(Number(contentEnd)) ? Number(contentEnd) : c0;
    const start = Number(region && region.startBeat) || 0;
    const bounded = !!region && (region.lenBeat != null || region.srcIn != null || start > 0);
    if (!bounded) return { t0: c0, t1: Math.max(c0, c1) };
    const b2t = typeof beatToTime === 'function' ? beatToTime : (b => b);
    const t0 = b2t(start);
    const t1 = region.lenBeat != null ? b2t(start + Number(region.lenBeat)) : c1;
    return { t0, t1: Math.max(t0, t1) };
}

// Clamp a region's pixel span [x0, x1] to the visible band [gutter, width].
// `visible` is false when the block is off-screen or collapses to nothing, so
// the caller can skip both the draw and the hit target.
export function _regionBlockRectPure(x0, x1, gutter, width) {
    const g = Number(gutter) || 0;
    const wMax = Number(width) || 0;
    const lo = Math.max(g, Math.min(x0, x1));
    const hi = Math.min(wMax, Math.max(x0, x1));
    const w = hi - lo;
    return { x: lo, w: Math.max(0, w), visible: w > 0.5 };
}

// Does a canvas x land inside a drawn region block? (Vertical bounds are the
// lane's, tested by the caller before it gets here.)
export function _regionHitPure(rect, x) {
    if (!rect || !rect.visible) return false;
    const n = Number(x);
    return Number.isFinite(n) && n >= rect.x && n <= rect.x + rect.w;
}

// The glass title-banner height for a region block at a given lane height. The
// banner is ~14px, but it shrinks on a short lane and collapses to 0 below ~23px
// so a squeezed lane falls back to a bare colour spine (no banner, no inset)
// instead of a crushed title strip. The Parts-view renderer insets the note
// silhouette below this height so the notes never cross the title line, and
// because the banner is always strictly less than the lane height the inset
// content band can never invert.
export function _regionBannerH(laneH) {
    const h = Math.min(14, (Number(laneH) || 0) - 3 - 12);
    return h >= 8 ? h : 0;
}

// ── Move (reposition) ─────────────────────────────────────────────────

// The exact seconds shift for a beat offset `dBeat` when the tempo is globally
// constant (a uniform grid) or absent (a degenerate < 2-beat grid = seconds-
// primary), else null to signal "remap each note through beats individually".
// Uniform: every consecutive gap is equal, so secondsPerBeat·dBeat is exact and
// carries none of the beatOf∘timeOf round-trip drift. Degenerate: beat == time,
// so the shift simply IS dBeat. This is the fast path that makes the common
// (constant-tempo) region move bit-exact — a round-trip test would otherwise
// fail on sub-microsecond float drift (the same `_r3` drift TempoMapCmd flags).
export function _regionConstantShiftPure(beats, dBeat) {
    if (!Array.isArray(beats) || beats.length < 2) return dBeat;      // seconds-primary
    const g0 = beats[1].time - beats[0].time;
    for (let i = 2; i < beats.length; i++) {
        if (Math.abs((beats[i].time - beats[i - 1].time) - g0) > 1e-9) return null;
    }
    return g0 * dBeat;
}

// Reposition a set of note/hit intervals by a constant beat offset `dBeat`,
// against the tempo map `beats`. A notation/drum region MOVE preserves MUSICAL
// position, not wall-clock seconds (mirrors TempoMapCmd's interval walk): each
// note is the interval [onset, onset+sustain]; both ends remap through beats and
// the new sustain is the reprojected span (never negative), so a beat-filling
// note stays beat-filling and its feel scales to the destination tempo.
//   newTime    = timeOf(beatOf(oldTime) + dBeat)
//   newSustain = timeOf(beatOf(oldTime + oldSustain) + dBeat) - newTime   (>= 0)
// FAST PATH: when the tempo is constant across the grid, collapse to one exact
// seconds shift (a constant shift never changes a duration). `dBeat === 0` is
// the caller's no-op — routing a zero move through beats would perturb every
// note by an epsilon. `beatOf`/`timeOf` are passed in so this stays converter-
// free like the layout pures above. Returns fresh arrays; never mutates input.
// AUDIO regions do NOT use this — their samples are physical seconds, so they
// move by a constant dtime (re-gridding audio would be a time-stretch, a
// separate op); this beat-remap is for notation/drum content only.
export function _regionRemapPure(times, sustains, dBeat, beats, beatOf, timeOf) {
    const n = times.length;
    const outT = new Array(n);
    const outS = new Array(n);
    const shift = _regionConstantShiftPure(beats, dBeat);
    for (let i = 0; i < n; i++) {
        const t = Number(times[i]) || 0;
        const s = Math.max(0, Number(sustains ? sustains[i] : 0) || 0);
        if (shift !== null) {
            outT[i] = t + shift;
            outS[i] = s;                                 // constant shift keeps duration
        } else {
            const nt = timeOf(beats, beatOf(beats, t) + dBeat);
            const ne = s > 0 ? timeOf(beats, beatOf(beats, t + s) + dBeat) : nt;
            outT[i] = nt;
            outS[i] = Math.max(0, ne - nt);
        }
    }
    return { times: outT, sustains: outS };
}

// Snap a region's dragged start time to the nearest bar line (downbeat) — the
// DAW default for regions (Logic/Live snap regions to bars, not subdivisions).
// `free` (the Alt modifier) bypasses snapping for a fine nudge. Never < 0, and
// a chart with no downbeats falls back to the free position.
export function _regionSnapStartPure(downbeats, rawStart, free) {
    const t = Math.max(0, Number(rawStart) || 0);
    if (free || !Array.isArray(downbeats) || !downbeats.length) return t;
    let best = downbeats[0];
    let bestD = Math.abs(Number(best) - t);
    for (const d of downbeats) {
        const dd = Math.abs(Number(d) - t);
        if (dd < bestD) { bestD = dd; best = d; }
    }
    return Math.max(0, Number(best) || 0);
}

// The startBeat an import dialog's "Place at" choice resolves to, or null for
// "keep source timing" (no placement — the content stays where the source put
// it). 'bar1' = the first downbeat; 'playhead' = the cursor snapped to the
// nearest bar (the region-snap default). Downbeats are derived here from the
// grid itself (`measure > 0` marks a bar start) so the pure stays converter-
// free; `beatOf` is passed in like the other pures. A gridless chart resolves
// through beatOf's own degenerate (seconds-primary) handling.
export function _placeAtStartBeatPure(placeAt, beats, cursorTime, beatOf) {
    if (placeAt !== 'bar1' && placeAt !== 'playhead') return null;
    const downbeats = (Array.isArray(beats) ? beats : [])
        .filter(b => b && b.measure > 0).map(b => b.time).sort((a, b) => a - b);
    const t = placeAt === 'bar1'
        ? (downbeats.length ? downbeats[0] : 0)
        : _regionSnapStartPure(downbeats, cursorTime, false);
    return Math.max(0, beatOf(beats, t));
}
