@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"
title Ekoplastic - Preparar a troca de pastas - PARTE 1 de 2

REM ===================================================================
REM  RODA NO MINI PC, DENTRO DA PASTA QUE ESTA EM PRODUCAO.
REM  PODE RODAR COM O SISTEMA NO AR. Nao para nada, nao altera nada
REM  nesta pasta - so' LE. Tudo que ele cria vai para a pasta nova.
REM ===================================================================
set "REPO=git@github.com:Baptista2107/ekoplastic-pesagem.git"
set "DESTINO=C:\Ekoplastic\pesagem"
set "CHAVE=%USERPROFILE%\.ssh\id_ed25519_pesagem"
REM ===================================================================

set "LOG=%TEMP%\OUTPUT_TROCA_PARTE1.TXT"
set "URLSAUDE=http://localhost:3000/healthcheck"

> "%LOG%" echo ============================================================
call :L "  TROCA DE PASTAS - PARTE 1 - PREPARAR"
call :L "============================================================"
call :L "Data......: %date% %time%"
call :L "Producao..: %~dp0"
call :L "Destino...: %DESTINO%"
call :L ""
call :L "Esta parte NAO para o sistema e NAO escreve nada na pasta de"
call :L "producao. Pode rodar com a fabrica trabalhando."
call :L ""
call :L "O destino fica FORA do Desktop de proposito: a pasta atual"
call :L "aparenta estar em nuvem sincronizada, e banco SQLite em pasta"
call :L "sincronizada e' risco de corrupcao."
call :L ""

REM ---------- FASE 0 ----------
call :L "------------------------------------------------------------"
call :L "FASE 0 - VERIFICACOES"
call :L "------------------------------------------------------------"
if not exist "server.js" ( call :L "FALHA: rode este .bat DENTRO da pasta de producao." & goto :parar )
git --version >>"%LOG%" 2>&1
if errorlevel 1 ( call :L "FALHA: Git nao respondeu." & goto :parar )
where node >nul 2>&1
if errorlevel 1 ( call :L "FALHA: Node nao esta no PATH." & goto :parar )
where ssh-keygen >nul 2>&1
if errorlevel 1 ( call :L "FALHA: ssh-keygen nao esta no PATH - sem ele nao da' para gerar a chave." & goto :parar )
where curl >nul 2>&1
if errorlevel 1 ( call :L "FALHA: curl nao esta no PATH." & goto :parar )
call :L "OK: pasta de producao, Git, Node, ssh-keygen e curl."

if exist "%DESTINO%\.git" (
  call :L "FALHA: ja existe um clone em %DESTINO%"
  call :L "Se quer refazer, apague a pasta antes. Nao vou sobrescrever."
  goto :parar
)

REM ---------- FASE 1 - fotografa o estado atual ----------
call :L ""
call :L "------------------------------------------------------------"
call :L "FASE 1 - FOTOGRAFANDO O SISTEMA NO AR"
call :L "------------------------------------------------------------"
curl -s -o nul --max-time 5 "%URLSAUDE%" >nul 2>&1
if errorlevel 1 (
  call :L "FALHA: o sistema nao respondeu em %URLSAUDE%"
  call :L "Esta parte precisa do sistema NO AR para anotar as contagens"
  call :L "que a PARTE 2 vai conferir depois da copia do banco."
  goto :parar
)
set "REF=%TEMP%\eko_ref_troca.txt"
curl -s "%URLSAUDE%" > "%REF%" 2>nul
call :L "Healthcheck de agora:"
type "%REF%" >>"%LOG%"
echo.
echo ------------------------------------------------------------
type "%REF%"
echo.
echo ------------------------------------------------------------
call :L ""
call :L "Guarde de cabeca os numeros de etiquetas e sessoes. A PARTE 2"
call :L "compara com eles: se depois da copia os numeros cairem, o WAL"
call :L "ficou para tras e o banco veio incompleto."
call :L ""

