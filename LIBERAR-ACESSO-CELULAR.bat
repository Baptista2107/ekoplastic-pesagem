@echo off
REM ===== Auto-elevar para administrador (preciso p/ mexer no firewall) =====
net session >nul 2>&1
if %errorLevel% neq 0 (
  powershell -Command "Start-Process '%~f0' -Verb RunAs"
  exit /b
)
chcp 65001 >nul
title Liberar acesso do celular - Ekoplastic

echo ============================================================
echo   LIBERAR ACESSO DO CELULAR  (HTTPS - porta 3443)
echo ============================================================
echo.
echo Liberando a porta 3443 no firewall do Windows...
netsh advfirewall firewall delete rule name="Ekoplastic HTTPS 3443" >nul 2>&1
netsh advfirewall firewall add rule name="Ekoplastic HTTPS 3443" dir=in action=allow protocol=TCP localport=3443 >nul
netsh advfirewall firewall add rule name="Ekoplastic HTTP 3000"  dir=in action=allow protocol=TCP localport=3000 >nul
echo   [OK] Porta 3443 liberada para a rede.
echo.
echo ============================================================
echo   IP DESTE COMPUTADOR NA REDE (use um destes no celular):
echo ============================================================
ipconfig | findstr /C:"IPv4"
echo.
echo ------------------------------------------------------------
echo   No celular, no MESMO Wi-Fi, abra o Safari e digite:
echo.
echo        https://SEU-IP-AQUI:3443
echo.
echo   Trocando SEU-IP-AQUI pelo numero IPv4 mostrado acima.
echo   Exemplo:  https://192.168.0.42:3443
echo.
echo   IMPORTANTE: precisa ser HTTPS (com S) e terminar em :3443
echo ------------------------------------------------------------
echo.
pause
