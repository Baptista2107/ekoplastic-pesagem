@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"
title Ekoplastic Pesagem - Sincronizar com o GitHub
REM ===================================================================
REM  RODA NO PC DE QUEM DESENVOLVE, na pasta clonada do GitHub
REM  (a mesma do ENVIAR-ATUALIZACAO.bat). NAO roda no Mini PC - la'
REM  quem atualiza e' o ATUALIZAR.bat.
REM
REM  Para que serve: o ENVIAR-ATUALIZACAO.bat recusa enviar quando o
REM  GitHub tem commit que voce nao tem ("Alguem publicou algo"). Isso
REM  acontece quando outra pessoa (ou a VPS) publicou enquanto voce
REM  trabalhava. Este script TRAZ o que falta sem perder o seu trabalho:
REM
REM    1. guarda uma copia de tudo que e' seu, ANTES de mexer:
REM         - branch de seguranca com os seus commits
REM         - arquivo .patch com as suas alteracoes nao commitadas
REM         - stash com as mesmas alteracoes
REM    2. traz o GitHub (avanco direto, ou rebase se voce tem commit local)
REM    3. devolve as suas alteracoes por cima
REM
REM  Se der conflito, ele NAO decide por voce: desfaz o que fez pela
REM  metade, deixa a pasta como estava e diz onde esta cada copia.
REM  Nada e' apagado. Nunca usa reset --hard, checkout -- . ou push.
REM
REM  Depois de "SINCRONIZADO", rode o ENVIAR-ATUALIZACAO.bat de novo.
REM  Todo o passo a passo vai para OUTPUT_SINCRONIZAR.TXT (fora do Git).
REM
REM  v2 28/09/2026: dentro de "for /f" o cmd troca "=" por espaco. A v1
REM  usava --untracked-files=no e --diff-filter=U ali e contava ZERO
REM  alteracoes (e zero conflitos). Agora: -uno e git ls-files -u.
REM  v3 28/09/2026: mensagem passada ao :L NAO pode ter  menor, maior,
REM  barra vertical nem e-comercial - o "echo" da rotina :L os executa
REM  como redirecionamento. A v2 escrevia "-> git branch" e criou um
REM  arquivo chamado "git" na pasta (que foi parar no commit 017e85a).
REM ===================================================================

set "LOG=%~dp0OUTPUT_SINCRONIZAR.TXT"
set "TS="
for /f "delims=" %%T in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss" 2^>nul') do set "TS=%%T"
if not defined TS set "TS=%RANDOM%%RANDOM%"
set "TAG=sincronizar-%TS%"
set "BKDIR=%~dp0backups\sincronizar"

> "%LOG%" echo ============================================================
call :L "  EKOPLASTIC PESAGEM - SINCRONIZAR COM O GITHUB"
call :L "============================================================"
call :L "Data..: %date% %time%"
call :L "Pasta.: %~dp0"
call :L "Marca.: %TAG%"
call :L ""

