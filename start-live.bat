@echo off
cd /d "%~dp0"
node src\start.js --live --interval 1500
pause
