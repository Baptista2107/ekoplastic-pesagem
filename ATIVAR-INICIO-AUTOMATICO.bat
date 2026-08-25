@echo off

chcp 65001 >nul

cd /d "%~dp0"

title Ativar Inicio Automatico - Ekoplastic



echo ============================================================

echo    ATIVAR INICIO AUTOMATICO - SISTEMA EKOPLASTIC

echo ============================================================

echo.

echo  Depois disto, o sistema (servidor + tela de bipagem) vai

echo  abrir SOZINHO toda vez que o Mini PC ligar ou reiniciar.

echo.

echo  Pasta do sistema:

echo    %~dp0

echo.

echo  Aperte uma tecla para ATIVAR  (ou feche a janela para cancelar)...

pause >nul



REM Cria um atalho do INICIAR.bat dentro da pasta "Inicializar" do Windows.

REM Usar um atalho (.lnk) lida certo com acentos no caminho (ex AUTOMACAO).

set "ALVO=%~dp0INICIAR.bat"

set "PASTA=%~dp0"

set "LINK=%AppData%\Microsoft\Windows\Start Menu\Programs\Startup\Ekoplastic - Sistema de Etiquetas.lnk"



powershell -NoProfile -ExecutionPolicy Bypass -Command "$w=New-Object -ComObject WScript.Shell; $s=$w.CreateShortcut($env:LINK); $s.TargetPath=$env:ALVO; $s.WorkingDirectory=$env:PASTA; $s.WindowStyle=7; $s.Description='Inicia o sistema Ekoplastic automaticamente'; $s.Save()"



if exist "%LINK%" (

  echo.

  echo  [OK] Inicio automatico ATIVADO com sucesso.

) else (

  echo.

  echo  [ERRO] Nao consegui criar o atalho de inicializacao.

  echo  Tente rodar este arquivo de novo. Se persistir, clique

  echo  com o botao direito e escolha "Executar como administrador".

  echo.

  pause

  exit /b 1

)



echo.

echo  ==========================================================

echo   FALTA 1 PASSO (importante): LOGIN AUTOMATICO DO WINDOWS

echo  ==========================================================

echo   Para o sistema abrir sem ninguem digitar senha ao ligar,

echo   o Windows precisa ENTRAR SOZINHO na conta.

echo.

echo   Como configurar - so uma vez:

echo     1. Aperte as teclas   Windows + R

echo     2. Digite:   netplwiz     e clique OK

echo     3. DESMARQUE a caixa:

echo        "Os usuarios devem digitar um nome e senha para

echo         usar este computador"

echo     4. Clique OK e informe a senha da conta quando pedir

echo  ==========================================================

echo.

echo   PARA TESTAR: reinicie o Mini PC agora. Em alguns segundos

echo   o sistema deve abrir sozinho, pronto para bipar.

echo.

pause

