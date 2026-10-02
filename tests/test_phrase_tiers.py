"""Tests for per-phrase difficulty tiers (issue #33, storage foundation).

The editor holds a phrase's per-difficulty content in `phrases[].tiers[]` (the
editor's note/chord shape) and the save path (`_repopulate_phrase_levels`)
writes it back to the existing on-disk `phrases[].levels[]`. No new pack field
is introduced — `levels[]` is already `feedpak-spec`'s per-phrase tier array, so
a pack that already carries distinct tiers round-trips unchanged instead of
having every level overwritten with one flat chart slice.

Covers:
* `_phrase_with_tiers` — the load shape (wire `levels` replaced by editor
  `tiers`, other phrase fields preserved)
* `_authored_phrase_levels` via `_repopulate_phrase_levels` — authored lower
  tiers survive verbatim, the top tier re-slices from the flat chart, `tiers`
  never reaches the wire, malformed tiers fall back to the flat path
* the load → save round trip of an untiered-for-edit pack
"""
import copy

from routes import (
    _NOTE_TECH_FIELDS,
    _editor_chord_to_wire,
    _editor_note_to_wire,
    _note_tech_default,
    _phrase_with_tiers,
    _repopulate_phrase_levels,
)


# The technique dict a note carrying only the picked techniques comes back with:
# every field at its typed absent default, plus `bend_values`. Shared by the
# shape assertions below so they spell out the whole editor note shape.
_TECH_DEFAULTS = {f: _note_tech_default(f) for f in _NOTE_TECH_FIELDS}
_TECH_DEFAULTS["bend_values"] = None


# ---- fakes for core's parsed dataclasses ------------------------------------
#
# `lib.song` isn't importable outside the host app, so these stand in for the
# parsed side of the load path (`Phrase` / `PhraseLevel` / `Note` / `Chord` /
# `Anchor` / `HandShape`) with the attributes `_phrase_with_tiers` reads.
# `_note_tech_dict` fills absent technique attrs from its per-field defaults, so
# a note carrying only the picked techniques is enough.

class FakeNote:
    def __init__(self, time, string=0, fret=0, sustain=0.0, **tech):
        self.time = time
        self.string = string
        self.fret = fret
        self.sustain = sustain
        for k, v in tech.items():
            setattr(self, k, v)


class FakeChord:
    def __init__(self, time, chord_id=0, high_density=False, fn=None, notes=()):
        self.time = time
        self.chord_id = chord_id
        self.high_density = high_density
        self.fn = fn
        self.notes = list(notes)


class FakeAnchor:
    def __init__(self, time, fret=1, width=4):
        self.time = time
        self.fret = fret
        self.width = width


class FakeHandShape:
    def __init__(self, chord_id=0, start_time=0.0, end_time=1.0, arpeggio=False):
        self.chord_id = chord_id
        self.start_time = start_time
        self.end_time = end_time
        self.arpeggio = arpeggio


class FakePhraseLevel:
    def __init__(self, difficulty, notes=(), chords=(), anchors=(), hand_shapes=()):
        self.difficulty = difficulty
        self.notes = list(notes)
        self.chords = list(chords)
        self.anchors = list(anchors)
        self.hand_shapes = list(hand_shapes)


def _wire_phrase(start, end, max_diff, levels):
    """What core's `phrase_to_wire` emits — the dict `_phrase_with_tiers`
    receives as `phrase_wire`."""
    return {
        "start_time": start,
        "end_time": end,
        "max_difficulty": max_diff,
        "levels": levels,
    }


# ---- _phrase_with_tiers (load shape) ---------------------------------------

def test_phrase_with_tiers_replaces_wire_levels_with_editor_tiers():
    wire = _wire_phrase(0.0, 5.0, 3, [{"difficulty": 3, "notes": [{"t": 1.0}]}])
    levels = [FakePhraseLevel(3, notes=[FakeNote(1.0, string=2, fret=7, sustain=0.25,
                                               slide_to=5, bend=0.5)])]
    out = _phrase_with_tiers(wire, levels)
    assert "levels" not in out, "the wire mirror must not ride the editor model"
    assert [t["difficulty"] for t in out["tiers"]] == [3]
    tier = out["tiers"][0]
    # Editor shape, not the wire's short keys.
    assert tier["notes"] == [{
        "time": 1.0, "string": 2, "fret": 7, "sustain": 0.25,
        "techniques": {**_TECH_DEFAULTS, "slide_to": 5, "bend": 0.5},
    }]
    assert tier["chords"] == [] and tier["anchors"] == [] and tier["handshapes"] == []


