@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"
title Ekoplastic Pesagem - Enviar atualizacao

set "ORIGEM=git@github.com:Baptista2107/ekoplastic-pesagem.git"
set "LOG=%~dp0OUTPUT_ENVIAR_ATUALIZACAO.TXT"

> "%LOG%" echo ============================================================
call :L "  EKOPLASTIC PESAGEM - ENVIAR ATUALIZACAO PARA O GITHUB"
call :L "============================================================"
call :L "Data..: %date% %time%"
call :L ""
call :L "Substitui o CORRIGIR-COMMIT.bat, que era so' para a baseline e"
call :L "nao roda mais depois que o repositorio foi publicado."
call :L ""
call :L "Este script NAO toca no Mini PC. Ele so' manda o codigo para o"
call :L "GitHub. Quem leva ao chao de fabrica e' o ATUALIZAR.bat, la'."
call :L ""

REM ================= FASE 0 - VERIFICACOES =================
call :L "------------------------------------------------------------"
call :L "FASE 0 - VERIFICACOES"
call :L "------------------------------------------------------------"
git --version >>"%LOG%" 2>&1
if errorlevel 1 ( call :L "FALHA: Git nao respondeu." & goto :parar )
if not exist "server.js" ( call :L "FALHA: pasta errada - sem server.js." & goto :parar )
git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 ( call :L "FALHA: nao e' repositorio Git." & goto :parar )
if exist ".git\MERGE_HEAD"   ( call :L "FALHA: merge pela metade." & goto :parar )
if exist ".git\rebase-merge" ( call :L "FALHA: rebase pela metade." & goto :parar )
if exist ".git\rebase-apply" ( call :L "FALHA: rebase pela metade." & goto :parar )
git symbolic-ref -q HEAD >nul 2>&1
if errorlevel 1 ( call :L "FALHA: HEAD destacado." & goto :parar )
call :L "OK 1/4: Git, pasta, repositorio, HEAD em branch."

set "REMOTO="
for /f "delims=" %%R in ('git remote get-url origin 2^>nul') do set "REMOTO=%%R"
if not defined REMOTO ( call :L "FALHA: nenhum remote origin. Use o PUBLICAR.bat primeiro." & goto :parar )
call :L "OK 2/4: origin = %REMOTO%"

call :L "Buscando o estado do GitHub..."
git fetch origin >>"%LOG%" 2>&1
if errorlevel 1 ( call :L "FALHA: nao consegui alcancar o GitHub. Rede ou chave SSH." & goto :parar )

set "ATRAS=0"
for /f %%N in ('git rev-list --count HEAD..origin/main 2^>nul') do set "ATRAS=%%N"
if not "%ATRAS%"=="0" (
  call :L "FALHA: o GitHub tem %ATRAS% commit que voce nao tem."
  call :L "Alguem publicou algo. Rode antes:   git pull --ff-only origin main"
  call :L "Commits que faltam aqui:"
  git log --oneline HEAD..origin/main >>"%LOG%" 2>&1
  goto :parar
)
call :L "OK 3/4: voce esta em dia com o GitHub."

set "PEND=0"
for /f %%N in ('git status --porcelain ^| find /c /v ""') do set "PEND=%%N"
if "%PEND%"=="0" (
  call :L "Nada mudou na pasta. Nao ha o que enviar."
  call :L "=== FIM DO DIAGNOSTICO ==="
  echo.
  echo  Nada mudou. Nada a enviar.
  echo.
  pause
  exit /b 0
)
call :L "OK 4/4: %PEND% mudanca a enviar."
call :L ""

REM ================= FASE 1 - PORTAO DE TESTES =================
call :L "------------------------------------------------------------"
call :L "FASE 1 - PORTAO DE TESTES"
call :L "------------------------------------------------------------"
call :L "Sobe o server.js de verdade com banco temporario, portas de"
call :L "teste e Bling e impressao simulados. Nao encosta em producao."
call :L ""
where node >nul 2>&1
if errorlevel 1 (
  call :L "FALHA: Node nao esta no PATH. Sem ele nao ha portao de teste."
  goto :parar
)
echo.
echo  Rodando os testes de piso. Aguarde...
echo.
REM  Roda UMA vez, guarda a saida e joga na tela e no log. Rodar duas
REM  vezes so' para capturar o log dobraria o tempo e mascararia
REM  qualquer teste que dependa de ordem.
set "SAIDA=%TEMP%\eko_testes.tmp"
node testes\piso-testes.js > "%SAIDA%" 2>&1
set "RCT=%ERRORLEVEL%"
type "%SAIDA%"
type "%SAIDA%" >>"%LOG%"
del "%SAIDA%" >nul 2>&1

REM  Pergunta e resposta ficam FORA de bloco entre parenteses: variavel
REM  lida no mesmo bloco onde foi setada nao expande sem delayed expansion.
if "%RCT%"=="0" goto :testes_ok

