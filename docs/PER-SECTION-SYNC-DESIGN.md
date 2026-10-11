# Per-section sync: time-map and persistence decisions

Status: design decision for #23 (parent #8), 2026-10-11. This document specifies
the contract for #24–#26; it does not implement or claim to ship per-section sync.

## Decision summary

| Question | Decision | Rejected alternative and reason |
|---|---|---|
| Beat grid | Fit the existing song-wide grid to the recording, preserving beat order, count, downbeat numbers and meter. Move its beat timestamps through the accepted map. | A second authored grid would make snapping, metronome and saved notes disagree about musical position. Inferring fresh beats from note density would change bar identities. |
| Data model | Bake seconds into existing chart fields and existing `song_timeline.json`. No new pack key, section tempo field, or persisted warp. | Per-section tempo metadata duplicates the existing tempo map and cannot by itself encode offsets or protect skipped intervals. |
| Boundaries | Use one continuous, strictly increasing piecewise-linear map. Shared anchors have one target time; skipped intervals and locked anchors are hard constraints. Reject incompatible proposals. | Independent affine sections can jump or reverse event order. Clamping collapses notes; snapping to a neighbouring analysis can move a skipped section; an invisible blend invents unreviewed timing. |
| Scope | Analysis is read-only; an explicit Apply creates one undoable, offline edit. Playback consumes the baked chart. | Live following changes committed timing according to playback conditions and is outside #8. |

## Evidence and format check

