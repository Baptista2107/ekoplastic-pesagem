@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"
title Ekoplastic Pesagem - Enviar atualizacao

set "ORIGEM=git@github.com:Baptista2107/ekoplastic-pesagem.git"

REM ===================================================================
REM  ENDERECO DO MINI PC - preencha com o IP da LAN ou o do Tailscale.
REM  Deixando VAZIO, o script so' publica no GitHub e nao oferece
REM  aplicar na estacao.
REM
REM  A conversa com a estacao e' pela porta 3443 (HTTPS), NAO pela 3000.
REM  A porta 3000 do sistema escuta so' em 127.0.0.1 - de fora da propria
REM  maquina ela nunca responde. Quem atende a rede e' a 3443, a mesma
REM  que o celular usa, liberada no firewall pelo LIBERAR-ACESSO-CELULAR.bat.
REM  O certificado e' auto-assinado, por isso o curl vai com -k.
set "MINIPC=100.82.224.60"
REM  exemplo:  set "MINIPC=192.168.3.42"
REM ===================================================================
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

REM  O commit atual e' lido JA AQUI. Antes ele so' existia depois da FASE 3,
REM  o que impedia usar a FASE 5 quando nao havia nada novo a enviar.
set "SHA="
for /f "delims=" %%H in ('git rev-parse --short HEAD 2^>nul') do set "SHA=%%H"

set "PEND=0"
for /f %%N in ('git status --porcelain ^| find /c /v ""') do set "PEND=%%N"
if not "%PEND%"=="0" goto :tem_mudanca

REM  Nada novo para publicar. Isso NAO quer dizer que nao ha nada a fazer:
REM  a estacao pode estar atrasada em relacao ao que ja esta no GitHub -
REM  por exemplo quando a FASE 5 foi pulada numa rodada anterior. Entao,
REM  havendo endereco da estacao, seguimos direto para aplicar o commit
REM  que ja existe, em vez de encerrar sem opcao.
call :L "Nada mudou na pasta - nao ha o que publicar."
if not defined MINIPC (
  call :L "E nao ha endereco de estacao configurado. Encerrando."
  call :L "=== FIM DO DIAGNOSTICO ==="
  echo.
  echo  Nada mudou e nenhuma estacao configurada. Nada a fazer.
  echo.
  pause
  exit /b 0
)
call :L "Seguindo para a FASE 5: aplicar na estacao o commit %SHA%,"
call :L "que ja esta publicado."
call :L ""
goto :aplicar_estacao

:tem_mudanca
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
call :L "PUBLICADO NO GITHUB."
call :L "------------------------------------------------------------"
call :L ""

REM ================= FASE 5 - APLICAR NA ESTACAO =================
:aplicar_estacao
if not defined MINIPC (
  call :L "O Mini PC nao recebeu nada. Ele continua na versao anterior."
  call :L "Para poder aplicar daqui, preencha a linha MINIPC no topo"
  call :L "deste .bat com o IP da estacao."
  call :L "=== FIM DO DIAGNOSTICO ==="
  goto :fim_ok
)

call :L "------------------------------------------------------------"
call :L "FASE 5 - APLICAR NA ESTACAO"
call :L "------------------------------------------------------------"
set "URLMINI=https://%MINIPC%:3443"
set "TMPHC=%TEMP%\eko_mini_hc.tmp"
set "TMPJ=%TEMP%\eko_mini_body.tmp"

call :L "Consultando a estacao em %URLMINI% ..."
curl -s -k --max-time 8 "%URLMINI%/healthcheck" > "%TMPHC%" 2>nul
if errorlevel 1 goto :mini_inalcancavel
for %%Z in ("%TMPHC%") do if %%~zZ EQU 0 goto :mini_inalcancavel

type "%TMPHC%" >>"%LOG%"
echo.
echo ------------------------------------------------------------
echo  A ESTACAO RESPONDEU. Confira se e' a maquina certa:
echo ------------------------------------------------------------
type "%TMPHC%"
echo.
echo ------------------------------------------------------------
echo.
echo  Aplicar AGORA o commit %SHA% nesta estacao?
echo.
echo  O servidor vai encerrar e voltar em alguns segundos. A tela
echo  do operador fecha e reabre sozinha. Se houver sessao aberta,
echo  a propria estacao recusa e nada acontece.
echo.
set "APLICAR="
set /p "APLICAR=Digite S para aplicar, ou ENTER para deixar para depois: "
if /I not "%APLICAR%"=="S" (
  call :L "Operador escolheu nao aplicar agora. GitHub atualizado, estacao nao."
  call :L "=== FIM DO DIAGNOSTICO ==="
  goto :fim_ok
)