def test_phrase_with_tiers_preserves_phrase_metadata():
    wire = _wire_phrase(4.0, 9.0, 7, [])
    out = _phrase_with_tiers(wire, [])
    assert out == {"start_time": 4.0, "end_time": 9.0, "max_difficulty": 7, "tiers": []}


def test_phrase_with_tiers_carries_chords_anchors_and_handshapes():
    levels = [FakePhraseLevel(
        2,
        chords=[FakeChord(1.5, chord_id=1, high_density=True,
                          notes=[FakeNote(1.5, string=1, fret=3)])],
        anchors=[FakeAnchor(0.5, fret=5, width=4)],
        hand_shapes=[FakeHandShape(chord_id=1, start_time=1.5, end_time=2.0,
                                   arpeggio=True)],
    )]
    tier = _phrase_with_tiers(_wire_phrase(0.0, 5.0, 2, []), levels)["tiers"][0]
    assert tier["chords"] == [{
        "time": 1.5, "chord_id": 1, "high_density": True, "fn": None,
        "notes": [{"time": 1.5, "string": 1, "fret": 3, "sustain": 0.0,
                   "techniques": {"bend_values": None, **_TECH_DEFAULTS}}],
    }]
    assert tier["anchors"] == [{"time": 0.5, "fret": 5, "width": 4}]
    assert tier["handshapes"] == [
        {"chord_id": 1, "start_time": 1.5, "end_time": 2.0, "arp": True},
    ]


def test_phrase_with_tiers_tolerates_missing_level_attrs():
    """A level from an older core (no `anchors` / `hand_shapes` attr) must not
    crash the load — the tiers come back with empty lists for the absent parts."""
    class Bare:
        difficulty = 0
        notes = [FakeNote(0.5)]
    tier = _phrase_with_tiers(_wire_phrase(0.0, 1.0, 0, []), [Bare()])["tiers"][0]
    assert tier["notes"][0]["time"] == 0.5
    assert tier["chords"] == [] and tier["anchors"] == [] and tier["handshapes"] == []


# ---- save: _repopulate_phrase_levels with tiers ------------------------------

def _tier(difficulty, *, notes=(), chords=(), anchors=(), handshapes=()):
    return {
        "difficulty": difficulty,
        "notes": list(notes),
        "chords": list(chords),
        "anchors": list(anchors),
        "handshapes": list(handshapes),
    }


def _editor_note(time, string=0, fret=0, sustain=0.0, **tech):
    return {"time": time, "string": string, "fret": fret, "sustain": sustain,
            "techniques": tech}


def test_every_technique_field_reaches_the_wire():
    """Mechanical guard on `_editor_note_to_wire`, the converter shared by flat
    and tier notes. Every name in `_NOTE_TECH_FIELDS` must change the emitted
    note when it is set: a mistyped key (`slide_unpick_to` for
    `slide_unpitch_to`) makes the field read as absent and silently resets the
    authored value on EVERY save, which no single-technique test catches.
    """
    blank = {"time": 1.0, "string": 0, "fret": 0, "sustain": 0.0,
             "techniques": {}}
    baseline = _editor_note_to_wire(blank)
    for field in _NOTE_TECH_FIELDS:
        default = _note_tech_default(field)
        if isinstance(default, bool):
            probe = not default
        elif isinstance(default, int):
            probe = default + 3
        elif field == "hand":
            probe = "lh"
        else:  # bend: None, or a float default
            probe = 0.75
        assert _editor_note_to_wire(dict(blank, techniques={field: probe})) \
            != baseline, f"{field} never reaches the wire"


