"""End-to-end verification of the mastery slider on editor-saved packs (#36).

The four sub-issues of #3 form one chain: the editor authors per-phrase tiers
(`src/tiers.js` — "Simplify phrase at cursor", or tiers loaded from a pack that
already carries them), the save path writes them to each phrase's on-disk
`levels[]` (`_repopulate_phrase_levels`, #33), and feedBack core's highway
consumes them — `static/highway.js` `_rebuildMasteryFilter` picks one level per
phrase from the master-difficulty slider and stages that level's notes, chords
and anchors for rendering (feedBack#48).

Core owns that filter, so this suite mirrors its semantics rather than
importing them: `phraseLevelTiers` / `phraseLevelIndexForMastery` /
`_rebuildMasteryFilter` from the core fork's `static/highway.js`, with the
upstream `got-feedback/feedback` highway picking levels positionally
(`floor(mastery * n)`) — the fork's tier-aware mapping is that same index for
every fully-authored ladder the editor can emit (difficulty 0..n-1 with
`max_difficulty = n-1`), and only diverges on sparse ladders
(`test_mirror_matches_core_s_documented_tier_mapping` locks the mapping).

The mirror is always driven over the *save path's real output*
(`_repopulate_phrase_levels`, never the editor's in-memory `tiers` shape) —
that output is exactly what lands in a saved `.feedpak`. So these tests pin the
end-to-end #3 contract:

* a pack with authored tiers visibly changes the rendered note set as the
  slider moves (acceptance 1);
* a pack without authored tiers keeps today's behavior — every slider position
  renders the same (correct) chart (acceptance 2).

Manual host-side check (what the tiered-pack tests automate): open an editor
pack, place the cursor in a phrase and press `Alt+P` ("Simplify phrase at
cursor") so the phrase gains an authored lower tier, save the pack, load it in
the host and drag the master-difficulty slider — the highway's note set must
shrink as the slider drops toward 0. An un-simplified phrase keeps the same
notes at every slider position.
"""
import math

from routes import _repopulate_phrase_levels


# ---- mirror of core's static/highway.js mastery consumer --------------------
#
# Ported 1:1 from the core fork's `static/highway.js` (`phraseLevelTiers`,
# `phraseLevelIndexForMastery`, `_rebuildMasteryFilter`). The mirror-lock test
# below pins the ported semantics against the contract core documents next to
# the function; nothing here can import the host's JS, so re-syncing when that
# file changes is a manual step — the function names above are the anchor.

def _is_nonneg_int(v):
    """`Number.isInteger` for JSON numbers: an integral int OR an integral
    float (a JSON `1.0` parses to a Python float but passes core's test)."""
    if isinstance(v, bool):
        return False
    if isinstance(v, int):
        return v >= 0
    if isinstance(v, float) and v.is_integer():
        return v >= 0
    return False


def _level_tiers(levels):
    """Mirror of `phraseLevelTiers` — the strictly-increasing `difficulty`
    ladder, or None when the numbers are missing, non-integral, negative or
    not strictly increasing (core then falls back to positional indexing)."""
    tiers = []
    for i, lv in enumerate(levels):
        d = lv.get("difficulty") if isinstance(lv, dict) else None
        if not _is_nonneg_int(d):
            return None
        d = int(d)
        if i > 0 and d <= tiers[i - 1]:
            return None
        tiers.append(d)
    return tiers


def _level_index_for_mastery(levels, max_difficulty, mastery):
    """Mirror of `phraseLevelIndexForMastery` — the single level a phrase
    plays at a slider fraction, per the mapping core documents next to the
    function (a full ladder maps as floor(mastery * n) always did)."""
    n = len(levels)
    if n <= 1:
        return 0
    tiers = _level_tiers(levels)
    if tiers is None:
        return min(n - 1, math.floor(mastery * n))
    scale = max(tiers[-1], int(max_difficulty) if _is_nonneg_int(max_difficulty) else 0)
    tier = min(scale, math.floor(mastery * (scale + 1)))
    idx = 0
    while idx + 1 < n and tiers[idx + 1] <= tier:
        idx += 1
    return idx


