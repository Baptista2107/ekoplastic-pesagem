@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"
title Ekoplastic Pesagem - Publicar no GitHub

REM ===================================================================
REM  ENDERECO DO REPOSITORIO - conferir antes de rodar
REM ===================================================================
set "ORIGEM=git@github.com:Baptista2107/ekoplastic-pesagem.git"
REM ===================================================================

set "LOG=%~dp0OUTPUT_PUBLICAR.TXT"
set "VARRE=%TEMP%\eko_varredura.tmp"

> "%LOG%" echo ============================================================
call :L "  EKOPLASTIC PESAGEM - PUBLICAR NO GITHUB"
call :L "  Secao 4.5 do HANDOFF_MIGRACAO_PESAGEM.md"
call :L "============================================================"
call :L "Data........: %date% %time%"
call :L "Destino.....: %ORIGEM%"
call :L ""
call :L "ANTES DE RODAR: o repositorio precisa existir no GitHub,"
call :L "criado como PRIVATE e VAZIO - sem README, sem .gitignore,"
call :L "sem licenca. Qualquer arquivo inicial la' cria conflito no"
call :L "primeiro push."
call :L ""

REM ===================================================================
call :L "------------------------------------------------------------"
call :L "FASE 0 - VERIFICACOES - SOMENTE LEITURA"
call :L "------------------------------------------------------------"

git --version >>"%LOG%" 2>&1
if errorlevel 1 ( call :L "FALHA: Git nao respondeu." & goto :parar )
if not exist "server.js" ( call :L "FALHA: server.js nao encontrado - pasta errada." & goto :parar )
git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 ( call :L "FALHA: nao e' um repositorio Git." & goto :parar )
call :L "OK 1/7: Git, pasta e repositorio."

set "SUJO=0"
for /f %%N in ('git status --porcelain ^| find /c /v ""') do set "SUJO=%%N"
if not "%SUJO%"=="0" (
  call :L "FALHA: ha %SUJO% mudanca pendente na pasta."
  call :L "Publique so' com a pasta limpa. Rode o CORRIGIR-COMMIT.bat antes."
  git status --short >>"%LOG%" 2>&1
  goto :parar
)
call :L "OK 2/7: working tree limpo."

set "SHAFULL="
for /f "delims=" %%H in ('git rev-parse HEAD 2^>nul') do set "SHAFULL=%%H"
set "SHACURTO="
for /f "delims=" %%H in ('git rev-parse --short HEAD 2^>nul') do set "SHACURTO=%%H"
if not defined SHAFULL ( call :L "FALHA: sem commit." & goto :parar )
call :L "OK 3/7: commit %SHACURTO%"

set "SHATAG="
for /f "delims=" %%H in ('git rev-list -n 1 v157 2^>nul') do set "SHATAG=%%H"
if not defined SHATAG ( call :L "FALHA: a tag v157 nao existe." & goto :parar )
if /I not "%SHATAG%"=="%SHAFULL%" (
  call :L "FALHA: a tag v157 nao aponta para o commit atual."
  goto :parar
)
call :L "OK 4/7: tag v157 sobre o commit atual."

call :L "OK 5/7: conferindo que nenhum arquivo de runtime esta rastreado"
set "VAZOU=0"
for /f %%N in ('git ls-files -- etiquetas.db credenciais-bling.json bling_tokens.json logs backups cert ^| find /c /v ""') do set "VAZOU=%%N"
git ls-files -- etiquetas.db credenciais-bling.json bling_tokens.json logs backups cert >>"%LOG%" 2>&1
if not "%VAZOU%"=="0" (
  call :L "FALHA: %VAZOU% arquivo de producao esta no commit. NAO PUBLIQUE."
  goto :parar
)
call :L "        nenhum. Banco, credenciais, tokens, logs e certificados fora."

call :L "OK 6/7: testando o acesso ao GitHub por SSH"
ssh -T -o BatchMode=yes -o StrictHostKeyChecking=accept-new git@github.com >>"%LOG%" 2>&1
findstr /I /C:"successfully authenticated" "%LOG%" >nul 2>&1
if errorlevel 1 (
  call :L "FALHA: o GitHub nao reconheceu sua chave SSH."
  call :L "Teste a mao:  ssh -T git@github.com"
  goto :parar
)
call :L "        chave SSH reconhecida pelo GitHub."

set "REMOTOATUAL="
for /f "delims=" %%R in ('git remote get-url origin 2^>nul') do set "REMOTOATUAL=%%R"
if defined REMOTOATUAL (
  if /I not "%REMOTOATUAL%"=="%ORIGEM%" (
    call :L "FALHA: ja existe um remote origin diferente do esperado:"
    call :L "   atual....: %REMOTOATUAL%"
    call :L "   esperado.: %ORIGEM%"
    goto :parar
  )
  call :L "OK 7/7: remote origin ja configurado e correto."
) else (
  call :L "OK 7/7: nenhum remote ainda - sera criado na FASE 2."
)
call :L ""

