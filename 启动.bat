@echo off
chcp 65001 >nul
title 反向开单器 · 控制台
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [!] 没找到 Node.js
  echo.
  echo   这个工具需要 Node.js 才能运行，装一次就行：
  echo   https://nodejs.org  下载 LTS 版本，一路下一步
  echo.
  echo   装完后关掉这个窗口，重新双击「启动.bat」
  echo.
  pause
  exit /b 1
)

echo.
echo   正在启动控制台，浏览器会自动打开...
echo   如果没打开，手动访问下面的地址
echo.

node src\ui\server.js

echo.
echo   控制台已关闭。
pause
