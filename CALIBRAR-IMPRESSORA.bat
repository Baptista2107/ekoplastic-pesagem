@echo off
chcp 65001 >nul
title Calibrar impressora - etiqueta 100 x 150
cd /d "%~dp0"

echo ============================================================
echo   CALIBRAR IMPRESSORA PARA ETIQUETA 100 x 150 mm
echo ============================================================
echo.
echo   Use este programa UMA VEZ, depois de colocar o rolo novo
echo   de etiquetas 100 x 150 na impressora.
echo.
echo   O que ele faz: manda a impressora "medir" a etiqueta nova,
echo   para ela saber onde uma termina e a outra comeca. Sem isso
echo   a impressao pode sair deslocada ou pular etiquetas.
echo.
echo   A impressora vai puxar algumas etiquetas em branco. E normal.
echo.
pause

REM --- Descobre a impressora configurada no sistema ---
set IMPRESSORA=
for /f "usebackq tokens=2 delims=:," %%A in (`curl -s http://localhost:3000/healthcheck ^| findstr /C:"impressora"`) do (
  set IMPRESSORA=%%~A
)
set IMPRESSORA=%IMPRESSORA:"=%
set IMPRESSORA=%IMPRESSORA: =%

if "%IMPRESSORA%"=="" (
  echo.
  echo   Nao consegui descobrir a impressora pelo sistema.
  echo   Digite o nome exato dela ^(igual aparece em Dispositivos e Impressoras^):
  set /p IMPRESSORA=Nome: 
)

echo.
echo   Impressora: %IMPRESSORA%
echo.

REM --- Arquivo EPL de calibracao ---
REM   q800   = largura 100mm (800 dots a 203dpi)
REM   Q1200,24 = comprimento 150mm + espaco entre etiquetas
REM   xa     = AutoSense: a impressora mede a etiqueta sozinha
set TMPEPL=%TEMP%\eko-calibrar.epl
> "%TMPEPL%" echo N
>>"%TMPEPL%" echo q800
>>"%TMPEPL%" echo Q1200,24
>>"%TMPEPL%" echo xa

echo   Enviando calibracao...
powershell -ExecutionPolicy Bypass -File "enviar_raw.ps1" -EplFile "%TMPEPL%" -PrinterName "%IMPRESSORA%"

if errorlevel 1 (
  echo.
  echo   [X] Falhou. Confira se o nome da impressora esta certo
  echo       e se ela esta ligada.
  echo.
  pause
  exit /b
)

echo.
echo   [OK] Calibracao enviada.
echo.
echo   Agora imprima UMA etiqueta de teste pelo sistema e confira:
echo     - o conteudo cabe todo na etiqueta?
echo     - comeca no lugar certo (nao cortado no topo)?
echo     - para na etiqueta certa (nao avanca demais)?
echo.
echo   Se ainda sair torto, segure o botao FEED da impressora
echo   com ela ligada ate ela puxar 2 ou 3 etiquetas sozinha.
echo.
pause
