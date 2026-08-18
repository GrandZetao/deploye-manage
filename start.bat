@echo off
chcp 65001 >nul
set PORT=3000

echo 正在启动部署管理服务...
node server.js
pause
