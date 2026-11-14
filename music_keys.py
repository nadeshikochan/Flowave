from __future__ import annotations

import re
from pathlib import Path
from typing import List


_AUDIO_EXT_RE = re.compile(r"\.(mp3|flac|wav|m4a|ogg|aac|ape|wma)$", re.IGNORECASE)
_BRACKET_QUALITY_RE = re.compile(
    r"[\[\(（【]\s*(?:\d{2,4}\s*(?:k|kbps|khz)|flac(?:\s*24bit)?|hi[-\s]?res|24bit|16bit|hq|sq|lossless|无损)\s*[\]\)）】]$",
    re.IGNORECASE,
)
_TAIL_QUALITY_RE = re.compile(
    r"(?:[-_.\s]+(?:\d{2,4}\s*(?:k|kbps)|flac(?:\s*24bit)?|hi[-\s]?res|24bit|16bit|hq|sq|lossless|无损))+$",
    re.IGNORECASE,
)


def normalize_text_key(s: str) -> str:
    return " ".join(str(s or "").strip().lower().split())


def normalize_title_key(title: str) -> str:
    t = str(title or "").strip()
    if not t:
        return ""
    t = _AUDIO_EXT_RE.sub("", t).strip()
    while True:
        nxt = _BRACKET_QUALITY_RE.sub("", t).strip()
        if nxt == t:
            break
        t = nxt
    t = _TAIL_QUALITY_RE.sub("", t).strip(" -_.")
    t = _AUDIO_EXT_RE.sub("", t).strip()
    return normalize_text_key(t)


def build_artist_title_key(artist: str, title: str) -> str:
    a = normalize_text_key(artist)
    t = normalize_title_key(title)
    if not t:
        return ""
    return f"{a} - {t}".strip()


def normalize_song_key(raw_key: str) -> str:
    text = str(raw_key or "").strip().lower()
    if not text:
        return ""
    artist, sep, title = text.partition(" - ")
    if sep:
        return build_artist_title_key(artist, title)
    return build_artist_title_key("", text)


def list_audio_files(folder: Path) -> List[Path]:
    exts = {".wav", ".mp3", ".flac", ".m4a", ".ogg", ".aac", ".ape", ".wma"}
    return [p for p in folder.rglob("*") if p.suffix.lower() in exts]


def get_song_key(path: Path) -> str:
    from tinytag import TinyTag
    from pymediainfo import MediaInfo

    artist = ""
    title = ""
    try:
        with path.open('rb') as stream:
            tag = TinyTag.get(file_obj=stream, duration=False, image=False)
        artist = tag.artist or tag.albumartist or ''
        title = tag.title or ''
        if any('\x80' <= character <= '\xff' for character in artist + title):
            # Resolve ambiguous legacy single-byte text with the format-aware
            # reader, preserving the original Unicode metadata when present.
            raise ValueError('Legacy text requires format-aware metadata reading')
    except Exception:
        # MediaInfo covers APE and format-sniffing fallback without decoding audio.
        try:
            general = next(track for track in MediaInfo.parse(str(path)).tracks if track.track_type == 'General')
            artist = general.performer or general.album_performer or ''
            title = general.track_name or ''
        except Exception:
            pass
    if not title:
        title = path.stem
    return build_artist_title_key(artist, title)


def is_online_token(path_or_token: str) -> bool:
    return str(path_or_token or "").startswith("online://")
