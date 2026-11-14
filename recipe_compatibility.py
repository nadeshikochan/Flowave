"""Recognize reviewed path-only adaptations and text line endings.

Result provenance stays intact. Every accepted digest retains the current
inference content and model manifests. In-flight publication keeps its raw recipe.
"""
import hashlib
from functools import lru_cache
from pathlib import Path
from resource_runtime import asset_path, recipe_asset_path, source_path, catalog
from runtime_paths import resolve_data_dir

# These substitutions restore the preceding release's resource lookups. They
# retain every inference statement and current model manifest in the digest.
_PREVIOUS_RESOURCE_LOOKUPS = {
    'analysis_audio.py': (
        ("asset_path(root,'data/components/ffmpeg/ffmpeg.exe')", "root/'data/components/ffmpeg/ffmpeg.exe'"),
    ),
    'music_analysis_worker.py': (
        ('from resource_runtime import asset_path\n', ''),
        ("asset_path(ROOT,'data/components/music-analysis/python')", "ROOT/'data/components/music-analysis/python'"),
    ),
    'music_structure_engine.py': (
        ("asset_path(ROOT,'data/cache/analysis-audio')", "ROOT/'data/cache/analysis-audio'"),
    ),
}


@lru_cache(maxsize=4)
def _newline_variants(prefix, contents):
    digests = [hashlib.sha256(prefix.encode())]
    for alternatives in contents:
        variants = set()
        for raw in alternatives:
            lf = raw.replace(b'\r\n', b'\n')
            variants.update((raw, lf, lf.replace(b'\n', b'\r\n')))
        following = []
        for digest in digests:
            for value in variants:
                copied = digest.copy()
                copied.update(value)
                following.append(copied)
        digests = following
    return frozenset(d.hexdigest() for d in digests)


def equivalent_recipes(root, current, target='tags'):
    """Current inputs plus audited path lookups, preserving model identities."""
    root = Path(root)
    if target == 'tags':
        from analysis_vocab import VERSION
        prefix = VERSION
        names = ['analysis_features.py', 'analysis_vocab.py', 'analysis_audio.py',
                 'music_analysis_worker.py', 'models/Essentia-tagging/download-manifest.json',
                 'models/MuQ-MuLan-download.json']
        optional = 'data/components/music-analysis/manifest.json'
        if recipe_asset_path(root,optional).is_file():
            names.append(optional)
    elif target == 'structure':
        from music_structure import RECIPE_ID
        prefix = RECIPE_ID
        names = ['music_structure.py', 'analysis_audio.py', 'music_structure_engine.py',
                 'music_structure_worker.py', 'data/components/music-structure/manifest.json']
    else:
        raise ValueError('Unknown analysis recipe target')
    try:
        metadata = recipe_asset_path if target == 'tags' else asset_path
        contents = tuple((metadata(root,name) if name.startswith(("models/","data/")) else source_path(root,name)).read_bytes() for name in names)
    except OSError:
        return frozenset((current,))
    raw = hashlib.sha256(prefix.encode())
    for value in contents:
        raw.update(value)
    # Also fail closed when inputs changed after the caller obtained its recipe.
    if raw.hexdigest() != current:
        return frozenset((current,))
    alternatives = []
    reviewed_metadata = catalog(root).get('recipe_metadata_compatibility', []) if target == 'tags' else []
    data = resolve_data_dir(root)
    for name, value in zip(names, contents):
        previous = value.replace(b'\r\n', b'\n')
        for new, old in _PREVIOUS_RESOURCE_LOOKUPS.get(name, ()):
            previous = previous.replace(new.encode(), old.encode())
        options = [value, previous]
        # Reviewed metadata pairs retain identical model files and provider code.
        # Serialization differences alone must not invalidate saved analyses.
        if reviewed_metadata:
            legacy_files = (data / name[5:],) if name.startswith('data/') else (
                data / 'components/resources/legacy' / name, root / name)
            for pair in reviewed_metadata:
                if pair['path'] != name or hashlib.sha256(value).hexdigest() != pair['current_sha256']:
                    continue
                for legacy in legacy_files:
                    if legacy.is_file():
                        raw = legacy.read_bytes()
                        if len(raw) == pair['legacy_bytes'] and hashlib.sha256(raw).hexdigest() == pair['legacy_sha256']:
                            options.append(raw)
        alternatives.append(tuple(options))
    return _newline_variants(prefix, tuple(alternatives))


def accepted_recipes(current, edges, equivalents=()):
    accepted = {current, *equivalents}
    for _ in range(len(edges) + 1):
        expanded = accepted | {old for old, new in edges if new in accepted}
        if expanded == accepted:
            break
        accepted = expanded
    return accepted
