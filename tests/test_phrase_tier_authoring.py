"""Tests for frontend-authored simplification ladders (issue #3).

The editor's new tier-authoring UI writes a fresh phrase shape the save path
has never seen before: no wire `levels`, no `max_difficulty` — just client
keys (`name` / `number` / `start_time`) plus `tiers[]` holding a
simplification ladder plus a FULL stub for the top tier that rides the flat
window content. The save path (`_repopulate_phrase_levels`) must handle it
exactly like the storage-foundation shapes in `test_phrase_tiers.py` (issue
#33): authored LOWER tiers convert to wire verbatim, the TOP tier re-slices
from the flat chart (its shipped notes/chords/anchors are ignored, its
shipped handshapes are kept validated + template-bound), unknown ladder keys
survive via `by_diff`, `tiers` never reaches the wire, and `dict(p)`
passthrough preserves the client keys without inventing `max_difficulty`.

Covers:
* fresh-phrase ladder — authored tier 0 converts to wire, top tier takes the
  flat window slice, handshapes ride the stub, client keys survive, `tiers`
  stripped, no `max_difficulty` added
* cascade ladder — two authored tiers survive sorted verbatim, top rebuilds
* template-count bound on an authored-simplification tier's handshapes
* one tier mixing valid + junk across notes/chords/anchors — valid survive,
  junk dropped, no raise
"""

from routes import _repopulate_phrase_levels


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


def test_fresh_phrase_ladder_saves_authored_lower_and_flat_top():
    """The new shape's core contract: tier 0 is the authored simplification
    (converted to wire), tier 1 is a FULL stub whose shipped notes/chords/
    anchors are ignored in favor of the flat window slice — while its shipped
    handshapes are the top level's handshapes."""
    tier0 = _tier(
        0,
        notes=[_editor_note(0.5, string=1, fret=3)],
        chords=[{"time": 0.75, "chord_id": 0,
                 "notes": [_editor_note(0.75, string=2, fret=5)]}],
        anchors=[{"time": 0.25, "fret": 2, "width": 4}],
        handshapes=[{"chord_id": 0, "start_time": 0.5, "end_time": 1.0}],
    )
    stub = _tier(
        1,
        notes=[_editor_note(99.0)],
        chords=[{"time": 99.0, "chord_id": 5, "notes": []}],
        anchors=[{"time": 99.0, "fret": 9, "width": 4}],
        handshapes=[{"chord_id": 1, "start_time": 1.5, "end_time": 2.0,
                      "arp": True}],
    )
    phrases = [{"name": "verse", "number": 1, "start_time": 0.0,
                "tiers": [tier0, stub]}]
    flat_notes = [{"t": 2.0, "s": 3, "f": 7, "sus": 0.5}]
    flat_chords = [{"t": 2.5, "id": 0, "hd": False, "notes": []}]
    flat_anchors = [{"time": 1.0, "fret": 3, "width": 4}]
    out = _repopulate_phrase_levels(phrases, flat_notes, flat_chords,
                                    flat_anchors)
    levels = out[0]["levels"]
    assert [lv["difficulty"] for lv in levels] == [0, 1]
    # Authored tier converts to wire short keys, not the editor's.
    assert [n["t"] for n in levels[0]["notes"]] == [0.5]
    assert levels[0]["notes"][0]["s"] == 1 and levels[0]["notes"][0]["f"] == 3
    assert [c["t"] for c in levels[0]["chords"]] == [0.75]
    assert levels[0]["anchors"] == [{"time": 0.25, "fret": 2, "width": 4}]
    assert levels[0]["handshapes"] == [
        {"chord_id": 0, "start_time": 0.5, "end_time": 1.0, "arp": False},
    ]
    # Top tier IS the chart: flat slice wins over the stub's stale content.
    assert levels[1]["notes"] == flat_notes
    assert levels[1]["chords"] == flat_chords
    assert levels[1]["anchors"] == flat_anchors
    # ... except handshapes, which ride the stub through validation.
    assert levels[1]["handshapes"] == [
        {"chord_id": 1, "start_time": 1.5, "end_time": 2.0, "arp": True},
    ]


def test_fresh_phrase_keeps_client_keys_strips_tiers_adds_no_max_difficulty():
    """`dict(p)` passthrough must preserve the fresh shape's client keys and
    nothing else: `tiers` stripped, no `max_difficulty` invented, each new
    level carrying exactly the five keys the authored path owns."""
    phrases = [{"name": "verse", "number": 1, "start_time": 0.0,
                "tiers": [_tier(0, notes=[_editor_note(0.5)]), _tier(1)]}]
    out = _repopulate_phrase_levels(phrases, [{"t": 2.0}], [], [])
    phrase = out[0]
    assert phrase["name"] == "verse" and phrase["number"] == 1
    assert phrase["start_time"] == 0.0
    assert "tiers" not in phrase, "tiers is the editor working copy, not wire"
    assert "max_difficulty" not in phrase, "fresh phrase ships none to keep"
    for lv in phrase["levels"]:
        assert set(lv) == {"difficulty", "notes", "chords", "anchors",
                           "handshapes"}


