@echo off
chcp 65001 >nul
rem 예제 값으로 켭니다. 화면에 "예제"라고 표시되고, 실제 PC는 읽지 않아요.
cd /d "%~dp0\.."
set "NODE=node"
if exist "%~dp0node\node.exe" set "NODE=%~dp0node\node.exe"
"%NODE%" -v >nul 2>nul
if errorlevel 1 (
  echo Node.js를 찾지 못했어요. student\README.md 의 "Node.js가 없는 PC" 안내를 보세요.
  pause
  exit /b 1
)
"%NODE%" student\server.mjs --demo --open --no-save
pause
