@echo off
setlocal
pushd %~dp0
chcp 65001 >nul
where npm >nul 2>nul
if errorlevel 1 (
  echo 未找到 npm。开发运行请先安装 Node.js LTS。
  pause
  exit /b 1
)
cd electron-lxplayer
set ELECTRON_RUN_AS_NODE=
npm start
popd
pause
