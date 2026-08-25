@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"
title Ekoplastic Pesagem - FASE 2 - Empacotar node_modules

set "LOG=%~dp0OUTPUT_EMPACOTAR_NODE_MODULES.TXT"

echo ============================================================
echo   EKOPLASTIC PESAGEM - EMPACOTAR node_modules
echo   FASE 2 - so roda se a FASE 1 tiver dado OK
echo ============================================================
echo.
echo   Este script apenas LE o node_modules e gera um pacote.
echo   Nao altera nada do sistema em producao.
echo.

> "%LOG%" echo ============================================================
>>"%LOG%" echo   EKOPLASTIC PESAGEM - EMPACOTAR node_modules - FASE 2
>>"%LOG%" echo ============================================================
>>"%LOG%" echo Data........: %date% %time%
>>"%LOG%" echo Maquina.....: %COMPUTERNAME%
>>"%LOG%" echo Pasta.......: %~dp0
>>"%LOG%" echo.

if not exist "server.js" (
  echo [FALHA] server.js nao encontrado. Pasta errada.
  >>"%LOG%" echo FALHA: pasta errada - sem server.js.
  >>"%LOG%" echo === FIM DO DIAGNOSTICO ===
  pause & exit /b 1
)
if not exist "diagnostico-serialport.js" (
  echo [FALHA] falta diagnostico-serialport.js - copie os dois arquivos.
  >>"%LOG%" echo FALHA: diagnostico-serialport.js ausente.
  >>"%LOG%" echo === FIM DO DIAGNOSTICO ===
  pause & exit /b 1
)
if not exist "node_modules" (
  echo [FALHA] nao existe node_modules nesta pasta.
  >>"%LOG%" echo FALHA: node_modules ausente.
  >>"%LOG%" echo === FIM DO DIAGNOSTICO ===
  pause & exit /b 1
)

REM ---- TRAVA: so empacota se o serialport carregar de verdade -------
echo   Reconferindo se o serialport carrega...
>>"%LOG%" echo ------------------------------------------------------------
>>"%LOG%" echo TRAVA DE SEGURANCA - o serialport carrega mesmo?
>>"%LOG%" echo ------------------------------------------------------------
node diagnostico-serialport.js --gate >>"%LOG%" 2>&1
if errorlevel 1 (
  echo.
  echo [BLOQUEADO] o serialport NAO carrega nesta pasta.
  echo             Nao faz sentido empacotar. Rode antes:
  echo             MINIPC-DIAGNOSTICO-SERIALPORT.bat
  >>"%LOG%" echo BLOQUEADO: gate falhou - nada foi empacotado.
  >>"%LOG%" echo === FIM DO DIAGNOSTICO ===
  echo.
  start "" notepad "%LOG%"
  pause & exit /b 1
)
echo   OK: serialport carrega. Liberado para empacotar.
>>"%LOG%" echo OK: gate passou - serialport carrega.
>>"%LOG%" echo.

REM ---- quantos arquivos temos que levar -----------------------------
set "NFILES=0"
for /f %%N in ('dir /s /b /a-d "node_modules" 2^>nul ^| find /c /v ""') do set "NFILES=%%N"
echo   Arquivos em node_modules: %NFILES%
>>"%LOG%" echo Arquivos em node_modules: %NFILES%

REM ---- destino ------------------------------------------------------
set "DEST=%USERPROFILE%\Desktop"
if not exist "%DEST%\" set "DEST=%~dp0."
set "TS="
for /f "delims=" %%T in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss" 2^>nul') do set "TS=%%T"
if not defined TS set "TS=pacote"
set "ZIP=%DEST%\node_modules-minipc-%TS%.zip"
set "EKO_ZIP=%ZIP%"

>>"%LOG%" echo Destino: %ZIP%
echo.
echo   Gerando o pacote...
echo   %ZIP%
echo.

REM ---- 1a opcao: tar nativo do Windows - rapido e sem limite de 260 --
REM  O Compress-Archive do PowerShell 5.1 estoura em caminho longo, que
REM  e' banal dentro de node_modules, e e' lento com milhares de arquivos.
REM  A lista e' montada FORA de qualquer bloco: variavel escrita e lida
REM  no mesmo bloco entre parenteses nao expande sem delayed expansion.
set "LISTA=node_modules package.json"
set "ITENS='node_modules','package.json'"
if exist "package-lock.json" set "LISTA=node_modules package.json package-lock.json"
if exist "package-lock.json" set "ITENS='node_modules','package.json','package-lock.json'"
>>"%LOG%" echo Itens do pacote: %LISTA%

