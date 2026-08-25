@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"
title Ekoplastic Pesagem - Corrigir commit de baseline

set "LOG=%~dp0OUTPUT_CORRIGIR_COMMIT.TXT"
set "TAGMSG=Baseline v157 - sistema de pesagem Ekoplastic"

> "%LOG%" echo ============================================================
call :L "  EKOPLASTIC PESAGEM - CORRECAO DO COMMIT DE BASELINE"
call :L "  Secao 4.3 do HANDOFF_MIGRACAO_PESAGEM.md"
call :L "============================================================"
call :L "Data........: %date% %time%"
call :L "Pasta.......: %~dp0"
call :L "Relatorio...: OUTPUT_CORRIGIR_COMMIT.TXT"
call :L ""
call :L "Este script NAO envia nada para a internet."
call :L "Ele corrige o ultimo commit LOCAL, ainda nao publicado."
call :L "Pode ser rodado mais de uma vez com seguranca."
call :L ""

REM ===================================================================
REM  FASE 0 - VERIFICACOES DE SEGURANCA - SOMENTE LEITURA
REM ===================================================================
call :L "------------------------------------------------------------"
call :L "FASE 0 - VERIFICACOES DE SEGURANCA"
call :L "------------------------------------------------------------"

git --version >>"%LOG%" 2>&1
if errorlevel 1 (
  call :L "FALHA: o Git nao respondeu. Instale ou reabra o terminal."
  goto :abortar
)
call :L "OK 1/12: Git respondeu."

if not exist "server.js" (
  call :L "FALHA: server.js nao encontrado nesta pasta."
  call :L "Coloque este .bat na pasta do sistema de pesagem."
  goto :abortar
)
call :L "OK 2/12: server.js encontrado - pasta correta."

git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
  call :L "FALHA: esta pasta nao e' um repositorio Git."
  goto :abortar
)
call :L "OK 3/12: repositorio Git encontrado."

if exist ".git\MERGE_HEAD" (
  call :L "FALHA: ha um merge em andamento. Resolva antes."
  goto :abortar
)
if exist ".git\rebase-merge" (
  call :L "FALHA: ha um rebase em andamento. Resolva antes."
  goto :abortar
)
if exist ".git\rebase-apply" (
  call :L "FALHA: ha um rebase em andamento. Resolva antes."
  goto :abortar
)
call :L "OK 4/12: nenhum merge ou rebase pela metade."

git symbolic-ref -q HEAD >nul 2>&1
if errorlevel 1 (
  call :L "FALHA: HEAD esta destacado - detached HEAD."
  call :L "O amend criaria um commit fora de qualquer branch."
  goto :abortar
)
call :L "OK 5/12: HEAD esta em um branch."

set "SHAFULL="
for /f "delims=" %%H in ('git rev-parse HEAD 2^>nul') do set "SHAFULL=%%H"
if not defined SHAFULL (
  call :L "FALHA: nao ha commit nesta branch ainda."
  goto :abortar
)
set "SHAANTES="
for /f "delims=" %%H in ('git rev-parse --short HEAD 2^>nul') do set "SHAANTES=%%H"
call :L "OK 6/12: HEAD existe - commit %SHAANTES%"

set "NCOMMITS=0"
for /f "delims=" %%N in ('git rev-list --count HEAD 2^>nul') do set "NCOMMITS=%%N"
if not "%NCOMMITS%"=="1" (
  call :L "FALHA: este repositorio tem %NCOMMITS% commits."
  call :L "A baseline deveria ser o UNICO commit. Se ja existe historico"
  call :L "depois dela, o --amend reescreveria o commit ERRADO e a tag"
  call :L "v157 sairia do lugar. Pare e reavalie a mao."
  goto :abortar
)
call :L "OK 7/12: existe exatamente 1 commit - e' a baseline."

