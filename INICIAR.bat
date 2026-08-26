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
if exist "eko-atualizar.flag" goto atualizar
echo.
echo [AVISO] O servidor encerrou (codigo %errorlevel%).
echo Reiniciando em 5 segundos... feche esta janela para parar de vez.
timeout /t 5 /nobreak >nul
goto loop

REM ===================================================================
REM  ATUALIZACAO REMOTA
REM  Disparada de outro PC por POST /sistema/atualizar. O servidor ja
REM  validou a senha de supervisor e confirmou que NAO ha sessao aberta;
REM  gravou a bandeira e encerrou. O git roda AQUI, com o node parado -
REM  a unica hora segura para trocar o codigo debaixo do sistema.
REM
REM  Se qualquer passo falhar, nada e' desfeito pela metade: o laco
REM  sobe o servidor de novo com o codigo que ja estava, e a estacao
REM  volta a trabalhar. Falhar aqui custa uma reinicializacao, nao um
REM  turno parado.
REM ===================================================================
:atualizar
del "eko-atualizar.flag" >nul 2>&1
set "LOGA=%~dp0OUTPUT_ATUALIZACAO_REMOTA.TXT"
> "%LOGA%" echo ============================================================
>>"%LOGA%" echo   ATUALIZACAO REMOTA
>>"%LOGA%" echo ============================================================
>>"%LOGA%" echo Data: %date% %time%
echo.
echo ============================================================
echo  ATUALIZACAO REMOTA SOLICITADA
echo ============================================================

if not exist "%~dp0.git" (
  echo  [AVISO] Esta pasta nao veio de um clone. Nada a atualizar.
  >>"%LOGA%" echo AVISO: pasta sem .git - nada a atualizar.
  >>"%LOGA%" echo === FIM DO DIAGNOSTICO ===
  goto atualizar_fim
)

REM ---- copia do banco, aproveitando que o servidor esta parado ----
if not exist "%~dp0backups" mkdir "%~dp0backups" >nul 2>&1
set "BKP=%~dp0backups\antes-ultima-atualizacao"
if not exist "%BKP%" mkdir "%BKP%" >nul 2>&1
copy /y "%~dp0etiquetas.db"     "%BKP%\" >nul 2>&1
copy /y "%~dp0etiquetas.db-wal" "%BKP%\" >nul 2>&1
copy /y "%~dp0etiquetas.db-shm" "%BKP%\" >nul 2>&1
echo  Banco copiado para backups\antes-ultima-atualizacao
>>"%LOGA%" echo Banco copiado para %BKP%

set "ANTES="
for /f "delims=" %%H in ('git rev-parse --short HEAD 2^>nul') do set "ANTES=%%H"
echo  Versao antes.: %ANTES%
>>"%LOGA%" echo Versao antes: %ANTES%

echo  Buscando no GitHub...
git fetch origin >>"%LOGA%" 2>&1
if errorlevel 1 (
  echo  [FALHA] Nao alcancei o GitHub. Subindo com o codigo atual.
  >>"%LOGA%" echo FALHA: git fetch nao alcancou o GitHub.
  >>"%LOGA%" echo === FIM DO DIAGNOSTICO ===
  goto atualizar_fim
)

git merge --ff-only origin/main >>"%LOGA%" 2>&1
if errorlevel 1 (
  echo  [FALHA] Nao deu para avancar em linha reta.
  echo          A estacao continua na versao %ANTES%.
  >>"%LOGA%" echo FALHA: merge --ff-only recusado - pasta divergente ou suja.
  git status --short >>"%LOGA%" 2>&1
  >>"%LOGA%" echo === FIM DO DIAGNOSTICO ===
  goto atualizar_fim
)

set "DEPOIS="
for /f "delims=" %%H in ('git rev-parse --short HEAD 2^>nul') do set "DEPOIS=%%H"
echo  Versao depois: %DEPOIS%
>>"%LOGA%" echo Versao depois: %DEPOIS%
if /I "%ANTES%"=="%DEPOIS%" (
  echo  Nada novo - ja estava na versao mais recente.
  >>"%LOGA%" echo Nada novo: ja estava atualizado.
) else (
  >>"%LOGA%" echo OK: atualizado de %ANTES% para %DEPOIS%
  git log --oneline %ANTES%..%DEPOIS% >>"%LOGA%" 2>&1
)
>>"%LOGA%" echo === FIM DO DIAGNOSTICO ===

:atualizar_fim
REM  Fecha o navegador para ele reabrir ja com a tela nova. Sem isto,
REM  mudanca de HTML ou JS so' apareceria depois de um F5 manual.
taskkill /IM chrome.exe /F >nul 2>&1
taskkill /IM msedge.exe /F >nul 2>&1
start "Abrindo navegador" /min "%~f0" abrir
echo  Subindo o servidor...
timeout /t 2 /nobreak >nul
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