Checked against editor main commit
[`f823a422`](https://github.com/get-flashbacks/feedBack-plugin-editor/tree/f823a4224f331b17c21c2daab1275a4e76d85243)
and feedpak-spec commit
[`936960ca`](https://github.com/get-flashbacks/feedpak-spec/tree/936960caa4f362b99e099c489d135911cd768ff7).

- [Tempo mapping design](TEMPO-MAPPING-DESIGN.md) defines one authoritative
  musical ruler and fixed source audio. `src/beats.js` implements the shared
  `beatOf`/`timeOf` inverse pair.
- `src/sync-tempo.js:editorApplySync` presently scales a grid around a pivot by
  `1/factor`, where factor is audio BPM / tab BPM. The per-section engine must
  explicitly label its convention: the time-map slope is seconds-out /
  seconds-in, not the BPM ratio.
- `src/tempo.js:TempoMapCmd` lifts beats and reprojects every timed object,
  including exact pre-edit second snapshots for undo. Its current total
  reprojection rounds times; it must not be reused unchanged when #25 requires
  bit-for-bit preservation of skipped objects.
- `src/file-ops.js:_buildSaveBody` strips runtime beat caches before sending
  seconds. `routes.py:_build_song_timeline`, `_write_song_timeline_sidecar` and
  `_load_song_timeline` already write/read the shared grid and convert editor
  section `start_time` to wire `time`.
- feedpak-v1 §§6.8 and 7.4 already define `beats[{time,measure}]`,
  `sections[{name,number,time}]`, `tempos[{time,bpm}]` and
  `time_signatures[{time,ts}]`. A valid song timeline takes priority over
  arrangement-embedded beats/sections. Section tempo metadata is unnecessary.
- §6.10 permits per-arrangement tempo overrides, but not per-arrangement meter
  overrides. Such overrides must be reconciled or application refused, never
  silently left stale. The relevant existing schemas are
  [song timeline](https://github.com/get-flashbacks/feedpak-spec/blob/936960caa4f362b99e099c489d135911cd768ff7/schemas/song-timeline.schema.json),
  [arrangement](https://github.com/get-flashbacks/feedpak-spec/blob/936960caa4f362b99e099c489d135911cd768ff7/schemas/arrangement.schema.json)
  and [manifest](https://github.com/get-flashbacks/feedpak-spec/blob/936960caa4f362b99e099c489d135911cd768ff7/schemas/manifest.schema.json).

**Schema delta: none.** Keep song timeline `version: 1` and the existing manifest
`song_timeline` pointer. Analysis confidence, correspondences, selection and
proposed factors are transient session data. They are not authored pack fields.
Any later request to persist them requires a separately reviewed spec change
before implementation, even though schemas allow unknown extension fields.

## Analysis and application contract

Section boundaries come from an immutable snapshot of the canonical song
sections, not repeatedly from already-warped results. Use half-open intervals
`[start_i, start_(i+1))`; the final interval includes the final chart endpoint.
A leading region before the first marker is an explicit region, never silently
discarded. Derive the analysis domain from the chart's timed content and mapped
grid; refuse an undefined or degenerate domain rather than treating an unmapped
audio tail as a giant measure. Do not synthesize meter from section names.

#24 returns an independent proposal per region: original interval, source-to-
audio anchor correspondences in seconds, affine slope/intercept when available,
confidence and a reason for failure. Analysis neither edits the chart nor merges
a mismatched region's evidence into its neighbours. A single-section result
matches the uniform analysis convention. Confidence thresholds and evidence
quality belong to #24; a low-confidence region is not selected by default (#26).

#25 turns the selected proposals into a final map `W(t)`. For each accepted
anchor pair `(x_j,y_j)`, interpolate:

```text
W(t) = y_j + (t - x_j) * (y_(j+1) - y_j) / (x_(j+1) - x_j)
```

Both source and target anchors must be finite and strictly increasing. Duplicate
source anchors with different target times, nonpositive slopes, out-of-domain
results and conflicting locked anchors make a proposal inapplicable.
No automatic repair may hide these errors.

At an edge shared by two accepted sections, both use the same target anchor.
If their analysis proposes different targets, mark the edge as a conflict;
require a reviewed replacement anchor or skip the affected proposal. Do not
average silently. The effective map, including any user-approved adjustment,
is the one previewed and applied. Re-evaluate fit error/confidence after an
adjustment; the original confidence cannot vouch for a constrained fit.

Every skipped interval imposes `W(t)=t` throughout that interval, including
its two edges. Thus an accepted run next to it has a pinned identity endpoint.
It may fit inside that run using reviewed interior anchors, but cannot carry a
global offset through the skipped neighbour. If this makes the fit incompatible,
disable Apply for that run until the proposal or selection changes. This
deliberately sacrifices some automatic correction to preserve #25's skip
guarantee. A single accepted section covering the full chart, with no locks or
skipped neighbours, may use the exact uniform affine map. Existing locks take
precedence, as they do in uniform sync.

The finite map covers all affected chart objects and beat positions, including
span endpoints. Outside its domain retain identity; require continuity at an
edge bordering retained content. When the whole chart is selected, the domain
must include all timed chart content so no event depends on implicit
extrapolation. Audio samples, source offsets and stem placement are not warped.

## Grid and event rules

Apply the same reviewed `W` song-wide to the ruler and all arrangements/drum
parts in each selected region. The current editor has a shared ruler; a
chart-only fit with its own independent ruler is outside this decision.
The UI must name that scope before Apply.

Map every existing beat time, retaining its index, measure number and denominator.
Do not insert or remove beats as part of sync. Reconcile generated tempo events
from the resulting grid and retain authored meter/grouping. A breakpoint between
beats must also be represented in event reprojection: merely moving two beat
endpoints and using linear `timeOf` across a hidden breakpoint would give a
different map. #25 must reject such a fit or make the breakpoint an explicit,
reviewed grid-topology edit that preserves event seconds before relifting.
The initial topology-preserving implementation should require non-affine map
breakpoints on existing beats.

For selected point events, map the timestamp. For selected spans, map both
endpoints and derive sustain/duration from their difference; do not multiply
duration by the onset section's slope when the span crosses a boundary.
This includes notes, chord notes, anchors, handshapes, phrases and their
difficulty-level content, tones, all drum parts, and other supported timed chart
annotations. Preserve identifiers, fingering, techniques and tier membership.

Classify an object by its original onset. **An object starting in a skipped
section retains all its timing fields exactly**, even if its sustain ends in
a selected section. If keeping that endpoint prevents a consistent beat-primary
map, refuse the conflicting fit until the user revises it; never truncate or
silently rescale the skipped span. Selected spans may end in an identity region:
their endpoint uses identity there. Reject a zero/negative result. A section
marker exactly on a shared boundary maps once, using the shared anchor.

Keep skipped objects' seconds by copying their original fields, not by passing
them through a rounding helper or a nominal identity reprojection. Relift
runtime beat caches from the final ruler where necessary without changing those
seconds; rebuild derived caches after the one history commit. Preserve time locks
and reconcile authored tempo/ramp marks so they cannot later regenerate the old
map. Incompatible locked marks or unsupported timed payloads block Apply with
a reason rather than being silently dropped. Grid-aligned loops follow the new
ruler; free source-time loops retain seconds.

## Save, build and XML

| Path | Required representation and verification |
|---|---|
| Editor state / undo | One history command snapshots exact original grid, all affected timing fields and authored marks. Rollback restores them verbatim; redo reproduces the accepted map. Increment edit generation once. |
| Save / reload | Send baked seconds through the existing save body. Write authoritative song timeline beats/sections, derive tempos/signatures consistently, preserve unknown fields, and leave no stale arrangement-embedded grid that can win on reload. Runtime beats and analysis results are not serialized. |
| Build / reload | Use the same baked chart and timeline, never run the proposal again. All arrangements, difficulty tiers and primary/extra drum parts must agree with the saved version. |
| XML export / reload | Write baked note/chord times, sustains, ebeats, sections and supported annotation spans through the existing XML representation. Reimport reconstructs the same grid within its numeric precision; confidence and the original warp are not portable XML metadata. |

The existing timeline writer uses six decimal places for seconds; current chart
paths may use lower precision. #25 must specify and test each path's numeric
tolerance, preserve skipped values at the in-memory/save-payload boundary, and
avoid introducing additional quantization. If an existing save path rounds a
skipped object's original numeric value, #25 must fix that path or refuse the
apply; documenting a tolerance alone does not satisfy the skip guarantee. Bit-for-bit *file bytes* are not
promised by a serializer that rewrites JSON/XML; numeric equality is required
where the format/path supports it. Unsupported export fields must be identified
explicitly; do not claim a lossless full-pack XML conversion.

## Required acceptance fixtures for implementation

1. Two sections with different known time slopes: selected event/grid errors
   against truth improve over a global affine fit; report timestamp MAE in
   seconds independently for each section.
2. A mismatched/skipped middle section: all its onset/end/sustain values are
   deep-equal before/after Apply, neighbouring analysis is unchanged, and the
   final grid is strictly increasing.
3. Boundary conflict, a lock, duplicate targets, a crossing sustain and a
   breakpoint between beats: demonstrate the rejection/review path, not
   clamping or silent blending.
4. A single-section song: match uniform analysis and its applied affine map
   when unconstrained. Preserve the existing #22 meter-change do-no-harm tests.
5. Multi-arrangement, primary/extra drums, phrase tiers and span annotations:
   exec → exact rollback → redo, then save/reload and build/reload.
6. XML timestamp/grid round-trip with declared precision; no persisted warp or
   newly invented pack key. Already aligned input remains unchanged within the
   measured path tolerance.

#23 resolves these design choices only. #24 still owns the estimator and
confidence validation; #25 owns baking, serialization and the tests above;
#26 owns reviewed selection, scope/constraint feedback and low-confidence
defaults. Parent #8 remains open until those features ship.
