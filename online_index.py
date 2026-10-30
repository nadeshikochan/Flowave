from __future__ import annotations

import json
import tempfile
from pathlib import Path
from typing import Dict, Any, Tuple

import requests
import torch

from music_recommender import load_wave, embed_segment, release_model
from runtime_paths import LIBRARY_DIR, ONLINE_CATALOG_PATH

ONLINE_INDEX_PATH = LIBRARY_DIR / "online_index.pt"

Index = Dict[str, Tuple[str, torch.Tensor]]


def load_online_index() -> Index:
    if not ONLINE_INDEX_PATH.exists():
        return {}
    raw = torch.load(ONLINE_INDEX_PATH)
    out: Index = {}
    for k, v in raw.items():
        if isinstance(v, (list, tuple)) and len(v) == 2:
            path_str, emb = v
            out[str(k)] = (str(path_str), emb)
    return out


def save_online_index(index: Index):
    torch.save(index, ONLINE_INDEX_PATH)


def load_online_catalog() -> Dict[str, Any]:
    if not ONLINE_CATALOG_PATH.exists():
        return {}
    try:
        return json.loads(ONLINE_CATALOG_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_online_catalog(catalog: Dict[str, Any]):
    ONLINE_CATALOG_PATH.write_text(json.dumps(catalog, ensure_ascii=False, indent=2), encoding="utf-8")


def is_online_token(path_or_token: str) -> bool:
    return str(path_or_token or "").startswith("online://")


def embed_online_stream(stream_url: str, timeout_sec: int = 25, max_bytes: int = 80 * 1024 * 1024) -> torch.Tensor:
    with requests.get(stream_url, stream=True, timeout=timeout_sec) as resp:
        resp.raise_for_status()
        with tempfile.NamedTemporaryFile(delete=False, suffix=".media") as tmp:
            written = 0
            for chunk in resp.iter_content(chunk_size=1024 * 256):
                if not chunk:
                    continue
                written += len(chunk)
                if written > max_bytes:
                    raise RuntimeError("stream too large")
                tmp.write(chunk)
            temp_path = Path(tmp.name)
    try:
        wav, sr = load_wave(temp_path)
        return embed_segment(wav, sr)
    finally:
        try:
            temp_path.unlink(missing_ok=True)
        except Exception:
            pass
        release_model()