set "SHATAG="
for /f "delims=" %%H in ('git rev-list -n 1 v157 2^>nul') do set "SHATAG=%%H"
if not defined SHATAG (
  call :L "AVISO 8/12: a tag v157 nao existe ainda - sera criada."
) else (
  if /I not "%SHATAG%"=="%SHAFULL%" (
    call :L "FALHA: a tag v157 aponta para outro commit, nao para HEAD."
    call :L "  v157: %SHATAG%"
    call :L "  HEAD: %SHAFULL%"
    goto :abortar
  )
  call :L "OK 8/12: a tag v157 aponta para HEAD."
)

set "TEMREMOTE="
for /f "delims=" %%R in ('git remote 2^>nul') do set "TEMREMOTE=%%R"
if defined TEMREMOTE (
  call :L "FALHA: este repositorio JA tem remote configurado: %TEMREMOTE%"
  call :L "O amend reescreve o commit e so' e' seguro enquanto nada"
  call :L "foi publicado. Pare e reavalie."
  goto :abortar
)
call :L "OK 9/12: nenhum remote - o amend e' seguro."

findstr /C:"SETUP-GIT-LOG.txt" ".gitignore" >nul 2>&1
if errorlevel 1 (
  call :L "FALHA: o .gitignore ainda e' a versao ANTIGA - falta a regra"
  call :L "SETUP-GIT-LOG.txt. Foi exatamente isso que fez o amend"
  call :L "anterior falhar. Aplique o .gitignore novo primeiro."
  goto :abortar
)
findstr /C:".zip" ".gitignore" >nul 2>&1
if errorlevel 1 (
  call :L "FALHA: o .gitignore nao tem regra para arquivos .zip."
  goto :abortar
)
call :L "OK 10/12: .gitignore tem as regras .zip e SETUP-GIT-LOG.txt."

findstr /C:"!node_modules/**" ".gitignore" >nul 2>&1
if errorlevel 1 (
  call :L "FALHA: falta a linha  !node_modules/**  no fim do .gitignore."
  call :L "Sem ela, regras como *.db, cert/, logs/, .env, *.tmp e *.bak"
  call :L "engolem arquivos DENTRO do node_modules e pacotes inteiros"
  call :L "ficam de fora do commit. A balanca nao subiria no Mini PC."
  goto :abortar
)
call :L "OK 11/12: .gitignore protege o node_modules vendorizado."

findstr /C:"node_modules/** -text" ".gitattributes" >nul 2>&1
if errorlevel 1 (
  call :L "FALHA: o .gitattributes ainda e' a versao antiga."
  call :L "Falta a regra  node_modules/** -text  - sem ela o Git pode"
  call :L "converter fim de linha dentro do node_modules vendorizado."
  goto :abortar
)
findstr /C:"enviar_raw.ps1" ".gitattributes" >nul 2>&1
if errorlevel 1 (
  call :L "FALHA: falta a excecao do enviar_raw.ps1 no .gitattributes."
  call :L "Sem ela o server.js reescreve o arquivo a cada boot e o"
  call :L "git pull do Mini PC passa a falhar."
  goto :abortar
)
call :L "OK 12/12: .gitattributes e' a versao nova."
call :L ""

REM ===================================================================
REM  FASE 1 - ESTADO ANTES - SOMENTE LEITURA
REM ===================================================================
call :L "------------------------------------------------------------"
call :L "FASE 1 - ESTADO ANTES - SOMENTE LEITURA"
call :L "------------------------------------------------------------"

set "TOTANTES=0"
for /f %%N in ('git ls-files ^| find /c /v ""') do set "TOTANTES=%%N"
call :L "Arquivos rastreados agora: %TOTANTES%"
call :L ""

set "SOBRA=0"
for /f %%N in ('git ls-files -- "*files.zip" "*SETUP-GIT-LOG.txt" ^| find /c /v ""') do set "SOBRA=%%N"
call :L "Arquivos indevidos rastreados - qualquer subpasta: %SOBRA%"
git ls-files -- "*files.zip" "*SETUP-GIT-LOG.txt" >>"%LOG%" 2>&1
call :L ""

