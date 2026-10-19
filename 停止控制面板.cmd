@echo off
cd /d "%~dp0"
node scripts\manage-panel.mjs stop
if errorlevel 1 pause
