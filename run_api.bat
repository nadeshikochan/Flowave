@echo off
setlocal
pushd %~dp0
chcp 65001 >nul
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
python -m uvicorn api:app --host 127.0.0.1 --port 29613 --workers 1
popd
pause
