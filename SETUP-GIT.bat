@echo off
chcp 65001 >nul
title Ekoplastic Pesagem - Setup do repositorio Git
color 0B
cd /d "%~dp0"
set "LOG=%~dp0SETUP-GIT-LOG.txt"
echo Ekoplastic Pesagem - Setup Git - %DATE% %TIME% > "%LOG%"

call :say ""
call :say "============================================================"
call :say "  EKOPLASTIC PESAGEM - SETUP DO REPOSITORIO GIT (v157)"
call :say "============================================================"
call :say ""
call :say "  Prepara o controle de versao NESTA pasta."
call :say "  NAO envia nada para a internet."
call :say "  Tudo e' reversivel apagando a pasta .git"
call :say ""
call :say "  Pasta atual:"
call :say "  %CD%"
call :say ""
call :say "  Um log sera salvo em SETUP-GIT-LOG.txt"
call :say "============================================================"
call :say ""
pause

call :say ""
call :say "[1/7] Verificando o Git..."
git --version >> "%LOG%" 2>&1
if errorlevel 1 (
  call :say "  ERRO: Git nao encontrado nesta maquina."
  goto :erro
)
for /f "delims=" %%v in ('git --version') do call :say "  %%v"
call :say "  OK."

call :say ""
call :say "[2/7] Verificando os arquivos necessarios..."
if not exist "server.js" (
  call :say "  ERRO: server.js NAO esta nesta pasta."
  call :say "  Coloque o SETUP-GIT.bat DENTRO da pasta do sistema."
  goto :erro
)
call :say "  OK: server.js encontrado."
if not exist ".gitignore" (
  call :say "  ERRO: .gitignore NAO esta nesta pasta."
  goto :erro
)
call :say "  OK: .gitignore encontrado."
if not exist ".gitattributes" (
  call :say "  ERRO: .gitattributes NAO esta nesta pasta."
  goto :erro
)
call :say "  OK: .gitattributes encontrado."

call :say ""
call :say "[3/7] Verificando se ja existe repositorio..."
if exist ".git" (
  call :say "  AVISO: esta pasta JA e um repositorio Git."
  call :say "  Nada foi alterado, para preservar o historico."
  goto :fim
)
call :say "  OK: pasta limpa."

call :say ""
call :say "[4/7] Criando o repositorio local..."
git init -b main >> "%LOG%" 2>&1
if errorlevel 1 goto :erro
call :say "  OK."

call :say ""
call :say "[5/7] Registrando os arquivos (pode demorar 1-2 min)..."
git add . >> "%LOG%" 2>&1
if errorlevel 1 goto :erro
for /f %%n in ('git diff --cached --name-only ^| find /c /v ""') do call :say "  OK: %%n arquivos registrados."

call :say ""
call :say "[6/7] CONFERINDO SE ALGO PROIBIDO ENTROU..."
set "SUJO=0"
call :checar "etiquetas.db"
call :checar "credenciais-bling.json"
call :checar "logs/"
call :checar "backups/"
call :checar "cert/"
if "%SUJO%"=="1" (
  call :say ""
  call :say "  PERIGO: arquivo de producao entrou no repositorio."
  call :say "  NAO continue. Me avise no chat."
  goto :erro
)
call :say "  OK: nenhum arquivo de producao foi incluido."

call :say ""
call :say "[7/7] Gravando a versao base e marcando v157..."
git commit -m "Baseline v157 - sistema de pesagem Ekoplastic" -m "Primeira versao sob controle de versao. Substitui a distribuicao por ZIP." >> "%LOG%" 2>&1
if errorlevel 1 goto :erro
git tag -a v157 -m "v157 - correcao da tecla LIMPAR no teclado touch" >> "%LOG%" 2>&1
if errorlevel 1 goto :erro
for /f "delims=" %%c in ('git log --oneline -1') do call :say "  Commit: %%c"
call :say "  OK."

call :say ""
call :say "============================================================"
call :say "  CONCLUIDO COM SUCESSO"
call :say "============================================================"
call :say ""
call :say "  Historico criado e versao v157 marcada."
call :say "  NADA foi enviado para a internet ainda."
call :say ""
call :say "  PROXIMO PASSO: criar o repositorio no GitHub."
call :say "  Volte ao chat e avise que chegou ate aqui."
call :say ""
goto :fim

:checar
git diff --cached --name-only | findstr /I /C:"%~1" >nul 2>&1
if not errorlevel 1 (
  call :say "  PROIBIDO ENCONTRADO: %~1"
  set "SUJO=1"
)
exit /b 0

:say
echo(%~1
echo(%~1>> "%LOG%"
exit /b 0

:erro
color 0C
call :say ""
call :say "  PAROU POR ERRO. Nada foi perdido."
call :say "  O log completo esta em SETUP-GIT-LOG.txt"
call :say "  Abrindo o log - copie o conteudo e mande no chat."
call :say ""
pause
notepad "%LOG%"
exit /b 1

:fim
call :say "  Abrindo o log para conferencia..."
pause
notepad "%LOG%"
exit /b 0