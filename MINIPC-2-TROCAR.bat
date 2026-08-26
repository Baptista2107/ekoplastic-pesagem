@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"
title Ekoplastic - Troca de pastas - PARTE 2 de 2

REM ===================================================================
REM  RODA NO MINI PC, DENTRO DA PASTA NOVA - a que veio do clone.
REM  EXIGE O SISTEMA PARADO. E' a unica parte com janela de parada.
REM  Nada e' apagado: a pasta antiga continua inteira e e' a volta.
REM ===================================================================
REM  A pasta de producao e' localizada por curinga de proposito: o nome
REM  real tem acento, e arquivo .bat sem BOM e' lido pela codepage ANSI
REM  do Windows, o que corromperia o caminho. "PROJETO*" evita o acento.
set "PRODUCAO="
for /d %%D in ("%USERPROFILE%\Desktop\PROJETO*") do set "PRODUCAO=%%D"
if not defined PRODUCAO for /d %%D in ("%USERPROFILE%\OneDrive\Desktop\PROJETO*") do set "PRODUCAO=%%D"
REM  Se nenhum dos dois achar, escreva o caminho a mao na linha abaixo,
REM  salvando este arquivo como UTF-8 COM BOM:
REM  set "PRODUCAO=C:\caminho\da\pasta"
REM ===================================================================

set "LOG=%~dp0OUTPUT_TROCA_PARTE2.TXT"
set "URLSAUDE=http://localhost:3000/healthcheck"
set "REF=%~dp0OUTPUT_REFERENCIA_TROCA.TXT"

> "%LOG%" echo ============================================================
call :L "  TROCA DE PASTAS - PARTE 2 - TROCAR"
call :L "============================================================"
call :L "Data......: %date% %time%"
call :L "Pasta nova: %~dp0"
call :L "Producao..: %PRODUCAO%"
call :L ""

REM ---------- FASE 0 ----------
call :L "------------------------------------------------------------"
call :L "FASE 0 - VERIFICACOES"
call :L "------------------------------------------------------------"
if not exist "%~dp0.git" ( call :L "FALHA: rode este .bat DENTRO da pasta clonada." & goto :parar )
if not exist "%PRODUCAO%\server.js" (
  call :L "FALHA: nao achei a pasta de producao em:"
  call :L "   %PRODUCAO%"
  call :L "Abra este .bat no bloco de notas e corrija a linha PRODUCAO."
  goto :parar
)
if not exist "%REF%" (
  call :L "FALHA: falta o OUTPUT_REFERENCIA_TROCA.TXT. Rode a PARTE 1 antes."
  goto :parar
)
call :L "OK: pasta clonada, producao localizada, referencia presente."

curl -s -o nul --max-time 3 "%URLSAUDE%" >nul 2>&1
if not errorlevel 1 (
  call :L "FALHA: o sistema ainda esta no ar."
  echo.
  echo ============================================================
  echo  ENCERRE O SISTEMA PRIMEIRO, pela propria tela.
  echo  Confirme que a janela preta do INICIAR fechou.
  echo.
  echo  Copiar o banco com o servidor de pe' produz copia
  echo  inconsistente - e' o unico jeito de perder dado aqui.
  echo ============================================================
  goto :parar
)
call :L "OK: sistema parado."
call :L ""

REM ---------- FASE 1 - o banco ----------
call :L "------------------------------------------------------------"
call :L "FASE 1 - LEVANDO O BANCO E O QUE FALTAVA"
call :L "------------------------------------------------------------"
call :L "Os TRES arquivos do banco vao juntos. O -wal guarda o que"
call :L "ainda nao foi gravado no .db; sozinho, o .db esta velho."
set "FALTOU="
call :copiar "etiquetas.db"
call :copiar "etiquetas.db-wal"
call :copiar "etiquetas.db-shm"
call :copiar "bling_tokens.json"
call :copiar "credenciais-bling.json"
if defined FALTOU (
  call :L "FALHA na copia. NAO troque. A pasta antiga esta intacta."
  goto :parar
)
if exist "%PRODUCAO%\logs" (
  robocopy "%PRODUCAO%\logs" "%~dp0logs" /E /NFL /NDL /NJH /NJS /NP >>"%LOG%" 2>&1
  call :L "  copiada: pasta logs"
)
call :L "OK: runtime no lugar."
call :L ""

