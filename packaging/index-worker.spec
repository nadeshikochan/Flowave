# -*- mode: python ; coding: utf-8 -*-

from PyInstaller.utils.hooks import collect_submodules


hiddenimports = collect_submodules("nnAudio") + [
    "transformers.models.hubert",
    "transformers.models.hubert.configuration_hubert",
    "transformers.models.hubert.modeling_hubert",
    "transformers.models.wav2vec2",
    "transformers.models.wav2vec2.configuration_wav2vec2",
    "transformers.models.wav2vec2.feature_extraction_wav2vec2",
]
datas = []

a = Analysis(
    ["../index_worker.py"],
    pathex=[".."],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=1,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="index-worker",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="index-worker",
)
