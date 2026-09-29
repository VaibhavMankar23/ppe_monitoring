@echo off
REM Starts the PPE Compliance Monitor. Open http://localhost:8000 once "ready" appears.
cd /d "%~dp0backend"
"%~dp0backend_venv311\Scripts\python.exe" run.py
pause