set "FEITO="
where tar >nul 2>&1
if not errorlevel 1 (
  >>"%LOG%" echo Empacotando com tar nativo do Windows...
  tar -a -c -f "%ZIP%" %LISTA% >>"%LOG%" 2>&1
  if not errorlevel 1 if exist "%ZIP%" set "FEITO=tar"
)

if not defined FEITO (
  >>"%LOG%" echo tar nao serviu - caindo para Compress-Archive.
  echo   Usando PowerShell...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; try { Compress-Archive -Path %ITENS% -DestinationPath $env:EKO_ZIP -Force } catch { Write-Output $_.Exception.Message; exit 1 }" >>"%LOG%" 2>&1
  if exist "%ZIP%" set "FEITO=powershell"
)

if not defined FEITO (
  echo [FALHA] nao consegui gerar o pacote. Veja o relatorio.
  >>"%LOG%" echo FALHA: nem tar nem Compress-Archive geraram o pacote.
  >>"%LOG%" echo === FIM DO DIAGNOSTICO ===
  start "" notepad "%LOG%"
  pause & exit /b 1
)
>>"%LOG%" echo Metodo usado: %FEITO%
>>"%LOG%" echo.

REM ---- CONFERENCIA DE INTEGRIDADE: o pacote tem tudo mesmo? ---------
>>"%LOG%" echo ------------------------------------------------------------
>>"%LOG%" echo CONFERENCIA DO PACOTE
>>"%LOG%" echo ------------------------------------------------------------
set "NZIP=0"
where tar >nul 2>&1
if not errorlevel 1 (
  for /f %%N in ('tar -t -f "%ZIP%" 2^>nul ^| find /c /v ""') do set "NZIP=%%N"
)
>>"%LOG%" echo Entradas dentro do pacote: %NZIP%
>>"%LOG%" echo Arquivos que deveriam ir..: %NFILES%
echo   Entradas no pacote: %NZIP%  -  esperado ao menos %NFILES%

if "%NZIP%"=="0" (
  echo   AVISO: nao consegui listar o pacote para conferir.
  >>"%LOG%" echo AVISO: listagem do pacote indisponivel - confira a mao.
) else (
  if %NZIP% LSS %NFILES% (
    echo   [FALHA] o pacote tem MENOS entradas do que arquivos. Truncado.
    >>"%LOG%" echo FALHA: pacote truncado - %NZIP% entradas para %NFILES% arquivos.
    >>"%LOG%" echo NAO use este pacote. Apague e gere de novo.
    >>"%LOG%" echo === FIM DO DIAGNOSTICO ===
    start "" notepad "%LOG%"
    pause & exit /b 1
  )
  echo   OK: pacote completo.
  >>"%LOG%" echo OK: pacote completo.
)

>>"%LOG%" echo.
for %%F in ("%ZIP%") do >>"%LOG%" echo Arquivo: %%~nxF   %%~zF bytes
for %%F in ("%ZIP%") do echo   Gerado: %%~nxF - %%~zF bytes

>>"%LOG%" echo.
>>"%LOG%" echo SHA256 - confira no PC de Pesagem para garantir que o
>>"%LOG%" echo arquivo chegou inteiro:
certutil -hashfile "%ZIP%" SHA256 >>"%LOG%" 2>&1

>>"%LOG%" echo.
>>"%LOG%" echo ------------------------------------------------------------
>>"%LOG%" echo COMO LEVAR PARA O PC DE PESAGEM
>>"%LOG%" echo ------------------------------------------------------------
>>"%LOG%" echo 1. Pen drive, ou
>>"%LOG%" echo 2. copia pela rede - as duas maquinas estao na mesma LAN e
>>"%LOG%" echo    no Tailscale, ou
>>"%LOG%" echo 3. qualquer pasta compartilhada que voce ja use.
>>"%LOG%" echo.
>>"%LOG%" echo No PC de Pesagem, arraste este arquivo para cima do icone
>>"%LOG%" echo do INGERIR-NODE-MODULES.bat - ele faz o resto.
>>"%LOG%" echo.
>>"%LOG%" echo === FIM DO DIAGNOSTICO ===

echo.
echo ============================================================
echo   PACOTE PRONTO
echo.
echo   %ZIP%
echo.
echo   No PC de Pesagem, arraste este arquivo para cima do icone
echo   do INGERIR-NODE-MODULES.bat
echo ============================================================
echo.
start "" notepad "%LOG%"
pause
exit /b 0
