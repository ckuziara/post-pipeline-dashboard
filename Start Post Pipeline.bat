@echo off
REM Double-click to launch the Post Pipeline dashboard in your browser.
start "" http://localhost:8771/
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1" -Port 8771
