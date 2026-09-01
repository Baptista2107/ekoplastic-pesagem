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
set "MINIPC="
REM  exemplo:  set "MINIPC=192.168.3.42"
REM
REM  Quantas vezes insistir na FASE 5 quando a estacao estiver ocupada,
REM  esperando 10s entre uma e outra. 30 = 5 minutos. Suba este numero
REM  se quiser deixar o script cacando a janela por mais tempo
REM  (180 = 30 minutos), por exemplo na virada de turno.
set "TENTATIVAS=30"
REM ===================================================================
if not defined TENTATIVAS set "TENTATIVAS=30"

REM  O arquivo estacao.txt, se existir nesta pasta, MANDA MAIS que a
REM  linha MINIPC acima. E' nele que o DESCOBRIR-MINIPC.bat grava o
REM  endereco. Assim uma versao nova deste .bat nunca apaga a sua
REM  configuracao - foi o que aconteceu antes. Ele fica fora do Git.
if exist "%~dp0estacao.txt" for /f "usebackq eol=# delims=" %%E in ("%~dp0estacao.txt") do if not "%%E"=="" set "MINIPC=%%E"

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
if not "%RCT%"=="0" goto :testes_falharam

REM  Segundo portao: a janela segura da atualizacao remota. Leva uns 30s
REM  porque ele espera o silencio de verdade e reinicia o servidor de
REM  teste para provar que a sessao aberta sobrevive com as bipadas.
REM  Terceiro portao: as travas de extrusao (bipagem duplicada, peso
REM  repetido por maquina, auto-fim de turno). Reproduz o caso real de
REM  30/08/2026 num servidor de teste.
if not exist "testes\travas-extrusao.js" goto :sem_travas
echo.
echo  Rodando o teste das travas de extrusao. Leva uns 25 segundos...
echo.
set "SAIDA3=%TEMP%\eko_testes3.tmp"
node testes\travas-extrusao.js > "%SAIDA3%" 2>&1
set "RCT=%ERRORLEVEL%"
type "%SAIDA3%"
type "%SAIDA3%" >>"%LOG%"
del "%SAIDA3%" >nul 2>&1
if not "%RCT%"=="0" goto :testes_falharam

:sem_travas
REM  Quarto portao: resumo opcional / resumo do dia. Prova que extrusao,
REM  recebimento e produto acabado seguem imprimindo o resumo ao finalizar
REM  e que retirada, retorno e residuos acumulam no resumo do dia sem
REM  perder nenhum dado.
if not exist "testes\resumo-opcional.js" goto :sem_resumo
echo.
echo  Rodando o teste do resumo do dia. Leva uns 20 segundos...
echo.
set "SAIDA4=%TEMP%\eko_testes4.tmp"
node testes\resumo-opcional.js > "%SAIDA4%" 2>&1
set "RCT=%ERRORLEVEL%"
type "%SAIDA4%"
type "%SAIDA4%" >>"%LOG%"
del "%SAIDA4%" >nul 2>&1
if not "%RCT%"=="0" goto :testes_falharam

:sem_resumo
if not exist "testes\janela-atualizacao.js" goto :testes_ok
echo.
echo  Rodando o teste da janela de atualizacao. Leva uns 30 segundos...
echo.
set "SAIDA2=%TEMP%\eko_testes2.tmp"
node testes\janela-atualizacao.js > "%SAIDA2%" 2>&1
set "RCT=%ERRORLEVEL%"
type "%SAIDA2%"
type "%SAIDA2%" >>"%LOG%"
del "%SAIDA2%" >nul 2>&1
if "%RCT%"=="0" goto :testes_ok

:testes_falharam
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
echo  Sessao aberta NAO impede mais. A Extrusao roda 24h e nunca
echo  fecharia sessao. Quem impede e' trabalho no ar: bobina
echo  impressa esperando bipe, sessao aberta ainda sem nenhuma
echo  bipada, ou movimento nos ultimos segundos.
echo.
echo  Estando ocupada, eu fico tentando a cada 10s por ate 5 min e
echo  aplico no primeiro momento de silencio. Se nao aparecer
echo  janela, nada acontece na estacao.
echo.
echo  Quando aplicar, o servidor encerra e volta em alguns segundos.
echo  A tela do operador fecha e reabre sozinha. As sessoes abertas
echo  continuam abertas, com tudo que ja foi bipado.
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

call :L "Disparando a atualizacao. Se a estacao estiver ocupada, insisto a"
call :L "cada 10s, ate' %TENTATIVAS% vezes, ate' aparecer um momento de silencio."
set "RESP=%TEMP%\eko_mini_resp.tmp"
set /a _t=0

:tentar_aplicar
set /a _t+=1
REM  O corpo vai por arquivo: montar JSON com aspas na linha de comando
REM  do cmd e' fonte garantida de dor de cabeca.
> "%TMPJ%" echo {"senha":"%SENHA%"}
curl -s -k --max-time 25 -X POST "%URLMINI%/sistema/atualizar" -H "Content-Type: application/json" -d "@%TMPJ%" > "%RESP%" 2>nul
del "%TMPJ%" >nul 2>&1
type "%RESP%" >>"%LOG%"
echo.
echo  Tentativa %_t% de %TENTATIVAS% - resposta da estacao:
type "%RESP%"
echo.
REM  O "." no lugar da aspa e' proposital: dentro de findstr /C: nao ha
REM  escape de barra invertida, entao \" chegaria literal e nunca casaria.
REM  Com /R, o ponto casa a aspa sem precisar escrever a aspa.
findstr /R /C:"ok.:true" "%RESP%" >nul 2>&1
if not errorlevel 1 goto :aplicar_aceito