def test_authored_lower_tier_survives_while_top_tier_rides_the_chart():
    """The tier story this whole path exists for: an authored easy tier keeps
    its own content, and the top tier follows the flat chart edits."""
    easy = _editor_note(0.5, string=0, fret=0)
    phrases = [{
        "start_time": 0.0, "end_time": 5.0, "max_difficulty": 10,
        "tiers": [_tier(3, notes=[easy]), _tier(10)],
    }]
    flat = [{"t": 2.0, "s": 3, "f": 7, "sus": 0.5}]
    out = _repopulate_phrase_levels(phrases, flat, [], [])
    levels = out[0]["levels"]
    assert [lv["difficulty"] for lv in levels] == [3, 10]
    # The authored tier is written as wire notes (short keys), not the editor's.
    assert levels[0]["notes"][0]["t"] == 0.5
    assert levels[0]["notes"][0]["s"] == 0 and levels[0]["notes"][0]["f"] == 0
    # The top tier is the chart, so the edited note reaches it.
    assert levels[1]["notes"] == flat


def test_authored_tier_notes_go_through_the_flat_wire_conversion():
    """A tier note must be validated exactly like a chart note — same short
    keys, same technique mapping, same rounding."""
    phrases = [{
        "start_time": 0.0, "end_time": 5.0, "max_difficulty": 2,
        "tiers": [_tier(1, notes=[_editor_note(1.23456, string=2, fret=7,
                                                sustain=0.5, bend=0.5,
                                                slide_to=9, fret_finger=2)]),
                  _tier(2)],
    }]
    out = _repopulate_phrase_levels(phrases, [], [], [])
    note = out[0]["levels"][0]["notes"][0]
    assert note["t"] == 1.235 and note["s"] == 2 and note["f"] == 7
    assert note["sus"] == 0.5 and note["bn"] == 0.5 and note["sl"] == 9
    assert note["fg"] == 2
    assert note["ho"] is False and note["ig"] is False


def test_a_lone_tier_is_the_top_tier_so_the_chart_wins():
    """Documented consequence of "the top tier IS the chart": a phrase with a
    single tier has no authored tier to preserve, so its notes come from the
    flat chart like any untiered phrase. Adding a tier ladder is what makes a
    lower tier survive."""
    phrases = [{
        "start_time": 0.0, "end_time": 5.0, "max_difficulty": 1,
        "tiers": [_tier(1, notes=[_editor_note(99.0)])],
    }]
    out = _repopulate_phrase_levels(phrases, [{"t": 1.0}], [], [])
    assert [n["t"] for n in out[0]["levels"][0]["notes"]] == [1.0]


def test_authored_tier_chords_anchors_and_handshapes_survive():
    phrases = [{
        "start_time": 0.0, "end_time": 5.0, "max_difficulty": 1,
        "tiers": [_tier(
            0,
            chords=[{"time": 1.0, "chord_id": 1, "high_density": True,
                     "notes": [_editor_note(1.0, string=1, fret=2)]}],
            anchors=[{"time": 0.5, "fret": 5, "width": 4}],
            handshapes=[{"chord_id": 1, "start_time": 1.0, "end_time": 2.0,
                         "arp": True}],
        ), _tier(1)],
    }]
    out = _repopulate_phrase_levels(phrases, [], [], [])
    lv = out[0]["levels"][0]
    assert lv["chords"][0]["t"] == 1.0 and lv["chords"][0]["id"] == 1
    assert lv["chords"][0]["hd"] is True
    assert lv["chords"][0]["notes"][0]["s"] == 1
    assert "t" not in lv["chords"][0]["notes"][0], "chord note carries no time"
    assert lv["anchors"] == [{"time": 0.5, "fret": 5, "width": 4}]
    assert lv["handshapes"] == [
        {"chord_id": 1, "start_time": 1.0, "end_time": 2.0, "arp": True},
    ]


def test_authored_tiers_are_sorted_by_difficulty():
    phrases = [{
        "start_time": 0.0, "end_time": 5.0, "max_difficulty": 9,
        "tiers": [_tier(9), _tier(1), _tier(5)],
    }]
    out = _repopulate_phrase_levels(phrases, [], [], [])
    assert [lv["difficulty"] for lv in out[0]["levels"]] == [1, 5, 9]


def test_tiers_never_reach_the_wire():
    """`tiers` is the editor's working copy — only `levels[]` is a pack field,
    so the save must not emit both."""
    phrases = [{"start_time": 0.0, "end_time": 5.0, "max_difficulty": 1,
                "tiers": [_tier(0), _tier(1)]}]
    out = _repopulate_phrase_levels(phrases, [], [], [])
    assert "tiers" not in out[0]
    assert set(out[0]) == {"start_time", "end_time", "max_difficulty", "levels"}