def test_cascade_ladder_keeps_both_authored_tiers_and_rebuilds_top():
    """A cascade ships two simplifications below the stub: both survive
    verbatim (sorted), the stub still rebuilds from the flat chart."""
    phrases = [{"name": "chorus", "number": 2, "start_time": 0.0,
                "tiers": [
                    _tier(2, notes=[_editor_note(99.0)]),
                    _tier(0, notes=[_editor_note(0.5)],
                           chords=[{"time": 0.5, "chord_id": 0,
                                    "notes": [_editor_note(0.5, string=1,
                                                             fret=2)]}],
                           anchors=[{"time": 0.25, "fret": 2, "width": 4}]),
                    _tier(1, notes=[_editor_note(0.75)],
                           anchors=[{"time": 0.6, "fret": 3, "width": 4}]),
                ]}]
    out = _repopulate_phrase_levels(phrases, [{"t": 2.0}],
                                    [{"t": 2.5, "id": 0, "hd": False,
                                      "notes": []}],
                                    [{"time": 1.0, "fret": 3, "width": 4}])
    levels = out[0]["levels"]
    assert [lv["difficulty"] for lv in levels] == [0, 1, 2]
    assert [n["t"] for n in levels[0]["notes"]] == [0.5]
    assert [c["t"] for c in levels[0]["chords"]] == [0.5]
    assert levels[0]["anchors"] == [{"time": 0.25, "fret": 2, "width": 4}]
    assert [n["t"] for n in levels[1]["notes"]] == [0.75]
    assert levels[1]["anchors"] == [{"time": 0.6, "fret": 3, "width": 4}]
    assert [n["t"] for n in levels[2]["notes"]] == [2.0]
    assert [c["t"] for c in levels[2]["chords"]] == [2.5]
    assert levels[2]["anchors"] == [{"time": 1.0, "fret": 3, "width": 4}]


def test_authored_simplification_handshapes_honor_template_count():
    """The arrangement's chord-template bound applies to the fresh shape's
    authored-simplification tier, mirroring `_arr_dict_to_wire` — otherwise
    the new ladder can persist an index core can't resolve."""
    hs = [{"chord_id": cid, "start_time": 1.0, "end_time": 2.0}
          for cid in (0, 1, 2)]
    phrases = [{"name": "verse", "number": 1, "start_time": 0.0,
                "tiers": [_tier(0, handshapes=hs), _tier(1)]}]
    out = _repopulate_phrase_levels(phrases, [], [], [],
                                    n_chord_templates=2)
    assert [h["chord_id"] for h in out[0]["levels"][0]["handshapes"]] == [0, 1]
    # No count (a caller that doesn't know it) leaves them alone.
    out = _repopulate_phrase_levels(phrases, [], [], [])
    assert len(out[0]["levels"][0]["handshapes"]) == 3


def test_single_tier_mixes_valid_and_junk_across_notes_chords_anchors():
    """One fresh-shape tier carrying valid + junk in notes, chords AND
    anchors keeps the valid members and drops the junk without raising —
    `tiers` rides the client's save payload, so one bad member must cost
    itself, not the whole save."""
    phrases = [{"name": "verse", "number": 1, "start_time": 0.0,
                "tiers": [_tier(
                    0,
                    notes=[
                        _editor_note(1.0),
                        dict(_editor_note(2.0), time="abc"),
                        dict(_editor_note(3.0), techniques=5),
                        "junk",
                        None,
                    ],
                    chords=[
                        {"time": 1.0, "chord_id": 0,
                         "notes": [_editor_note(1.0, string=1, fret=2)]},
                        {"time": 1.0, "chord_id": 0, "notes": None},
                        "junk",
                    ],
                    anchors=[
                        {"time": 0.5, "fret": 5, "width": 4},
                        {"time": -1.0, "fret": 5, "width": 4},
                        {"fret": 5},
                        "junk",
                        None,
                    ],
                ), _tier(1)]}]
    out = _repopulate_phrase_levels(phrases, [], [], [])
    lv = out[0]["levels"][0]
    assert [n["t"] for n in lv["notes"]] == [1.0]
    assert len(lv["chords"]) == 1 and lv["chords"][0]["t"] == 1.0
    assert lv["anchors"] == [{"time": 0.5, "fret": 5, "width": 4}]
