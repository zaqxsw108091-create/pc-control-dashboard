@echo off
chcp 65001 >nul
rem 바탕화면과 시작 메뉴의 "내 PC 관제 대시보드" 아이콘을 지웁니다. 프로그램 폴더와 기록은 그대로 둬요.
cd /d "%~dp0\.."
set "NODE=node"
if exist "%~dp0node\node.exe" set "NODE=%~dp0node\node.exe"
"%NODE%" -v >nul 2>nul
if errorlevel 1 (
  echo Node.js를 찾지 못했어요.
  pause
  exit /b 1
)
"%NODE%" student\install.mjs --uninstall
echo.
pause