def test_top_tier_takes_the_flat_window_slice_not_its_own_notes():
    """A stale top-tier note must not survive: the top tier IS the chart."""
    phrases = [{
        "start_time": 0.0, "end_time": 5.0, "max_difficulty": 9,
        "tiers": [_tier(0, notes=[_editor_note(0.5)]),
                  _tier(9, notes=[_editor_note(99.0)])],
    }]
    out = _repopulate_phrase_levels(phrases, [{"t": 1.0}], [], [])
    assert [n["t"] for n in out[0]["levels"][1]["notes"]] == [1.0]


def test_phrase_metadata_preserved_with_tiers():
    phrases = [{"start_time": 2.0, "end_time": 8.0, "max_difficulty": 7,
                "tiers": [_tier(7)]}]
    p = _repopulate_phrase_levels(phrases, [], [], [])[0]
    assert p["start_time"] == 2.0 and p["end_time"] == 8.0
    assert p["max_difficulty"] == 7


def test_tier_handshapes_bound_and_coerced():
    """Per-tier handshapes ride the save through the arrangement's own
    validation, so a malformed one can't reach the wire as junk."""
    phrases = [{
        "start_time": 0.0, "end_time": 5.0, "max_difficulty": 1,
        "tiers": [_tier(0, handshapes=[
            # wire-style `"false"` must coerce to False, not string-truthy True
            {"chord_id": 0, "start_time": 1.0, "end_time": 2.0, "arp": "false"},
            {"chord_id": -1, "start_time": 1.0, "end_time": 2.0},   # no chord
            {"chord_id": 1, "start_time": 3.0, "end_time": 2.0},    # inverted
            "junk",
        ]), _tier(1)],
    }]
    out = _repopulate_phrase_levels(phrases, [], [], [])
    hs = out[0]["levels"][0]["handshapes"]
    assert hs == [{"chord_id": 0, "start_time": 1.0, "end_time": 2.0,
                   "arp": False}]


def test_tier_handshapes_honor_the_template_count():
    """A per-tier handshape pointing past the arrangement's chord templates
    drops, the same bound `_arr_dict_to_wire` applies to arrangement-level
    ones — otherwise a tier can persist an index core can't resolve."""
    hs = [{"chord_id": cid, "start_time": 1.0, "end_time": 2.0}
          for cid in (0, 1, 2)]
    phrases = [{
        "start_time": 0.0, "end_time": 5.0, "max_difficulty": 1,
        "tiers": [_tier(0, handshapes=hs), _tier(1)],
    }]
    out = _repopulate_phrase_levels(phrases, [], [], [], n_chord_templates=2)
    assert [h["chord_id"] for h in out[0]["levels"][0]["handshapes"]] == [0, 1]
    # No count (a caller that doesn't know it) leaves them alone.
    out = _repopulate_phrase_levels(phrases, [], [], [])
    assert len(out[0]["levels"][0]["handshapes"]) == 3


def test_tier_member_that_cannot_be_converted_is_dropped_not_raised():
    """A member can be a dict and still make the wire converter raise
    (`time: "abc"`, `techniques: 5`, a chord whose `notes` is null). `tiers`
    comes straight off the client's save payload, so one bad authored note must
    cost itself, not the whole save."""
    phrases = [{
        "start_time": 0.0, "end_time": 5.0, "max_difficulty": 1,
        "tiers": [_tier(0, notes=[
            _editor_note(1.0),
            dict(_editor_note(2.0), time="abc"),
            dict(_editor_note(3.0), techniques=5),
        ], chords=[
            {"time": 1.0, "chord_id": 0, "notes": None},
        ]), _tier(1)],
    }]
    out = _repopulate_phrase_levels(phrases, [], [], [])
    assert [n["t"] for n in out[0]["levels"][0]["notes"]] == [1.0]
    assert out[0]["levels"][0]["chords"] == []


