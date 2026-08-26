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
REM  A pasta de producao chega por tres caminhos, nesta ordem:
REM   1. arrastada para cima do icone deste .bat  -> forma mais segura,
REM      porque o Explorer entrega o caminho pronto e o acento do nome
REM      "PROJETO AUTOMACAO" nao passa por interpretacao de texto
REM   2. deteccao por curinga "PROJETO*", que evita digitar o acento
REM   3. escrita a mao, se as duas acima falharem
set "PRODUCAO=%~1"
if defined PRODUCAO goto :tem_producao
for /d %%D in (%USERPROFILE%\Desktop\PROJETO*) do set "PRODUCAO=%%D"
if not defined PRODUCAO for /d %%D in (%USERPROFILE%\OneDrive\Desktop\PROJETO*) do set "PRODUCAO=%%D"
:tem_producao
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
if not defined PRODUCAO (
  call :L "FALHA: nao localizei a pasta de producao."
  call :L "Arraste a pasta de producao para cima do icone deste .bat."
  goto :parar
)
if not exist "%PRODUCAO%\server.js" (
  call :L "FALHA: nao ha server.js em:"
  call :L "   %PRODUCAO%"
  call :L "Arraste a pasta CERTA para cima do icone deste .bat."
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
echo.
echo ============================================================
echo  CONFIRME OS DOIS CAMINHOS ANTES DE SEGUIR
echo.
echo   DE ONDE vem o banco:
echo   %PRODUCAO%
echo.
echo   PARA ONDE vai:
echo   %~dp0
echo.
echo  Nada foi copiado ainda. A pasta de origem so' e' LIDA.
echo  Pressione uma tecla para copiar, ou feche para cancelar.
echo ============================================================
pause >nul
call :L "Origem confirmada: %PRODUCAO%"
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
call :L "------------------------------------------------------------"
call :L "O SISTEMA SUJOU A PASTA AO SUBIR?"
call :L "------------------------------------------------------------"
call :L "O server.js reescreve o enviar_raw.ps1 no boot se os bytes nao"
call :L "baterem. Se isso acontecer, a pasta fica suja para sempre e o"
call :L "ATUALIZAR.bat passa a recusar toda atualizacao. E' o defeito de"
call :L "fim de linha que foi corrigido no .gitattributes - aqui e' onde"
call :L "se confirma que a correcao pegou, na maquina de verdade."
set "SUJOU=0"
for /f %%N in ('git status --porcelain ^| find /c /v ""') do set "SUJOU=%%N"
git status --porcelain >>"%LOG%" 2>&1
if "%SUJOU%"=="0" (
  call :L "  OK: pasta continua limpa depois do boot."
) else (
  call :L "  ATENCAO: %SUJOU% arquivo mudou sozinho ao subir o sistema."
  call :L "  Veja a lista no relatorio e me avise ANTES de trocar o atalho."
  git status --short
)
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
