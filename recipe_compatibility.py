"""Recognize legacy recipe hashes differing only in text line endings.

Do not rewrite provenance or accept changed code/models. Raw recipe generation
stays unchanged so in-flight workers retain their exact publication contract.
"""
import hashlib
from functools import lru_cache
from pathlib import Path


@lru_cache(maxsize=4)
def _newline_variants(prefix, contents):
    digests = [hashlib.sha256(prefix.encode())]
    for raw in contents:
        lf = raw.replace(b'\r\n', b'\n')
        variants = set((raw, lf, lf.replace(b'\n', b'\r\n')))
        following = []
        for digest in digests:
            for value in variants:
                copied = digest.copy()
                copied.update(value)
                following.append(copied)
        digests = following
    return frozenset(d.hexdigest() for d in digests)


def equivalent_recipes(root, current, target='tags'):
    """Only current inputs, preserving content and per-file boundaries exactly."""
    root = Path(root)
    if target == 'tags':
        from analysis_vocab import VERSION
        prefix = VERSION
        names = ['analysis_features.py', 'analysis_vocab.py', 'analysis_audio.py',
                 'music_analysis_worker.py', 'models/Essentia-tagging/download-manifest.json',
                 'models/MuQ-MuLan-download.json']
        optional = 'data/components/music-analysis/manifest.json'
        if (root / optional).is_file():
            names.append(optional)
    elif target == 'structure':
        from music_structure import RECIPE_ID
        prefix = RECIPE_ID
        names = ['music_structure.py', 'analysis_audio.py', 'music_structure_engine.py',
                 'music_structure_worker.py', 'data/components/music-structure/manifest.json']
    else:
        raise ValueError('Unknown analysis recipe target')
    try:
        contents = tuple((root / name).read_bytes() for name in names)
    except OSError:
        return frozenset((current,))
    raw = hashlib.sha256(prefix.encode())
    for value in contents:
        raw.update(value)
    # Also fail closed when inputs changed after the caller obtained its recipe.
    if raw.hexdigest() != current:
        return frozenset((current,))
    return _newline_variants(prefix, contents)


def accepted_recipes(current, edges, equivalents=()):
    accepted = {current, *equivalents}
    for _ in range(len(edges) + 1):
        expanded = accepted | {old for old, new in edges if new in accepted}
        if expanded == accepted:
            break
        accepted = expanded
    return accepted
