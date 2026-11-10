@echo off
cd /d "%~dp0"
echo ============================================================
echo  Unfolding Lab TMS - page-by-page smoke check
echo ============================================================
echo.
echo  Opens every page in headless Edge and checks for: error-boundary blank pages,
echo  literal null/undefined, page-wide horizontal scroll, table overflow, untranslated
echo  English in the Chinese UI, console errors and failed requests.
echo  Add --layout to also check layout: overflowing text, line length, off-centre
echo  buttons, large empty areas, cards nested in cards.
echo.
if "%~1"=="" (
  echo  Tell it which server to check - it no longer defaults to 8767. Three ways:
  echo.
  echo    smoke.bat --boot=backups\lms-YYYYMMDD-HHMMSS.db --accounts=D:\smoke-accounts.json --lang=both
  echo        Starts a throwaway server on a COPY of that backup. Nothing is written to the live
  echo        database. Recommended for go-live checks.
  echo    smoke.bat --base=http://127.0.0.1:8767 --live-ok --accounts=D:\smoke-accounts.json --lang=both
  echo        Checks the running server directly. It signs in, so it writes sessions and login audit rows.
  echo    smoke.bat --boot
  echo        Fresh empty database plus the review-v2 fixture. Developer self-check, no accounts file needed.
  echo.
  echo  The accounts file format is in docs\HANDOVER-IT.md section 7.2. Keep it outside the
  echo  program folder and delete it afterwards.
  echo.
  pause
  exit /b 2
)
"%~dp0runtime\node.exe" scripts\smoke.js --json=smoke-report.json %*
set SMOKE_RC=%ERRORLEVEL%
echo.
echo  Details: smoke-report.json. Exit code %SMOKE_RC%: 0 = no fail, 1 = something failed,
echo  2 = the script could not run - arguments, browser or server.
echo  Both languages: add --lang=both. Layout: add --layout --viewport=1440x900,390x844
echo.
pause
exit /b %SMOKE_RC%
