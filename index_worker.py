from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import json
import sys
from pathlib import Path
from typing import Any, Dict

import numpy as np
import torch
from index_progress import report_progress

torch.set_num_threads(2)
torch.set_num_interop_threads(1)

import vector_store
from music_library_roots import normalize_roots, scan_roots
from audio_payload_fingerprint import (
    AudioPayloadFingerprintError,
    fingerprint_audio_payload,
    is_audio_payload_identity,
)
from music_keys import list_audio_files, get_song_key, is_online_token, normalize_song_key
from music_recommender import DEVICE, build_index, load_existing_index
from online_index import embed_online_stream, load_online_index
from runtime_paths import (
    LEGACY_LOCAL_INDEX_PATH,
    LEGACY_ONLINE_INDEX_PATH,
    LIBRARY_DIR,
    TRACK_IDENTITIES_PATH,
    ensure_runtime_dirs,
)
from track_identity import TrackIdentityRegistry, TrackObservation, normalize_resource_path


def _tensor_to_numpy(value: Any) -> np.ndarray:
    if hasattr(value, "detach"):
        value = value.detach().cpu().numpy()
    return np.asarray(value, dtype=np.float32)


def _to_vector_index(index: Dict[str, Any]) -> vector_store.VectorIndex:
    out: vector_store.VectorIndex = {}
    for key, value in (index or {}).items():
        if isinstance(value, (list, tuple)) and len(value) == 2:
            path_str, emb = value
        else:
            path_str, emb = key, value
        out[str(key)] = (str(path_str), _tensor_to_numpy(emb))
    return out


def _load_legacy_local_pt() -> Dict[str, Any]:
    if not LEGACY_LOCAL_INDEX_PATH.exists():
        return {}
    raw = torch.load(LEGACY_LOCAL_INDEX_PATH, map_location="cpu")
    out: Dict[str, Any] = {}
    for key, value in (raw or {}).items():
        if isinstance(value, (list, tuple)) and len(value) == 2:
            path_str, emb = value
            song_key = normalize_song_key(str(key)) or get_song_key(Path(path_str))
        else:
            path_str, emb = key, value
            song_key = get_song_key(Path(path_str))
        if song_key and song_key not in out:
            out[song_key] = (str(path_str), emb)
    return out


def _load_legacy_online_pt() -> Dict[str, Any]:
    if not LEGACY_ONLINE_INDEX_PATH.exists():
        return {}
    raw = torch.load(LEGACY_ONLINE_INDEX_PATH, map_location="cpu")
    out: Dict[str, Any] = {}
    for key, value in (raw or {}).items():
        if isinstance(value, (list, tuple)) and len(value) == 2:
            path_str, emb = value
        else:
            path_str, emb = key, value
        token = str(key)
        if token:
            out[token] = (str(path_str or token), emb)
    return out


def _record_fingerprint(record: vector_store.LocalVectorRecord) -> str:
    value = str(record.content_fingerprint or "").strip()
    return value if is_audio_payload_identity(value) else ""


def _payload_fingerprint(path: Path) -> str:
    try:
        return fingerprint_audio_payload(path).identity_value()
    except (AudioPayloadFingerprintError, OSError):
        return ""


def _build_identity_observations(
    audio_files: list[Path],
    records: vector_store.LocalVectorRecords,
    known_identities: dict[str, dict[str, Any]] | None = None,
) -> tuple[list[TrackObservation], dict[str, str]]:
    records_by_path: dict[str, list[vector_store.LocalVectorRecord]] = defaultdict(list)
    for record in records.values():
        path_key = normalize_resource_path(record.path)
        if path_key:
            records_by_path[path_key].append(record)

    song_keys = {}
    identities_by_path = {
        normalize_resource_path(path): entry
        for path, entry in (known_identities or {}).items()
        if normalize_resource_path(path)
    }
    observations: list[TrackObservation] = []
    for position, path in enumerate(audio_files):
        report_progress(stage="identity", done=position, total=len(audio_files))
        path_str = str(path)
        song_key = get_song_key(path)
        song_keys[path_str] = song_key
        exact = records_by_path.get(normalize_resource_path(path_str)) or []
        record = exact[0] if len(exact) == 1 else None
        try:
            stat = path.stat()
            size = int(stat.st_size)
            mtime_ns = int(stat.st_mtime_ns)
        except OSError:
            size = 0
            mtime_ns = 0
        known_identity = identities_by_path.get(normalize_resource_path(path_str)) or {}
        known_fingerprint = str(known_identity.get("content_fingerprint") or "")
        fingerprint = ""
        if (
            is_audio_payload_identity(known_fingerprint)
            and int(known_identity.get("size") or 0) == size
            and int(known_identity.get("mtime_ns") or 0) == mtime_ns
        ):
            fingerprint = known_fingerprint
        elif record is not None and is_audio_payload_identity(record.content_fingerprint):
            fingerprint = _payload_fingerprint(path)
        else:
            fingerprint = _payload_fingerprint(path)
        observations.append(TrackObservation(
            path=path_str,
            song_key=song_key,
            size=size,
            mtime_ns=mtime_ns,
            content_fingerprint=fingerprint,
        ))
    report_progress(stage="identity", done=len(audio_files), total=len(audio_files))
    return observations, song_keys


