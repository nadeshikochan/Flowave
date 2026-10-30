"""Optional GAME evidence capture. No model imports in the service process."""
from contextlib import contextmanager
import hashlib
import json
import math
import zlib

MAX_BYTES = 32 * 1024 * 1024


def analysis_digest(payload):
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)
    return hashlib.sha256(raw.encode('utf-8')).hexdigest()


@contextmanager
def capture_game(model):
    """Observe original logits without changing decoding, RNG, or return values."""
    network = model.model
    previous = {name: network.__dict__.get(name) for name in ('forward_segmentation', 'forward_estimation')}
    originals = {name: getattr(network, name) for name in previous}
    captured = {}

    def segmentation(*args, **kwargs):
        output = originals['forward_segmentation'](*args, **kwargs)
        captured['boundary_logits'] = output[0].detach()
        return output

    def estimation(*args, **kwargs):
        output = originals['forward_estimation'](*args, **kwargs)
        captured['pitch_logits'] = output.detach()
        return output

    network.forward_segmentation = segmentation
    network.forward_estimation = estimation
    try:
        yield captured
    finally:
        for name, value in previous.items():
            if value is None:
                delattr(network, name)
            else:
                setattr(network, name, value)


def evidence_chunk(captured, durations, presence, pitches, offset, length, timestep):
    boundary = captured['boundary_logits'].float().sigmoid()[0].cpu().tolist()
    scores = captured['pitch_logits'].float().sigmoid()[0].cpu().tolist()
    regions = []
    at = 0.0
    for duration, voiced, pitch in zip(durations, presence, pitches):
        end = min(at + float(duration), length)
        regions.append([offset + min(at, length), offset + end, float(pitch), bool(voiced)])
        at += float(duration)
    return dict(start=offset, end=offset + length, timestep=timestep,
                boundary_activation=boundary, pitch_activation=scores, regions=regions)


def validate_evidence(evidence, payload):
    if evidence.get('schema') != 1 or evidence.get('analysis_sha256') != analysis_digest(payload):
        raise ValueError('旋律证据与演奏结果不匹配。')
    provenance = payload.get('provenance', {})
    for key in ('source_sha256', 'vocal_sha256', 'component_manifest_sha256'):
        if not provenance.get(key) or evidence.get(key) != provenance[key]:
            raise ValueError('旋律证据来源不匹配。')
    chunks = evidence.get('chunks')
    if not isinstance(chunks, list) or len(chunks) > 3600:
        raise ValueError('旋律证据片段无效。')
    previous = -1.0
    voiced_notes = []
    for chunk in chunks:
        start, end, step = chunk['start'], chunk['end'], chunk['timestep']
        if (not all(isinstance(v, (int, float)) and math.isfinite(v) for v in (start, end, step))
                or start < previous or not 0 <= start < end <= payload['duration'] + .1 or not .001 <= step <= .1):
            raise ValueError('旋律证据时间轴无效。')
        previous = end
        boundary = chunk['boundary_activation']
        if abs(len(boundary) * step - (end - start)) > .1:
            raise ValueError('旋律边界证据长度无效。')
        scores, regions = chunk['pitch_activation'], chunk['regions']
        if len(scores) != len(regions) or len(regions) > 100000:
            raise ValueError('旋律区域证据无效。')
        if any(not isinstance(row, list) or len(row) != 257 for row in scores):
            raise ValueError('旋律音高证据维度无效。')
        for value in boundary:
            if not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 1:
                raise ValueError('旋律边界激活无效。')
        for row in scores:
            if any(not isinstance(v, (int, float)) or not math.isfinite(v) or not 0 <= v <= 1 for v in row):
                raise ValueError('旋律音高激活无效。')
        at = start
        for row in regions:
            if not isinstance(row, list) or len(row) != 4 or not isinstance(row[3], bool):
                raise ValueError('旋律区域无效。')
            a, b, pitch, voiced = row
            if (not all(isinstance(v, (int, float)) and math.isfinite(v) for v in (a, b, pitch))
                    or abs(a - at) > .001 or b < a or b > end + .001 or not 0 <= pitch <= 128):
                raise ValueError('旋律区域时间无效。')
            at = b
            if voiced and b > a:
                voiced_notes.append([a, min(b, payload['duration']), pitch])
        if abs(at - end) > .03:
            raise ValueError('旋律区域未覆盖音频。')
    if len(voiced_notes) != len(payload['notes']):
        raise ValueError('旋律区域与原始音符不匹配。')
    for region, note in zip(voiced_notes, payload['notes']):
        if any(abs(a - b) > .001 for a, b in zip(region, note[:3])):
            raise ValueError('旋律区域与原始音符不一致。')


def encode_evidence(evidence, payload):
    validate_evidence(evidence, payload)
    raw = json.dumps(evidence, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')
    if len(raw) > MAX_BYTES:
        raise ValueError('旋律证据超过保存上限。')
    return zlib.compress(raw, level=6)


def decode_evidence(blob, payload):
    decoder = zlib.decompressobj()
    raw = decoder.decompress(blob, MAX_BYTES + 1)
    if len(raw) > MAX_BYTES or not decoder.eof or decoder.unused_data:
        raise ValueError('旋律证据损坏或超过上限。')
    value = json.loads(raw)
    validate_evidence(value, payload)
    return value
