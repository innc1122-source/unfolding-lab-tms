@echo off
cd /d "%~dp0"
echo Running the automated test suite on throwaway databases in the system temp folder (lms.db and config.json are never opened or modified; the scale smoke copies lms.db to temp only when it is the 925-person fake test set with an empty -wal)...
rem Same steps as npm test (scripts\run-tests.js), one after the other: [1/3] TMS tests, [2/3] module tests,
rem [3/3] Serial: the 4,000-person scale smoke and the office-convert timing tests on their own (their timing limits assume no other test process is running).
"%~dp0runtime\node.exe" "%~dp0scripts\run-tests.js"
set RC=%ERRORLEVEL%
if not "%RC%"=="0" set RC=1
echo.
if "%RC%"=="0" (echo All tests passed.) else (echo Some tests FAILED - see the step summary above.)
rem The window stays open when double-clicked; the exit code (0 = all passed, 1 = something failed) is for callers.
pause
exit /b %RC%
