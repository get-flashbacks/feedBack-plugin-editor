/* Slopsmith Arrangement Editor — per-section sync alignment engine (#24).
 *
 * Sub-issue 3/5 of per-section syncing (#8). PURE ANALYSIS: it reads the chart
 * grid and the audio onset strip, and returns one INDEPENDENT proposal per
 * section. It never mutates note timestamps (baking is #25) and never touches
 * `S`, the DOM or the host (the reviewed selection UI is #26).
 *
 * ── What it reuses, and what "chroma" means here ───────────────────────────
 * #24 was scoped to "reuse the chroma + DTW alignment from the current uniform
 * sync redesign, per section". The shipped uniform model (src/sync-tempo.js) has
 * no spectral-chroma front-end: its audio fingerprint is the banded
 * spectral-flux onset strip (src/onsets.js), and its tempo estimate is the
 * strength-weighted inter-onset vote `_detectTempoFromOnsetsPure`. The engine
 * therefore runs THAT estimator once per section — the literal "run it per
 * section instead of once for the whole song" — and adds a DTW pass over the
 * section's onset sequence for the source→audio anchor correspondences the #23
 * design doc requires. A separate, unvalidated chroma extractor would be a
 * bigger audio-feature change than this sub-issue owns.
 *
 * ── Contract (docs/PER-SECTION-SYNC-DESIGN.md) ─────────────────────────────
 * - Boundaries come from an immutable snapshot of the canonical `sections`, as
 *   half-open intervals [start_i, start_(i+1)); the final interval includes the
 *   chart endpoint, and a leading region before the first marker is explicit.
 * - Each region returns its own original interval, source→audio anchor
 *   correspondences in seconds, an affine slope/intercept (seconds-out /
 *   seconds-in, NOT the BPM ratio), a confidence and a failure reason. A
 *   mismatched region's evidence never reaches its neighbours — every region is
 *   estimated from its own events alone.
 * - A single region reduces to the uniform analysis: the same song-wide tab BPM
 *   and the same onset vote.
 */
import { _detectTempoFromOnsetsPure } from './sync-tempo.js';

/* @pure:section-sync:start */

const EPS = 1e-9;

