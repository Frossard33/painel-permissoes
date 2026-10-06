@echo off
rem Atualiza data\usuarios.enc.json lendo os usuarios ativos do ERP pela API (somente leitura).
rem Pede a senha do painel no terminal. Depois publique: git add data, git commit, git push.
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js nao encontrado. Instale a versao LTS em https://nodejs.org e tente de novo.
  pause
  exit /b 1
)
node tools\atualizar-dados.mjs %*
set RESULTADO=%ERRORLEVEL%
echo.
pause
exit /b %RESULTADO%
