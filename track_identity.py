from __future__ import annotations

import copy
import json
import os
import re
import shutil
import time
import uuid
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path, PureWindowsPath
from threading import RLock
from typing import Any, Callable, Iterable, Mapping, Optional

from audio_payload_fingerprint import is_audio_payload_identity


SCHEMA_VERSION = 1
MAX_ALIASES = 32
_WINDOWS_PATH_RE = re.compile(r"^[A-Za-z]:[\\/]")


class TrackIdentityError(RuntimeError):
    pass


@dataclass(frozen=True)
class TrackObservation:
    path: str
    song_key: str = ""
    size: int = 0
    mtime_ns: int = 0
    content_fingerprint: str = ""


@dataclass(frozen=True)
class TrackIdentityReconcileResult:
    by_path: dict[str, dict[str, Any]]
    relocations: list[dict[str, str]]
    created: int
    restored: int
    changed: bool


def normalize_resource_path(raw_path: str) -> str:
    raw = str(raw_path or "").strip()
    if not raw:
        return ""
    if _WINDOWS_PATH_RE.match(raw) or "\\" in raw:
        return str(PureWindowsPath(raw)).casefold()
    try:
        return os.path.normcase(str(Path(raw).expanduser().resolve(strict=False)))
    except Exception:
        return os.path.normcase(os.path.abspath(raw))


def _unique_aliases(
    values: Iterable[str],
    *,
    current: str = "",
    path_values: bool = False,
) -> list[str]:
    current_norm = (
        normalize_resource_path(current)
        if path_values and current
        else str(current or "").strip().casefold()
    )
    out: list[str] = []
    seen: set[str] = set()
    for value in values:
        text = str(value or "").strip()
        if not text:
            continue
        normalized = normalize_resource_path(text) if path_values else text.casefold()
        if not normalized or normalized == current_norm or normalized in seen:
            continue
        seen.add(normalized)
        out.append(text)
    return out[-MAX_ALIASES:]


def _empty_payload() -> dict[str, Any]:
    return {"version": SCHEMA_VERSION, "revision": 0, "tracks": {}}


def _coerce_entry(resource_id: str, raw: Any) -> dict[str, Any]:
    if not isinstance(raw, Mapping):
        raise TrackIdentityError("歌曲身份条目格式无效")
    resource_id = str(resource_id or raw.get("resource_id") or "").strip()
    if not resource_id:
        raise TrackIdentityError("歌曲身份缺少 resource_id")
    current_path = str(raw.get("current_path") or "").strip()
    current_song_key = str(raw.get("current_song_key") or "").strip()
    return {
        "resource_id": resource_id,
        "current_path": current_path,
        "path_aliases": _unique_aliases(
            raw.get("path_aliases") if isinstance(raw.get("path_aliases"), list) else [],
            current=current_path,
            path_values=True,
        ),
        "current_song_key": current_song_key,
        "song_key_aliases": _unique_aliases(
            raw.get("song_key_aliases") if isinstance(raw.get("song_key_aliases"), list) else [],
            current=current_song_key,
        ),
        "content_fingerprint": str(raw.get("content_fingerprint") or "").strip(),
        "size": max(0, int(raw.get("size") or 0)),
        "mtime_ns": max(0, int(raw.get("mtime_ns") or 0)),
        "missing": bool(raw.get("missing", False)),
        **({"trashed": True} if raw.get("trashed") is True else {}),
        "created_at": max(0.0, float(raw.get("created_at") or 0.0)),
        "updated_at": max(0.0, float(raw.get("updated_at") or 0.0)),
    }