function _clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
function _round4(v) { return Math.round(v * 1e4) / 1e4; }
function _median(sortedOrRaw) {
    const a = Array.isArray(sortedOrRaw) ? sortedOrRaw.slice() : [];
    if (!a.length) return 0;
    a.sort((x, y) => x - y);
    const mid = a.length >> 1;
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/**
 * Split the canonical section markers into regions over `domain = {start,end}`
 * (seconds). Returns `[{index, name, number, start, end, leading, final}]`.
 *
 * - A marker at or before the domain start is the baseline, not a boundary.
 * - If the first marker is after the start, the gap is an explicit leading
 *   region (`leading: true`, empty name) — never silently discarded.
 * - Intervals are half-open; `final` marks the region that owns the endpoint.
 * - No markers (or a single marker at the start) yields one full-domain region,
 *   the single-section case that reduces to the uniform model.
 */
export function _sectionRegionsPure(sections, domain) {
    const start = domain.start, end = domain.end;
    const markers = (Array.isArray(sections) ? sections : [])
        .filter((s) => s && Number.isFinite(s.start_time))
        .map((s) => ({
            name: s.name || '',
            number: Number.isFinite(s.number) ? s.number : 0,
            start: s.start_time,
        }))
        .filter((m) => m.start > start + EPS && m.start < end - EPS)
        .sort((a, b) => a.start - b.start);
    const bounds = [];
    for (const m of markers) {
        if (bounds.length && Math.abs(bounds[bounds.length - 1].start - m.start) < 1e-6) continue;
        bounds.push(m);
    }
    const regions = [];
    if (!bounds.length) {
        regions.push({ index: 0, name: '', number: 0, start, end, leading: true, final: true });
        return regions;
    }
    if (bounds[0].start > start + EPS) {
        regions.push({ index: 0, name: '', number: 0, start, end: bounds[0].start, leading: true, final: false });
    }
    for (let i = 0; i < bounds.length; i++) {
        const next = i + 1 < bounds.length ? bounds[i + 1].start : end;
        regions.push({
            index: regions.length,
            name: bounds[i].name,
            number: bounds[i].number,
            start: bounds[i].start,
            end: next,
            leading: false,
            final: i === bounds.length - 1,
        });
    }
    return regions;
}

/** The section's chart tempo as BPM, from the beat grid restricted to
 *  [start,end). Mirrors getTabBPM()'s downbeat-interval method so a full-domain
 *  region reproduces the uniform model; falls back to the mean beat interval on
 *  a region too short to hold two downbeats. 0 when unmeasurable. */
export function _localBpmFromBeatsPure(beats, start, end, includeEnd) {
    const inRegion = (t) => t >= start - 1e-6 && (t < end - 1e-6 || (includeEnd && t <= end + 1e-6));
    const bs = (Array.isArray(beats) ? beats : [])
        .filter((b) => b && Number.isFinite(b.time) && inRegion(b.time));
    if (bs.length < 2) return 0;
    const downbeats = bs.filter((b) => b.measure > 0);
    if (downbeats.length >= 2) {
        let sum = 0, n = 0;
        for (let i = 1; i < downbeats.length; i++) {
            const dt = downbeats[i].time - downbeats[i - 1].time;
            const per = bs.filter((b) => b.time >= downbeats[i - 1].time && b.time < downbeats[i].time).length;
            if (dt > EPS && per > 0) { sum += dt / per; n++; }
        }
        if (n > 0 && sum > 0) return 60 / (sum / n);
    }
    let sum = 0, n = 0;
    for (let i = 1; i < bs.length; i++) {
        const dt = bs[i].time - bs[i - 1].time;
        if (dt > EPS) { sum += dt; n++; }
    }
    return n > 0 ? 60 / (sum / n) : 0;
}

/**
 * DTW-align a time-sorted source sequence to a time-sorted target sequence.
 * Local cost is the |difference| of each sequence's time normalised to [0,1],
 * so a tempo ratio is a linear stretch the path can follow while remaining
 * monotone. Returns `{ pairs: [[sourceSec, targetSec], …], coverage }` where
 * each source event carries the mean of the target times it matched (coverage
 * is the matched-source fraction, 0..1). Endpoints are always paired.
 */
export function _dtwAlignPure(src, dst) {
    const n = src.length, m = dst.length;
    if (n < 2 || m < 2) return { pairs: [], coverage: 0 };
    const sn = new Float64Array(n), dn = new Float64Array(m);
    const s0 = src[0], sSpan = src[n - 1] - src[0];
    const d0 = dst[0], dSpan = dst[m - 1] - dst[0];
    for (let i = 0; i < n; i++) sn[i] = sSpan > EPS ? (src[i] - s0) / sSpan : i / (n - 1);
    for (let j = 0; j < m; j++) dn[j] = dSpan > EPS ? (dst[j] - d0) / dSpan : j / (m - 1);
    const W = m + 1;
    const D = new Float64Array((n + 1) * W).fill(Infinity);
    D[0] = 0;
    for (let i = 1; i <= n; i++) {
        const si = sn[i - 1];
        for (let j = 1; j <= m; j++) {
            const cost = Math.abs(si - dn[j - 1]);
            const a = D[(i - 1) * W + j], b = D[i * W + (j - 1)], c = D[(i - 1) * W + (j - 1)];
            D[i * W + j] = cost + Math.min(a, b, c);
        }
    }
    let i = n, j = m;
    const bySrc = new Map();
    while (i > 0 && j > 0) {
        const a = D[(i - 1) * W + (j - 1)], b = D[(i - 1) * W + j], c = D[i * W + (j - 1)];
        if (a <= b && a <= c) { i--; j--; }
        else if (b <= c) { i--; }
        else { j--; }
        if (!bySrc.has(i)) bySrc.set(i, []);
        if (bySrc.get(i).length === 0 || bySrc.get(i)[bySrc.get(i).length - 1] !== j) bySrc.get(i).push(j);
    }
    const pairs = [];
    for (let s = 0; s < n; s++) {
        const js = bySrc.get(s);
        if (!js || !js.length) continue;
        let sum = 0;
        for (const jj of js) sum += dst[jj];
        pairs.push([src[s], sum / js.length]);
    }
    pairs.sort((p, q) => p[0] - q[0]);
    return { pairs, coverage: pairs.length / n };
}

/** Theil-Sen slope over pairs: the median of all pairwise slopes, robust to the
 *  odd mis-matched correspondence. 0 when underdetermined. */
export function _slopeFromPairsPure(pairs) {
    const n = pairs.length;
    if (n < 2) return 0;
    const slopes = [];
    // Cap the O(n²) walk on very long sections by sampling evenly.
    const stride = n > 96 ? Math.ceil(n / 96) : 1;
    const idx = [];
    for (let i = 0; i < n; i += stride) idx.push(i);
    if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);
    for (let a = 0; a < idx.length; a++) {
        for (let b = a + 1; b < idx.length; b++) {
            const dx = pairs[idx[b]][0] - pairs[idx[a]][0];
            if (dx > EPS) slopes.push((pairs[idx[b]][1] - pairs[idx[a]][1]) / dx);
        }
    }
    return slopes.length ? _median(slopes) : 0;
}

