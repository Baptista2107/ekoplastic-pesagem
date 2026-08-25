@echo off
chcp 65001 >nul
title Gerar Dashboard - Ekoplastic
cd /d "%~dp0"

echo ============================================================
echo   GERAR DASHBOARD (arquivo unico, funciona sem o sistema)
echo ============================================================
echo.

REM --- O servidor precisa estar rodando (e' ele que le o banco) ---
curl -s -o nul http://localhost:3000/healthcheck >nul 2>&1
if errorlevel 1 (
  echo   [!] O servidor nao esta rodando.
  echo.
  echo   Abra o INICIAR.bat primeiro, espere a tela do sistema abrir,
  echo   e entao rode este arquivo de novo.
  echo.
  pause
  exit /b
)

if not exist "dashboard" mkdir "dashboard"

REM --- Nome do arquivo com a data de hoje (AAAA-MM-DD) ---
for /f "tokens=1-3 delims=/" %%a in ("%date%") do (
  set DIA=%%a
  set MES=%%b
  set ANO=%%c
)
set ARQ=dashboard\dashboard-%ANO%-%MES%-%DIA%.html

echo   Gerando... (pode levar alguns segundos)
curl -s -o "%ARQ%" "http://localhost:3000/dashboard/exportar-html?dias=365"

if not exist "%ARQ%" (
  echo   [X] Nao consegui gerar o arquivo.
  pause
  exit /b
)

for %%A in ("%ARQ%") do set TAM=%%~zA
if %TAM% LSS 5000 (
  echo   [X] O arquivo saiu vazio ou incompleto. Confira se o servidor esta ok.
  pause
  exit /b
)

echo.
echo   [OK] Arquivo gerado:
echo        %CD%\%ARQ%
echo.
echo   Este arquivo funciona SOZINHO: pode copiar para o Google Drive,
echo   mandar por e-mail ou abrir em qualquer computador.
echo.
echo   Abrindo para conferencia...
start "" "%ARQ%"
echo.
echo   Dica: a pasta "dashboard" guarda um arquivo por dia.
echo.
pause
