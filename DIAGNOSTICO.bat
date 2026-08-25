@echo off
chcp 65001 >nul
cd /d "%~dp0"
set OUT=diagnostico-impressora.txt

echo.
echo Coletando diagnostico da impressora... aguarde alguns segundos.
echo (o servidor Ekoplastic precisa estar rodando para o item 3)
echo.

> "%OUT%" echo ============================================================
>> "%OUT%" echo  DIAGNOSTICO DE IMPRESSORA - EKOPLASTIC
>> "%OUT%" echo  Data: %date% %time%
>> "%OUT%" echo ============================================================
>> "%OUT%" echo.

>> "%OUT%" echo [1] VERSAO DO NODE
node --version >> "%OUT%" 2>&1
>> "%OUT%" echo.

>> "%OUT%" echo [2] IMPRESSORAS INSTALADAS NO WINDOWS (nome exato / driver / porta / status)
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Printer | Select-Object Name,DriverName,PortName,PrinterStatus,Shared,Published | Format-List | Out-String -Width 300" >> "%OUT%" 2>&1
>> "%OUT%" echo.

>> "%OUT%" echo [3] HEALTHCHECK DO SERVIDOR (impressora_detectada / impressao_simulada / versao)
curl -s http://localhost:3000/healthcheck >> "%OUT%" 2>&1
>> "%OUT%" echo.
>> "%OUT%" echo.

>> "%OUT%" echo [4] CONTEUDO DO enviar_raw.ps1 (como o sistema manda o EPL)
if exist enviar_raw.ps1 (
  type enviar_raw.ps1 >> "%OUT%" 2>&1
) else (
  >> "%OUT%" echo enviar_raw.ps1 NAO ENCONTRADO nesta pasta
)
>> "%OUT%" echo.

>> "%OUT%" echo [5] ULTIMAS 40 LINHAS DO LOG MAIS RECENTE
powershell -NoProfile -ExecutionPolicy Bypass -Command "$f = Get-ChildItem 'logs\*.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1; if ($f) { '--- ' + $f.Name + ' ---'; Get-Content $f.FullName -Tail 40 } else { 'nenhum log encontrado em logs\' }" >> "%OUT%" 2>&1
>> "%OUT%" echo.

>> "%OUT%" echo [6] EPLs SIMULADOS RECENTES (se houver arquivos aqui, o sistema NAO esta imprimindo de verdade)
powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Test-Path 'logs\print-simulado') { $a = Get-ChildItem 'logs\print-simulado\*.epl' | Sort-Object LastWriteTime -Descending | Select-Object -First 5; if ($a) { $a | Format-Table Name,LastWriteTime -AutoSize | Out-String } else { 'pasta existe mas vazia' } } else { 'pasta print-simulado NAO existe (bom sinal: nao simulou)' }" >> "%OUT%" 2>&1
>> "%OUT%" echo.

>> "%OUT%" echo [7] TESTE DE IMPRESSAO DIRETO (manda um EPL de teste pela 1a impressora detectada)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0_teste_impressao.ps1" >> "%OUT%" 2>&1
>> "%OUT%" echo.

>> "%OUT%" echo ============================================================
>> "%OUT%" echo  FIM DO DIAGNOSTICO
>> "%OUT%" echo ============================================================

echo.
echo ============================================================
echo  PRONTO! Arquivo gerado: %OUT%
echo  Envie este arquivo (diagnostico-impressora.txt) para o Claude.
echo ============================================================
echo.
pause