/**
 * Fit `audio = slope * source + intercept` through the matched pairs. `slope`
 * may be supplied (the onset-vote convention wins for the factor); otherwise a
 * robust Theil-Sen slope is used. `intercept` is the median residual — robust to
 * the handful of correspondences a tempo change near a boundary can mis-pair.
 * Returns `{slope, intercept, rms, mad, n}` or null when unfit.
 */
export function _fitAffinePure(pairs, slope) {
    const n = pairs.length;
    if (n < 2) return null;
    const a = slope > EPS ? slope : _slopeFromPairsPure(pairs);
    if (!(a > EPS)) return null;
    const intercept = _median(pairs.map(([x, y]) => y - a * x));
    let sum2 = 0;
    const errs = [];
    for (const [x, y] of pairs) {
        const e = y - (a * x + intercept);
        sum2 += e * e;
        errs.push(e);
    }
    const med = _median(errs);
    const mad = _median(errs.map((e) => Math.abs(e - med)));
    return { slope: a, intercept, rms: Math.sqrt(sum2 / n), mad, n };
}

/** Keep the DTW correspondences that sit within `tol` of the fitted map —
 *  boundary onsets that jittered into a section's window are rejected, not
 *  blended into the fit. Returns the surviving pairs (all pairs when no tol). */
export function _trimPairsPure(pairs, slope, intercept, tol) {
    if (!(tol > EPS)) return pairs;
    return pairs.filter(([x, y]) => Math.abs(y - (slope * x + intercept)) <= tol);
}

/** The chart's analysable domain — the grid's own span. 0/0 when the grid is
 *  degenerate, which the caller refuses rather than analysing. */
export function _chartDomainPure(beats) {
    const bs = (Array.isArray(beats) ? beats : []).filter((b) => b && Number.isFinite(b.time));
    if (bs.length < 2) return { start: 0, end: 0 };
    const start = bs[0].time, end = bs[bs.length - 1].time;
    return { start, end };
}

/** Every timed chart onset (notes, chord notes, anchors, phrases, drum hits),
 *  time-sorted and de-duplicated to 1 ms. This is the on-the-beat pulse the
 *  engine anchors on; the grid itself is the fallback when a section is sparse. */
export function _collectSourceOnsetsPure(source) {
    const out = [];
    const push = (t) => { if (Number.isFinite(t)) out.push(t); };
    for (const a of ((source && source.arrangements) || [])) {
        if (!a) continue;
        for (const nt of (a.notes || [])) push(nt.time);
        for (const ch of (a.chords || [])) {
            push(ch.time);
            for (const cn of (ch.notes || [])) push(cn.time);
        }
        for (const an of (a.anchors || [])) push(an.time);
        for (const an of (a.anchors_user || [])) push(an.time);
        for (const ph of (a.phrases || [])) push(ph.start_time);
    }
    if (source && source.drumTab && Array.isArray(source.drumTab.hits)) {
        for (const h of source.drumTab.hits) push(h.t);
    }
    out.sort((x, y) => x - y);
    const uniq = [];
    for (const t of out) if (!uniq.length || t - uniq[uniq.length - 1] > 1e-3) uniq.push(t);
    return uniq;
}

const DEFAULTS = {
    minEvents: 4,        // fewest source onsets a region may anchor on
    minOnsets: 8,        // _detectTempoFromOnsetsPure's own floor
    resTol: 0.25,        // seconds of anchor spread that reads as "no fit"
    tempoTol: 0.15,      // relative disagreement allowed between vote and anchors
    confidenceFloor: 0.5, // confidence >= this counts as a trustworthy proposal
    slopeBand: 0.2,      // ± fraction of the prior slope searched around a region
    pad: 0.35,           // absolute seconds of slack on each window edge
    tightPad: 0.15,      // seconds of slack on the refinement window
};