def _visible_at(mastery, phrases, flat_notes=(), flat_chords=(), flat_anchors=(),
                flat_handshapes=()):
    """Mirror of `_rebuildMasteryFilter` (no practice override) — the note /
    chord / anchor set the highway draws at a slider fraction.

    A chart with *no* phrases at all nulls the filtered arrays and the draw
    loops fall through to the flat lists; the mirror returns those with
    `"fallback": True`. With phrases present, each phrase contributes its
    chosen level's content (a phrase with no levels contributes nothing), and
    handshapes only come from the chosen levels when some of them authored
    one — otherwise the draw falls back to the flat handshape list, exactly
    core's `b.handShapes` gate.
    """
    if not phrases:
        return {"notes": list(flat_notes), "chords": list(flat_chords),
                "anchors": list(flat_anchors), "handshapes": list(flat_handshapes),
                "fallback": True}
    out = {"notes": [], "chords": [], "anchors": [], "handshapes": []}
    authored_handshapes = False
    for p in phrases:
        levels = p.get("levels") or []
        if not levels:
            continue
        lv = levels[_level_index_for_mastery(levels, p.get("max_difficulty"),
                                             mastery)]
        out["notes"] += lv.get("notes") or []
        out["chords"] += lv.get("chords") or []
        out["anchors"] += lv.get("anchors") or []
        hs = lv.get("handshapes") or []
        if hs:
            authored_handshapes = True
            out["handshapes"] += hs
    if not authored_handshapes:
        out["handshapes"] = list(flat_handshapes)
    return out


# ---- mirror lock ------------------------------------------------------------

def test_mirror_matches_core_s_documented_tier_mapping():
    """Core's own doc comment above `phraseLevelIndexForMastery` spells the
contract; this locks the mirror to it so the end-to-end assertions below
rest on the real consumer semantics, not a made-up mapping."""
    full_ladder = [
        {"difficulty": 0}, {"difficulty": 1}, {"difficulty": 2},
        {"difficulty": 3},
    ]
    # A fully authored ladder (difficulty 0..n-1, max_difficulty n-1) maps as
    # floor(mastery * n) always did — the fork's tier-aware mapping is the
    # old positional index for _every_ mastered ladder the editor emits.
    for mastery, want in [(0.0, 0), (0.125, 0), (0.5, 2), (0.75, 3), (1.0, 3)]:
        assert _level_index_for_mastery(full_ladder, 3, mastery) == want, mastery
    for n in range(1, 6):
        ladder = [{"difficulty": d} for d in range(n)]
        for q in (0.0, 0.25, 0.5, 0.75, 1.0):
            want = min(n - 1, int(q * n))
            assert _level_index_for_mastery(ladder, n - 1, q) == want, (n, q)

    # A sparse ladder (duplicate tiers collapsed: content at 0, 1 and 3) keeps
    # each remaining level covering the slider band it was authored for instead
    # of stretching it over the whole slider.
    sparse = [{"difficulty": 0}, {"difficulty": 1}, {"difficulty": 3}]
    for mastery, want in [(0.0, 0), (0.3, 1), (0.5, 1), (0.6, 1), (0.99, 2)]:
        assert _level_index_for_mastery(sparse, 3, mastery) == want, mastery

    # Non-monotonic / missing `difficulty` falls back to positional indexing.
    malformed = [{"difficulty": 0}, {"difficulty": 0}, {"difficulty": 2}]
    assert _level_index_for_mastery(malformed, 3, 0.5) == 1
    assert _level_index_for_mastery(malformed, 3, 1.0) == 2

    # A single level always plays regardless of the slider.
    assert _level_index_for_mastery([{"difficulty": 7}], 7, 0.0) == 0
    assert _level_index_for_mastery([{"difficulty": 7}], 7, 1.0) == 0

    # Without `max_difficulty` (a fresh editor phrase ships none) the scale
    # is the phrase's own top tier.
    assert _level_index_for_mastery(full_ladder[:2], None, 0.0) == 0
    assert _level_index_for_mastery(full_ladder[:2], None, 1.0) == 1

    # A ladder whose top tier sits below `max_difficulty` (a loaded pack can
    # carry a larger scale than its authored content tops out at) is where the
    # tier-aware mapping intentionally leaves the old positional index: the
    # scale grows with `max_difficulty`, so a low slider fraction reaches the
    # highest authored tier sooner than floor(mastery * n) would.
    short = [{"difficulty": 0}, {"difficulty": 1}]
    assert _level_index_for_mastery(short, 4, 0.25) == 1   # tier-aware
    assert min(1, math.floor(0.25 * 2)) == 0               # old positional


# ---- fixtures ----------------------------------------------------------------

def _tier(difficulty, *, notes=(), chords=(), anchors=(), handshapes=()):
    return {
        "difficulty": difficulty,
        "notes": list(notes),
        "chords": list(chords),
        "anchors": list(anchors),
        "handshapes": list(handshapes),
    }