set "PEND=0"
for /f %%N in ('git status --porcelain ^| find /c /v ""') do set "PEND=%%N"
call :L "Mudancas pendentes na pasta: %PEND%"
git status --porcelain >>"%LOG%" 2>&1
call :L ""

echo.
echo ============================================================
echo  FASE 1 concluida. NADA foi alterado ate' aqui.
echo.
if not "%PEND%"=="0" (
  echo  ATENCAO: ha %PEND% mudanca pendente na pasta.
  echo  TUDO isso vai entrar no commit de baseline:
  echo.
  git status --short
  echo.
  echo  Se houver aqui algo que voce NAO quer na baseline,
  echo  feche esta janela agora e resolva antes.
  echo.
)
echo  A proxima fase vai:
echo    - criar a branch de seguranca "backup-commit-sujo"
echo    - guardar a tag atual como "backup-v157-antiga"
echo    - tirar files.zip e SETUP-GIT-LOG.txt do commit
echo    - refazer o commit com --amend
echo    - recriar a tag v157
echo.
echo  Pressione uma tecla para APLICAR,
echo  ou feche esta janela para cancelar.
echo ============================================================
pause >nul

REM ===================================================================
REM  FASE 2 - BACKUPS
REM ===================================================================
call :L "------------------------------------------------------------"
call :L "FASE 2 - BACKUPS ANTES DE ALTERAR"
call :L "------------------------------------------------------------"
git branch backup-commit-sujo >>"%LOG%" 2>&1
if errorlevel 1 (
  call :L "AVISO: branch backup-commit-sujo ja existia - mantida."
) else (
  call :L "OK: branch backup-commit-sujo criada sobre %SHAANTES%"
)
if defined SHATAG (
  git tag backup-v157-antiga v157 >>"%LOG%" 2>&1
  if errorlevel 1 (
    call :L "AVISO: tag backup-v157-antiga ja existia - mantida."
  ) else (
    call :L "OK: tag backup-v157-antiga guardada. Tag apagada nao tem"
    call :L "    reflog - sem esta copia a v157 original some."
  )
)
call :L ""
call :L "Commit de referencia desta execucao: %SHAFULL%"
call :L ""

REM ===================================================================
REM  FASE 3 - CORRECAO
REM ===================================================================
call :L "------------------------------------------------------------"
call :L "FASE 3 - CORRECAO DO COMMIT"
call :L "------------------------------------------------------------"

call :L "3.1 - tirando os arquivos indevidos do indice - qualquer subpasta"
git rm --cached --ignore-unmatch -- "*files.zip" "*SETUP-GIT-LOG.txt" >>"%LOG%" 2>&1

call :L "3.2 - reindexando a pasta"
git add -A >>"%LOG%" 2>&1
if errorlevel 1 goto :abortar_sujo

call :L "3.3 - renormalizando: o .gitattributes mudou, isto reaplica as"
call :L "      regras de fim de linha nos arquivos ja rastreados"
git add --renormalize . >>"%LOG%" 2>&1
if errorlevel 1 goto :abortar_sujo

call :L "3.4 - refazendo o commit"
git commit --amend --no-edit >>"%LOG%" 2>&1
if errorlevel 1 (
  call :L "FALHA no git commit --amend. Veja o detalhe acima no log."
  goto :abortar_sujo
)
set "SHADEPOIS="
for /f "delims=" %%H in ('git rev-parse --short HEAD 2^>nul') do set "SHADEPOIS=%%H"
call :L "OK: commit refeito. Novo hash: %SHADEPOIS%"

call :L "3.5 - reescrevendo a pasta a partir do commit, para que o disco"
call :L "      fique igual ao que um clone novo vai receber"
git checkout-index -f -a >>"%LOG%" 2>&1
if errorlevel 1 (
  call :L "AVISO: git checkout-index reclamou. Veja o log."
) else (
  call :L "OK: disco alinhado com o commit."
)
call :L ""