REM ---------- FASE 2 - chave ----------
call :L "------------------------------------------------------------"
call :L "FASE 2 - CHAVE DE ACESSO DESTA MAQUINA"
call :L "------------------------------------------------------------"
if exist "%CHAVE%" (
  call :L "OK: ja existe a chave %CHAVE%"
) else (
  if not exist "%USERPROFILE%\.ssh" mkdir "%USERPROFILE%\.ssh" >nul 2>&1
  ssh-keygen -t ed25519 -N "" -C "minipc-ekoplastic-pesagem" -f "%CHAVE%" >>"%LOG%" 2>&1
  if errorlevel 1 ( call :L "FALHA ao gerar a chave." & goto :parar )
  call :L "OK: chave gerada."
)

echo.
echo ============================================================
echo  COPIE A LINHA ABAIXO INTEIRA
echo ============================================================
type "%CHAVE%.pub"
echo.
echo ============================================================
echo  No GitHub, no repositorio ekoplastic-pesagem:
echo    Settings  ^>  Deploy keys  ^>  Add deploy key
echo    Title: Mini PC TANCA
echo    Key:   cole a linha acima
echo    Allow write access:  DEIXE DESMARCADO
echo.
echo  Esta maquina so' precisa LER. Sem escrita, nada que aconteca
echo  aqui no chao de fabrica consegue alterar o repositorio.
echo.
echo  Depois de cadastrar, pressione uma tecla para continuar.
echo ============================================================
type "%CHAVE%.pub" >>"%LOG%"
pause >nul

REM ---------- FASE 3 - testa o acesso ----------
call :L ""
call :L "------------------------------------------------------------"
call :L "FASE 3 - TESTANDO O ACESSO AO GITHUB"
call :L "------------------------------------------------------------"
set "GIT_SSH_COMMAND=ssh -i %CHAVE% -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
ssh -i "%CHAVE%" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -T git@github.com >>"%LOG%" 2>&1
findstr /I /C:"successfully authenticated" "%LOG%" >nul 2>&1
if errorlevel 1 (
  call :L "FALHA: o GitHub nao aceitou a chave."
  call :L "Confira se a deploy key foi mesmo cadastrada NESTE repositorio."
  call :L "Se o erro for timeout, a porta 22 pode estar bloqueada. Nesse"
  call :L "caso acrescente ao %USERPROFILE%\.ssh\config:"
  call :L "   Host github.com"
  call :L "     HostName ssh.github.com"
  call :L "     Port 443"
  goto :parar
)
call :L "OK: o GitHub aceitou a chave desta maquina."

REM ---------- FASE 4 - clone ----------
call :L ""
call :L "------------------------------------------------------------"
call :L "FASE 4 - BAIXANDO O CODIGO"
call :L "------------------------------------------------------------"
echo.
echo  Baixando o repositorio. Pode demorar um pouco...
echo.
git clone "%REPO%" "%DESTINO%" >>"%LOG%" 2>&1
if errorlevel 1 ( call :L "FALHA no clone. Veja o log." & goto :parar )
call :L "OK: codigo baixado em %DESTINO%"

set "NARQ=0"
for /f %%N in ('git -C "%DESTINO%" ls-files ^| find /c /v ""') do set "NARQ=%%N"
call :L "Arquivos no clone: %NARQ%"
if not exist "%DESTINO%\node_modules\serialport\package.json" (
  call :L "FALHA: o clone veio sem o serialport. NAO prossiga."
  goto :parar
)
call :L "OK: serialport presente no clone."

REM  DEFEITO CORRIGIDO: sem isto, o clone so' autentica enquanto o
REM  GIT_SSH_COMMAND desta janela existir. Na proxima vez - no
REM  ATUALIZAR.bat - o git tentaria a chave padrao, que nao e' esta, e
REM  o fetch falharia com "Permission denied". Gravado no .git/config
REM  do clone, vale para sempre. Aspas simples porque quem interpreta
REM  esta linha e' o git, e ele entende aspas simples em toda plataforma.
git -C "%DESTINO%" config core.sshCommand "ssh -i '%CHAVE%' -o IdentitiesOnly=yes" >>"%LOG%" 2>&1
if errorlevel 1 ( call :L "FALHA ao gravar a chave no clone." & goto :parar )
call :L "OK: chave desta maquina gravada no clone."

