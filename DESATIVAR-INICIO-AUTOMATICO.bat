@echo off
chcp 65001 >nul
title Desativar Inicio Automatico - Ekoplastic

set "LINK=%AppData%\Microsoft\Windows\Start Menu\Programs\Startup\Ekoplastic - Sistema de Etiquetas.lnk"

echo ============================================================
echo    DESATIVAR INICIO AUTOMATICO - EKOPLASTIC
echo ============================================================
echo.

if exist "%LINK%" (
  del "%LINK%" >nul 2>&1
  if exist "%LINK%" (
    echo  [ERRO] Nao consegui remover. Rode como administrador.
  ) else (
    echo  [OK] Inicio automatico DESATIVADO.
    echo  O sistema nao vai mais abrir sozinho ao ligar o Mini PC.
    echo  (Voce ainda pode abrir na mao pelo INICIAR.bat.)
  )
) else (
  echo  O inicio automatico ja estava desativado (nada a fazer).
)

echo.
pause