def _prepare_existing_resource_index(
    audio_files: list[Path],
    records: vector_store.LocalVectorRecords,
    identities_by_path: dict[str, dict[str, Any]],
    song_keys: dict[str, str],
    trusted_legacy_resource_ids: set[str] | None = None,
) -> Dict[str, Any]:
    records_by_path: dict[str, list[tuple[str, vector_store.LocalVectorRecord]]] = defaultdict(list)
    records_by_fingerprint: dict[str, list[tuple[str, vector_store.LocalVectorRecord]]] = defaultdict(list)
    records_by_song_key: dict[str, list[tuple[str, vector_store.LocalVectorRecord]]] = defaultdict(list)
    for mapping_key, record in records.items():
        path_key = normalize_resource_path(record.path)
        if path_key:
            records_by_path[path_key].append((mapping_key, record))
        fingerprint = _record_fingerprint(record)
        if fingerprint:
            records_by_fingerprint[fingerprint].append((mapping_key, record))
        if record.song_key:
            records_by_song_key[record.song_key].append((mapping_key, record))

    current_key_counts = Counter(value for value in song_keys.values() if value)
    used_records: set[str] = set()
    trusted_legacy_ids = trusted_legacy_resource_ids or set()
    existing: Dict[str, Any] = {}
    for path in audio_files:
        path_str = str(path)
        identity = identities_by_path.get(path_str) or {}
        resource_id = str(identity.get("resource_id") or "").strip()
        if not resource_id:
            raise RuntimeError(f"歌曲缺少稳定身份：{path}")

        candidates: list[tuple[str, vector_store.LocalVectorRecord]] = []
        direct = records.get(resource_id)
        if direct is not None:
            candidates = [(resource_id, direct)]
        if not candidates:
            exact = records_by_path.get(normalize_resource_path(path_str)) or []
            if len(exact) == 1:
                candidates = exact
        if not candidates:
            fingerprint = str(identity.get("content_fingerprint") or "").strip()
            matches = records_by_fingerprint.get(fingerprint) if fingerprint else []
            if matches and len(matches) == 1:
                candidates = matches
        if not candidates:
            song_key = song_keys.get(path_str) or ""
            matches = [
                candidate
                for candidate in (records_by_song_key.get(song_key) or [])
                if candidate[1].legacy or not str(candidate[1].resource_id or "")
            ] if song_key else []
            if song_key and current_key_counts[song_key] == 1 and matches and len(matches) == 1:
                candidates = matches
        if not candidates:
            continue
        mapping_key, record = candidates[0]
        identity_fingerprint = str(identity.get("content_fingerprint") or "")
        fingerprints_match = (
            is_audio_payload_identity(identity_fingerprint)
            and _record_fingerprint(record) == identity_fingerprint
        )
        if not fingerprints_match and resource_id not in trusted_legacy_ids:
            continue
        if mapping_key in used_records:
            continue
        used_records.add(mapping_key)
        existing[resource_id] = (
            path_str,
            torch.as_tensor(np.array(record.embedding, dtype=np.float32, copy=True)),
        )
    return existing


def _records_from_resource_index(
    audio_files: list[Path],
    index: Dict[str, Any],
    identities_by_path: dict[str, dict[str, Any]],
    song_keys: dict[str, str],
) -> vector_store.LocalVectorRecords:
    records: vector_store.LocalVectorRecords = {}
    for path in audio_files:
        path_str = str(path)
        identity = identities_by_path.get(path_str) or {}
        resource_id = str(identity.get("resource_id") or "").strip()
        item = index.get(resource_id)
        if not resource_id or not item:
            continue
        _, embedding = item
        vector = _tensor_to_numpy(embedding)
        records[resource_id] = vector_store.LocalVectorRecord(
            resource_id=resource_id,
            song_key=str(song_keys.get(path_str) or ""),
            path=path_str,
            embedding=vector,
            content_fingerprint=str(identity.get("content_fingerprint") or ""),
        )
    return records


