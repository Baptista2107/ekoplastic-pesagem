@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"
title Ekoplastic Pesagem - Atualizar o Mini PC

REM ===================================================================
REM  RODA NO MINI PC, na pasta clonada do GitHub.
REM  Traz a versao nova do codigo. NAO toca no banco: etiquetas.db nao
REM  e' versionado, entao o git pull nem enxerga o arquivo.
REM  Mesmo assim faz copia dos tres arquivos do banco antes, porque
REM  backup barato vale mais que confianca.
REM ===================================================================

set "LOG=%~dp0OUTPUT_ATUALIZAR.TXT"
set "URLSAUDE=http://localhost:3000/healthcheck"

> "%LOG%" echo ============================================================
call :L "  EKOPLASTIC PESAGEM - ATUALIZAR A ESTACAO"
call :L "============================================================"
call :L "Data..: %date% %time%"
call :L "Pasta.: %~dp0"
call :L ""

REM ================= FASE 0 =================
call :L "------------------------------------------------------------"
call :L "FASE 0 - VERIFICACOES"
call :L "------------------------------------------------------------"
git --version >>"%LOG%" 2>&1
if errorlevel 1 ( call :L "FALHA: Git nao respondeu." & goto :parar )
if not exist "server.js" ( call :L "FALHA: pasta errada - sem server.js." & goto :parar )
git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 ( call :L "FALHA: esta pasta nao veio de um clone do GitHub." & goto :parar )
set "REMOTO="
for /f "delims=" %%R in ('git remote get-url origin 2^>nul') do set "REMOTO=%%R"
if not defined REMOTO ( call :L "FALHA: sem remote origin." & goto :parar )
call :L "OK 1/4: pasta clonada de %REMOTO%"

REM ---- o servidor TEM que estar parado ----
curl -s -o nul --max-time 3 "%URLSAUDE%" >nul 2>&1
if not errorlevel 1 (
  call :L "FALHA: o sistema ainda esta rodando."
  echo.
  echo ============================================================
  echo  O SISTEMA AINDA ESTA NO AR.
  echo.
  echo  Encerre primeiro pela propria tela do sistema, confirme que
  echo  a janela preta do INICIAR fechou, e rode este .bat de novo.
  echo.
  echo  Atualizar com o servidor de pe' pode trocar o codigo debaixo
  echo  de uma operacao em andamento.
  echo ============================================================
  goto :parar
)
call :L "OK 2/4: servidor parado."

set "SUJO=0"
for /f %%N in ('git status --porcelain ^| find /c /v ""') do set "SUJO=%%N"
if not "%SUJO%"=="0" (
  call :L "FALHA: ha %SUJO% arquivo alterado nesta pasta."
  call :L "O Mini PC nao edita codigo. Se alguem mexeu, descarte com:"
  call :L "   git checkout -- ."
  git status --short >>"%LOG%" 2>&1
  git status --short
  goto :parar
)
call :L "OK 3/4: nenhuma alteracao local."

call :L "Buscando novidades no GitHub..."
git fetch origin >>"%LOG%" 2>&1
if errorlevel 1 ( call :L "FALHA: nao alcancei o GitHub. Rede ou deploy key." & goto :parar )

set "NOVOS=0"
for /f %%N in ('git rev-list --count HEAD..origin/main 2^>nul') do set "NOVOS=%%N"
if "%NOVOS%"=="0" (
  call :L "OK 4/4: ja esta na versao mais nova. Nada a fazer."
  call :L "=== FIM DO DIAGNOSTICO ==="
  echo.
  echo  Ja esta atualizado. Pode subir o sistema normalmente.
  echo.
  pause
  exit /b 0
)
call :L "OK 4/4: ha %NOVOS% versao nova para aplicar."
call :L ""

REM ================= FASE 1 - O QUE VEM =================
call :L "------------------------------------------------------------"
call :L "FASE 1 - O QUE VAI ENTRAR"
call :L "------------------------------------------------------------"
git log --oneline HEAD..origin/main >>"%LOG%" 2>&1
git diff --name-status HEAD origin/main >>"%LOG%" 2>&1
echo.
echo ------------------------------------------------------------
echo  Versoes que vao entrar:
echo ------------------------------------------------------------
git log --oneline HEAD..origin/main
echo.
echo  Arquivos afetados:
git diff --name-only HEAD origin/main
echo ------------------------------------------------------------
echo.
echo ============================================================
echo  Nada foi alterado ate' aqui.
echo  Pressione uma tecla para APLICAR, ou feche para cancelar.
echo ============================================================
pause >nul

