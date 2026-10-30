"""Explicit metadata edits using the existing reversible file and identity transactions."""
import secrets
import time
from pathlib import Path

from tag_metadata_adapter import MetadataTagAdapter, clean_updates
from tag_transaction import TagTransactionManager, TagWriteRequest, capture_file_version
from tag_write_pipeline import TagWritePipeline, TagWritePipelineRequest
from music_keys import build_artist_title_key


class TagEditService:
    def __init__(self, snapshot_root, identities, *, now=time.time):
        self.adapter = MetadataTagAdapter()
        self.transactions = TagTransactionManager(snapshot_root)
        self.pipeline = TagWritePipeline(transactions=self.transactions, identities=identities,
            song_key_builder=lambda fields: build_artist_title_key(next(iter(fields.get("artists") or fields.get("albumArtists") or []), ""), fields.get("title") or ""))
        self.pending = {}
        self.now = now

    def prepare(self, path, resource_id, updates):
        self.pending = {key: item for key, item in self.pending.items() if item["expires"] > self.now()}
        if len(self.pending) >= 32:
            raise ValueError("待确认修改过多，请关闭旧窗口后重试")
        target = Path(path).resolve(strict=True)
        updates = clean_updates(updates)
        expected = capture_file_version(target)
        before = self.adapter.read(target)
        if not self.transactions._same_expected(expected, capture_file_version(target)):
            raise ValueError("文件在读取时发生变化，请重试")
        updates = {key: value for key, value in updates.items() if value != before.fields[key]}
        if not updates:
            return {"ok": True, "status": "unchanged"}
        token = secrets.token_urlsafe(32)
        self.pending[token] = {"path": target, "id": resource_id, "updates": updates,
            "expected": expected, "previous_key": build_artist_title_key(next(iter(before.fields["artists"] or before.fields["albumArtists"]), ""), before.fields["title"] or target.stem),
            "expires": self.now() + 3600}
        return {"ok": True, "confirmationId": token, "changes": [
            {"field": key, "current": before.fields[key], "proposed": value} for key, value in updates.items()]}

    def commit(self, token):
        item = self.pending.pop(str(token), None)
        if not item or item["expires"] <= self.now():
            raise ValueError("修改确认已过期，请重新保存")
        request = TagWriteRequest(item["path"], item["updates"], item["expected"], resource_id=item["id"], provider="user-confirmed")
        return self.pipeline.execute(TagWritePipelineRequest(request, item["previous_key"]), self.adapter)

    def undo(self, transaction_id):
        transaction_id = self.transactions._validate_transaction_id(transaction_id)
        return self.pipeline.undo(self.transactions.snapshot_root / transaction_id / "manifest.json")

    def cancel(self, token):
        self.pending.pop(str(token), None)
