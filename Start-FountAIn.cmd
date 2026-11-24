@echo off
setlocal
cd /d "%~dp0"
set "FOUNTAIN_LAUNCHER=%~f0"
npm start
endlocal
