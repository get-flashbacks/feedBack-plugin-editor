"""Regression tests for the XML entity-expansion ("billion laughs") guard
(issue #15).

routes._reject_entity_declarations() must block <!ENTITY declarations
regardless of the byte encoding used to smuggle them past a naive ASCII scan
(UTF-16 in particular, since expat/ET.parse autodetects and parses it
transparently) while never rejecting a legitimate arrangement XML file.
"""

import pytest

from routes import _ENTITY_DECL_RE, _reject_entity_declarations, _safe_parse_xml_file


_ENTITY_BOMB = '''<?xml version="1.0"?>
<!DOCTYPE song [
  <!ENTITY a "1234567890">
  <!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">
]>
<song>&b;</song>
'''

_LEGIT_DOC = '''<?xml version="1.0"?>
<song><title>Test Song</title><arrangement>Lead</arrangement></song>
'''


@pytest.mark.parametrize(
    'encoding', ['utf-8', 'utf-16', 'utf-16-le', 'utf-16-be', 'utf-32', 'utf-32-le', 'utf-32-be']
)
def test_entity_declaration_rejected_across_encodings(encoding):
    xml_bytes = _ENTITY_BOMB.encode(encoding)
    with pytest.raises(ValueError, match='entity'):
        _reject_entity_declarations(xml_bytes)


def test_utf16_entity_bypasses_raw_ascii_byte_scan_but_is_still_caught():
    """The raw ASCII byte regex alone must NOT catch this (regression guard
    for the bypass itself), while the full guard function must."""
    xml_bytes = _ENTITY_BOMB.encode('utf-16')
    assert _ENTITY_DECL_RE.search(xml_bytes) is None
    with pytest.raises(ValueError):
        _reject_entity_declarations(xml_bytes)


@pytest.mark.parametrize(
    'encoding', ['utf-8', 'utf-16', 'utf-16-le', 'utf-16-be', 'utf-32', 'utf-32-le', 'utf-32-be']
)
def test_legitimate_document_not_rejected_across_encodings(encoding):
    xml_bytes = _LEGIT_DOC.encode(encoding)
    _reject_entity_declarations(xml_bytes)  # must not raise


def test_safe_parse_xml_file_rejects_entity_bomb_before_expat_parses_it(tmp_path):
    bomb_path = tmp_path / "bomb.xml"
    bomb_path.write_bytes(_ENTITY_BOMB.encode('utf-16'))
    with pytest.raises(ValueError, match='entity'):
        _safe_parse_xml_file(bomb_path)


def test_safe_parse_xml_file_parses_a_legitimate_file(tmp_path):
    good_path = tmp_path / "song.xml"
    good_path.write_bytes(_LEGIT_DOC.encode('utf-8'))
    root = _safe_parse_xml_file(good_path).getroot()
    assert root.tag == "song"
    assert root.find("arrangement").text == "Lead"