def _editor_note(time, string=0, fret=0, sustain=0.0, **tech):
    """Editor-shape note (long keys) — the shape tiers ride in `tiers[]`."""
    return {"time": time, "string": string, "fret": fret, "sustain": sustain,
            "techniques": tech}


def _full_chart():
    """The arrangement's flat chart: a 6-note run plus a chord and an anchor
    in phrase A's window, and one note in phrase B's."""
    notes = [
        {"t": 0.1, "s": 0, "f": 3},
        {"t": 0.2, "s": 1, "f": 5},
        {"t": 0.3, "s": 2, "f": 7},
        {"t": 0.4, "s": 3, "f": 9},
        {"t": 0.6, "s": 0, "f": 4},
        {"t": 0.9, "s": 1, "f": 6},
        {"t": 6.0, "s": 2, "f": 8},
    ]
    chords = [{"t": 0.5, "id": 0, "hd": False, "notes": []}]
    anchors = [{"time": 0.2, "fret": 5, "width": 4}]
    return notes, chords, anchors


# ---- acceptance 1: a tiered pack changes the rendered note set --------------

def test_authored_tier_changes_the_rendered_note_set():
    """Authoring an easy tier in one phrase and saving must make the mirrored
    highway render a smaller note set at low mastery than at full — the
    slider finally does something concrete on an editor-saved pack."""
    notes, chords, anchors = _full_chart()
    easy = [
        _editor_note(0.2, string=1, fret=5),   # the landing note of the run
        _editor_note(0.6, string=0, fret=4),
    ]
    phrases = [
        {   # the tiered phrase — authored via the frontend's fresh shape
            # (client keys, no `max_difficulty`); the top tier is a stub whose
            # shipped content is ignored in favor of the flat window slice.
            "name": "verse", "number": 1, "start_time": 0.0,
            "tiers": [
                _tier(0, notes=easy, anchors=[{"time": 0.2, "fret": 3, "width": 4}]),
                _tier(4, handshapes=[{"chord_id": 0, "start_time": 0.2,
                                       "end_time": 1.0}]),
            ],
        },
        {   # a bass phrase the editor never tiered — 2/4 and 3/4 below the
            # slider story, still flat like every pre-#3 pack.
            "start_time": 5.0, "end_time": 10.0, "max_difficulty": 4,
            "levels": [{"difficulty": 0}, {"difficulty": 4}],
        },
    ]
    saved = _repopulate_phrase_levels(phrases, notes, chords, anchors)
    assert [lv["difficulty"] for lv in saved[0]["levels"]] == [0, 4]
    assert [lv["difficulty"] for lv in saved[1]["levels"]] == [0, 4]

    low = _visible_at(0.0, saved)
    high = _visible_at(1.0, saved)
    # The slider visibly changes what is shown: low mastery drops to the two
    # authored easy notes (plus the untouched bass note), full mastery shows
    # the whole chart.
    assert [n["t"] for n in low["notes"]] == [0.2, 0.6, 6.0]
    assert [n["t"] for n in high["notes"]] == \
        [0.1, 0.2, 0.3, 0.4, 0.6, 0.9, 6.0]
    assert low["notes"] != high["notes"]
    assert len(low["notes"]) < len(high["notes"])
    # Chords and anchors pair with their level too (core filters them with the
    # notes): the chord at 0.5 and the chart anchor are top-tier content,
    # absent from the authored easy tier.
    assert low["chords"] == []
    assert low["anchors"] == [{"time": 0.2, "fret": 3, "width": 4}]
    assert high["chords"] == chords
    assert [a["time"] for a in high["anchors"]] == [0.2]
    # The untiered phrase contributes identically at both extremes.
    assert [n["t"] for n in low["notes"][2:]] == [6.0]
    assert [n["t"] for n in high["notes"][6:]] == [6.0]

    # The slider's mid stop lands between: the composed 6-note run only has
    # scenery at difficulty 1..3, so a 50% mastery reads as the easy tier.
    mid = _visible_at(0.5, saved)
    assert [n["t"] for n in mid["notes"]] == [0.2, 0.6, 6.0]


