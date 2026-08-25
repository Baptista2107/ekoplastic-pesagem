@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"
title Ekoplastic Pesagem - FASE 3 - Ingerir node_modules do Mini PC

set "LOG=%~dp0OUTPUT_INGERIR_NODE_MODULES.TXT"
set "TMPX=%~dp0_ingest.tmp"

> "%LOG%" echo ============================================================
>>"%LOG%" echo   EKOPLASTIC PESAGEM - INGERIR node_modules DO MINI PC
>>"%LOG%" echo   FASE 3 - roda no PC de Pesagem
>>"%LOG%" echo   Secao 4.4 do HANDOFF_MIGRACAO_PESAGEM.md
>>"%LOG%" echo ============================================================
>>"%LOG%" echo Data...: %date% %time%
>>"%LOG%" echo Pasta..: %~dp0
>>"%LOG%" echo.

echo ============================================================
echo   INGERIR node_modules VINDO DO MINI PC
echo ============================================================
echo.

REM ---- pre-requisitos ----------------------------------------------
if not exist "server.js" (
  echo [FALHA] server.js nao encontrado. Coloque este .bat na pasta v157.
  >>"%LOG%" echo FALHA: pasta errada.
  >>"%LOG%" echo === FIM DO DIAGNOSTICO ===
  pause & exit /b 1
)
git --version >nul 2>&1
if errorlevel 1 (
  echo [FALHA] o Git nao respondeu. Sem ele a conferencia final mente.
  >>"%LOG%" echo FALHA: git ausente.
  >>"%LOG%" echo === FIM DO DIAGNOSTICO ===
  pause & exit /b 1
)
git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
  echo [FALHA] esta pasta nao e' um repositorio Git.
  >>"%LOG%" echo FALHA: nao e repositorio git.
  >>"%LOG%" echo === FIM DO DIAGNOSTICO ===
  pause & exit /b 1
)
echo   OK: pasta certa e repositorio Git presente.
>>"%LOG%" echo OK: server.js e repositorio Git encontrados.

REM ---- caminho do pacote -------------------------------------------
REM  O dequote fica FORA de qualquer bloco entre parenteses de proposito:
REM  a sintaxe de remocao de aspas quebra o parser do cmd dentro de bloco.
set "ZIP=%~1"
if defined ZIP goto :temzip

echo.
echo   Arraste o pacote node_modules-minipc-....zip para cima desta
echo   janela e tecle ENTER.
echo   Mais simples: arraste o pacote para cima do ICONE deste .bat -
echo   assim nao precisa digitar nada.
echo.
set "ZIPIN="
set /p "ZIPIN=Caminho do pacote: "
if defined ZIPIN set ZIPIN=%ZIPIN:"=%
set "ZIP=%ZIPIN%"

:temzip
REM  Arrastar para a janela costuma colar um espaco no fim do caminho.
if not defined ZIP goto :semzip
if not exist "%ZIP%" if exist "%ZIP:~0,-1%" set "ZIP=%ZIP:~0,-1%"
if exist "%ZIP%" goto :achou

:semzip
echo.
echo [FALHA] arquivo nao encontrado: %ZIP%
>>"%LOG%" echo FALHA: pacote nao encontrado - %ZIP%
>>"%LOG%" echo === FIM DO DIAGNOSTICO ===
echo.
pause & exit /b 1

:achou
echo.
echo   Pacote: %ZIP%
>>"%LOG%" echo Pacote: %ZIP%
>>"%LOG%" echo.
>>"%LOG%" echo SHA256 recebido - compare com o que o Mini PC gerou:
certutil -hashfile "%ZIP%" SHA256 >>"%LOG%" 2>&1
>>"%LOG%" echo.

REM ---- extrair para pasta temporaria --------------------------------
REM  Os caminhos vao por variavel de ambiente e nao pela linha de comando:
REM  a pasta do projeto tem acento e a combinacao chcp 65001 + argumento
REM  acentuado e' fonte classica de caminho corrompido.
set "EKO_ZIP=%ZIP%"
set "EKO_TMP=%TMPX%"
if exist "%TMPX%" rd /s /q "%TMPX%"
mkdir "%TMPX%" 2>nul
echo   Extraindo...

set "EXTRAIU="
where tar >nul 2>&1
if not errorlevel 1 (
  >>"%LOG%" echo Extraindo com tar nativo do Windows...
  tar -x -f "%ZIP%" -C "%TMPX%" >>"%LOG%" 2>&1
  if not errorlevel 1 if exist "%TMPX%\node_modules" set "EXTRAIU=tar"
)
if not defined EXTRAIU (
  >>"%LOG%" echo tar nao serviu - caindo para Expand-Archive.
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; try { Expand-Archive -LiteralPath $env:EKO_ZIP -DestinationPath $env:EKO_TMP -Force } catch { Write-Output $_.Exception.Message; exit 1 }" >>"%LOG%" 2>&1
  if exist "%TMPX%\node_modules" set "EXTRAIU=powershell"
)
if not defined EXTRAIU (
  echo [FALHA] nao consegui extrair o pacote.
  >>"%LOG%" echo FALHA: extracao nao produziu node_modules.
  >>"%LOG%" echo === FIM DO DIAGNOSTICO ===
  rd /s /q "%TMPX%" >nul 2>&1
  start "" notepad "%LOG%"
  pause & exit /b 1
)
>>"%LOG%" echo Metodo de extracao: %EXTRAIU%
>>"%LOG%" echo.

