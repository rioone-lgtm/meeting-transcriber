@echo off
cd /d "%~dp0"

echo Starting meeting transcriber server...

start "Meeting Transcriber - close this window to stop" cmd /k "python -m http.server 3333"

timeout /t 2 /nobreak >nul
start "" "http://localhost:3333/"
exit