REM  So' insistimos quando a recusa foi por ESTACAO OCUPADA. Duas marcas,
REM  porque a estacao pode ainda estar com o server.js antigo:
REM    tente_de_novo -> versao nova, janela fechada agora
REM    abertas       -> as duas versoes listam as sessoes abertas
REM  Senha errada e falha de verdade nao trazem nenhuma das duas.
findstr /C:"tente_de_novo" "%RESP%" >nul 2>&1
if not errorlevel 1 goto :aplicar_insistir
findstr /C:"abertas" "%RESP%" >nul 2>&1
if errorlevel 1 goto :aplicar_recusado

:aplicar_insistir
if %_t% geq %TENTATIVAS% goto :aplicar_sem_janela
echo  Estacao ocupada. Tento de novo em 10 segundos...
timeout /t 10 /nobreak >nul
goto :tentar_aplicar

:aplicar_recusado
set "SENHA="
call :L ""
call :L "A ESTACAO RECUSOU. Nada foi alterado la'."
call :L "Motivo mais comum: senha de supervisor errada. A resposta"
call :L "acima diz qual foi."
del "%RESP%" >nul 2>&1
del "%TMPHC%" >nul 2>&1
call :L "=== FIM DO DIAGNOSTICO ==="
goto :fim_ok

:aplicar_sem_janela
set "SENHA="
call :L ""
call :L "NAO APARECEU JANELA em %TENTATIVAS% tentativas - a estacao ficou"
call :L "ocupada o tempo todo. NADA foi alterado la': ela segue na versao"
call :L "antiga, com as sessoes e as etiquetas intactas."
call :L "O GitHub ja esta atualizado. Rode este .bat de novo mais tarde"
call :L "que ele vai direto para a FASE 5."
del "%RESP%" >nul 2>&1
del "%TMPHC%" >nul 2>&1
call :L "=== FIM DO DIAGNOSTICO ==="
goto :fim_ok

:aplicar_aceito
set "SENHA="
del "%RESP%" >nul 2>&1

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
REM  ---- espera a deteccao da impressora --------------------------------
REM  detectarImpressora roda PowerShell e e' ASSINCRONA: a estacao ja
REM  responde /healthcheck varios segundos antes de PRINTER_DETECTADA
REM  virar true. Ler cedo demais mostra "impressora nao detectada" e da'
REM  um susto que nao existe - mas o susto tambem pode ser real, e nesse
REM  caso a etiqueta sairia em SIMULACAO, sem papel. Entao esperamos ate'
REM  30s e, nao vindo, pedimos a re-deteccao pelo endpoint proprio.
echo.
echo  Esperando a impressora ser detectada na estacao...
set /a _i=0
:esperaimp
findstr /R /C:"impressora_detectada.:true" "%TMPHC%" >nul 2>&1
if not errorlevel 1 goto :impok
set /a _i+=1
if %_i% geq 15 goto :impforca
timeout /t 2 /nobreak >nul
curl -s -k --max-time 5 "%URLMINI%/healthcheck" > "%TMPHC%" 2>nul
goto :esperaimp

:impforca
call :L "Impressora nao apareceu em 30s - pedindo re-deteccao na estacao..."
curl -s -k --max-time 20 -X POST "%URLMINI%/impressora/redetectar" >>"%LOG%" 2>&1
timeout /t 3 /nobreak >nul
curl -s -k --max-time 5 "%URLMINI%/healthcheck" > "%TMPHC%" 2>nul

:impok
type "%TMPHC%" >>"%LOG%"
echo.
echo ------------------------------------------------------------
type "%TMPHC%"
echo.
echo ------------------------------------------------------------
findstr /R /C:"impressora_detectada.:true" "%TMPHC%" >nul 2>&1
if errorlevel 1 goto :impruim
call :L ""
call :L "OK: impressora detectada - impressao real, sem simulacao."
goto :impfim

:impruim
call :L ""
call :L "ATENCAO: a impressora NAO foi detectada na estacao."
call :L "A pesagem funciona, mas a etiqueta sai em SIMULACAO - ou seja,"
call :L "NAO sai no papel. Confira se a ELGIN esta ligada e reconhecida"
call :L "no Windows do Mini PC, e teste uma impressao antes de liberar"
call :L "o turno."

:impfim
del "%TMPHC%" >nul 2>&1
call :L ""
call :L "------------------------------------------------------------"
call :L "ESTACAO ATUALIZADA no commit %SHA%."
call :L "------------------------------------------------------------"
call :L ""
call :L "No healthcheck acima, balanca.portaAberta deve estar true e as"
call :L "contagens do banco devem ser as mesmas de antes - nada se perde"
call :L "num reinicio. As sessoes que estavam abertas continuam abertas."
call :L "Se a alteracao mexeu em tela, ela ja reabriu com a versao nova."
call :L ""
call :L "=== FIM DO DIAGNOSTICO ==="
goto :fim_ok

:mini_inalcancavel
call :L "Nao consegui falar com a estacao em %URLMINI%"
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
