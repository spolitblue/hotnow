@echo off
chcp 65001 >nul
title HotNow · 全网热榜
cd /d "%~dp0"

echo.
echo   ============================================
echo     HotNow · 全网热榜  本地服务启动中...
echo   ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [错误] 没有检测到 Node.js。
  echo.
  echo   方案一：安装 Node.js https://nodejs.org/  然后重新双击本文件
  echo   方案二：直接双击 index.html 也能用（直连上游 API）
  echo.
  pause
  exit /b 1
)

node server.mjs

echo.
echo   服务已退出。
pause