REM ---- validar conteudo ---------------------------------------------
>>"%LOG%" echo ------------------------------------------------------------
>>"%LOG%" echo VALIDACAO DO PACOTE - antes de trocar qualquer coisa
>>"%LOG%" echo ------------------------------------------------------------
set "MAU="

if exist "%TMPX%\node_modules\serialport\package.json" (
  echo   OK: serialport presente.
  >>"%LOG%" echo OK: node_modules\serialport presente.
) else (
  echo   FALHA: serialport ausente no pacote.
  >>"%LOG%" echo FALHA: node_modules\serialport ausente.
  set "MAU=1"
)

if exist "%TMPX%\node_modules\@serialport\parser-readline\package.json" (
  echo   OK: parser-readline presente.
  >>"%LOG%" echo OK: @serialport\parser-readline presente.
) else (
  echo   FALHA: @serialport parser-readline ausente.
  >>"%LOG%" echo FALHA: @serialport\parser-readline ausente.
  set "MAU=1"
)

set "NNODE=0"
for /f %%N in ('dir /s /b "%TMPX%\node_modules\*.node" 2^>nul ^| find /c /v ""') do set "NNODE=%%N"
>>"%LOG%" echo Binarios .node no pacote: %NNODE%
>>"%LOG%" echo Lista dos binarios:
dir /s /b "%TMPX%\node_modules\*.node" >>"%LOG%" 2>&1
if "%NNODE%"=="0" (
  echo   FALHA: nenhum binario .node no pacote.
  >>"%LOG%" echo FALHA: nenhum binario nativo.
  set "MAU=1"
) else (
  echo   OK: %NNODE% binario nativo encontrado.
)

set "TEMWIN="
for /f "delims=" %%W in ('dir /s /b "%TMPX%\node_modules\*.node" 2^>nul ^| findstr /I "win32-x64 win32_x64 Release"') do set "TEMWIN=%%W"
if defined TEMWIN (
  echo   OK: binario para Windows 64 bits presente.
  >>"%LOG%" echo OK: binario Windows x64 - %TEMWIN%
) else (
  echo   ATENCAO: nao identifiquei binario de Windows x64 pelo nome.
  >>"%LOG%" echo ATENCAO: nenhum binario win32-x64 identificado pelo nome.
  >>"%LOG%" echo Confira a lista acima antes de seguir.
)

if defined MAU (
  echo.
  echo [BLOQUEADO] o pacote nao passou na validacao.
  echo             NADA foi trocado - seu node_modules atual esta intacto.
  >>"%LOG%" echo BLOQUEADO: pacote invalido - node_modules atual preservado.
  >>"%LOG%" echo === FIM DO DIAGNOSTICO ===
  rd /s /q "%TMPX%" >nul 2>&1
  start "" notepad "%LOG%"
  pause & exit /b 1
)

REM ---- package.json: comparar, NAO sobrescrever ---------------------
>>"%LOG%" echo.
>>"%LOG%" echo ------------------------------------------------------------
>>"%LOG%" echo package.json - Mini PC x PC de Pesagem
>>"%LOG%" echo ------------------------------------------------------------
if exist "%TMPX%\package.json" (
  fc /b "%TMPX%\package.json" "%~dp0package.json" >nul 2>&1
  if errorlevel 1 (
    echo   ATENCAO: o package.json do Mini PC e DIFERENTE do daqui.
    >>"%LOG%" echo ATENCAO: package.json do Mini PC difere do local.
    >>"%LOG%" echo O daqui foi corrigido para 157.0.0 e declara o serialport.
    >>"%LOG%" echo O do Mini PC pode ser a versao antiga 1.44.0.
    >>"%LOG%" echo NAO vou sobrescrever o seu. Diferencas:
    fc "%TMPX%\package.json" "%~dp0package.json" >>"%LOG%" 2>&1
  ) else (
    >>"%LOG%" echo OK: package.json identico nas duas maquinas.
  )
) else (
  >>"%LOG%" echo AVISO: o pacote nao trouxe package.json.
)

echo.
echo ============================================================
echo   O pacote passou na validacao.
echo   O node_modules atual sera GUARDADO, nao apagado.
echo   Pressione uma tecla para trocar, ou feche para cancelar.
echo ============================================================
pause >nul

REM ---- backup do node_modules atual ---------------------------------
set "TS="
for /f "delims=" %%T in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss" 2^>nul') do set "TS=%%T"
if not defined TS set "TS=backup"

