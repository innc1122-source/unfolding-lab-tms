@echo off
cd /d "%~dp0"
echo Backing up the LMS database...
"%~dp0runtime\node.exe" scripts\backup.js
pause
