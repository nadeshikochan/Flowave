from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping, Optional, Protocol

from audio_payload_fingerprint import is_audio_payload_identity
from tag_commit_reconciler import TagCommitIdentityRequest
from tag_transaction import TagAdapter, TagTransactionManager, TagWriteRequest


class IdentityReconciler(Protocol):
    def reconcile(self, request: TagCommitIdentityRequest) -> Mapping[str, Any]: ...


@dataclass(frozen=True)
class TagWritePipelineRequest:
    write: TagWriteRequest
    previous_song_key: str


class TagWritePipeline:
    def __init__(
        self,
        *,
        transactions: TagTransactionManager,
        identities: IdentityReconciler,
        song_key_builder: Callable[[Mapping[str, Any]], str],
        invalidate_metadata: Optional[Callable[[dict[str, str]], Any]] = None,
        on_committed: Optional[Callable[[dict[str, str]], Any]] = None,
    ) -> None:
        self.transactions = transactions
        self.identities = identities
        self.song_key_builder = song_key_builder
        self.invalidate_metadata = invalidate_metadata
        self.on_committed = on_committed

    @staticmethod
    def _warning(stage: str) -> dict[str, str]:
        return {"stage": stage, "message": "后续刷新将在稍后重试"}

    @staticmethod
    def _audio_payload_identity(value: Mapping[str, Any]) -> str:
        raw = value if isinstance(value, Mapping) else {}
        identity = ":".join([
            str(raw.get("algorithm") or ""),
            str(raw.get("format") or ""),
            str(int(raw.get("bytes_hashed") or 0)),
            str(raw.get("sha256") or ""),
        ])
        return identity if is_audio_payload_identity(identity) else ""

    def _song_key(self, manifest, fields_key):
        fields = dict(manifest.get(fields_key) or {})
        if not fields.get("title"):
            fields["title"] = Path(str(manifest.get("path") or "")).stem
        return str(self.song_key_builder(fields) or "").strip()

    def execute(self, request: TagWritePipelineRequest, adapter: TagAdapter) -> dict[str, Any]:
        manifest = self.transactions.write(request.write, adapter)
        return self._finish_committed(manifest, previous_song_key=request.previous_song_key)

    def _finish_committed(self, manifest: Mapping[str, Any], *, previous_song_key: str) -> dict[str, Any]:
        transaction_id = str(manifest.get("transaction_id") or "")
        resource_id = str(manifest.get("resource_id") or "")
        target = str(manifest.get("path") or "")
        after = manifest.get("after") or {}
        next_song_key = self._song_key(manifest, "after_fields")
        warnings: list[dict[str, str]] = []
        metadata_pending = False

        invalidation = {"transactionId": transaction_id, "resourceId": resource_id, "trackPath": target}
        if self.invalidate_metadata is not None:
            try:
                self.invalidate_metadata(invalidation)
            except Exception:
                metadata_pending = True
                warnings.append(self._warning("metadata"))

        reconcile_request = TagCommitIdentityRequest(
            transaction_id=transaction_id,
            resource_id=resource_id,
            path=target,
            previous_song_key=str(previous_song_key or "").strip(),
            next_song_key=next_song_key,
            size=int(after.get("size") or 0),
            mtime_ns=int(after.get("mtime_ns") or 0),
            content_fingerprint=self._audio_payload_identity(after.get("audio_payload") or {}),
        )
        try:
            if (
                not reconcile_request.transaction_id
                or not reconcile_request.resource_id
                or not reconcile_request.next_song_key
                or not reconcile_request.content_fingerprint
            ):
                raise ValueError("标签提交缺少身份对账证据")
            reconciled = dict(self.identities.reconcile(reconcile_request))
        except Exception:
            return {
                "ok": True,
                "status": "committed-pending-reconcile",
                "transactionId": transaction_id,
                "resourceId": resource_id,
                "warnings": [*warnings, self._warning("identity")],
            }

        notification = {
            "transactionId": transaction_id,
            "resourceId": resource_id,
            "songKey": next_song_key,
        }
        if self.on_committed is not None:
            try:
                self.on_committed(notification)
            except Exception:
                warnings.append(self._warning("notification"))
        if metadata_pending:
            return {
                "ok": True,
                "status": "committed-pending-refresh",
                "transactionId": transaction_id,
                "resourceId": resource_id,
                "songKey": next_song_key,
                "reconciled": str(reconciled.get("status") or "reconciled"),
                "warnings": warnings,
            }
        try:
            self.transactions.mark_post_commit_complete(transaction_id)
        except Exception:
            warnings.append(self._warning("manifest"))
        return {
            "ok": True,
            "status": "committed",
            "transactionId": transaction_id,
            "resourceId": resource_id,
            "songKey": next_song_key,
            "reconciled": str(reconciled.get("status") or "reconciled"),
            "warnings": warnings,
        }

    def undo(self, manifest_path: Path | str) -> dict[str, Any]:
        manifest = self.transactions.undo(manifest_path)
        return self._finish_undone(manifest)

    def _finish_undone(self, manifest: Mapping[str, Any]) -> dict[str, Any]:
        transaction_id = str(manifest.get("transaction_id") or "")
        resource_id = str(manifest.get("resource_id") or "")
        target = str(manifest.get("path") or "")
        restored = manifest.get("restored") or {}
        previous_song_key = self._song_key(manifest, "after_fields")
        restored_song_key = self._song_key(manifest, "before_fields")
        warnings: list[dict[str, str]] = []
        metadata_pending = False

        invalidation = {"transactionId": transaction_id, "resourceId": resource_id, "trackPath": target}
        if self.invalidate_metadata is not None:
            try:
                self.invalidate_metadata(invalidation)
            except Exception:
                metadata_pending = True
                warnings.append(self._warning("metadata"))

        reconcile_request = TagCommitIdentityRequest(
            transaction_id=f"{transaction_id}-undo",
            resource_id=resource_id,
            path=target,
            previous_song_key=previous_song_key,
            next_song_key=restored_song_key,
            size=int(restored.get("size") or 0),
            mtime_ns=int(restored.get("mtime_ns") or 0),
            content_fingerprint=self._audio_payload_identity(restored.get("audio_payload") or {}),
        )
        try:
            if (
                not transaction_id
                or not resource_id
                or not target
                or not previous_song_key
                or not restored_song_key
                or not reconcile_request.content_fingerprint
            ):
                raise ValueError("撤销缺少身份对账证据")
            reconciled = dict(self.identities.reconcile(reconcile_request))
        except Exception:
            return {
                "ok": True,
                "status": "undone-pending-reconcile",
                "transactionId": transaction_id,
                "resourceId": resource_id,
                "warnings": [*warnings, self._warning("identity")],
            }

        notification = {
            "transactionId": transaction_id,
            "resourceId": resource_id,
            "songKey": restored_song_key,
        }
        if self.on_committed is not None:
            try:
                self.on_committed(notification)
            except Exception:
                warnings.append(self._warning("notification"))
        if metadata_pending:
            return {
                "ok": True,
                "status": "undone-pending-refresh",
                "transactionId": transaction_id,
                "resourceId": resource_id,
                "songKey": restored_song_key,
                "reconciled": str(reconciled.get("status") or "reconciled"),
                "warnings": warnings,
            }
        try:
            self.transactions.mark_post_undo_complete(transaction_id)
        except Exception:
            warnings.append(self._warning("manifest"))
        return {
            "ok": True,
            "status": "undone",
            "transactionId": transaction_id,
            "resourceId": resource_id,
            "songKey": restored_song_key,
            "reconciled": str(reconciled.get("status") or "reconciled"),
            "warnings": warnings,
        }

    def recover_pending(self) -> list[dict[str, Any]]:
        self.transactions.recover_incomplete()
        outcomes: list[dict[str, Any]] = []
        for manifest in self.transactions.pending_post_commits():
            previous_song_key = self._song_key(manifest, "before_fields")
            outcomes.append(self._finish_committed(manifest, previous_song_key=previous_song_key))
        for manifest in self.transactions.pending_post_undos():
            outcomes.append(self._finish_undone(manifest))
        return outcomes


__all__ = ["TagWritePipeline", "TagWritePipelineRequest"]
