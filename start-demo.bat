@echo off
cd /d "%~dp0"
rem Unfolding Lab TMS - demo. First run builds data\demo-unfolding.db (100 fictional employees, courses, review cycles).
set PORT=8790
set LMS_DB_PATH=%~dp0data\demo-unfolding.db
rem Demo config: brand + non-production, no secrets. Production uses config.json (see config.json.example).
set LMS_CONFIG_PATH=%~dp0config.demo.json
if not exist "%LMS_DB_PATH%" (
  echo First run: generating demo data, about 30 seconds...
  "%~dp0runtime\node.exe" scripts\make-demo-db.js
  if errorlevel 1 ( echo Demo data generation failed. & pause & exit /b 1 )
)
echo Unfolding Lab TMS (demo) - open http://localhost:8790   Test account: UL-TEST / Demo1234 (all features)   Admin: ADMIN / unfolding888   Employees: password Demo1234
echo Press Ctrl+C to stop.
"%~dp0runtime\node.exe" server.js
pause