REM ================= FASE 2 - BACKUP DO BANCO =================
call :L "------------------------------------------------------------"
call :L "FASE 2 - COPIA DE SEGURANCA DO BANCO"
call :L "------------------------------------------------------------"
set "TS="
for /f "delims=" %%T in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss" 2^>nul') do set "TS=%%T"
if not defined TS set "TS=antes-pull"
set "DESTINO=%~dp0backups\antes-pull-%TS%"
if not exist "%~dp0backups" mkdir "%~dp0backups" >nul 2>&1
mkdir "%DESTINO%" >nul 2>&1

call :L "Destino: %DESTINO%"
call :L "Os TRES arquivos vao juntos. O -wal guarda o que ainda nao foi"
call :L "gravado dentro do .db; copiar so' o .db perde dado."
set "FALTOU="
for %%F in (etiquetas.db etiquetas.db-wal etiquetas.db-shm) do call :copiar "%%F"
if defined FALTOU (
  call :L "FALHA: nao consegui copiar o banco. Nada foi atualizado."
  goto :parar
)
call :L "OK: banco copiado."
call :L ""

REM ================= FASE 3 - TRAZER O CODIGO =================
call :L "------------------------------------------------------------"
call :L "FASE 3 - TRAZENDO O CODIGO NOVO"
call :L "------------------------------------------------------------"
git merge --ff-only origin/main >>"%LOG%" 2>&1
if errorlevel 1 (
  call :L "FALHA: o codigo local divergiu do GitHub e nao da' para"
  call :L "avancar em linha reta. NAO forcei nada."
  call :L "A estacao continua na versao anterior - pode subir normal."
  goto :parar
)
set "SHA="
for /f "delims=" %%H in ('git rev-parse --short HEAD 2^>nul') do set "SHA=%%H"
call :L "OK: agora na versao %SHA%"
call :L ""

REM ================= FASE 4 - SUBIR E CONFERIR =================
call :L "------------------------------------------------------------"
call :L "FASE 4 - SUBINDO O SISTEMA"
call :L "------------------------------------------------------------"
start "" "%~dp0INICIAR.bat"
call :L "INICIAR.bat disparado. Aguardando o sistema responder..."

set /a _t=0
:esperar
timeout /t 2 /nobreak >nul
set /a _t+=1
curl -s -o nul --max-time 3 "%URLSAUDE%" >nul 2>&1
if not errorlevel 1 goto :subiu
if %_t% lss 20 goto :esperar

call :L "FALHA: o sistema nao respondeu em 40 segundos."
call :L ""
call :L "VOLTAR ATRAS - feche a janela do INICIAR e rode, nesta pasta:"
call :L "   git checkout v157"
call :L "   INICIAR.bat"
call :L "Troque v157 pela tag da ultima versao que funcionava."
goto :parar

:subiu
call :L "OK: o sistema respondeu."
call :L ""
call :L "Healthcheck - confira a versao e as contagens:"
curl -s "%URLSAUDE%" >>"%LOG%" 2>&1
echo.
echo ------------------------------------------------------------
curl -s "%URLSAUDE%"
echo.
echo ------------------------------------------------------------
call :L ""
call :L "------------------------------------------------------------"
call :L "RESULTADO: ATUALIZADO na versao %SHA%."
call :L "------------------------------------------------------------"
call :L ""
call :L "Confira na tela: pese uma vez e imprima uma etiqueta antes de"
call :L "liberar o turno. Se algo estiver errado:"
call :L "   git checkout v157   e   INICIAR.bat"
call :L ""
call :L "Copia do banco antes desta atualizacao:"
call :L "   %DESTINO%"
call :L ""
call :L "=== FIM DO DIAGNOSTICO ==="
echo.
start "" notepad "%LOG%"
echo.
pause
exit /b 0

:copiar
if not exist "%~dp0%~1" (
  call :L "  AVISO: %~1 nao existe - pulando."
  exit /b 0
)
copy /y "%~dp0%~1" "%DESTINO%\%~1" >nul 2>&1
if errorlevel 1 ( call :L "  ERRO ao copiar %~1" & set "FALTOU=1" & exit /b 1 )
call :L "  copiado: %~1"
exit /b 0

:parar
call :L ""
call :L "*** INTERROMPIDO ***"
call :L "=== FIM DO DIAGNOSTICO ==="
echo.
start "" notepad "%LOG%"
echo.
pause
exit /b 1

:L
echo(%~1
>>"%LOG%" echo(%~1
exit /b 0
