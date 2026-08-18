"""Tests for _is_youtube_url — the allow-list guard in front of the
/api/plugins/editor/youtube-audio route (issue #14).

The route hands a caller-supplied URL to yt_dlp, whose generic extractor can
fetch essentially any web page server-side — an SSRF shape with no
scheme/host restriction. The UI only ever offers "paste a YouTube URL", so
_is_youtube_url restricts requests to youtube.com/youtu.be hostnames before
the URL ever reaches yt_dlp.
"""

from routes import _is_youtube_url


def test_real_youtube_urls_pass():
    for url in (
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "https://youtube.com/watch?v=dQw4w9WgXcQ",
        "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
        "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
        "https://youtu.be/dQw4w9WgXcQ",
        "http://youtube.com/watch?v=dQw4w9WgXcQ",  # http allowed, not just https
    ):
        assert _is_youtube_url(url) is True


def test_non_youtube_hosts_rejected():
    for url in (
        "https://example.com/video",
        "https://vimeo.com/12345",
        "https://169.254.169.254/latest/meta-data/",  # cloud metadata endpoint
        "http://127.0.0.1:8080/internal",
        "http://localhost/admin",
        "http://192.168.1.1/",
        "https://internal-service.local/",
    ):
        assert _is_youtube_url(url) is False


def test_lookalike_hosts_rejected():
    # A generic-extractor SSRF guard must not be foolable by a hostname that
    # merely *contains* "youtube.com" — only the real domain (and its
    # documented subdomains) is allowed.
    for url in (
        "https://youtube.com.evil.example/watch?v=1",
        "https://evil-youtube.com/watch?v=1",
        "https://notyoutube.com/watch?v=1",
        "https://youtube.com.evil.com/",
        "https://xn--youtube-com.evil.example/",
    ):
        assert _is_youtube_url(url) is False


def test_userinfo_host_confusion_rejected():
    # https://youtube.com@evil.example/ — browsers/naive parsers can be
    # tricked into reading "youtube.com" as the host when it's actually
    # userinfo; urlparse().hostname correctly resolves this to "evil.example",
    # which must still be rejected.
    assert _is_youtube_url("https://youtube.com@evil.example/watch?v=1") is False


def test_non_http_schemes_rejected():
    for url in (
        "file:///etc/passwd",
        "ftp://youtube.com/watch?v=1",
        "javascript:alert(1)",
        "data:text/html,<script>alert(1)</script>",
        "gopher://youtube.com/",
    ):
        assert _is_youtube_url(url) is False


def test_malformed_and_non_string_input_rejected():
    for url in ("", "not a url", "   ", None, 42, ["https://youtube.com/"]):
        assert _is_youtube_url(url) is False