REM ================= FASE 0 - VERIFICACOES (so' leitura) =================
call :L "------------------------------------------------------------"
call :L "FASE 0 - VERIFICACOES"
call :L "------------------------------------------------------------"
git --version >>"%LOG%" 2>&1
if errorlevel 1 ( call :L "FALHA: Git nao respondeu." & goto :parar )
if not exist "server.js" ( call :L "FALHA: pasta errada - sem server.js. Copie este .bat para a pasta do projeto." & goto :parar )
git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 ( call :L "FALHA: esta pasta nao e' um repositorio Git." & goto :parar )
if exist ".git\rebase-merge" ( call :L "FALHA: ja existe um rebase pela metade. Chame o suporte - nao mexa." & goto :parar )
if exist ".git\rebase-apply" ( call :L "FALHA: ja existe um rebase pela metade. Chame o suporte - nao mexa." & goto :parar )
if exist ".git\MERGE_HEAD"   ( call :L "FALHA: ja existe um merge pela metade. Chame o suporte - nao mexa." & goto :parar )
set "RAMO="
for /f "delims=" %%B in ('git symbolic-ref -q --short HEAD 2^>nul') do set "RAMO=%%B"
if not defined RAMO ( call :L "FALHA: HEAD destacado (fora de branch)." & goto :parar )
if /I not "%RAMO%"=="main" ( call :L "FALHA: voce esta no branch '%RAMO%', nao no main." & goto :parar )
set "CONFLITO_ANTES=0"
for /f %%N in ('git ls-files -u 2^>nul ^| find /c /v ""') do set "CONFLITO_ANTES=%%N"
if not "%CONFLITO_ANTES%"=="0" ( call :L "FALHA: ja ha arquivo em conflito na pasta. Chame o suporte." & git diff --name-only --diff-filter=U >>"%LOG%" 2>&1 & goto :parar )
call :L "OK 1/3: Git, pasta, branch main, nada pela metade."

set "HEAD_ANTES="
for /f "delims=" %%H in ('git rev-parse HEAD 2^>nul') do set "HEAD_ANTES=%%H"
call :L "Commit atual: %HEAD_ANTES%"
call :L ""
call :L "Estado da pasta ANTES (git status --short):"
git status --short >>"%LOG%" 2>&1
call :L "Stashes que ja existiam:"
git stash list >>"%LOG%" 2>&1

call :L ""
call :L "Buscando o estado do GitHub..."
git fetch origin >>"%LOG%" 2>&1
if errorlevel 1 ( call :L "FALHA: nao consegui alcancar o GitHub. Rede ou chave SSH." & goto :parar )

set "ATRAS=0"
set "FRENTE=0"
for /f %%N in ('git rev-list --count HEAD..origin/main 2^>nul') do set "ATRAS=%%N"
for /f %%N in ('git rev-list --count origin/main..HEAD 2^>nul') do set "FRENTE=%%N"
call :L "OK 2/3: GitHub tem %ATRAS% commit(s) que voce nao tem; voce tem %FRENTE% commit(s) que o GitHub nao tem."

if "%ATRAS%"=="0" (
  call :L ""
  call :L "Nada a trazer - voce ja esta em dia com o GitHub."
  call :L "Pode rodar o ENVIAR-ATUALIZACAO.bat."
  goto :fim_ok
)

call :L ""
call :L "Commits que vao chegar (e os arquivos que cada um mexe):"
git log --stat --format="--- %%h %%an %%ad%%n    %%s" --date=format:"%%d/%%m %%H:%%M" HEAD..origin/main >>"%LOG%" 2>&1
if not "%FRENTE%"=="0" (
  call :L ""
  call :L "Seus commits que ainda nao estao no GitHub:"
  git log --oneline origin/main..HEAD >>"%LOG%" 2>&1
)

REM ---- sobreposicao: arquivo que os dois lados mexeram ----
call :L ""
call :L "Arquivos que VOCE alterou e que TAMBEM chegam do GitHub (onde pode dar conflito):"
set "SOBREPOE=0"
for /f "delims=" %%F in ('git diff --name-only HEAD..origin/main 2^>nul') do (
  git diff --quiet HEAD -- "%%F" >nul 2>&1 || ( >>"%LOG%" echo    %%F  ^(alteracao nao commitada^) & set "SOBREPOE=1" )
  git diff --quiet origin/main...HEAD -- "%%F" >nul 2>&1 || ( >>"%LOG%" echo    %%F  ^(commit local^) & set "SOBREPOE=1" )
)
if "%SOBREPOE%"=="0" call :L "   nenhum - deve passar direto."
call :L "OK 3/3: diagnostico gravado."

REM ================= FASE 1 - COPIAS DE SEGURANCA =================
call :L ""
call :L "------------------------------------------------------------"
call :L "FASE 1 - COPIAS DE SEGURANCA (antes de mexer em qualquer coisa)"
call :L "------------------------------------------------------------"
if not exist "%BKDIR%" mkdir "%BKDIR%" >nul 2>&1

git branch "seguranca/%TAG%" HEAD >>"%LOG%" 2>&1
if errorlevel 1 ( call :L "FALHA: nao consegui criar o branch de seguranca." & goto :parar )
call :L "Branch de seguranca: seguranca/%TAG%  (aponta para %HEAD_ANTES%)"

set "SUJO=0"
for /f %%N in ('git status --porcelain -uno ^| find /c /v ""') do set "SUJO=%%N"
set "GUARDOU=0"
if "%SUJO%"=="0" (
  call :L "Nenhuma alteracao nao commitada - nada a guardar alem do branch."
  goto :integrar
)

git diff HEAD --binary > "%BKDIR%\%TAG%.patch" 2>>"%LOG%"
call :L "Alteracoes nao commitadas (%SUJO% arquivo(s)) copiadas para:"
call :L "   backups\sincronizar\%TAG%.patch"

set "STASH_ANTES="
for /f "delims=" %%S in ('git rev-parse -q --verify refs/stash 2^>nul') do set "STASH_ANTES=%%S"
git stash push -m "%TAG%" >>"%LOG%" 2>&1
if errorlevel 1 ( call :L "FALHA: git stash recusou. Nada foi alterado." & goto :parar )
set "STASH_DEPOIS="
for /f "delims=" %%S in ('git rev-parse -q --verify refs/stash 2^>nul') do set "STASH_DEPOIS=%%S"
if "%STASH_DEPOIS%"=="%STASH_ANTES%" ( call :L "FALHA: o stash nao foi criado. Nada foi alterado." & goto :parar )
set "GUARDOU=1"
call :L "Alteracoes guardadas no stash '%TAG%' (%STASH_DEPOIS%)."

REM ================= FASE 2 - TRAZER O GITHUB =================
:integrar
call :L ""
call :L "------------------------------------------------------------"
call :L "FASE 2 - TRAZENDO O GITHUB"
call :L "------------------------------------------------------------"
if "%FRENTE%"=="0" (
  call :L "Voce nao tem commit local: avanco direto (merge --ff-only)."
  git merge --ff-only origin/main >>"%LOG%" 2>&1
  if errorlevel 1 goto :falha_integrar
) else (
  call :L "Voce tem %FRENTE% commit(s) local(is): reaplicando por cima do GitHub (rebase)."
  git rebase origin/main >>"%LOG%" 2>&1
  if errorlevel 1 goto :falha_rebase
)
set "HEAD_DEPOIS="
for /f "delims=" %%H in ('git rev-parse --short HEAD 2^>nul') do set "HEAD_DEPOIS=%%H"
call :L "OK: pasta agora em %HEAD_DEPOIS%."

REM ================= FASE 3 - DEVOLVER AS SUAS ALTERACOES =================
call :L ""
call :L "------------------------------------------------------------"
call :L "FASE 3 - DEVOLVENDO AS SUAS ALTERACOES"
call :L "------------------------------------------------------------"
if "%GUARDOU%"=="0" (
  call :L "Nao havia alteracao guardada."
  goto :resultado
)
git stash pop >>"%LOG%" 2>&1
set "CONFL=0"
for /f %%N in ('git ls-files -u 2^>nul ^| find /c /v ""') do set "CONFL=%%N"
if not "%CONFL%"=="0" goto :falha_pop
set "AINDA="
git stash list 2>nul | findstr /C:"%TAG%" >nul && set "AINDA=1"
if defined AINDA (
  call :L "ATENCAO: o stash '%TAG%' ainda existe - as alteracoes podem nao ter voltado."
  call :L "Confira com 'git status'. Nada foi apagado."
  goto :parar_pop
)
call :L "OK: suas alteracoes voltaram por cima da versao nova."

:resultado
call :L ""
call :L "------------------------------------------------------------"
call :L "RESULTADO"
call :L "------------------------------------------------------------"
call :L "Ultimos commits:"
git log --oneline -8 >>"%LOG%" 2>&1
call :L "Estado da pasta DEPOIS (git status --short):"
git status --short >>"%LOG%" 2>&1
call :L ""
call :L "*** SINCRONIZADO ***"
call :L "Agora rode o ENVIAR-ATUALIZACAO.bat."
call :L "Copias de seguranca (pode apagar depois que tudo estiver no GitHub):"
call :L "   branch seguranca/%TAG%     - apagar com: git branch -D seguranca/%TAG%"
if "%GUARDOU%"=="1" call :L "   backups\sincronizar\%TAG%.patch"
goto :fim_ok

REM ================= FALHAS - desfazem so' o que ESTE script fez =================
:falha_integrar
call :L ""
call :L "FALHA: o avanco direto foi recusado."
git status --short >>"%LOG%" 2>&1
goto :devolver_e_parar

:falha_rebase
call :L ""
call :L "FALHA: CONFLITO ao reaplicar os seus commits sobre o GitHub."
call :L "Arquivos em conflito:"
git diff --name-only --diff-filter=U >>"%LOG%" 2>&1
call :L "Trecho do conflito (para o suporte):"
git diff >>"%LOG%" 2>&1
call :L "Desfazendo o rebase - a pasta volta exatamente para %HEAD_ANTES%..."
git rebase --abort >>"%LOG%" 2>&1
goto :devolver_e_parar

:devolver_e_parar
if "%GUARDOU%"=="1" (
  call :L "Devolvendo as suas alteracoes nao commitadas..."
  git stash pop >>"%LOG%" 2>&1
)
call :L "Estado da pasta agora (deve ser igual ao de ANTES):"
git status --short >>"%LOG%" 2>&1
call :L ""
call :L "Nada foi perdido. A pasta esta como antes do script."
call :L "Envie este arquivo (OUTPUT_SINCRONIZAR.TXT) para o suporte."
goto :parar

:falha_pop
call :L ""
call :L "CONFLITO: a versao nova do GitHub e as suas alteracoes mexem"
call :L "no MESMO trecho destes arquivos:"
git diff --name-only --diff-filter=U >>"%LOG%" 2>&1
call :L "Trecho do conflito (para o suporte):"
git diff >>"%LOG%" 2>&1
goto :parar_pop

:parar_pop
call :L ""
call :L "A pasta JA ESTA na versao nova do GitHub. As suas alteracoes"
call :L "continuam guardadas - NADA foi perdido:"
call :L "   stash '%TAG%'   (git stash list)"
call :L "   backups\sincronizar\%TAG%.patch"
call :L "   branch seguranca/%TAG%   (seus commits, se havia)"
call :L "Os arquivos em conflito tem marcas de 7 sinais de menor, 7 de igual"
call :L "e 7 de maior, mostrando os dois lados. NAO rode o ENVIAR-ATUALIZACAO.bat agora."
call :L "Envie este arquivo (OUTPUT_SINCRONIZAR.TXT) para o suporte."
goto :parar

:fim_ok
call :L "=== FIM DO DIAGNOSTICO ==="
echo.
start "" notepad "%LOG%"
echo.
pause
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