function _fail(region, reason) {
    return {
        ok: false,
        index: region.index,
        name: region.name,
        number: region.number,
        start: region.start,
        end: region.end,
        reason,
        confidence: 0,
        factor: 1,
        slope: 1,
        intercept: 0,
        tabBpm: 0,
        audioBpm: 0,
        anchors: [],
        rms: 0,
        coverage: 0,
    };
}

function _priorWindow(prior, region, span, opts) {
    const slope = prior && prior.slope > EPS ? prior.slope : 1;
    const intercept = prior && Number.isFinite(prior.intercept) ? prior.intercept : 0;
    const a0 = slope * region.start + intercept;
    const a1 = slope * region.end + intercept;
    const pad = Math.max(opts.pad, opts.slopeBand * span * slope);
    return { lo: Math.min(a0, a1) - pad, hi: Math.max(a0, a1) + pad };
}

/** The median beat interval of a time-sorted onset sequence (the grid step). */
function _medianGridStepPure(times) {
    const dt = [];
    for (let i = 1; i < times.length; i++) {
        const d = times[i] - times[i - 1];
        if (d > EPS) dt.push(d);
    }
    return dt.length ? _median(dt) : 0;
}

/** The onset closest to `v`, or `v` itself when it is farther than `tol` away —
 *  a glue point for the chain, unwilling to jump a beat. */
/**
 * Snap the chained place to a real onset. The place predates this region's
 * first onset; everything below it belongs to the previous section (its proper
 * beats sit a full period away and stay out of `tol`, but a stray click near
 * the boundary can edge a few dozen ms under a real onset). Within `tol` we
 * therefore prefer the onset at-or-after the place when it is not decisively
 * farther than the nearest one below (a `tieSlop`-sized margin covers detector
 * jitter), so the window's lower edge glues to THIS section's boundary onset
 * and the previous section's content never enters it. Falls back to the
 * nearest onset, and to `v` itself when nothing is in range.
 */
function _nearestOnsetPure(audioOnsets, v, tol, tieSlop) {
    if (!audioOnsets.length) return v;
    let lo = 0, hi = audioOnsets.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (audioOnsets[mid].t < v) lo = mid + 1; else hi = mid;
    }
    const atOrAfter = audioOnsets[lo];
    const below = lo > 0 ? audioOnsets[lo - 1] : null;
    const dAfter = Math.abs(atOrAfter.t - v);
    const dBelow = below ? Math.abs(below.t - v) : Infinity;
    const bestD = Math.min(dAfter, dBelow);
    if (bestD > tol) return v;
    if (below && dBelow < dAfter - (tieSlop || 0)) return below.t;
    return atOrAfter.t;
}

/**
 * The tight-window DTW for a section whose PLACE is already known: `audioStart`
 * is the chained place snapped to a real onset, so on-the-beat recordings the
 * window is the section's OWN map — exactly `[audioStart, audioStart +
 * slope·span + tailPad]`. `audioStart` is the detected onset of the region's
 * FIRST note, so the window's lower edge is that very onset: everything before
 * it belongs to the previous section and never enters. The tail pad covers the
 * model's drift over the section while staying well under a beat period, so the
 * next section's onsets — a beat beyond the section's own — stay out, and the
 * intercept belongs to the chain, never to a minimisation over period-shifted
 * windows (with on-the-beat clicks every period shift fits a straight line
 * equally well). Relies on the coarse window fallback when the section is too
 * sparse or the place could not be snapped. Returns the `_dtwAlignPure` result
 * or null.
 */
function _tightDTWPure(sourceTimes, audioOnsets, slope, audioStart, tailPad, opts) {
    if (!(slope > EPS) || !sourceTimes.length) return null;
    const src0 = sourceTimes[0], srcN = sourceTimes[sourceTimes.length - 1];
    const tLo = audioStart;
    const tHi = audioStart + slope * (srcN - src0) + tailPad;
    const tight = audioOnsets
        .filter((o) => o && Number.isFinite(o.t) && o.t >= tLo && o.t <= tHi)
        .map((o) => o.t);
    if (tight.length < opts.minOnsets) return null;
    const align = _dtwAlignPure(sourceTimes, tight);
    return _fitAffinePure(align.pairs, slope) ? { align, tight } : null;
}