REM ===================================================================
REM  FASE 4 - TAG
REM ===================================================================
call :L "------------------------------------------------------------"
call :L "FASE 4 - RECRIANDO A TAG v157"
call :L "------------------------------------------------------------"
git tag -d v157 >>"%LOG%" 2>&1
git tag -a v157 -m "%TAGMSG%" >>"%LOG%" 2>&1
if errorlevel 1 (
  call :L "FALHA ao criar a tag v157."
  call :L "A copia continua em backup-v157-antiga."
  goto :abortar_sujo
)
call :L "OK: tag v157 recriada sobre %SHADEPOIS%"
call :L ""

REM ===================================================================
REM  FASE 5 - VALIDACAO
REM ===================================================================
call :L "------------------------------------------------------------"
call :L "FASE 5 - VALIDACAO"
call :L "------------------------------------------------------------"

set "FALHOU="
set "TOTDEPOIS=0"
for /f %%N in ('git ls-files ^| find /c /v ""') do set "TOTDEPOIS=%%N"
call :L "Arquivos rastreados antes.: %TOTANTES%"
call :L "Arquivos rastreados agora.: %TOTDEPOIS%"
call :L ""

call :L "5.1 - sobrou algum files.zip ou SETUP-GIT-LOG.txt rastreado?"
set "SOBRA=0"
for /f %%N in ('git ls-files -- "*files.zip" "*SETUP-GIT-LOG.txt" ^| find /c /v ""') do set "SOBRA=%%N"
git ls-files -- "*files.zip" "*SETUP-GIT-LOG.txt" >>"%LOG%" 2>&1
if "%SOBRA%"=="0" (
  call :L "  OK: nenhum dos dois esta rastreado, em nenhuma subpasta."
) else (
  call :L "  FALHA: ainda ha %SOBRA% arquivo indevido rastreado."
  set "FALHOU=1"
)
call :L ""

call :L "5.2 - o que mudou no commit - A adicionado, D removido, M alterado:"
set "NDIF=0"
for /f %%N in ('git diff --name-status %SHAFULL% HEAD ^| find /c /v ""') do set "NDIF=%%N"
git diff --name-status %SHAFULL% HEAD >>"%LOG%" 2>&1
call :L "  %NDIF% arquivo mudaram. A lista completa, um por um, esta no"
call :L "  relatorio OUTPUT_CORRIGIR_COMMIT.TXT, que abre no fim - a tela"
call :L "  nao mostra a lista porque com node_modules ela passa de 200 linhas."
call :L ""

call :L "5.3 - a pasta ficou limpa?"
set "SUJO=0"
for /f %%N in ('git status --porcelain ^| find /c /v ""') do set "SUJO=%%N"
git status --porcelain >>"%LOG%" 2>&1
if "%SUJO%"=="0" (
  call :L "  OK: working tree limpo."
) else (
  call :L "  FALHA: %SUJO% arquivo diferente do commit. Veja a lista no log."
  set "FALHOU=1"
)
call :L ""

call :L "5.4 - algum arquivo IGNORADO caiu dentro de node_modules?"
call :L "      isto e' CRITICO: o node_modules e' vendorizado de proposito"
call :L "      e um pacote faltando derruba a balanca no Mini PC."
REM  "git status --ignored" devolve DUAS coisas: "??" = nao rastreado e
REM  "!!" = ignorado. Contar as duas juntas transforma arquivo novo - que e'
REM  normal antes do add - em alarme falso. So as linhas que comecam com "!!"
REM  interessam aqui.
set "IGN=0"
for /f %%N in ('git status --ignored --porcelain -- node_modules ^| findstr /B /C:"!!" ^| find /c /v ""') do set "IGN=%%N"
git status --ignored --porcelain -- node_modules | findstr /B /C:"!!" >>"%LOG%" 2>&1
if "%IGN%"=="0" (
  call :L "  OK: nada ignorado dentro de node_modules."
) else (
  call :L "  FALHA: %IGN% item ignorado dentro de node_modules."
  set "FALHOU=1"
)
call :L ""