call :L "Testando se o clone fala com o GitHub SOZINHO, sem esta janela:"
setlocal
set "GIT_SSH_COMMAND="
git -C "%DESTINO%" fetch origin >>"%LOG%" 2>&1
if errorlevel 1 (
  endlocal
  call :L "FALHA: o clone nao autentica por conta propria."
  call :L "O ATUALIZAR.bat falharia depois. NAO prossiga."
  goto :parar
)
endlocal
call :L "OK: o clone autentica sozinho - o ATUALIZAR.bat vai funcionar."

REM ---------- FASE 5 - runtime que nao depende de parar ----------
call :L ""
call :L "------------------------------------------------------------"
call :L "FASE 5 - LEVANDO O QUE NAO EXIGE PARAR O SISTEMA"
call :L "------------------------------------------------------------"
call :copiar_arq "credenciais-bling.json"
call :copiar_pasta "cert"
call :copiar_pasta "backups"
call :L "O banco, o token do Bling e os logs ficam para a PARTE 2 -"
call :L "eles mudam a todo instante e so' podem ser copiados com o"
call :L "sistema parado."

copy /y "%REF%" "%DESTINO%\OUTPUT_REFERENCIA_TROCA.TXT" >nul 2>&1
call :L "Referencia salva em %DESTINO%\OUTPUT_REFERENCIA_TROCA.TXT"

call :L ""
call :L "------------------------------------------------------------"
call :L "CONFERENCIA FINAL - o clone ficou limpo?"
call :L "------------------------------------------------------------"
call :L "O ATUALIZAR.bat se recusa a rodar com arquivo estranho na pasta."
call :L "Tudo que copiamos para ca' tem que estar coberto pelo .gitignore."
set "SUJO=0"
for /f %%N in ('git -C "%DESTINO%" status --porcelain ^| find /c /v ""') do set "SUJO=%%N"
git -C "%DESTINO%" status --porcelain >>"%LOG%" 2>&1
if "%SUJO%"=="0" (
  call :L "OK: clone limpo. O ATUALIZAR.bat vai aceitar esta pasta."
) else (
  call :L "ATENCAO: %SUJO% arquivo aparece como alteracao no clone."
  call :L "Veja a lista no relatorio - algum arquivo copiado escapou do"
  call :L ".gitignore e vai travar o ATUALIZAR.bat depois."
)

call :L ""
call :L "------------------------------------------------------------"
call :L "PARTE 1 CONCLUIDA - o sistema nunca parou."
call :L "------------------------------------------------------------"
call :L ""
call :L "Proximo passo, quando a fabrica permitir alguns minutos:"
call :L "  1. Encerre o sistema pela propria tela"
call :L "  2. Rode  MINIPC-2-TROCAR.bat  que esta em:"
call :L "     %DESTINO%"
call :L ""
call :L "Ate' la' nada mudou: a pasta de producao segue intacta e"
call :L "rodando. Se voce desistir, e' so' apagar %DESTINO%"
call :L ""
call :L "=== FIM DO DIAGNOSTICO ==="
echo.
start "" notepad "%LOG%"
echo.
pause
exit /b 0

:copiar_arq
if not exist "%~dp0%~1" ( call :L "  AVISO: %~1 nao existe na producao." & exit /b 0 )
copy /y "%~dp0%~1" "%DESTINO%\%~1" >nul 2>&1
if errorlevel 1 ( call :L "  ERRO ao copiar %~1" ) else ( call :L "  copiado: %~1" )
exit /b 0

:copiar_pasta
if not exist "%~dp0%~1" ( call :L "  AVISO: pasta %~1 nao existe na producao." & exit /b 0 )
robocopy "%~dp0%~1" "%DESTINO%\%~1" /E /NFL /NDL /NJH /NJS /NP >>"%LOG%" 2>&1
if errorlevel 8 ( call :L "  ERRO ao copiar a pasta %~1" ) else ( call :L "  copiada: pasta %~1" )
exit /b 0

:parar
call :L ""
call :L "*** INTERROMPIDO - a producao nao foi tocada. ***"
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
