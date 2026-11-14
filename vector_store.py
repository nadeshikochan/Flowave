from __future__ import annotations

import json
import hashlib
import os
import shutil
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

from runtime_paths import (
    LOCAL_EMBEDDINGS_PATH,
    LOCAL_TRACKS_PATH,
    ONLINE_CATALOG_PATH,
    ONLINE_EMBEDDINGS_META_PATH,
    ONLINE_EMBEDDINGS_PATH,
    ensure_runtime_dirs,
)


VectorIndex = Dict[str, Tuple[str, np.ndarray]]


@dataclass(frozen=True)
class LocalVectorRecord:
    resource_id: str
    song_key: str
    path: str
    embedding: np.ndarray
    content_fingerprint: str = ""
    legacy: bool = False


LocalVectorRecords = Dict[str, LocalVectorRecord]


def embedding_content_fingerprint(embedding: Any) -> str:
    """返回与路径、标签无关的 MERT 向量指纹。"""
    try:
        vector = np.asarray(embedding, dtype="<f4").reshape(-1)
    except Exception:
        return ""
    if not vector.size or not np.isfinite(vector).all():
        return ""
    digest = hashlib.sha256(vector.tobytes(order="C")).hexdigest()
    return f"mert-embedding-sha256-v1:{vector.size}:{digest}"