REM ===================================================================
call :L "------------------------------------------------------------"
call :L "FASE 1 - O QUE VAI SUBIR"
call :L "------------------------------------------------------------"
set "TOTAL=0"
for /f %%N in ('git ls-files ^| find /c /v ""') do set "TOTAL=%%N"
call :L "Arquivos no commit: %TOTAL%"
call :L ""
call :L "Varredura de segredo no que esta commitado - fora node_modules."
call :L "Leia linha por linha. Qualquer valor de verdade entre aspas aqui"
call :L "vai para o GitHub e fica no historico para sempre."
call :L ""
git grep -n -i -E "client_secret|client_id|password|senha|api_?key|secret|token" -- . ":(exclude)node_modules" > "%VARRE%" 2>nul
set "NVARRE=0"
for /f %%N in ('type "%VARRE%" ^| find /c /v ""') do set "NVARRE=%%N"
call :L "Linhas a conferir: %NVARRE%"
type "%VARRE%" >>"%LOG%" 2>&1
echo.
echo ------------------------------------------------------------
echo  VARREDURA DE SEGREDO - %NVARRE% linha^(s^). Leia com atencao:
echo ------------------------------------------------------------
type "%VARRE%"
echo ------------------------------------------------------------
del "%VARRE%" >nul 2>&1

echo.
echo ============================================================
echo  Vai publicar %TOTAL% arquivos.
echo  Commit %SHACURTO% + tag v157
echo  Destino: %ORIGEM%
echo.
echo  Se viu algum segredo de verdade na lista acima,
echo  FECHE ESTA JANELA agora. Depois do push nao tem volta simples.
echo.
echo  Pressione uma tecla para PUBLICAR,
echo  ou feche esta janela para cancelar.
echo ============================================================
pause >nul

REM ===================================================================
call :L "------------------------------------------------------------"
call :L "FASE 2 - CONECTANDO AO REPOSITORIO"
call :L "------------------------------------------------------------"
if not defined REMOTOATUAL (
  git remote add origin "%ORIGEM%" >>"%LOG%" 2>&1
  if errorlevel 1 ( call :L "FALHA ao adicionar o remote." & goto :parar )
  call :L "OK: remote origin criado."
)
call :L ""

REM ===================================================================
call :L "------------------------------------------------------------"
call :L "FASE 3 - PUBLICANDO"
call :L "------------------------------------------------------------"
call :L "3.1 - enviando a branch main"
git push -u origin main >>"%LOG%" 2>&1
if errorlevel 1 (
  call :L "FALHA no push da main. Causas comuns:"
  call :L "  - o repositorio no GitHub nao esta vazio"
  call :L "  - o repositorio ainda nao foi criado"
  call :L "  - a chave SSH nao tem permissao de escrita"
  call :L "Nada foi perdido: o commit local continua intacto."
  goto :parar
)
call :L "OK: main publicada."

call :L "3.2 - enviando a tag v157"
git push origin v157 >>"%LOG%" 2>&1
if errorlevel 1 ( call :L "FALHA no push da tag v157." & goto :parar )
call :L "OK: tag v157 publicada."
call :L ""

REM ===================================================================
call :L "------------------------------------------------------------"
call :L "FASE 4 - CONFERINDO NO SERVIDOR"
call :L "------------------------------------------------------------"
set "SHAREMOTO="
for /f "tokens=1" %%H in ('git ls-remote origin refs/heads/main 2^>nul') do set "SHAREMOTO=%%H"
call :L "Commit local..: %SHAFULL%"
call :L "Commit no GitHub: %SHAREMOTO%"
if /I "%SHAREMOTO%"=="%SHAFULL%" (
  call :L "OK: o GitHub tem exatamente o mesmo commit."
) else (
  call :L "ATENCAO: o commit remoto nao bate com o local. Confira a mao."
  goto :parar
)
call :L ""
call :L "Referencias no servidor:"
git ls-remote origin >>"%LOG%" 2>&1
call :L ""
call :L "------------------------------------------------------------"
call :L "RESULTADO: PUBLICADO."
call :L "------------------------------------------------------------"
call :L ""
call :L "Agora da' para apagar a rede de seguranca local:"
call :L "   git branch -D backup-commit-sujo"
call :L "   git tag -d backup-v157-antiga"
call :L "   rmdir /s /q node_modules.antigo-20260825-135832"
call :L ""
call :L "Proximo passo - secao 4.5, item 4: no Mini PC, gerar chave,"
call :L "cadastrar como deploy key SOMENTE LEITURA, clonar em pasta"
call :L "NOVA, copiar para dentro dela etiquetas.db, credenciais-bling.json,"
call :L "bling_tokens.json, logs, backups e cert, subir, conferir o"
call :L "/healthcheck, e so' entao trocar as pastas."
call :L ""
call :L "=== FIM DO DIAGNOSTICO ==="
echo.
start "" notepad "%LOG%"
echo.
pause
exit /b 0

:parar
call :L ""
call :L "*** INTERROMPIDO - nada foi publicado nesta execucao. ***"
call :L "=== FIM DO DIAGNOSTICO ==="
del "%VARRE%" >nul 2>&1
echo.
start "" notepad "%LOG%"
echo.
pause
exit /b 1

:L
echo(%~1
>>"%LOG%" echo(%~1
exit /b 0
