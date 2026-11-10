@echo off
cd /d "%~dp0"
echo Starting Unfolding Lab TMS ...
echo Open http://localhost:8780 in your browser. Press Ctrl+C to stop.
set PORT=8780
set LMS_NO_DEMO_USERS=1
"%~dp0runtime\node.exe" server.js
pause