echo.
set "SENHA="
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "$s=Read-Host -AsSecureString 'Senha de supervisor'; [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))"`) do set "SENHA=%%P"
if not defined SENHA (
  call :L "Senha nao informada - nada foi aplicado na estacao."
  call :L "=== FIM DO DIAGNOSTICO ==="
  goto :fim_ok
)

REM  O corpo vai por arquivo: montar JSON com aspas na linha de comando
REM  do cmd e' fonte garantida de dor de cabeca.
> "%TMPJ%" echo {"senha":"%SENHA%"}
set "SENHA="
call :L "Disparando a atualizacao..."
curl -s -k --max-time 15 -X POST "%URLMINI%/sistema/atualizar" -H "Content-Type: application/json" -d "@%TMPJ%" > "%TEMP%\eko_mini_resp.tmp" 2>nul
del "%TMPJ%" >nul 2>&1
type "%TEMP%\eko_mini_resp.tmp" >>"%LOG%"
echo.
echo  Resposta da estacao:
type "%TEMP%\eko_mini_resp.tmp"
echo.
REM  O "." no lugar da aspa e' proposital: dentro de findstr /C: nao ha
REM  escape de barra invertida, entao \" chegaria literal e nunca casaria.
REM  Com /R, o ponto casa a aspa sem precisar escrever a aspa.
findstr /R /C:"ok.:true" "%TEMP%\eko_mini_resp.tmp" >nul 2>&1
if errorlevel 1 (
  call :L ""
  call :L "A ESTACAO RECUSOU. Nada foi alterado la'."
  call :L "Motivos comuns: senha de supervisor errada, ou sessao aberta"
  call :L "no turno. A resposta acima diz qual foi."
  del "%TEMP%\eko_mini_resp.tmp" >nul 2>&1
  call :L "=== FIM DO DIAGNOSTICO ==="
  goto :fim_ok
)
del "%TEMP%\eko_mini_resp.tmp" >nul 2>&1

call :L "Aceito. Esperando a estacao voltar com o commit %SHA% ..."
echo.
echo  Esperando a estacao voltar. Isso leva alguns segundos.
set /a _e=0
:esperamini
timeout /t 3 /nobreak >nul
set /a _e+=1
curl -s -k --max-time 5 "%URLMINI%/healthcheck" > "%TMPHC%" 2>nul
findstr /C:"%SHA%" "%TMPHC%" >nul 2>&1
if not errorlevel 1 goto :minivoltou
if %_e% lss 25 goto :esperamini

call :L ""
call :L "ATENCAO: a estacao nao voltou com o commit %SHA% em 75 segundos."
call :L "Va' ate' o Mini PC e leia o OUTPUT_ATUALIZACAO_REMOTA.TXT da pasta."
call :L "A estacao pode ter subido com o codigo antigo - que e' o caminho"
call :L "seguro previsto, mas precisa ser conferido."
type "%TMPHC%" >>"%LOG%"
del "%TMPHC%" >nul 2>&1
call :L "=== FIM DO DIAGNOSTICO ==="
goto :fim_ok

:minivoltou
type "%TMPHC%" >>"%LOG%"
echo.
echo ------------------------------------------------------------
type "%TMPHC%"
echo.
echo ------------------------------------------------------------
del "%TMPHC%" >nul 2>&1
call :L ""
call :L "------------------------------------------------------------"
call :L "ESTACAO ATUALIZADA no commit %SHA%."
call :L "------------------------------------------------------------"
call :L ""
call :L "Confira no healthcheck acima: modulo_serial e portaAberta"
call :L "devem estar true, e a impressora detectada. Se a alteracao"
call :L "mexeu em tela, ela ja reabriu sozinha com a versao nova."
call :L ""
call :L "=== FIM DO DIAGNOSTICO ==="
goto :fim_ok

:mini_inalcancavel
call :L "Nao consegui falar com a estacao em %URLMINI%"
call :L "O GitHub JA foi atualizado - isso nao se perdeu."
call :L "O GitHub nao se perdeu - a estacao e' que nao atendeu."
call :L "Confira, nesta ordem:"
call :L "  1. a estacao esta ligada e com o INICIAR.bat rodando?"
call :L "  2. a porta 3443 esta liberada no firewall dela? Rode uma vez"
call :L "     o LIBERAR-ACESSO-CELULAR.bat NO MINI PC."
call :L "  3. o HTTPS subiu la'? Na janela preta do servidor deve aparecer"
call :L "     a linha HTTPS(rede): https://<ip-do-mini-pc>:3443"
call :L "  4. o IP mudou? Rode o DESCOBRIR-MINIPC.bat."
del "%TMPHC%" >nul 2>&1
call :L "=== FIM DO DIAGNOSTICO ==="
goto :fim_ok

:fim_ok
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