if exist "%~dp0node_modules" (
  ren "%~dp0node_modules" "node_modules.antigo-%TS%"
  if errorlevel 1 (
    echo [FALHA] nao consegui renomear o node_modules atual.
    echo         Feche qualquer programa usando essa pasta e tente de novo.
    >>"%LOG%" echo FALHA: ren node_modules falhou - nada foi trocado.
    >>"%LOG%" echo === FIM DO DIAGNOSTICO ===
    start "" notepad "%LOG%"
    pause & exit /b 1
  )
  echo   node_modules antigo guardado como node_modules.antigo-%TS%
  >>"%LOG%" echo OK: backup em node_modules.antigo-%TS%
)

move "%TMPX%\node_modules" "%~dp0node_modules" >>"%LOG%" 2>&1
if errorlevel 1 (
  echo [FALHA] nao consegui mover o node_modules novo.
  echo         Seu node_modules antigo esta em node_modules.antigo-%TS%
  >>"%LOG%" echo FALHA: move do node_modules novo.
  >>"%LOG%" echo === FIM DO DIAGNOSTICO ===
  start "" notepad "%LOG%"
  pause & exit /b 1
)
echo   node_modules novo instalado.
>>"%LOG%" echo OK: node_modules novo no lugar.

if exist "%TMPX%\package-lock.json" (
  copy /y "%TMPX%\package-lock.json" "%~dp0package-lock.json" >>"%LOG%" 2>&1
  echo   package-lock.json do Mini PC copiado.
  >>"%LOG%" echo OK: package-lock.json copiado do Mini PC.
) else (
  >>"%LOG%" echo AVISO: o pacote nao trouxe package-lock.json.
)

rd /s /q "%TMPX%" >nul 2>&1

REM ---- previa do que o git vai ver ----------------------------------
>>"%LOG%" echo.
>>"%LOG%" echo ------------------------------------------------------------
>>"%LOG%" echo PREVIA - O QUE O GIT VAI VER
>>"%LOG%" echo ------------------------------------------------------------
set "NOVOS=0"
for /f %%N in ('git status --porcelain -- node_modules ^| find /c /v ""') do set "NOVOS=%%N"
>>"%LOG%" echo Mudancas dentro de node_modules: %NOVOS%
echo   Mudancas que o git enxerga em node_modules: %NOVOS%

REM  So contam as linhas "!!" - ignorados de verdade. As linhas "??" sao
REM  arquivos novos ainda nao rastreados, que e' exatamente o esperado aqui.
set "IGN=0"
for /f %%N in ('git status --ignored --porcelain -- node_modules ^| findstr /B /C:"!!" ^| find /c /v ""') do set "IGN=%%N"
>>"%LOG%" echo.
>>"%LOG%" echo Arquivos IGNORADOS dentro de node_modules - tem que ser zero:
git status --ignored --porcelain -- node_modules | findstr /B /C:"!!" >>"%LOG%" 2>&1
>>"%LOG%" echo.
>>"%LOG%" echo Pacotes novos ainda nao rastreados - isto e NORMAL, o
>>"%LOG%" echo CORRIGIR-COMMIT.bat e quem vai adiciona-los ao commit:
git status --porcelain -- node_modules | findstr /B /C:"??" >>"%LOG%" 2>&1
if "%IGN%"=="0" (
  echo   OK: nada ignorado dentro de node_modules.
  >>"%LOG%" echo OK: nenhum arquivo ignorado dentro de node_modules.
) else (
  echo   ATENCAO: %IGN% arquivo ignorado dentro de node_modules.
  echo            Isso deixaria a baseline incompleta. Veja o relatorio.
  >>"%LOG%" echo ATENCAO: %IGN% arquivo ignorado - a baseline ficaria incompleta.
  >>"%LOG%" echo Confira se o .gitignore tem a linha  !node_modules/**  no fim.
)

>>"%LOG%" echo.
>>"%LOG%" echo ------------------------------------------------------------
>>"%LOG%" echo PROXIMO PASSO
>>"%LOG%" echo ------------------------------------------------------------
>>"%LOG%" echo Rode agora o CORRIGIR-COMMIT.bat. Ele e reexecutavel: incorpora
>>"%LOG%" echo o node_modules novo na baseline e confere, na validacao 5.7, se
>>"%LOG%" echo o serialport entrou mesmo no commit.
>>"%LOG%" echo.
>>"%LOG%" echo Quando tudo estiver publicado, apague o backup:
>>"%LOG%" echo    rmdir /s /q node_modules.antigo-%TS%
>>"%LOG%" echo.
>>"%LOG%" echo === FIM DO DIAGNOSTICO ===

echo.
echo ============================================================
echo   PRONTO.
echo.
echo   Agora rode:  CORRIGIR-COMMIT.bat
echo ============================================================
echo.
start "" notepad "%LOG%"
pause
exit /b 0