def _same_local_records(
    left: vector_store.LocalVectorRecords,
    right: vector_store.LocalVectorRecords,
) -> bool:
    if set(left) != set(right):
        return False
    for resource_id, record in left.items():
        other = right.get(resource_id)
        if other is None or record.legacy or other.legacy:
            return False
        if (
            record.song_key != other.song_key
            or normalize_resource_path(record.path) != normalize_resource_path(other.path)
            or _record_fingerprint(record) != _record_fingerprint(other)
            or not np.array_equal(
                np.asarray(record.embedding, dtype=np.float32),
                np.asarray(other.embedding, dtype=np.float32),
            )
        ):
            return False
    return True


def migrate_existing() -> Dict[str, Any]:
    ensure_runtime_dirs()
    local_index = _load_legacy_local_pt() or load_existing_index()
    if local_index:
        vector_store.save_local_index(_to_vector_index(local_index))
    online_index = _load_legacy_online_pt() or load_online_index()
    if online_index:
        vector_store.save_online_index(_to_vector_index(online_index))
    return {"ok": True, "local_count": len(local_index), "online_count": len(online_index)}


def _legacy_records(index: Dict[str, Any]) -> vector_store.LocalVectorRecords:
    records: vector_store.LocalVectorRecords = {}
    for position, (song_key, value) in enumerate((index or {}).items()):
        if isinstance(value, (list, tuple)) and len(value) == 2:
            path_str, embedding = value
        else:
            path_str, embedding = song_key, value
        vector = _tensor_to_numpy(embedding)
        mapping_key = f"legacy:{position}:{song_key}"
        records[mapping_key] = vector_store.LocalVectorRecord(
            resource_id="",
            song_key=str(song_key or get_song_key(Path(path_str))),
            path=str(path_str),
            embedding=vector,
            content_fingerprint="",
            legacy=True,
        )
    return records