REM ---------- FASE 2 - subir a pasta nova ----------
call :L "------------------------------------------------------------"
call :L "FASE 2 - SUBINDO O SISTEMA DA PASTA NOVA"
call :L "------------------------------------------------------------"
start "" "%~dp0INICIAR.bat"
call :L "INICIAR.bat disparado. Aguardando resposta..."
set /a _t=0
:esperar
timeout /t 2 /nobreak >nul
set /a _t+=1
curl -s -o nul --max-time 3 "%URLSAUDE%" >nul 2>&1
if not errorlevel 1 goto :subiu
if %_t% lss 20 goto :esperar
call :L "FALHA: a pasta nova nao respondeu em 40 segundos."
call :L "VOLTA: feche a janela do INICIAR desta pasta e suba o sistema"
call :L "pela pasta antiga, normalmente. Nada la' foi alterado."
goto :parar

:subiu
call :L "OK: a pasta nova respondeu."
call :L ""

REM ---------- FASE 3 - conferir que o banco veio inteiro ----------
call :L "------------------------------------------------------------"
call :L "FASE 3 - O BANCO VEIO INTEIRO?"
call :L "------------------------------------------------------------"
node "%~dp0comparar-troca.js" "%REF%" "%URLSAUDE%" > "%TEMP%\eko_cmp.txt" 2>&1
set "RCC=%ERRORLEVEL%"
type "%TEMP%\eko_cmp.txt"
type "%TEMP%\eko_cmp.txt" >>"%LOG%"
del "%TEMP%\eko_cmp.txt" >nul 2>&1

if not "%RCC%"=="0" (
  call :L ""
  call :L "*** NAO CONCLUA A TROCA. ***"
  call :L "Feche o sistema desta pasta nova e volte pela pasta antiga."
  goto :parar
)

call :L ""
call :L "Diagnostico da balanca no healthcheck - campo novo:"
curl -s "%URLSAUDE%" >>"%LOG%" 2>&1
echo.
echo ------------------------------------------------------------
curl -s "%URLSAUDE%"
echo.
echo ------------------------------------------------------------
call :L ""
call :L "  modulo_serial: true  = o serialport carregou"
call :L "  modulo_serial: false = modulo ausente, balanca desativada"
call :L "  portaAberta:   true  = a COM1 abriu"
call :L ""
call :L "------------------------------------------------------------"
call :L "RESULTADO: PASTA NOVA NO AR E CONFERIDA."
call :L "------------------------------------------------------------"
call :L ""
call :L "FALTA UM PASSO MANUAL: apontar o atalho de inicializacao"
call :L "e o inicio automatico do Windows para o INICIAR.bat DESTA"
call :L "pasta:  %~dp0INICIAR.bat"
call :L ""
call :L "NAO APAGUE a pasta antiga. Guarde algumas semanas. Voltar"
call :L "atras e' fechar este sistema e subir por la'."
call :L ""
call :L "Antes de liberar o turno: pese uma vez e imprima uma etiqueta."
call :L ""
call :L "=== FIM DO DIAGNOSTICO ==="
echo.
start "" notepad "%LOG%"
echo.
pause
exit /b 0

:copiar
if not exist "%PRODUCAO%\%~1" ( call :L "  AVISO: %~1 nao existe na producao - pulando." & exit /b 0 )
copy /y "%PRODUCAO%\%~1" "%~dp0%~1" >nul 2>&1
if errorlevel 1 ( call :L "  ERRO ao copiar %~1" & set "FALTOU=1" & exit /b 1 )
call :L "  copiado: %~1"
exit /b 0

:parar
call :L ""
call :L "*** INTERROMPIDO ***"
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