/**
 * Align ONE region. Returns an independent proposal; a failure yields
 * `{ok:false, reason, confidence:0}` and never a merged or guessed value.
 *
 * `sourceTimes` are the region's chart onsets (seconds, time-sorted); `beats`
 * the grid; `audioOnsets` the whole onset strip ({t,s}, time-sorted); `prior` a
 * source→audio affine used only to locate the region's audio window; `audioStart`
 * the recording time of the region's first chart onset, carried over from the
 * region before it (the first region snaps it to the prior). The factor follows
 * the uniform convention `audioBpm / tabBpm`; `slope` is its reciprocal
 * (seconds-out / seconds-in).
 */
export function _alignSectionPure(params) {
    const opts = Object.assign({}, DEFAULTS, params.options || {});
    const { region, beats, audioOnsets, prior } = params;
    const span = region.end - region.start;
    if (!(span > EPS)) return _fail(region, 'empty-region');

    const sourceTimes = (Array.isArray(params.sourceTimes) ? params.sourceTimes : [])
        .filter((t) => Number.isFinite(t) && t >= region.start - 1e-6
            && (t < region.end - 1e-6 || (region.final && t <= region.end + 1e-6)));
    if (sourceTimes.length < opts.minEvents) return _fail(region, 'too-few-notes');

    const win = _priorWindow(prior, region, span, opts);
    const inWin = (Array.isArray(audioOnsets) ? audioOnsets : [])
        .filter((o) => o && Number.isFinite(o.t) && o.t >= win.lo && o.t <= win.hi);
    if (inWin.length < opts.minOnsets) return _fail(region, 'no-audio');

    const winTimes = inWin.map((o) => o.t);
    const tabBpm = _localBpmFromBeatsPure(beats, region.start, region.end, region.final);
    if (!(tabBpm > 0)) return _fail(region, 'no-grid-tempo');

    // The uniform estimator, run per section — its vote is the tempo estimate,
    // re-voted over the section's own onsets once the window is known.
    let vote = _detectTempoFromOnsetsPure(inWin);

    // Slope: prefer the onset-vote convention (factor = audioBpm/tabBpm); fall
    // back to the robust anchor slope when the section is too short to vote.
    let factor = 0, audioBpm = 0, slope = 0;
    if (vote && vote.bpm > 0) {
        audioBpm = vote.bpm;
        factor = audioBpm / tabBpm;
        slope = 1 / factor;
    }
    if (!(slope > EPS)) {
        const coarse = _dtwAlignPure(sourceTimes, winTimes);
        const cs = _slopeFromPairsPure(coarse.pairs);
        if (!(cs > EPS)) return _fail(region, 'no-tempo');
        slope = cs;
        factor = 1 / slope;
        audioBpm = factor * tabBpm;
    }

    // Place the map: the chain's audioStart (or the prior's, for the first
    // region) fixes the intercept; the DTW then runs on a tight window of the
    // section's OWN onsets so its correspondences are not the next section's.
    // The window's lower edge is `audioStart` itself — the detected onset the
    // chained place snapped to — so the previous section's onsets never enter;
    // the upper tail pad covers the model's drift over the section while
    // staying under a beat period so the next section's onsets stay out.
    const audioStart = Number.isFinite(params.audioStart)
        ? params.audioStart
        : ((prior && Number.isFinite(prior.slope)) ? prior.slope : 1)
                * (sourceTimes.length ? sourceTimes[0] : region.start)
            + ((prior && Number.isFinite(prior.intercept)) ? prior.intercept : 0);
    const tailPad = Math.max(0.1, opts.tightPad);
    let pass = _tightDTWPure(sourceTimes, audioOnsets, slope, audioStart, tailPad, opts);
    // Re-vote over the section's OWN onsets, not the coarse window: a neighbour
    // with unrelated content must not soften the section's own tempo estimate.
    if (pass && pass.tight.length >= opts.minOnsets) {
        const own = _detectTempoFromOnsetsPure(pass.tight.map((t) => ({ t })));
        if (own && own.bpm > 0) {
            vote = own;
            audioBpm = own.bpm;
            factor = audioBpm / tabBpm;
            slope = 1 / factor;
            pass = _tightDTWPure(sourceTimes, audioOnsets, slope, audioStart, tailPad, opts);
        }
    }
    let align = pass ? pass.align : null;
    if (!align && winTimes.length >= opts.minOnsets) {
        const coarse = _dtwAlignPure(sourceTimes, winTimes);
        if (coarse.pairs.length >= 2) align = coarse;   // place uncertain — anchors loosen
    }
    const fit = align ? _fitAffinePure(align.pairs, slope) : null;
    if (!fit) return _fail(region, 'no-affine-fit');

    // Drop correspondences the DTW mis-paired — a boundary onset from the next
    // section that jittered into the window — then refit on what remains, so a
    // handful of off-beat pairs cannot drag the intercept. A tiny region that
    // trims to nothing falls back to its raw pairs and reads a lower confidence
    // (and possibly 'low-confidence'): better to surface the data than blend a
    // guessed line.
    const kept = _trimPairsPure(align.pairs, slope, fit.intercept, opts.resTol);
    const keptFit = kept.length >= Math.max(2, opts.minEvents) ? _fitAffinePure(kept, slope) : null;
    const pairs = keptFit ? kept : align.pairs;
    const fit2 = keptFit || fit;
    const anchorSlope2 = _slopeFromPairsPure(pairs);

    // Confidence: how well the anchors support the vote, how concentrated the
    // onset vote was, and how much of the section the anchors cover. A diffuse
    // vote or a scattered anchor fit on an unrelated region collapses this.
    const voteConf = vote && Number.isFinite(vote.confidence) ? _clamp01(vote.confidence) : 0;
    const fitConf = _clamp01(1 - fit2.mad / opts.resTol);
    const tempoAgree = anchorSlope2 > EPS
        ? _clamp01(1 - Math.abs(anchorSlope2 - slope) / (slope * opts.tempoTol))
        : 0;
    const confidence = _round4(_clamp01(
        fitConf * (0.5 + 0.5 * voteConf) * (0.5 + 0.5 * tempoAgree) * (0.5 + 0.5 * fit2.n / sourceTimes.length)
    ));

    const anchors = fit2.n > 64
        ? pairs.filter((_, i) => i % Math.ceil(fit2.n / 64) === 0)
        : pairs;

    return {
        ok: true,
        index: region.index,
        name: region.name,
        number: region.number,
        start: region.start,
        end: region.end,
        reason: confidence >= opts.confidenceFloor ? null : 'low-confidence',
        confidence,
        factor: _round4(factor),
        slope,
        intercept: _round4(fit2.intercept),
        tabBpm: _round4(tabBpm),
        audioBpm: _round4(audioBpm),
        anchors: anchors.map(([source, audio]) => ({ source, audio })),
        rms: fit2.rms,
        coverage: align.coverage,
    };
}

