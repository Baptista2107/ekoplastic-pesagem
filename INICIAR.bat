@echo off
chcp 65001 >nul
cd /d "%~dp0"
goto inicio

REM ===================================================================
REM  PASSAGEM DA ATUALIZACAO DE 11/11/2026 - NAO MEXER NESTE BLOCO
REM  O cmd le o .bat pela posicao em bytes. O INICIAR.bat ate 11/11/2026
REM  rodava o "git merge" numa linha sozinha; quando o git trocava este
REM  arquivo, o cmd seguia lendo o arquivo NOVO a partir do byte 4115 do
REM  antigo. Todas as linhas abaixo mandam para o mesmo lugar, entao
REM  onde quer que ele caia aqui dentro, vai para o fim da atualizacao.
REM  O teste testes/tela-sempre-viva.js confere a posicao. Pode sair
REM  quando nenhuma estacao rodar mais o INICIAR.bat antigo.
REM  Daqui para frente o merge e o "goto" estao na MESMA linha (o cmd le
REM  a linha inteira antes de executar), e isto nao e' mais preciso.
REM ===================================================================
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge
goto atualizar_pos_merge

:inicio
REM ===================================================================
REM  PORTA DA BALANCA: a balanca esta na COM1 do Mini PC.
REM  (confira as portas em http://localhost:3000/balanca/portas)
set EKO_SERIAL_PORT=COM1
REM ===================================================================

REM ===================================================================
REM  O SERVIDOR NAO FICA FECHADO E A TELA VOLTA SOZINHA (11/11/2026)
REM  Este .bat tem tres papeis:
REM   - sem argumento (atalho de inicializacao e duplo-clique): se o
REM     servidor ja responde, so' pede a tela e sai; se nao, vira o
REM     servidor.
REM   - servidor: o laco que roda o node e religa se cair. Se ja ha
REM     outro servidor respondendo, sai: a porta 3000 nao deixa dois.
REM   - o VIGIA da tela (tela-vigia.ps1, oculto): e' o UNICO que abre o
REM     navegador, e so' na sessao do monitor, nunca na sessao 0 do
REM     Windows (servicos), onde a janela nao aparece. Se o servidor
REM     some por 30 s sem ninguem cuidando, ele chama "INICIAR servidor".
REM  "Fechar agora" na tela fecha so' o navegador, por 10 minutos.
REM ===================================================================
set "URL=http://localhost:3000"
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell"

if "%~1"=="servidor" goto servidor
if "%~1"=="autostart" goto autostart
REM  "abrir" era o ramo que abria o navegador ate 11/11/2026. Agora so'
REM  pede a tela ao vigia.
if "%~1"=="abrir" goto pedir_tela

REM --- Garante dependencias na 1a vez (node-forge p/ HTTPS da rede) ---
if not exist "node_modules\node-forge" (
  echo Instalando dependencias pela primeira vez, aguarde...
  call npm install
)

REM --- Evita duas instancias: se o servidor JA responde, so pede a tela ---
curl -s -o nul -m 3 %URL%/healthcheck >nul 2>&1
if not errorlevel 1 (
  echo O servidor ja esta rodando. A tela abre em instantes...
  call :pedir_tela_aqui
  timeout /t 2 /nobreak >nul
  exit /b
)

call :garantir_vigia
REM  Confere o atalho de inicio automatico em segundo plano - nunca
REM  atrasa a subida do servidor. Ver o bloco :autostart la embaixo.
call :oculto autostart
goto servidor

REM ===================================================================
REM  PEDIR A TELA: tira a pausa do "Fechar agora" e garante o vigia.
REM ===================================================================
:pedir_tela
call :pedir_tela_aqui
exit /b

:pedir_tela_aqui
curl -s -o nul -m 3 -X POST %URL%/sistema/tela/abrir >nul 2>&1
call :garantir_vigia
exit /b

REM  Sobe o vigia oculto. Ele mesmo sai se estiver na sessao 0 ou se ja
REM  houver outro vigia (mutex) - chamar de novo nao duplica nada.
:garantir_vigia
if not exist "%~dp0tela-vigia.ps1" exit /b
"%PS%" -NoProfile -Command "Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"%~dp0tela-vigia.ps1\"'" >nul 2>&1
exit /b

REM ===================================================================
REM  SERVIDOR - o laco que roda o node
REM ===================================================================
:servidor
title Ekoplastic - Servidor de Etiquetas

:loop
REM  Ja ha um servidor respondendo (outra janela, outra sessao): nao
REM  sobe um segundo. Quem cuida dele e' quem o subiu; se ele cair e
REM  ninguem cuidar, o vigia chama um INICIAR novo.
curl -s -o nul -m 3 %URL%/healthcheck >nul 2>&1
if not errorlevel 1 (
  echo [AVISO] Ja ha um servidor respondendo em %URL% - esta janela nao sobe outro.
  timeout /t 3 /nobreak >nul
  exit
)
REM  eko-encerrar.flag: ate 11/11/2026 o "Fechar agora" gravava esta
REM  bandeira e o laco parava de vez. Nada mais a grava; se sobrou uma,
REM  ela NAO desliga o servidor.
if exist "eko-encerrar.flag" del "eko-encerrar.flag" >nul 2>&1
echo ============================================================
echo  EKOPLASTIC - Iniciando servidor...  (%date% %time%)
echo  Se cair, reinicia sozinho. Se esta janela for fechada, o vigia
echo  da tela sobe o servidor de novo em cerca de 30 segundos.
echo ============================================================
node server.js
set "RC=%errorlevel%"
if exist "eko-atualizar.flag" goto atualizar
if exist "eko-encerrar.flag" del "eko-encerrar.flag" >nul 2>&1
call :garantir_vigia
echo.
echo [AVISO] O servidor encerrou (codigo %RC%).
echo Reiniciando em 5 segundos...
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
REM
REM  eko-atualizando.flag: enquanto existir (ate 15 min), o vigia da
REM  tela nao sobe outro servidor - o git pode demorar mais de 30 s.
REM ===================================================================
:atualizar
del "eko-atualizar.flag" >nul 2>&1
> "%~dp0eko-atualizando.flag" echo %date% %time%
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

REM  O git pode trocar ESTE arquivo. O cmd le a linha inteira antes de
REM  executar, entao o "goto" no fim da mesma linha ja esta lido e manda
REM  procurar o rotulo na versao NOVA do arquivo. Nao separe em linhas.
git merge --ff-only origin/main >>"%LOGA%" 2>&1 && goto atualizar_pos_merge || goto atualizar_merge_falhou

:atualizar_merge_falhou
echo  [FALHA] Nao deu para avancar em linha reta.
echo          A estacao continua na versao %ANTES%.
>>"%LOGA%" echo FALHA: merge --ff-only recusado - pasta divergente ou suja.
git status --short >>"%LOGA%" 2>&1
>>"%LOGA%" echo === FIM DO DIAGNOSTICO ===
goto atualizar_fim

:atualizar_pos_merge
if not defined LOGA set "LOGA=%~dp0OUTPUT_ATUALIZACAO_REMOTA.TXT"
set "DEPOIS="
for /f "delims=" %%H in ('git rev-parse --short HEAD 2^>nul') do set "DEPOIS=%%H"
echo  Versao depois: %DEPOIS%
>>"%LOGA%" echo Versao depois: %DEPOIS%
if /I "%ANTES%"=="%DEPOIS%" (
  echo  Nada novo - ja estava na versao mais recente.
  >>"%LOGA%" echo Nada novo: ja estava atualizado - ou o merge foi recusado.
  git status --short >>"%LOGA%" 2>&1
) else (
  >>"%LOGA%" echo OK: atualizado de %ANTES% para %DEPOIS%
  git log --oneline %ANTES%..%DEPOIS% >>"%LOGA%" 2>&1
)
>>"%LOGA%" echo === FIM DO DIAGNOSTICO ===
goto atualizar_fim

:atualizar_fim
if not defined LOGA set "LOGA=%~dp0OUTPUT_ATUALIZACAO_REMOTA.TXT"
REM  O INICIAR antigo chega aqui pela passagem sem ter lido o comeco
REM  deste arquivo: as variaveis do comeco podem nao existir.
if not defined URL set "URL=http://localhost:3000"
if not defined PS set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not defined EKO_SERIAL_PORT set EKO_SERIAL_PORT=COM1
REM  A tela antiga precisa fechar para reabrir com o HTML/JS novo. Mas so'
REM  fecha se houver VIGIA para reabrir: em 11/11/2026 este ramo fechou o
REM  Chrome do monitor e abriu outro na sessao 0, invisivel. Sem vigia, a
REM  tela fica como esta (F5 mostra a versao nova) - tela velha e' melhor
REM  que tela nenhuma.
"%PS%" -NoProfile -Command "try { [void][System.Threading.Mutex]::OpenExisting('Global\EkoplasticTelaVigia'); exit 7 } catch { if ($_.Exception.ToString() -match 'UnauthorizedAccess') { exit 7 }; exit 0 }" >nul 2>&1
if "%errorlevel%"=="7" goto atualizar_fecha_tela
>>"%LOGA%" echo Tela: sem vigia na sessao do monitor - a tela fica como esta.
goto atualizar_sobe

:atualizar_fecha_tela
>>"%LOGA%" echo Tela: o vigia esta ativo - fecho o navegador e ele reabre com a versao nova.
taskkill /IM chrome.exe /F >nul 2>&1
taskkill /IM msedge.exe /F >nul 2>&1

:atualizar_sobe
del "%~dp0eko-atualizando.flag" >nul 2>&1
REM  Reconfere o atalho de inicializacao a CADA atualizacao remota. Sem
REM  isto, o ramo :autostart so' rodaria quando alguem abrisse o
REM  INICIAR.bat desta pasta - o que nao acontece justamente quando o
REM  atalho aponta para a pasta errada. Era o circulo vicioso.
call :oculto autostart
call :garantir_vigia
echo  Subindo o servidor...
timeout /t 2 /nobreak >nul
title Ekoplastic - Servidor de Etiquetas
goto loop

REM ===================================================================
REM  INICIO AUTOMATICO - AUTO-CORRECAO
REM  Em 29/08/2026 o Mini PC foi reiniciado e subiu o sistema ANTIGO.
REM  Quem manda no que sobe e' o atalho da pasta Inicializar do Windows,
REM  e ele continuava apontando para "Desktop\PROJETO AUTOMACAO". Trocar
REM  a pasta de onde o sistema roda nao mexe nesse atalho.
REM
REM  Agora, toda vez que o sistema sobe, ele mesmo confere e corrige o
REM  atalho, e desativa atalhos de outras instalacoes que disputariam a
REM  porta 3000 no boot. A proxima atualizacao remota ja deixa o inicio
REM  automatico certo, sem ninguem precisar ir ate a estacao.
REM
REM  Roda em segundo plano; o servidor nao espera por isto.
REM  Relatorio em OUTPUT_INICIO_AUTOMATICO.TXT
REM ===================================================================
:autostart
if not exist "%~dp0conferir-inicio-automatico.ps1" exit /b
set "ALVO=%~dp0INICIAR.bat"
set "PASTA=%~dp0"
set "LINK=%AppData%\Microsoft\Windows\Start Menu\Programs\Startup\Ekoplastic - Sistema de Etiquetas.lnk"
set "PS=powershell"
where powershell >nul 2>&1
if errorlevel 1 set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0conferir-inicio-automatico.ps1" > "%~dp0OUTPUT_INICIO_AUTOMATICO.TXT" 2>&1
exit /b

REM ===================================================================
REM  JANELAS DE APOIO SEM JANELA
REM  "start /min arquivo.bat" abre cmd /K: a janela fica aberta depois
REM  de terminar. E no Windows 11 quem abre e' o Windows Terminal, que
REM  ignora o /min. Resultado: terminais sobrando na tela a cada subida
REM  (20/10/2026). Aqui o ramo roda com cmd /c e janela oculta, e fecha
REM  sozinho. Se o PowerShell falhar, cai no jeito antigo.
REM ===================================================================
:oculto
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -Command "Start-Process cmd.exe -WindowStyle Hidden -ArgumentList '/c \"%~f0\" %~1'" >nul 2>&1
if errorlevel 1 start "" /min cmd /c ""%~f0" %~1"
exit /b