def build_local(folder: str, overwrite: bool = False, folders=None) -> Dict[str, Any]:
    report_progress(stage="scanning", done=0, total=0)
    ensure_runtime_dirs()
    target = Path(folder)
    if not target.exists():
        raise FileNotFoundError(f"目录不存在: {target}")
    roots = normalize_roots(folders if folders is not None else [folder])
    audio_files = scan_roots(roots, list_audio_files)
    if not audio_files:
        raise RuntimeError("所选目录中没有可建立索引的音频文件")

    stored_records = vector_store.load_local_records()
    if not stored_records and not overwrite:
        stored_records = _legacy_records(load_existing_index())
    identity_registry = TrackIdentityRegistry(TRACK_IDENTITIES_PATH)
    known_identities = {
        str(entry.get("current_path") or ""): entry
        for entry in (identity_registry.snapshot().get("tracks") or {}).values()
        if str(entry.get("current_path") or "") and not bool(entry.get("missing"))
    }
    observations, song_keys = _build_identity_observations(
        audio_files,
        stored_records,
        known_identities,
    )
    trusted_legacy_resource_ids: set[str] = set()
    stored_by_id = {
        str(record.resource_id or ""): record
        for record in stored_records.values()
        if str(record.resource_id or "")
    }
    for observation in observations:
        known = known_identities.get(observation.path) or {}
        resource_id = str(known.get("resource_id") or "")
        record = stored_by_id.get(resource_id)
        if (
            resource_id
            and record is not None
            and not _record_fingerprint(record)
            and normalize_resource_path(record.path) == normalize_resource_path(observation.path)
            and int(known.get("size") or 0) > 0
            and int(known.get("size") or 0) == observation.size
            and int(known.get("mtime_ns") or 0) > 0
            and int(known.get("mtime_ns") or 0) == observation.mtime_ns
        ):
            trusted_legacy_resource_ids.add(resource_id)
    identity_result = identity_registry.reconcile(observations)
    identities_by_path = identity_result.by_path

    existing = {}
    if not overwrite:
        existing = _prepare_existing_resource_index(
            audio_files,
            stored_records,
            identities_by_path,
            song_keys,
            trusted_legacy_resource_ids,
        )
    before_count = len(existing)
    stats: Dict[str, Any] = {}
    staging_path = LIBRARY_DIR / "music_index.staging.pt"
    resource_ids_by_path = {
        str(path): str((identities_by_path.get(str(path)) or {}).get("resource_id") or "")
        for path in audio_files
    }
    index = build_index(
        audio_files,
        existing,
        checkpoint_path=staging_path,
        stats=stats,
        key_resolver=lambda path: resource_ids_by_path.get(str(path), ""),
    )
    first_failure = (stats.get("failures") or [{}])[0]
    if stats.get("interrupted"):
        raise RuntimeError(f"索引任务已取消，旧索引保持不变；阶段检查点：{staging_path}")
    if int(stats.get("failed") or 0) > 0 and (overwrite or int(stats.get("embedded") or 0) == 0):
        detail = str(first_failure.get("error") or "未知读取或推理错误")
        raise RuntimeError(
            f"索引未发布：{stats.get('failed')} 首歌曲处理失败，旧索引保持不变。"
            f"首个错误：{detail}"
        )
    if not index:
        raise RuntimeError("索引未发布：没有任何歌曲成功生成向量，旧索引保持不变")

    report_progress(stage="publishing", done=len(audio_files), total=len(audio_files))
    records = _records_from_resource_index(audio_files, index, identities_by_path, song_keys)
    if not records:
        raise RuntimeError("索引未发布：没有任何歌曲具备稳定身份，旧索引保持不变")
    final_observations: list[TrackObservation] = []
    for observation in observations:
        identity = identities_by_path.get(observation.path) or {}
        record = records.get(str(identity.get("resource_id") or ""))
        final_observations.append(TrackObservation(
            path=observation.path,
            song_key=observation.song_key,
            size=observation.size,
            mtime_ns=observation.mtime_ns,
            content_fingerprint=record.content_fingerprint if record else observation.content_fingerprint,
        ))
    final_identity_result = identity_registry.reconcile(final_observations)
    if any(
        str((final_identity_result.by_path.get(path) or {}).get("resource_id") or "")
        != resource_id
        for path, resource_id in resource_ids_by_path.items()
    ):
        raise RuntimeError("索引未发布：歌曲稳定身份在任务期间发生变化")

    if vector_store.local_records_current_is_v3() and _same_local_records(stored_records, records):
        staging_path.unlink(missing_ok=True)
        return {
            "ok": True,
            "count": len(records),
            "reused": before_count,
            "added": 0,
            "failed": int(stats.get("failed") or 0),
            "saved": False,
        }
    vector_store.save_local_records(records)
    staging_path.unlink(missing_ok=True)
    return {
        "ok": True,
        "count": len(records),
        "reused": before_count,
        "added": max(0, len(records) - before_count),
        "failed": int(stats.get("failed") or 0),
        "saved": True,
    }


def online_upsert(token: str, stream_url: str) -> Dict[str, Any]:
    if not is_online_token(token):
        raise ValueError("invalid online token")
    emb = embed_online_stream(stream_url)
    index = vector_store.load_online_index()
    index[token] = (token, _tensor_to_numpy(emb))
    vector_store.save_online_index(index)
    return {"ok": True, "token": token, "count": len(index)}


def main() -> int:
    parser = argparse.ArgumentParser(description="Flowave heavy index worker")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("migrate")
    build = sub.add_parser("build")
    build.add_argument("--folder", required=True)
    build.add_argument("--folders-json", default=None)
    build.add_argument("--overwrite", action="store_true")
    online = sub.add_parser("online-upsert")
    online.add_argument("--token", required=True)
    online.add_argument("--stream-url", required=True)
    args = parser.parse_args()

    report_progress(stage="starting", device=DEVICE,
                    device_name=torch.cuda.get_device_name(0) if DEVICE == "cuda" else "CPU",
                    device_reason="" if DEVICE == "cuda" else (
                        "cpu_only" if torch.version.cuda is None else "cuda_unavailable"),
                    done=0, total=0, reused=0, embedded=0, failed=0)

    try:
        if args.cmd == "migrate":
            result = migrate_existing()
        elif args.cmd == "build":
            result = build_local(args.folder, bool(args.overwrite), json.loads(args.folders_json) if args.folders_json else None)
        elif args.cmd == "online-upsert":
            result = online_upsert(args.token, args.stream_url)
        else:
            raise RuntimeError(f"unknown command: {args.cmd}")
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