def test_cascade_ladder_keeps_every_derived_rung_distinct():
    """Repeated Simplifies on a phrase whose top tier sits at difficulty 3
    derive 2, then 1, then 0 — the cascade ladder below. Every authored rung
    must surface as its own, distinct note set, not collapse into the flat top
    tier. (On a fresh phrase the first `Alt+P` mints difficulty 0, after which
    `planTierSimplification` refuses any further presses — the two-rung case
    is still covered by `test_authored_tier_changes_the_rendered_note_set`.)"""
    notes, chords, anchors = _full_chart()
    phrases = [{
        "name": "chorus", "number": 2, "start_time": 0.0,
        "tiers": [
            _tier(0, notes=[_editor_note(0.2, string=1, fret=5)]),
            _tier(1, notes=[_editor_note(0.2, string=1, fret=5),
                            _editor_note(0.3, string=2, fret=7)]),
            _tier(2, notes=[_editor_note(0.2, string=1, fret=5),
                            _editor_note(0.3, string=2, fret=7),
                            _editor_note(0.4, string=3, fret=9)]),
            _tier(3),  # top-tier stub — takes the flat window slice
        ],
    }]
    saved = _repopulate_phrase_levels(phrases, notes, chords, anchors)
    assert [lv["difficulty"] for lv in saved[0]["levels"]] == [0, 1, 2, 3]
    rung0 = _visible_at(0.0, saved)["notes"]
    rung1 = _visible_at(0.25, saved)["notes"]
    rung2 = _visible_at(0.5, saved)["notes"]
    full = _visible_at(1.0, saved)["notes"]
    assert len(rung0) < len(rung1) < len(rung2) < len(full)
    # Highest rung is the whole chart (the 0.1..0.9 run + the 6.0 bass note;
    # the chord at 0.5 is chord data, not a note).
    assert [n["t"] for n in full] == [0.1, 0.2, 0.3, 0.4, 0.6, 0.9, 6.0]


# ---- acceptance 2: an untiered pack behaves as today -------------------------

def test_untiered_pack_shows_the_same_notes_at_every_slider_position():
    """A pack without authored tiers keeps today's behavior exactly: every
    level carries the same flat slice, so the slider still renders the same
    (correct) chart at every position — and the highway's flat fall-through
    (a song with no phrase data at all) is unchanged too."""
    notes, chords, anchors = _full_chart()
    phrases = [{
        "start_time": 0.0, "end_time": 10.0, "max_difficulty": 3,
        "levels": [{"difficulty": d} for d in range(4)],
    }]
    saved = _repopulate_phrase_levels(phrases, notes, chords, anchors)
    rows = [_visible_at(m, saved) for m in (0.0, 0.25, 0.5, 0.75, 1.0)]
    distinct = {tuple(tuple(sorted(n.items())) for n in r["notes"]) for r in rows}
    assert len(distinct) == 1, "slider must not change"
    assert rows[0]["notes"] == notes
    assert rows[0]["chords"] == chords and rows[0]["anchors"] == anchors

    # No phrase data at all: core nulls the filtered arrays and the draw loops
    # fall through to the flat chart.
    flat = _visible_at(0.0, [], notes, chords, anchors)
    assert flat["fallback"] and flat["notes"] == notes
    assert flat["chords"] == chords and flat["anchors"] == anchors


def test_fresh_phrase_with_empty_levels_contributes_nothing():
    """The actual add-a-phrase flow saves an empty ladder:
    `_editorAddPhraseAtCursor` creates `tiers: []` (src/input.js), which the
    save path writes as `levels: []`. Core's filter skips such a phrase
    (`n === 0` → continue), so a pack that gained an un-simplified phrase
    still renders the remaining phrases unchanged at every slider position —
    the pre-#3 behavior, not a regression."""
    notes, chords, anchors = _full_chart()
    phrases = [
        {   # freshly added phrase — `tiers` empty, so `levels` save empty
            "name": "phrase", "number": 1, "start_time": 0.0, "tiers": [],
        },
        {   # the pre-existing untiered phrase, untouched
            "name": "bass", "number": 2, "start_time": 5.0, "end_time": 10.0,
            "max_difficulty": 3,
            "levels": [{"difficulty": d} for d in range(4)],
        },
    ]
    saved = _repopulate_phrase_levels(phrases, notes, chords, anchors)
    assert saved[0]["levels"] == []
    rows = [_visible_at(m, saved) for m in (0.0, 0.25, 0.5, 0.75, 1.0)]
    same = {tuple(tuple(sorted(n.items())) for n in r["notes"]) for r in rows}
    assert len(same) == 1, "slider must not change"
    assert [n["t"] for n in rows[0]["notes"]] == [6.0]