def test_unknown_keys_on_the_incoming_level_survive_the_tiered_save():
    """The authored path copies the level it replaces and overwrites the five
    keys it owns, exactly like `_flat_phrase_levels` — so a key core adds to
    `levels[]` later can't be silently dropped by the editor's save."""
    phrases = [{
        "start_time": 0.0, "end_time": 5.0, "max_difficulty": 1,
        "levels": [{"difficulty": 0, "future_key": {"a": 1}}],
        "tiers": [_tier(0, notes=[_editor_note(0.5)]), _tier(1)],
    }]
    out = _repopulate_phrase_levels(phrases, [{"t": 1.0}], [], [])
    assert out[0]["levels"][0]["future_key"] == {"a": 1}
    assert [n["t"] for n in out[0]["levels"][0]["notes"]] == [0.5]


def test_a_repeated_tier_difficulty_keeps_the_first_tier():
    """Core keys levels by difficulty so a pack can't contain a repeat, but
    `tiers` is client data. First-wins is deterministic and keeps the ladder;
    dropping the ladder would cost every difficulty on the phrase."""
    phrases = [{
        "start_time": 0.0, "end_time": 5.0, "max_difficulty": 1,
        "tiers": [_tier(0, notes=[_editor_note(0.5)]),
                  _tier(0, notes=[_editor_note(0.25)]),
                  _tier(1)],
    }]
    out = _repopulate_phrase_levels(phrases, [], [], [])
    assert [lv["difficulty"] for lv in out[0]["levels"]] == [0, 1]
    assert [n["t"] for n in out[0]["levels"][0]["notes"]] == [0.5]


def test_malformed_tiers_fall_back_to_the_flat_path():
    """A client that sends something other than a tier list (or nothing at
    all) gets today's behavior, not a crash and not a lost level ladder."""
    base = {"start_time": 0.0, "end_time": 5.0, "max_difficulty": 1,
            "levels": [{"difficulty": 0, "handshapes": []}]}
    for bad in (None, [], {}, "tiers", [1, 2], [{"notes": []}],
                [{"difficulty": "high", "notes": []}],
                [{"difficulty": -1, "notes": []}]):
        phrase = dict(base, tiers=bad)
        out = _repopulate_phrase_levels([phrase], [{"t": 1.0}], [], [])
        assert [n["t"] for n in out[0]["levels"][0]["notes"]] == [1.0], bad


def test_tier_difficulty_is_not_capped_at_ten():
    """The spec types `levels[].difficulty` as a bare integer with no maximum,
    so a pack that scales past 10 must keep its ladder — capping would drop a
    schema-legal tier's content."""
    phrases = [{
        "start_time": 0.0, "end_time": 5.0, "max_difficulty": 42,
        "tiers": [_tier(11, notes=[_editor_note(0.5)]), _tier(42)],
    }]
    out = _repopulate_phrase_levels(phrases, [{"t": 1.0}], [], [])
    assert [lv["difficulty"] for lv in out[0]["levels"]] == [11, 42]
    assert [n["t"] for n in out[0]["levels"][0]["notes"]] == [0.5]
    assert [n["t"] for n in out[0]["levels"][1]["notes"]] == [1.0]


def test_malformed_tier_members_are_skipped_not_raised():
    phrases = [{
        "start_time": 0.0, "end_time": 5.0, "max_difficulty": 1,
        "tiers": [_tier(0, notes=[_editor_note(1.0), "junk", None, 7],
                        anchors="junk"), _tier(1)],
    }]
    out = _repopulate_phrase_levels(phrases, [], [], [])
    assert [n["t"] for n in out[0]["levels"][0]["notes"]] == [1.0]
    assert out[0]["levels"][0]["anchors"] == []


def test_tiered_and_untiered_phrases_mix_in_one_pass():
    """Only the tiered phrase takes the authored path — the rest keep the flat
    slice, so one untiered phrase can't drag the others flat."""
    phrases = [
        {"start_time": 0.0, "end_time": 5.0, "max_difficulty": 1,
         "tiers": [_tier(0, notes=[_editor_note(0.5)]), _tier(1)]},
        {"start_time": 5.0, "end_time": 10.0, "max_difficulty": 0,
         "levels": [{"difficulty": 0}]},
    ]
    notes = [{"t": 1.0}, {"t": 6.0}]
    out = _repopulate_phrase_levels(phrases, notes, [], [])
    # The authored tier keeps its own note; the phrase's top tier gets the chart.
    assert [n["t"] for n in out[0]["levels"][0]["notes"]] == [0.5]
    assert [n["t"] for n in out[0]["levels"][1]["notes"]] == [1.0]
    assert [n["t"] for n in out[1]["levels"][0]["notes"]] == [6.0]