call :L ""
call :L "TESTES FALHARAM - codigo de saida %RCT%."
echo.
echo ============================================================
echo  OS TESTES FALHARAM.
echo.
echo  O certo e' fechar esta janela e corrigir o codigo.
echo  Se voce tem certeza de que a falha e' do ambiente e nao do
echo  codigo, digite  IGNORAR  para enviar mesmo assim.
echo ============================================================
set "FORCA="
set /p "FORCA=Digite IGNORAR para prosseguir, ou ENTER para parar: "
if /I not "%FORCA%"=="IGNORAR" goto :parar_teste
call :L "ATENCAO: operador digitou IGNORAR e seguiu com teste falhando."
goto :testes_fim

:parar_teste
call :L "Interrompido pelo operador apos falha de teste."
goto :parar

:testes_ok
call :L "OK: todos os testes passaram."

:testes_fim
call :L ""

REM ================= FASE 2 - O QUE VAI E COM QUE MENSAGEM =================
call :L "------------------------------------------------------------"
call :L "FASE 2 - O QUE VAI SUBIR"
call :L "------------------------------------------------------------"
git status --short >>"%LOG%" 2>&1
echo.
echo ------------------------------------------------------------
echo  Mudancas que vao para o GitHub:
echo ------------------------------------------------------------
git status --short
echo ------------------------------------------------------------
echo.
echo  Descreva a mudanca em uma linha. Sem aspas.
echo  Exemplo:  Extrusao passa a gravar PRODUCAO C1 na observacao
echo.
set "MSG="
set /p "MSG=Mensagem: "
if not defined MSG ( call :L "Interrompido: mensagem vazia." & goto :parar )
set MSG=%MSG:"=%
call :L "Mensagem: %MSG%"

echo.
echo  Tag desta versao, se houver. ENTER pula.
echo  Serve para voltar atras depois com:  git checkout ^<tag^>
echo.
set "TAG="
set /p "TAG=Tag (ex: v158) ou ENTER: "
if defined TAG set TAG=%TAG:"=%
if defined TAG call :L "Tag: %TAG%"

echo.
echo ============================================================
echo  Vai enviar %PEND% mudanca para o GitHub.
echo  Pressione uma tecla para ENVIAR, ou feche para cancelar.
echo ============================================================
pause >nul

REM ================= FASE 3 - COMMIT E PUSH =================
call :L "------------------------------------------------------------"
call :L "FASE 3 - ENVIANDO"
call :L "------------------------------------------------------------"
git add -A >>"%LOG%" 2>&1
if errorlevel 1 ( call :L "FALHA no git add." & goto :parar )
git commit -m "%MSG%" >>"%LOG%" 2>&1
if errorlevel 1 ( call :L "FALHA no git commit." & goto :parar )
set "SHA="
for /f "delims=" %%H in ('git rev-parse --short HEAD 2^>nul') do set "SHA=%%H"
call :L "OK: commit %SHA% criado."

if defined TAG (
  git tag -a "%TAG%" -m "%MSG%" >>"%LOG%" 2>&1
  if errorlevel 1 ( call :L "AVISO: nao consegui criar a tag %TAG% - talvez ja exista." ) else ( call :L "OK: tag %TAG% criada." )
)

git push origin main >>"%LOG%" 2>&1
if errorlevel 1 (
  call :L "FALHA no push. O commit local existe e nada foi perdido."
  call :L "Se alguem publicou no meio do caminho:  git pull --ff-only origin main"
  goto :parar
)
call :L "OK: enviado para o GitHub."
if defined TAG (
  git push origin "%TAG%" >>"%LOG%" 2>&1
  if errorlevel 1 ( call :L "AVISO: falha ao enviar a tag." ) else ( call :L "OK: tag enviada." )
)
call :L ""

REM ================= FASE 4 - CONFERENCIA =================
call :L "------------------------------------------------------------"
call :L "FASE 4 - CONFERINDO NO SERVIDOR"
call :L "------------------------------------------------------------"
set "SHALOCAL="
for /f "delims=" %%H in ('git rev-parse HEAD 2^>nul') do set "SHALOCAL=%%H"
set "SHAREMOTO="
for /f "tokens=1" %%H in ('git ls-remote origin refs/heads/main 2^>nul') do set "SHAREMOTO=%%H"
call :L "Local ..: %SHALOCAL%"
call :L "GitHub .: %SHAREMOTO%"
if /I "%SHAREMOTO%"=="%SHALOCAL%" (
  call :L "OK: o GitHub tem o mesmo commit."
) else (
  call :L "ATENCAO: os commits nao batem. Confira a mao."
  goto :parar
)
call :L ""
call :L "------------------------------------------------------------"
call :L "RESULTADO: ENVIADO."
call :L "------------------------------------------------------------"
call :L ""
call :L "O Mini PC NAO recebeu nada ainda. Ele continua na versao"
call :L "anterior ate' alguem rodar o ATUALIZAR.bat la', na hora que"
call :L "voce escolher. Nada e' automatico."
call :L ""
call :L "=== FIM DO DIAGNOSTICO ==="
echo.
start "" notepad "%LOG%"
echo.
pause
exit /b 0

:parar
call :L ""
call :L "*** INTERROMPIDO - nada foi enviado ao GitHub. ***"
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
