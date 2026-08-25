@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"
title Ekoplastic Pesagem - FASE 1 - Diagnostico do serialport

set "LOG=%~dp0OUTPUT_DIAGNOSTICO_SERIALPORT.TXT"

echo ============================================================
echo   EKOPLASTIC PESAGEM - DIAGNOSTICO DO SERIALPORT
echo   FASE 1 - SOMENTE LEITURA
echo   Secao 4.4 do HANDOFF_MIGRACAO_PESAGEM.md
echo ============================================================
echo.
echo   Este script NAO instala, NAO copia, NAO apaga nada.
echo   NAO abre a porta da balanca - so consulta a lista de portas
echo   do Windows. Pode rodar com o sistema de pesagem ligado.
echo.
echo   Pasta analisada:
echo   %~dp0
echo.

> "%LOG%" echo ============================================================
>>"%LOG%" echo   EKOPLASTIC PESAGEM - DIAGNOSTICO DO SERIALPORT - FASE 1
>>"%LOG%" echo   Secao 4.4 do HANDOFF_MIGRACAO_PESAGEM.md
>>"%LOG%" echo ============================================================
>>"%LOG%" echo Data........: %date% %time%
>>"%LOG%" echo Maquina.....: %COMPUTERNAME%
>>"%LOG%" echo Usuario.....: %USERNAME%
>>"%LOG%" echo Pasta.......: %~dp0
>>"%LOG%" echo.

REM ---- FASE 0 - pre-requisitos ------------------------------------
>>"%LOG%" echo ------------------------------------------------------------
>>"%LOG%" echo FASE 0 - PRE-REQUISITOS
>>"%LOG%" echo ------------------------------------------------------------

if not exist "server.js" (
  echo [FALHA] server.js nao encontrado nesta pasta.
  echo         Copie este .bat para DENTRO da pasta do sistema de
  echo         pesagem em producao e rode de novo.
  >>"%LOG%" echo FALHA: server.js nao encontrado - pasta errada.
  >>"%LOG%" echo === FIM DO DIAGNOSTICO ===
  echo.
  pause
  exit /b 1
)
echo   OK: server.js encontrado.
>>"%LOG%" echo OK: server.js encontrado - pasta correta.

if not exist "diagnostico-serialport.js" (
  echo [FALHA] falta o arquivo diagnostico-serialport.js.
  echo         Ele vem junto com este .bat. Copie os DOIS.
  >>"%LOG%" echo FALHA: diagnostico-serialport.js ausente.
  >>"%LOG%" echo === FIM DO DIAGNOSTICO ===
  echo.
  pause
  exit /b 1
)
echo   OK: diagnostico-serialport.js encontrado.
>>"%LOG%" echo OK: diagnostico-serialport.js encontrado.

where node >nul 2>&1
if errorlevel 1 (
  echo [FALHA] o Node nao esta no PATH desta maquina.
  >>"%LOG%" echo FALHA: node nao encontrado no PATH.
  >>"%LOG%" echo === FIM DO DIAGNOSTICO ===
  echo.
  pause
  exit /b 1
)
echo   OK: Node encontrado.
>>"%LOG%" echo OK: node encontrado no PATH.

>>"%LOG%" echo.
>>"%LOG%" echo npm --version:
call npm --version >>"%LOG%" 2>&1
>>"%LOG%" echo.
>>"%LOG%" echo git --version:
git --version >>"%LOG%" 2>&1
>>"%LOG%" echo.

echo.
echo   Rodando o diagnostico...
echo.

node diagnostico-serialport.js
set "RC=%ERRORLEVEL%"

echo.
echo ============================================================
if "%RC%"=="0" (
  echo   RESULTADO: esta maquina TEM o serialport funcionando.
  echo.
  echo   Proximo passo: rodar nesta mesma pasta
  echo      MINIPC-EMPACOTAR-NODE-MODULES.bat
  echo   para gerar o zip que vai para o PC de Pesagem.
) else (
  echo   RESULTADO: esta maquina NAO carrega o serialport.
  echo.
  echo   NAO empacote nada. Mande o relatorio para analise.
)
echo ============================================================
echo.
echo   Relatorio salvo em:
echo   %LOG%
echo.

start "" notepad "%LOG%"
pause
exit /b %RC%