def test_tier_path_does_not_mutate_input():
    phrases = [{"start_time": 0.0, "end_time": 5.0, "max_difficulty": 1,
                "tiers": [_tier(0, notes=[_editor_note(1.0)],
                                anchors=[{"time": 1.0, "fret": 5, "width": 4}]),
                          _tier(1)]}]
    snapshot = copy.deepcopy(phrases)
    _repopulate_phrase_levels(phrases, [{"t": 2.0}], [], [])
    assert phrases == snapshot


# ---- load → save round trip --------------------------------------------------

def test_tiered_pack_round_trips_unchanged():
    """An edited-but-untouched pack must come back byte-for-byte: the authored
    tiers ARE its `levels[]`, the top tier already matches the flat chart, and
    nothing shifts on the way through the editor model."""
    levels = [
        {   # difficulty 0 — a simplified tier, fewer notes, one chord
            "difficulty": 0,
            "notes": [{"t": 0.5, "s": 0, "f": 0, "sus": 0.0, "sl": -1, "slu": -1,
                       "bn": 0.0, "ho": False, "po": False, "hm": False,
                       "hp": False, "pm": False, "mt": False, "tr": False,
                       "ac": False, "tp": False, "ln": False, "vb": False,
                       "fhm": False, "plk": False, "slp": False, "rh": -1,
                       "pkd": -1, "ig": False}],
            "chords": [{"t": 1.0, "id": 0, "hd": False, "notes": []}],
            "anchors": [{"time": 0.5, "fret": 5, "width": 4}],
            "handshapes": [{"chord_id": 0, "start_time": 1.0, "end_time": 2.0,
                            "arp": False}],
        },
        {   # difficulty 9 — the chart, as core would have written it
            "difficulty": 9,
            "notes": [
                {"t": 0.5, "s": 0, "f": 0, "sus": 0.0, "sl": -1, "slu": -1,
                 "bn": 0.0, "ho": False, "po": False, "hm": False, "hp": False,
                 "pm": False, "mt": False, "tr": False, "ac": False,
                 "tp": False, "ln": False, "vb": False, "fhm": False,
                 "plk": False, "slp": False, "rh": -1, "pkd": -1, "ig": False},
                {"t": 2.0, "s": 3, "f": 7, "sus": 0.5, "sl": -1, "slu": -1,
                 "bn": 0.0, "ho": False, "po": False, "hm": False, "hp": False,
                 "pm": False, "mt": False, "tr": False, "ac": False,
                 "tp": False, "ln": False, "vb": False, "fhm": False,
                 "plk": False, "slp": False, "rh": -1, "pkd": -1, "ig": False},
            ],
            "chords": [],
            "anchors": [{"time": 0.5, "fret": 5, "width": 4}],
            "handshapes": [],
        },
    ]
    parsed = [
        FakePhraseLevel(
            0,
            notes=[FakeNote(0.5, string=0, fret=0)],
            chords=[FakeChord(1.0, chord_id=0)],
            anchors=[FakeAnchor(0.5, fret=5, width=4)],
            hand_shapes=[FakeHandShape(0, 1.0, 2.0)],
        ),
        FakePhraseLevel(
            9,
            notes=[FakeNote(0.5, string=0, fret=0),
                   FakeNote(2.0, string=3, fret=7, sustain=0.5)],
            anchors=[FakeAnchor(0.5, fret=5, width=4)],
        ),
    ]
    # Load: the editor gets `tiers`, not `levels`.
    phrase = _phrase_with_tiers(_wire_phrase(0.0, 5.0, 9, levels), parsed)
    assert "levels" not in phrase
    # Save: with the flat chart untouched, `levels[]` must come back identical.
    flat_notes = [_editor_note_to_wire(n) for n in phrase["tiers"][1]["notes"]]
    flat_chords = [_editor_chord_to_wire(c) for c in phrase["tiers"][1]["chords"]]
    out = _repopulate_phrase_levels([phrase], flat_notes, flat_chords,
                                   phrase["tiers"][1]["anchors"])
    assert out[0]["levels"] == levels