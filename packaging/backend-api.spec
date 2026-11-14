# -*- mode: python ; coding: utf-8 -*-

from PyInstaller.utils.hooks import collect_submodules, copy_metadata, collect_dynamic_libs, collect_data_files
from pathlib import Path
import sys


hiddenimports = collect_submodules("uvicorn")
# Preserve upstream copyright and license files through PyInstaller metadata.
metadata = []
for package in ("fastapi", "uvicorn", "numpy", "tinytag", "pymediainfo"):
    metadata.extend(copy_metadata(package, recursive=True))
metadata.extend(collect_data_files('pymediainfo', includes=['License.html']))
python_license = Path(sys.base_prefix) / "LICENSE.txt"
if not python_license.is_file():
    raise RuntimeError("The bundled Python license is missing")
metadata.append((str(python_license), "licenses/python"))

a = Analysis(
    ["../backend_launcher.py"],
    pathex=[".."],
    binaries=collect_dynamic_libs('pymediainfo'),
    datas=metadata,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["torch", "torchaudio", "transformers", "mutagen"],
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