call :L "5.5 - ha .gitignore ou .gitattributes DENTRO de node_modules?"
call :L "      arquivo aninhado tem precedencia sobre o da raiz e pode"
call :L "      furar as duas protecoes acima."
set "NINHO=0"
for /f %%N in ('git ls-files -- node_modules ^| findstr /E /C:".gitignore" /C:".gitattributes" ^| find /c /v ""') do set "NINHO=%%N"
git ls-files -- node_modules | findstr /E /C:".gitignore" /C:".gitattributes" >>"%LOG%" 2>&1
if "%NINHO%"=="0" (
  call :L "  OK: nenhum arquivo de regra aninhado."
) else (
  call :L "  ATENCAO: %NINHO% arquivo de regra dentro de node_modules."
  call :L "  Confira a lista no log antes de publicar."
)
call :L ""

call :L "5.6 - fim de linha dos arquivos criticos."
call :L "      i/ = como esta no commit   w/ = como esta no disco"
call :L "      enviar_raw.ps1 TEM que ser lf nos dois, senao o server.js"
call :L "      reescreve o arquivo a cada boot e trava o git pull."
for /f "delims=" %%E in ('git ls-files --eol -- enviar_raw.ps1 INICIAR.bat CALIBRAR-IMPRESSORA.bat server.js 2^>nul') do call :L "  %%E"
call :L ""

call :L "5.7 - o serialport ja esta no commit?"
set "TEMSP=0"
for /f %%N in ('git ls-files -- "node_modules/serialport/package.json" ^| find /c /v ""') do set "TEMSP=%%N"
if "%TEMSP%"=="0" (
  call :L "  NAO. Esta baseline ainda NAO roda a balanca - bloqueio 4.4."
  call :L "  NAO PUBLIQUE no GitHub ainda. Rode antes, no Mini PC:"
  call :L "     MINIPC-DIAGNOSTICO-SERIALPORT.bat"
) else (
  call :L "  SIM: node_modules/serialport esta versionado."
)
call :L ""

call :L "5.8 - resumo do commit:"
for /f "delims=" %%C in ('git log -1 --oneline 2^>nul') do call :L "  %%C"
call :L ""

call :L "------------------------------------------------------------"
if defined FALHOU (
  call :L "RESULTADO: ATENCAO - alguma validacao FALHOU. Leia acima."
  call :L "Para voltar ao estado anterior sem perder nada do disco:"
  call :L "   git reset --soft backup-commit-sujo"
) else (
  call :L "RESULTADO: OK - commit de baseline limpo."
)
call :L "------------------------------------------------------------"
call :L ""
call :L "Depois que o push para o GitHub der certo, apague os backups:"
call :L "   git branch -D backup-commit-sujo"
call :L "   git tag -d backup-v157-antiga"
call :L ""
call :L "=== FIM DO DIAGNOSTICO ==="

echo.
echo Abrindo o relatorio...
start "" notepad "%LOG%"
echo.
pause
exit /b 0

:abortar
call :L ""
call :L "*** INTERROMPIDO NA FASE 0 - nada foi alterado. ***"
call :L "=== FIM DO DIAGNOSTICO ==="
echo.
start "" notepad "%LOG%"
echo.
pause
exit /b 1

:abortar_sujo
call :L ""
call :L "*** INTERROMPIDO NO MEIO DA CORRECAO ***"
call :L ""
call :L "ATENCAO: o indice do Git JA foi mexido nesta execucao, e o"
call :L "commit e a tag podem ter ficado pela metade. NAO publique."
call :L ""
call :L "Para voltar ao estado anterior mantendo os arquivos do disco:"
call :L "   git reset --soft backup-commit-sujo"
call :L ""
call :L "A tag original, se existia, esta em backup-v157-antiga."
call :L "=== FIM DO DIAGNOSTICO ==="
echo.
start "" notepad "%LOG%"
echo.
pause
exit /b 2

:L
echo(%~1
>>"%LOG%" echo(%~1
exit /b 0
