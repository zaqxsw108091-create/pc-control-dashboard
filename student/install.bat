@echo off
chcp 65001 >nul
rem 바탕화면과 시작 메뉴에 "내 PC 관제 대시보드" 아이콘을 만듭니다. 관리자 권한이 필요 없고, PC 설정을 바꾸지 않아요.
rem 아이콘을 지우려면 uninstall.bat 을 더블클릭하세요.
cd /d "%~dp0\.."
set "NODE=node"
if exist "%~dp0node\node.exe" set "NODE=%~dp0node\node.exe"
"%NODE%" -v >nul 2>nul
if errorlevel 1 (
  echo Node.js를 찾지 못했어요. README의 3단계^(Node.js 설치^)를 먼저 해 주세요.
  pause
  exit /b 1
)
"%NODE%" student\install.mjs
echo.
pause
