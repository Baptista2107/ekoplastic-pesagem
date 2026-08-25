@echo off
chcp 65001 >nul
cd /d "%~dp0"

REM ===================================================================
REM  PORTA DA BALANCA: a balanca esta na COM1 do Mini PC.
REM  (confira as portas em http://localhost:3000/balanca/portas)
set EKO_SERIAL_PORT=COM1
REM ===================================================================

if "%~1"=="abrir" goto abrir

REM --- Garante dependencias na 1a vez (node-forge p/ HTTPS da rede) ---
if not exist "node_modules\node-forge" (
  echo Instalando dependencias pela primeira vez, aguarde...
  call npm install
)

REM --- Evita duas instancias: se o servidor JA responde, so abre a tela ---
curl -s -o nul http://localhost:3000/healthcheck >nul 2>&1
if not errorlevel 1 (
  echo O servidor ja esta rodando. Abrindo apenas a tela...
  start "" /min "%~f0" abrir
  timeout /t 2 /nobreak >nul
  exit /b
)

title Ekoplastic - Servidor de Etiquetas
start "Abrindo navegador" /min "%~f0" abrir

:loop
echo ============================================================
echo  EKOPLASTIC - Iniciando servidor...  (%date% %time%)
echo  (se cair por erro, reinicia automaticamente)
echo ============================================================
node server.js
if exist "eko-encerrar.flag" (
  del "eko-encerrar.flag" >nul 2>&1
  exit
)
echo.
echo [AVISO] O servidor encerrou (codigo %errorlevel%).
echo Reiniciando em 5 segundos... feche esta janela para parar de vez.
timeout /t 5 /nobreak >nul
goto loop

:abrir
REM Espera o servidor responder
set _t=0
:esperar
timeout /t 1 /nobreak >nul
set /a _t+=1
curl -s -o nul http://localhost:3000/healthcheck >nul 2>&1
if not errorlevel 1 goto abriu
if %_t% lss 15 goto esperar

:abriu
set "URL=http://localhost:3000"

REM --- Abre como APP (sem barra de endereco). A tela cheia e ligada
set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if exist "%CHROME%" (
  start "" "%CHROME%" --app=%URL% --start-maximized --no-first-run --no-default-browser-check --overscroll-history-navigation=0 --disable-gpu-compositing
  exit /b
)

REM --- Fallback: Microsoft Edge em quiosque ---
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE%" (
  start "" "%EDGE%" --app=%URL% --start-maximized --no-first-run --disable-gpu-compositing
  exit /b
)

REM --- Ultimo fallback: navegador padrao (sem quiosque) ---
start "" "%URL%"
exit /b
