@echo off
chcp 65001 >nul
rem 더블클릭으로 켜는 단축 파일입니다. 설치 프로그램이 아니고 PC 설정을 바꾸지 않아요. 관리자 권한도 필요 없어요.
rem 공용 PC라서 기록을 남기고 싶지 않으면 이 줄 끝의 %* 자리에 --no-save 를 쓰는 start-shared.bat 을 쓰세요.
cd /d "%~dp0\.."
set "NODE=node"
if exist "%~dp0node\node.exe" set "NODE=%~dp0node\node.exe"
"%NODE%" -v >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js를 찾지 못했어요. 설치 없이 쓰는 방법:
  echo   1. https://nodejs.org/en/download 에서 Windows Binary ^(.zip^) 를 받아요
  echo   2. 압축을 풀고, 안의 파일들을 student\node 폴더에 옮겨요 ^(student\node\node.exe 가 되게^)
  echo   3. 이 파일을 다시 더블클릭해요
  echo.
  pause
  exit /b 1
)
"%NODE%" student\server.mjs --open %*
if errorlevel 1 pause
