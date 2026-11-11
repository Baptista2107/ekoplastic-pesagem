@echo off
chcp 65001 >nul
cd /d "%~dp0"

REM ===================================================================
REM  ABRIR-TELA: pede a tela de novo, SEM mexer no servidor que ja esta
REM  rodando. A sessao em andamento continua salva no servidor.
REM
REM  Desde 11/11/2026 quem abre o navegador e' so' o vigia da tela
REM  (tela-vigia.ps1). Este .bat tira a pausa do "Fechar agora" e garante
REM  o vigia; se a tela ja estiver aberta, nao abre outra. Antes ele abria
REM  o Chrome por conta propria no mesmo perfil do quiosque: rodado pela
REM  VPS (sessao 0), deixava a tela invisivel segurando o perfil.
REM  Para RECARREGAR a tela: fechar a janela (X ou Alt+F4); o vigia
REM  reabre em ate 5 segundos.
REM ===================================================================

curl -s -o nul -m 3 http://localhost:3000/healthcheck >nul 2>&1
if errorlevel 1 (
  echo [AVISO] O servidor nao respondeu em http://localhost:3000.
  echo Se o sistema nao estiver rodando, use o INICIAR.bat normal.
  echo.
  pause
  exit /b
)
call "%~dp0INICIAR.bat" abrir
echo A tela abre em instantes.
timeout /t 2 /nobreak >nul
exit /b
