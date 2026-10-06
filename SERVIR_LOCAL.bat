@echo off
rem Abre o painel em http://127.0.0.1:8080/ para testar antes de publicar.
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js nao encontrado. Instale a versao LTS em https://nodejs.org e tente de novo.
  pause
  exit /b 1
)
start "" "http://127.0.0.1:8080/"
node tools\servir.mjs 8080