def _read_json(path: Path, default: Any) -> Any:
    try:
        if not path.exists():
            return default
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.tmp")
    with tmp.open('w', encoding='utf-8') as stream:
        json.dump(payload, stream, ensure_ascii=False, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(tmp, path)


def _save_npy_atomic(path: Path, arr: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.tmp")
    with tmp.open("wb") as f:
        np.save(f, arr)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _previous_path(path: Path) -> Path:
    return path.with_name(f"{path.name}.previous")


def _load_rows_pair(
    meta_path: Path,
    emb_path: Path,
) -> Optional[Tuple[Dict[str, Any], List[Dict[str, Any]], np.ndarray]]:
    if not meta_path.exists() or not emb_path.exists():
        return None
    meta = _read_json(meta_path, {})
    tracks = meta.get("tracks") if isinstance(meta, dict) else None
    if not isinstance(tracks, list):
        return None
    try:
        # Keep API/worker free to rewrite the index on Windows.
        # A memmap keeps the .npy file handle open and can make os.replace fail.
        embs = np.load(emb_path, allow_pickle=False)
    except Exception:
        return None
    if getattr(embs, "ndim", 0) != 2 or len(tracks) != int(embs.shape[0]):
        return None
    try:
        version = int(meta.get("version") or 1)
    except (TypeError, ValueError):
        return None
    if version >= 2:
        expected_shape = meta.get("embedding_shape")
        expected_hash = str(meta.get("embedding_sha256") or "").strip().lower()
        if expected_shape != list(embs.shape) or not expected_hash:
            return None
        try:
            if _file_sha256(emb_path) != expected_hash:
                return None
        except OSError:
            return None
    normalized_tracks: List[Dict[str, Any]] = []
    for idx in range(len(tracks)):
        item = tracks[idx] or {}
        if not isinstance(item, dict):
            return None
        row = np.array(embs[idx], dtype=np.float32, copy=True)
        if not np.isfinite(row).all():
            return None
        normalized_tracks.append(dict(item))
    return dict(meta), normalized_tracks, np.array(embs, dtype=np.float32, copy=True)


def _load_index_pair(meta_path: Path, emb_path: Path, key_field: str) -> Optional[VectorIndex]:
    loaded = _load_rows_pair(meta_path, emb_path)
    if loaded is None:
        return None
    _, tracks, embs = loaded
    out: VectorIndex = {}
    for idx, item in enumerate(tracks):
        key = str(item.get(key_field) or item.get("token") or "").strip()
        path = str(item.get("path") or item.get("token") or "").strip()
        if key and path:
            row = np.array(embs[idx], dtype=np.float32, copy=True)
            if key in out:
                return None
            out[key] = (path, row)
    return out


def _load_index(meta_path: Path, emb_path: Path, key_field: str = "key") -> VectorIndex:
    current = _load_index_pair(meta_path, emb_path, key_field)
    if current is not None:
        return current
    previous = _load_index_pair(_previous_path(meta_path), _previous_path(emb_path), key_field)
    return previous if previous is not None else {}


def _save_index(
    meta_path: Path,
    emb_path: Path,
    tracks: List[Dict[str, Any]],
    arr: np.ndarray,
    key_field: str,
    version: int = 2,
) -> None:
    if arr.ndim != 2 or arr.shape[0] != len(tracks):
        raise ValueError("索引元数据与向量数量不一致")
    if not np.isfinite(arr).all():
        raise ValueError("索引包含无效向量")

    meta_path.parent.mkdir(parents=True, exist_ok=True)
    emb_path.parent.mkdir(parents=True, exist_ok=True)
    generation = uuid.uuid4().hex
    staged_meta = meta_path.with_name(f".{meta_path.name}.{generation}.tmp")
    staged_emb = emb_path.with_name(f".{emb_path.name}.{generation}.tmp")
    previous_meta = _previous_path(meta_path)
    previous_emb = _previous_path(emb_path)
    publication_started = False
    try:
        with staged_emb.open("wb") as stream:
            np.save(stream, arr)
            stream.flush()
            os.fsync(stream.fileno())
        payload = {
            "version": int(version),
            "generation": generation,
            "embedding_shape": list(arr.shape),
            "embedding_sha256": _file_sha256(staged_emb),
            "tracks": tracks,
        }
        with staged_meta.open('w', encoding='utf-8') as stream:
            json.dump(payload, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        staged = _load_index_pair(staged_meta, staged_emb, key_field)
        if staged is None or len(staged) != len(tracks):
            raise RuntimeError("新索引校验失败")

        # 只把完整、可校验的当前代推进 previous。当前代已损坏时保留
        # 既有 previous，避免一次成功重建反而覆盖最后可恢复副本。
        if _load_rows_pair(meta_path, emb_path) is not None:
            shutil.copy2(meta_path, previous_meta)
            shutil.copy2(emb_path, previous_emb)
            for backup in (previous_meta, previous_emb):
                with backup.open('r+b') as stream:
                    os.fsync(stream.fileno())

        publication_started = True
        os.replace(staged_emb, emb_path)
        os.replace(staged_meta, meta_path)
    except Exception:
        if publication_started and _load_rows_pair(previous_meta, previous_emb) is not None:
            shutil.copy2(previous_emb, emb_path)
            shutil.copy2(previous_meta, meta_path)
        raise
    finally:
        staged_meta.unlink(missing_ok=True)
        staged_emb.unlink(missing_ok=True)


def load_local_index() -> VectorIndex:
    records = load_local_records()
    out: VectorIndex = {}
    for record in records.values():
        if record.song_key and record.song_key not in out:
            out[record.song_key] = (
                record.path,
                np.array(record.embedding, dtype=np.float32, copy=True),
            )
    return out


def save_local_index(index: VectorIndex) -> None:
    ensure_runtime_dirs()
    tracks: List[Dict[str, Any]] = []
    embs: List[np.ndarray] = []
    for key, (path, emb) in index.items():
        tracks.append({"key": str(key), "path": str(path)})
        embs.append(np.asarray(emb, dtype=np.float32))
    arr = np.stack(embs).astype(np.float32) if embs else np.zeros((0, 0), dtype=np.float32)
    _save_index(LOCAL_TRACKS_PATH, LOCAL_EMBEDDINGS_PATH, tracks, arr, "key")


def _load_local_records_pair(meta_path: Path, emb_path: Path) -> Optional[LocalVectorRecords]:
    loaded = _load_rows_pair(meta_path, emb_path)
    if loaded is None:
        return None
    meta, tracks, embs = loaded
    try:
        version = int(meta.get("version") or 1)
    except (TypeError, ValueError):
        return None
    records: LocalVectorRecords = {}
    for idx, item in enumerate(tracks):
        path = str(item.get("path") or "").strip()
        song_key = str(item.get("song_key") or item.get("key") or "").strip()
        resource_id = str(item.get("resource_id") or "").strip()
        legacy = version < 3 or not resource_id
        record_key = resource_id or f"legacy:{idx}:{song_key}"
        if not path or not song_key or record_key in records:
            return None
        records[record_key] = LocalVectorRecord(
            resource_id=resource_id,
            song_key=song_key,
            path=path,
            embedding=np.array(embs[idx], dtype=np.float32, copy=True),
            content_fingerprint=str(item.get("content_fingerprint") or "").strip(),
            legacy=legacy,
        )
    return records


def load_local_records() -> LocalVectorRecords:
    current = _load_local_records_pair(LOCAL_TRACKS_PATH, LOCAL_EMBEDDINGS_PATH)
    if current is not None:
        return current
    previous = _load_local_records_pair(
        _previous_path(LOCAL_TRACKS_PATH),
        _previous_path(LOCAL_EMBEDDINGS_PATH),
    )
    return previous if previous is not None else {}


def local_records_current_is_v3() -> bool:
    current = _load_local_records_pair(LOCAL_TRACKS_PATH, LOCAL_EMBEDDINGS_PATH)
    return current is not None and all(not record.legacy for record in current.values())


def save_local_records(records: LocalVectorRecords) -> None:
    ensure_runtime_dirs()
    tracks: List[Dict[str, Any]] = []
    embs: List[np.ndarray] = []
    seen_paths: set[str] = set()
    for mapping_key, raw_record in records.items():
        if isinstance(raw_record, LocalVectorRecord):
            record = raw_record
        elif isinstance(raw_record, dict):
            record = LocalVectorRecord(
                resource_id=str(raw_record.get("resource_id") or mapping_key),
                song_key=str(raw_record.get("song_key") or ""),
                path=str(raw_record.get("path") or ""),
                embedding=np.asarray(raw_record.get("embedding"), dtype=np.float32),
                content_fingerprint=str(raw_record.get("content_fingerprint") or ""),
            )
        else:
            raise TypeError("本地向量记录格式无效")
        resource_id = str(record.resource_id or mapping_key).strip()
        song_key = str(record.song_key or "").strip()
        path = str(record.path or "").strip()
        if not resource_id or resource_id != str(mapping_key) or not song_key or not path:
            raise ValueError("本地向量记录缺少稳定身份")
        if path in seen_paths:
            raise ValueError("本地向量记录存在重复路径")
        seen_paths.add(path)
        tracks.append({
            "resource_id": resource_id,
            "song_key": song_key,
            "path": path,
            "content_fingerprint": str(record.content_fingerprint or ""),
        })
        embs.append(np.asarray(record.embedding, dtype=np.float32))
    arr = np.stack(embs).astype(np.float32) if embs else np.zeros((0, 0), dtype=np.float32)
    _save_index(
        LOCAL_TRACKS_PATH,
        LOCAL_EMBEDDINGS_PATH,
        tracks,
        arr,
        "resource_id",
        version=3,
    )


def load_online_index() -> VectorIndex:
    return _load_index(ONLINE_EMBEDDINGS_META_PATH, ONLINE_EMBEDDINGS_PATH, "token")


def save_online_index(index: VectorIndex) -> None:
    ensure_runtime_dirs()
    tracks: List[Dict[str, Any]] = []
    embs: List[np.ndarray] = []
    for token, (path, emb) in index.items():
        tracks.append({"token": str(token), "path": str(path or token)})
        embs.append(np.asarray(emb, dtype=np.float32))
    arr = np.stack(embs).astype(np.float32) if embs else np.zeros((0, 0), dtype=np.float32)
    _save_index(ONLINE_EMBEDDINGS_META_PATH, ONLINE_EMBEDDINGS_PATH, tracks, arr, "token")


def load_online_catalog() -> Dict[str, Any]:
    return _read_json(ONLINE_CATALOG_PATH, {})


def save_online_catalog(catalog: Dict[str, Any]) -> None:
    _write_json(ONLINE_CATALOG_PATH, catalog or {})