def _coerce_payload(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, Mapping):
        raise TrackIdentityError("歌曲身份文件顶层格式无效")
    version = int(raw.get("version") or 0)
    if version != SCHEMA_VERSION:
        raise TrackIdentityError(f"不支持的歌曲身份版本：{version}")
    raw_tracks = raw.get("tracks")
    if not isinstance(raw_tracks, Mapping):
        raise TrackIdentityError("歌曲身份文件缺少 tracks")
    tracks: dict[str, dict[str, Any]] = {}
    active_paths: set[str] = set()
    for raw_id, raw_entry in raw_tracks.items():
        entry = _coerce_entry(str(raw_id), raw_entry)
        resource_id = entry["resource_id"]
        if resource_id in tracks:
            raise TrackIdentityError("歌曲身份文件存在重复 resource_id")
        current_path_key = normalize_resource_path(entry["current_path"])
        if current_path_key and not entry["missing"]:
            if current_path_key in active_paths:
                raise TrackIdentityError("歌曲身份文件存在重复活动路径")
            active_paths.add(current_path_key)
        tracks[resource_id] = entry
    return {
        "version": SCHEMA_VERSION,
        "revision": max(0, int(raw.get("revision") or 0)),
        "tracks": tracks,
    }


class TrackIdentityRegistry:
    def __init__(
        self,
        path: Path,
        *,
        id_factory: Optional[Callable[[], str]] = None,
        clock: Optional[Callable[[], float]] = None,
    ) -> None:
        self.path = Path(path)
        self.previous_path = self.path.with_name(f"{self.path.name}.previous")
        self._id_factory = id_factory or (lambda: uuid.uuid4().hex)
        self._clock = clock or time.time
        self._lock = RLock()
        self._payload = _empty_payload()
        self.recovered_from_previous = False
        self.write_blocked_reason = ""
        self._skip_backup_once = False
        self._load()

    def _read_payload(self, path: Path) -> dict[str, Any]:
        return _coerce_payload(json.loads(path.read_text(encoding="utf-8")))

    def _archive_corrupt(self, path: Path) -> None:
        try:
            corrupt_dir = self.path.parent / "track-identities-corrupt"
            corrupt_dir.mkdir(parents=True, exist_ok=True)
            stamp = time.strftime("%Y%m%d-%H%M%S")
            target = corrupt_dir / f"{stamp}-{uuid.uuid4().hex[:8]}-{path.name}"
            shutil.copy2(path, target)
        except Exception:
            pass

    def _load(self) -> None:
        with self._lock:
            if not self.path.exists():
                self._payload = _empty_payload()
                return
            try:
                self._payload = self._read_payload(self.path)
                return
            except Exception as current_error:
                self._archive_corrupt(self.path)
                if self.previous_path.exists():
                    try:
                        self._payload = self._read_payload(self.previous_path)
                        self.recovered_from_previous = True
                        self._skip_backup_once = True
                        return
                    except Exception:
                        self._archive_corrupt(self.previous_path)
                self.write_blocked_reason = f"歌曲身份数据无法恢复：{current_error}"
                self._payload = _empty_payload()

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return copy.deepcopy(self._payload)

    def mark_trashed(self, resource_id: str, path: str) -> None:
        with self._lock:
            payload = copy.deepcopy(self._payload)
            entry = payload["tracks"].get(resource_id)
            if not entry or entry["current_path"] != path:
                raise TrackIdentityError("歌曲身份已变化")
            if entry.get("trashed"):
                return
            entry.update(missing=True, trashed=True, updated_at=float(self._clock()))
            payload["revision"] += 1
            self._save_locked(payload)

    def trashed_resource_ids(self) -> set[str]:
        with self._lock:
            return {rid for rid, entry in self._payload["tracks"].items() if entry.get("trashed")}

    def status(self) -> dict[str, Any]:
        with self._lock:
            return {
                "ok": not bool(self.write_blocked_reason),
                "recovered": bool(self.recovered_from_previous),
                "write_blocked": bool(self.write_blocked_reason),
                "reason": self.write_blocked_reason,
                "revision": int(self._payload.get("revision") or 0),
                "count": len(self._payload.get("tracks") or {}),
            }

    def _save_locked(self, payload: dict[str, Any]) -> None:
        if self.write_blocked_reason:
            raise TrackIdentityError(self.write_blocked_reason)
        payload = _coerce_payload(payload)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        staged = self.path.with_name(f".{self.path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
        try:
            staged.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            self._read_payload(staged)
            if self.path.exists() and not self._skip_backup_once:
                shutil.copy2(self.path, self.previous_path)
            os.replace(staged, self.path)
            self._skip_backup_once = False
            self.recovered_from_previous = False
            self._payload = payload
        finally:
            staged.unlink(missing_ok=True)

    def _new_entry(self, observation: TrackObservation, now: float) -> dict[str, Any]:
        resource_id = str(self._id_factory() or "").strip()
        if not resource_id:
            raise TrackIdentityError("无法生成 resource_id")
        return {
            "resource_id": resource_id,
            "current_path": observation.path,
            "path_aliases": [],
            "current_song_key": observation.song_key,
            "song_key_aliases": [],
            "content_fingerprint": observation.content_fingerprint,
            "size": max(0, int(observation.size)),
            "mtime_ns": max(0, int(observation.mtime_ns)),
            "missing": False,
            "created_at": now,
            "updated_at": now,
        }

    @staticmethod
    def _coerce_observation(raw: TrackObservation | Mapping[str, Any]) -> TrackObservation:
        if isinstance(raw, TrackObservation):
            observation = raw
        elif isinstance(raw, Mapping):
            observation = TrackObservation(
                path=str(raw.get("path") or ""),
                song_key=str(raw.get("song_key") or ""),
                size=int(raw.get("size") or 0),
                mtime_ns=int(raw.get("mtime_ns") or 0),
                content_fingerprint=str(raw.get("content_fingerprint") or ""),
            )
        else:
            raise TrackIdentityError("歌曲身份观察值格式无效")
        if not normalize_resource_path(observation.path):
            raise TrackIdentityError("歌曲身份观察值缺少路径")
        return TrackObservation(
            path=str(observation.path).strip(),
            song_key=str(observation.song_key or "").strip(),
            size=max(0, int(observation.size)),
            mtime_ns=max(0, int(observation.mtime_ns)),
            content_fingerprint=str(observation.content_fingerprint or "").strip(),
        )

    def reconcile(
        self,
        observations: Iterable[TrackObservation | Mapping[str, Any]],
        *,
        allow_song_key_relocation: bool = True,
        relocation_resource_ids: Optional[Mapping[str, str]] = None,
    ) -> TrackIdentityReconcileResult:
        with self._lock:
            if self.write_blocked_reason:
                raise TrackIdentityError(self.write_blocked_reason)
            normalized_observations: list[TrackObservation] = []
            seen_paths: set[str] = set()
            for raw in observations:
                observation = self._coerce_observation(raw)
                path_key = normalize_resource_path(observation.path)
                if path_key in seen_paths:
                    continue
                seen_paths.add(path_key)
                normalized_observations.append(observation)

            payload = copy.deepcopy(self._payload)
            tracks = payload["tracks"]
            before = json.dumps(payload, ensure_ascii=False, sort_keys=True)
            now = float(self._clock())
            used_ids: set[str] = set()
            by_current_path: dict[str, list[str]] = defaultdict(list)
            by_fingerprint: dict[str, list[str]] = defaultdict(list)
            by_song_key: dict[str, list[str]] = defaultdict(list)
            for resource_id, entry in tracks.items():
                current_key = normalize_resource_path(entry.get("current_path") or "")
                if current_key:
                    by_current_path[current_key].append(resource_id)
                if entry.get("trashed"):
                    continue
                fingerprint = str(entry.get("content_fingerprint") or "").strip()
                if not is_audio_payload_identity(fingerprint):
                    fingerprint = ""
                if fingerprint:
                    by_fingerprint[fingerprint].append(resource_id)
                song_keys = [entry.get("current_song_key") or "", *(entry.get("song_key_aliases") or [])]
                for song_key in {str(value).strip() for value in song_keys if str(value).strip()}:
                    by_song_key[song_key].append(resource_id)

            observed_song_key_counts = Counter(
                observation.song_key for observation in normalized_observations if observation.song_key
            )
            observed_paths = {normalize_resource_path(observation.path) for observation in normalized_observations}
            relocations: list[dict[str, str]] = []
            by_path: dict[str, dict[str, Any]] = {}
            created = 0
            restored = 0
            relocation_hints = {
                normalize_resource_path(path): str(resource_id or "").strip()
                for path, resource_id in (relocation_resource_ids or {}).items()
                if normalize_resource_path(path) and str(resource_id or "").strip()
            }

            for observation in normalized_observations:
                path_key = normalize_resource_path(observation.path)
                resource_id = ""
                hinted_resource_id = relocation_hints.get(path_key, "")
                if hinted_resource_id and hinted_resource_id not in used_ids and hinted_resource_id in tracks:
                    hinted_entry = tracks[hinted_resource_id]
                    hinted_path = normalize_resource_path(hinted_entry.get("current_path") or "")
                    # 调用方只可把当前未观察到的旧路径重定位到新路径；已被本轮观察占用的
                    # 身份仍按精确路径处理，避免提示覆盖另一首实际存在的歌曲。
                    if not hinted_entry.get("trashed") and hinted_path != path_key and hinted_path not in observed_paths:
                        resource_id = hinted_resource_id
                exact_candidates = [value for value in by_current_path.get(path_key, []) if value not in used_ids]
                if not resource_id and len(exact_candidates) == 1:
                    candidate = tracks[exact_candidates[0]]
                    old_fingerprint = str(candidate.get("content_fingerprint") or "")
                    if not is_audio_payload_identity(old_fingerprint):
                        old_fingerprint = ""
                    if candidate.get("trashed"):
                        if old_fingerprint and observation.content_fingerprint:
                            matches = old_fingerprint == observation.content_fingerprint
                        else:
                            matches = observation.size == candidate["size"] and observation.mtime_ns == candidate["mtime_ns"]
                    else:
                        matches = not old_fingerprint or not observation.content_fingerprint or old_fingerprint == observation.content_fingerprint
                    if matches:
                        resource_id = exact_candidates[0]

                if not resource_id and observation.content_fingerprint:
                    fingerprint_candidates = [
                        value for value in by_fingerprint.get(observation.content_fingerprint, []) if value not in used_ids
                    ]
                    if len(fingerprint_candidates) == 1:
                        resource_id = fingerprint_candidates[0]

                if (
                    not resource_id
                    and allow_song_key_relocation
                    and observation.song_key
                    and observed_song_key_counts[observation.song_key] == 1
                ):
                    key_candidates = [
                        value
                        for value in by_song_key.get(observation.song_key, [])
                        if value not in used_ids
                        and normalize_resource_path(tracks[value].get("current_path") or "") not in observed_paths
                    ]
                    if len(key_candidates) == 1:
                        resource_id = key_candidates[0]

                if resource_id:
                    entry = tracks[resource_id]
                    old_path = str(entry.get("current_path") or "")
                    old_song_key = str(entry.get("current_song_key") or "")
                    old_size = max(0, int(entry.get("size") or 0))
                    old_mtime_ns = max(0, int(entry.get("mtime_ns") or 0))
                    was_missing = bool(entry.get("missing"))
                    if old_path and normalize_resource_path(old_path) != path_key:
                        entry["path_aliases"] = _unique_aliases(
                            [*(entry.get("path_aliases") or []), old_path],
                            current=observation.path,
                            path_values=True,
                        )
                        relocations.append({
                            "resource_id": resource_id,
                            "from": old_path,
                            "to": observation.path,
                        })
                    if old_song_key and old_song_key != observation.song_key:
                        entry["song_key_aliases"] = _unique_aliases(
                            [*(entry.get("song_key_aliases") or []), old_song_key],
                            current=observation.song_key,
                        )
                    next_fingerprint = observation.content_fingerprint or entry.get("content_fingerprint") or ""
                    if (
                        not observation.content_fingerprint
                        and (old_size or old_mtime_ns)
                        and (old_size != observation.size or old_mtime_ns != observation.mtime_ns)
                    ):
                        next_fingerprint = ""
                    updates = {
                        "current_path": observation.path,
                        "current_song_key": observation.song_key,
                        "content_fingerprint": next_fingerprint,
                        "size": observation.size,
                        "mtime_ns": observation.mtime_ns,
                        "missing": False,
                    }
                    if any(entry.get(key) != value for key, value in updates.items()):
                        updates["updated_at"] = now
                    entry.update(updates)
                    entry.pop("trashed", None)
                    if was_missing:
                        restored += 1
                else:
                    entry = self._new_entry(observation, now)
                    resource_id = entry["resource_id"]
                    while resource_id in tracks:
                        entry = self._new_entry(observation, now)
                        resource_id = entry["resource_id"]
                    tracks[resource_id] = entry
                    created += 1

                used_ids.add(resource_id)
                by_path[observation.path] = copy.deepcopy(entry)

            for resource_id, entry in tracks.items():
                if resource_id in used_ids:
                    continue
                current_path = str(entry.get("current_path") or "")
                if current_path and normalize_resource_path(current_path) in observed_paths:
                    entry["path_aliases"] = _unique_aliases(
                        [*(entry.get("path_aliases") or []), current_path],
                        path_values=True,
                    )
                    entry["current_path"] = ""
                if not entry.get("missing"):
                    entry["missing"] = True
                    entry["updated_at"] = now

            after_without_revision = json.dumps(payload, ensure_ascii=False, sort_keys=True)
            changed = before != after_without_revision
            if changed:
                payload["revision"] = int(payload.get("revision") or 0) + 1
                self._save_locked(payload)
            return TrackIdentityReconcileResult(
                by_path=by_path,
                relocations=relocations,
                created=created,
                restored=restored,
                changed=changed,
            )

    def record_tag_change(
        self,
        *,
        resource_id: str,
        path: str,
        previous_song_key: str,
        next_song_key: str,
        size: int,
        mtime_ns: int,
        content_fingerprint: str = "",
    ) -> dict[str, Any]:
        with self._lock:
            if self.write_blocked_reason:
                raise TrackIdentityError(self.write_blocked_reason)
            payload = copy.deepcopy(self._payload)
            entry = payload["tracks"].get(str(resource_id or ""))
            if not entry:
                raise TrackIdentityError("歌曲身份不存在")
            if normalize_resource_path(entry.get("current_path") or "") != normalize_resource_path(path):
                raise TrackIdentityError("歌曲路径与 resource_id 不匹配")
            current_song_key = str(entry.get("current_song_key") or "")
            if previous_song_key and current_song_key and previous_song_key != current_song_key:
                raise TrackIdentityError("歌曲标签已被其他操作修改")
            if previous_song_key and previous_song_key != next_song_key:
                entry["song_key_aliases"] = _unique_aliases(
                    [*(entry.get("song_key_aliases") or []), previous_song_key],
                    current=next_song_key,
                )
            entry.update({
                "current_song_key": str(next_song_key or "").strip(),
                "content_fingerprint": str(content_fingerprint or entry.get("content_fingerprint") or "").strip(),
                "size": max(0, int(size)),
                "mtime_ns": max(0, int(mtime_ns)),
                "missing": False,
                "updated_at": float(self._clock()),
            })
            payload["revision"] = int(payload.get("revision") or 0) + 1
            self._save_locked(payload)
            return copy.deepcopy(entry)
