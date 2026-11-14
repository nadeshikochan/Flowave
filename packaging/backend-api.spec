# -*- mode: python ; coding: utf-8 -*-

from PyInstaller.utils.hooks import collect_submodules, copy_metadata
from pathlib import Path
import sys


hiddenimports = collect_submodules("uvicorn")
# Preserve upstream copyright and license files through PyInstaller metadata.
metadata = []
for package in ("fastapi", "uvicorn", "numpy", "mutagen"):
    metadata.extend(copy_metadata(package, recursive=True))
python_license = Path(sys.base_prefix) / "LICENSE.txt"
if not python_license.is_file():
    raise RuntimeError("The bundled Python license is missing")
metadata.append((str(python_license), "licenses/python"))

a = Analysis(
    ["../backend_launcher.py"],
    pathex=[".."],
    binaries=[],
    datas=metadata,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["torch", "torchaudio", "transformers"],
    noarchive=False,
    optimize=1,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="api",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
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
    upx=False,
    upx_exclude=[],
    name="api",
)
