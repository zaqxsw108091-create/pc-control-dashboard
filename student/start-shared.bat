@echo off
chcp 65001 >nul
rem 학원처럼 여러 사람이 쓰는 PC용: 조회 기록을 파일에 남기지 않고 창을 닫으면 사라지게 켭니다.
cd /d "%~dp0\.."
set "NODE=node"
if exist "%~dp0node\node.exe" set "NODE=%~dp0node\node.exe"
"%NODE%" -v >nul 2>nul
if errorlevel 1 (
  echo Node.js를 찾지 못했어요. student\README.md 의 "Node.js가 없는 PC" 안내를 보세요.
  pause
  exit /b 1
)
"%NODE%" student\server.mjs --open --no-save
if errorlevel 1 pause