/** A whole-song uniform prior (factor + phase), the same estimate the shipped
 *  dialog computes, used only to locate each region's audio window. */
export function _uniformPriorPure(beats, audioOnsets, domain) {
    const tabBpm = _localBpmFromBeatsPure(beats, domain.start, domain.end, true);
    const vote = _detectTempoFromOnsetsPure(audioOnsets);
    if (!(tabBpm > 0) || !vote || !(vote.bpm > 0)) {
        return { slope: 1, intercept: 0, factor: 1, tabBpm, audioBpm: 0, confidence: 0 };
    }
    const factor = vote.bpm / tabBpm;
    const slope = 1 / factor;
    return {
        slope,
        intercept: vote.phase - slope * domain.start,
        factor,
        tabBpm,
        audioBpm: vote.bpm,
        confidence: Number.isFinite(vote.confidence) ? vote.confidence : 0,
    };
}

/**
 * The engine entry point. Analyses every section of `source` (arrangements,
 * beats, drumTab) against `audioOnsets` and returns `{ok, domain, prior,
 * global, proposals}`. `prior` may be supplied (so a caller can hold the window
 * fixed while adding/removing sections); otherwise a uniform song-wide prior is
 * derived. Analysis only — nothing here writes chart timestamps.
 */
export function _alignSectionsPure(params) {
    const opts = Object.assign({}, DEFAULTS, params.options || {});
    const beats = params.beats || [];
    const domain = params.domain || _chartDomainPure(beats);
    if (!(domain.end - domain.start > EPS)) {
        return { ok: false, reason: 'degenerate-grid', domain, prior: null, global: null, proposals: [] };
    }
    const audioOnsets = (Array.isArray(params.audioOnsets) ? params.audioOnsets : [])
        .filter((o) => o && Number.isFinite(o.t))
        .sort((a, b) => a.t - b.t);
    const prior = params.prior || _uniformPriorPure(beats, audioOnsets, domain);
    const regions = _sectionRegionsPure(params.sections || [], domain);
    const allOnsets = params.sourceOnsets || _collectSourceOnsetsPure(params.source || {});
    const gridStep = _medianGridStepPure(allOnsets.length >= 2 ? allOnsets : beats.map((b) => b.time));

    // The one continuous piecewise-linear map: each region's place in the
    // recording is the previous region's map evaluated at their shared boundary.
    // A region that fails or reads low-confidence is NOT allowed to drag the
    // sections after it — its line is not carried, so the map stays the previous
    // accepted region's (already continuous at this boundary by construction).
    let carry = {
        slope: Number.isFinite(prior.slope) ? prior.slope : 1,
        xRef: domain.start,
        yRef: Number.isFinite(prior.intercept) ? prior.intercept : 0,
    };
    const proposals = [];
    for (const region of regions) {
        let sourceTimes = allOnsets.filter((t) => t >= region.start - 1e-6
            && (t < region.end - 1e-6 || (region.final && t <= region.end + 1e-6)));
        if (sourceTimes.length < opts.minEvents) {
            // Sparse region: fall back to the grid beats as the pulse.
            sourceTimes = beats
                .filter((b) => b && Number.isFinite(b.time) && b.time >= region.start - 1e-6
                    && (b.time < region.end - 1e-6 || (region.final && b.time <= region.end + 1e-6)))
                .map((b) => b.time);
            // Guard the boundary: the first beat of the next region is not ours.
            sourceTimes = sourceTimes.filter((t) => region.final || t < region.end - 1e-6);
        }

        // The chain's audio time for this region's FIRST chart onset, snapped to
        // the nearest real onset (within half a beat) so the place stays glued.
        // The first note is the DTW window's anchor, not the boundary — a section
        // whose notes start inside, past, or before its marker still lands on the
        // map that mark's own start implies.
        const x0 = sourceTimes.length ? sourceTimes[0] : region.start;
        const base = carry.slope * (x0 - carry.xRef) + carry.yRef;
        const tol = Math.max(0.05, (gridStep > EPS ? gridStep * carry.slope : 0.5) / 2);
        const audioStart = _nearestOnsetPure(audioOnsets, base, tol, 0.02);
        const prop = _alignSectionPure({ region, sourceTimes, beats, audioOnsets, prior, audioStart, options: opts });

        if (prop.ok && prop.confidence >= opts.confidenceFloor) {
            carry = { slope: prop.slope, xRef: region.start, yRef: prop.slope * region.start + prop.intercept };
        }
        proposals.push(prop);
    }

    return {
        ok: true,
        domain,
        prior,
        global: {
            factor: _round4(prior.factor || 1),
            intercept: _round4(prior.intercept || 0),
            slope: prior.slope,
            tabBpm: _round4(prior.tabBpm || 0),
            audioBpm: _round4(prior.audioBpm || 0),
            confidence: _round4(prior.confidence || 0),
        },
        confidenceFloor: opts.confidenceFloor,
        proposals,
    };
}

