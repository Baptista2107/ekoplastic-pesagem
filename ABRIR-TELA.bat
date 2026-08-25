@echo off
chcp 65001 >nul
cd /d "%~dp0"

REM ===================================================================
REM  ABRIR-TELA: reabre SOMENTE o navegador (perfil limpo), SEM mexer
REM  no servidor que ja esta rodando. Use quando precisar recarregar a
REM  tela (ex: depois de uma atualizacao) sem reiniciar o Mini PC e sem
REM  perder a sessao em andamento -- ela continua salva no servidor.
REM ===================================================================

set "URL=http://localhost:3000"

REM Confere se o servidor esta no ar; se nao estiver, avisa.
curl -s -o nul http://localhost:3000/healthcheck >nul 2>&1
if errorlevel 1 (
  echo [AVISO] O servidor nao respondeu em %URL%.
  echo Se o sistema nao estiver rodando, use o INICIAR.bat normal.
  echo.
  pause
  exit /b
)

REM Perfil dedicado + limpeza de cache (garante a versao atual da tela)
set "PERFIL=%~dp0navegador-eko"
rmdir /s /q "%PERFIL%\Default\Cache"      >nul 2>&1
rmdir /s /q "%PERFIL%\Default\Code Cache" >nul 2>&1
rmdir /s /q "%PERFIL%\Default\GPUCache"   >nul 2>&1
rmdir /s /q "%PERFIL%\ShaderCache"        >nul 2>&1

set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if exist "%CHROME%" (
  start "" "%CHROME%" --app=%URL% --user-data-dir="%PERFIL%" --start-maximized --no-first-run --no-default-browser-check --overscroll-history-navigation=0 --disable-gpu-compositing
  exit /b
)

set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE%" (
  start "" "%EDGE%" --app=%URL% --user-data-dir="%PERFIL%" --start-maximized --no-first-run --disable-gpu-compositing
  exit /b
)

start "" "%URL%"
exit /b
