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


def _song_key_id3(fileobj, **kwargs):
    from mutagen.easyid3 import EasyID3
    from mutagen.id3 import Frames, Frames_2_2

    # The key needs three text frames. Skip decoding pictures and embedded lyrics.
    frames = {name: Frames[name] for name in ("TIT2", "TPE1", "TPE2")}
    frames.update({name: Frames_2_2[name] for name in ("TT2", "TP1", "TP2")})
    tags = EasyID3()
    tags.load(fileobj, known_frames=frames, **kwargs)
    return tags


def get_song_key(path: Path) -> str:
    artist = ""
    title = ""
    try:
        from mutagen import File as MutagenFile

        if path.suffix.lower() == ".mp3":
            from mutagen.mp3 import EasyMP3

            try:
                mf = EasyMP3(str(path), ID3=_song_key_id3)
            except Exception:
                # Preserve format sniffing for mislabeled files and legacy errors.
                mf = MutagenFile(str(path), easy=True)
        else:
            mf = MutagenFile(str(path), easy=True)
        if mf:
            arts = mf.get("artist") or mf.get("albumartist")
            if arts:
                artist = str(arts[0])
            titles = mf.get("title")
            if titles:
                title = str(titles[0])
    except Exception:
        pass
    if not title:
        title = path.stem
    return build_artist_title_key(artist, title)


def is_online_token(path_or_token: str) -> bool:
    return str(path_or_token or "").startswith("online://")