/**
 * Build a piecewise map W(t) from accepted proposals for the given domain.
 * For each section interval [start,end) that is accepted (confidence >= floor),
 * the affine map is slope*x + intercept. Skipped intervals map as identity W(t)=t.
 * Continuity is enforced per accepted RUN: a run abutting a skipped interval is
 * shifted so the shared seam maps to identity, while a run with no such seam
 * keeps its proposal exactly (a lone accepted section uses the uniform affine
 * map). A run pinned to identity at BOTH ends by skipped neighbours is a
 * conflict unless it is already identity — exposed in `conflicts` rather than
 * silently demoted.
 */
export function _buildPiecewiseMapPure(proposals, domain, confidenceFloor = 0.7) {
    if (!domain || !Number.isFinite(domain.start) || !Number.isFinite(domain.end)) {
        return { ok: false, reason: 'bad-domain' };
    }
    // Build intervals in order
    const intervals = [];
    const sorted = [...proposals].sort((a, b) => {
        if (a.start < b.start - EPS) return -1;
        if (a.start > b.start + EPS) return 1;
        return 0;
    });
    // First pass: determine acceptance
    const temp = [];
    for (let i = 0; i < sorted.length; i++) {
        const p = sorted[i];
        const accepted = p.ok && p.confidence >= confidenceFloor && Number.isFinite(p.slope) && Number.isFinite(p.intercept);
        temp.push({
            start: p.start,
            end: p.end,
            slope: accepted ? p.slope : 1,
            intercept: accepted ? p.intercept : 0,
            accepted,
        });
    }
    // Enforce continuity. A skipped interval imposes W(t)=t throughout, both
    // edges included, so an accepted RUN abutting one is pinned to identity at
    // that shared seam. Shifting the whole run by one constant preserves its
    // internal continuity. A run pinned at BOTH ends must be identity at both;
    // a slope != 1 run cannot be, which is a conflict we expose, never demote
    // silently. Being first or last in the list is NOT itself a pin — a lone
    // accepted section covering the whole chart keeps its uniform affine map.
    // Retained content bordering the domain is a pin, and so is a skipped
    // neighbour.
    const conflicts = [];
    let runStart = 0;
    while (runStart < temp.length) {
        if (!temp[runStart].accepted) { runStart++; continue; }
        let runEnd = runStart;
        while (runEnd + 1 < temp.length && temp[runEnd + 1].accepted) runEnd++;
        const first = temp[runStart];
        const last = temp[runEnd];
        const leftPinned = (runStart > 0 && !temp[runStart - 1].accepted)
            || first.start > domain.start + EPS;
        const rightPinned = (runEnd < temp.length - 1 && !temp[runEnd + 1].accepted)
            || last.end < domain.end - EPS;
        if (leftPinned || rightPinned) {
            const anchor = leftPinned ? first.start : last.end;
            const at = leftPinned
                ? first.slope * first.start + first.intercept
                : last.slope * last.end + last.intercept;
            for (let k = runStart; k <= runEnd; k++) temp[k].intercept += anchor - at;
            if (leftPinned && rightPinned) {
                const atRight = last.slope * last.end + last.intercept;
                if (Math.abs(atRight - last.end) > 1e-6) {
                    conflicts.push({ start: first.start, end: last.end, reason: 'identity-conflict' });
                    for (let k = runStart; k <= runEnd; k++) {
                        temp[k].accepted = false;
                        temp[k].slope = 1;
                        temp[k].intercept = 0;
                    }
                }
            }
        }
        runStart = runEnd + 1;
    }
    for (let i = 0; i < temp.length; i++) {
        intervals.push(temp[i]);
    }
    return {
        ok: true,
        domain,
        intervals,
        conflicts,
        map: (t) => {
            if (!Number.isFinite(t)) return t;
            // Find the interval containing t
            for (let j = 0; j < intervals.length; j++) {
                const iv = intervals[j];
                if (t < iv.start - 1e-9) continue;
                const isLast = j === intervals.length - 1;
                // For interior points, t < iv.end means in this interval
                if (t < iv.end - 1e-9) {
                    return iv.slope * t + iv.intercept;
                }
                // At boundary t >= iv.end-1e-9 and t <= iv.end+1e-9
                if (Math.abs(t - iv.end) < 1e-9) {
                    // Boundary goes to the next interval if it starts at this point, else current
                    if (!isLast && Math.abs(t - intervals[j+1].start) < 1e-9) {
                        continue; // let next interval handle it
                    }
                    return iv.slope * t + iv.intercept;
                }
                if (isLast && t <= domain.end + 1e-9) {
                    return iv.slope * t + iv.intercept;
                }
            }
            // If t is before first interval start, use first interval's map if it starts at domain start?
            if (intervals.length > 0 && t <= intervals[0].start + 1e-9) {
                return intervals[0].slope * t + intervals[0].intercept;
            }
            // If t is after all, use last
            if (intervals.length > 0) {
                const last = intervals[intervals.length - 1];
                return last.slope * t + last.intercept;
            }
            return t;
        },
    };
}
/* @pure:section-sync:end */
