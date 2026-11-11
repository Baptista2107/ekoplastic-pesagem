# ============================================================
#  VIGIA DA TELA - Ekoplastic Pesagem (11/11/2026)
# ------------------------------------------------------------
#  O PROBLEMA QUE ISTO RESOLVE
#  Em 11/11/2026 a tela do Mini PC sumiu duas vezes. As 08h14 o
#  "Fechar agora" desligou o servidor. Depois, religado pela VPS,
#  o INICIAR.bat ficou na sessao 0 do Windows (a dos servicos), e
#  as 10h39 a atualizacao remota abriu o Chrome la: aberto, mas
#  invisivel. O monitor ficou sem tela ate alguem abrir na mao.
#
#  O QUE ELE FAZ
#  Roda oculto na sessao de quem esta no monitor (nunca na sessao
#  0) e e' o UNICO que abre a tela. A cada 5 s:
#   1. ve se a tela do quiosque esta aberta (perfil navegador-eko);
#   2. pergunta ao servidor GET /sistema/tela?s=<sessao>&a=<0|1>;
#      a resposta e' uma palavra (ver lib/tela.js). So' abre a
#      tela quando o servidor responde ABRIR: o servidor sabe da
#      pausa do "Fechar agora" e para de mandar abrir se a tela
#      nunca aparece aberta (protege contra encher de janelas);
#   3. se o servidor nao responde ha 30 s e ninguem cuida dele
#      (nenhum node server.js, nenhum INICIAR.bat, nenhuma
#      atualizacao ou manutencao em andamento), sobe o INICIAR.bat
#      servidor. A porta 3000 impede dois servidores.
#
#  Um so' vigia na maquina: mutex Global\EkoplasticTelaVigia. Um
#  segundo vigia sai na hora. O INICIAR.bat da atualizacao remota
#  usa o mesmo mutex para saber se ha quem reabra a tela.
#
#  Chamado pelo INICIAR.bat (oculto). Diario em logs\tela-vigia.log.
#  Arquivo so' em ASCII: o PowerShell 5.1 le .ps1 sem BOM como ANSI.
# ============================================================

$ErrorActionPreference = 'SilentlyContinue'

$Pasta   = $PSScriptRoot
$URL     = 'http://localhost:3000'
$Iniciar = Join-Path $Pasta 'INICIAR.bat'
$Perfis  = @((Join-Path $Pasta 'navegador-eko'), (Join-Path $Pasta 'navegador-eko-edge'))
$LogDir  = Join-Path $Pasta 'logs'
$Log     = Join-Path $LogDir 'tela-vigia.log'

$Sessao = [System.Diagnostics.Process]::GetCurrentProcess().SessionId

function Diga([string]$t) {
  try {
    if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }
    if ((Test-Path $Log) -and ((Get-Item $Log).Length -gt 512KB)) { Move-Item -Force $Log ($Log + '.1') }
    Add-Content -Path $Log -Value ((Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + "  [s$Sessao pid $PID] " + $t)
  } catch {}
}

# Sessao 0: nenhuma janela aparece no monitor. Nao abre nada.
if ($Sessao -eq 0) { Diga 'sessao 0 (servicos): aqui a tela nao aparece no monitor - vigia nao roda.'; exit 0 }

$criado = $false
$Mutex = New-Object System.Threading.Mutex($true, 'Global\EkoplasticTelaVigia', [ref]$criado)
if (-not $criado) { exit 0 }   # ja ha um vigia

# --- a tela do quiosque esta aberta nesta sessao? ---
# O Chrome segura <perfil>\lockfile aberto (so' leitura compartilhada)
# enquanto roda e o Windows apaga o arquivo quando ele fecha. Conferir
# isso custa quase nada. Se o arquivo diz "fechada", confere pelos
# processos antes de abrir (mais caro, so' nessa hora).
function TelaAberta {
  foreach ($p in $Perfis) {
    $lock = Join-Path $p 'lockfile'
    if (Test-Path $lock) {
      try {
        $f = [System.IO.File]::Open($lock, 'Open', 'ReadWrite', 'None')
        $f.Close()
      } catch {
        $h = $_.Exception.InnerException
        if (-not $h) { $h = $_.Exception }
        if (($h.HResult -band 0xFFFF) -eq 32) { return $true }   # em uso: navegador aberto
      }
    }
  }
  $q = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe' or Name='msedge.exe'" |
         Where-Object { $_.SessionId -eq $Sessao -and $_.CommandLine -like '*navegador-eko*' })
  return ($q.Count -gt 0)
}

# --- tela antiga: Chrome --app sem o perfil do quiosque ---
# Ate 11/11/2026 a tela abria no perfil padrao do Chrome, sem como saber
# se estava aberta. Fecha essas (nesta sessao e as invisiveis da sessao 0)
# uma vez, na partida do vigia, para a tela nova nao abrir em dobro.
function FecharTelasAntigas {
  $antigas = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe' or Name='msedge.exe'" |
    Where-Object { ($_.SessionId -eq $Sessao -or $_.SessionId -eq 0) -and
                   $_.CommandLine -like '*--app=http://localhost:3000*' -and
                   $_.CommandLine -notlike '*navegador-eko*' })
  foreach ($a in $antigas) {
    Diga ("fechando tela antiga: " + $a.Name + " pid " + $a.ProcessId + " sessao " + $a.SessionId)
    Stop-Process -Id $a.ProcessId -Force
  }
}

function Perguntar([string]$metodo, [string]$caminho) {
  $r = @{ vivo = $false; texto = '' }
  try {
    $req = [System.Net.HttpWebRequest]::Create($URL + $caminho)
    $req.Method = $metodo
    $req.Timeout = 3000
    $req.ReadWriteTimeout = 3000
    $req.Proxy = $null
    if ($metodo -eq 'POST') { $req.ContentLength = 0 }
    $resp = $req.GetResponse()
    $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
    $r.texto = $sr.ReadToEnd().Trim()
    $resp.Close()
    $r.vivo = $true
  } catch {
    # Respondeu com erro HTTP (403, 404...): o servidor esta vivo. O
    # PowerShell embrulha a excecao do .NET; procura a WebException dentro.
    $ex = $_.Exception
    while ($ex -and -not ($ex -is [System.Net.WebException])) { $ex = $ex.InnerException }
    if ($ex -and $ex.Response) { $r.vivo = $true; try { $ex.Response.Close() } catch {} }
  }
  return $r
}

$JaAbriuPadrao = $false
function AbrirTela {
  $cands = @(
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
    (Join-Path $env:LocalAppData 'Google\Chrome\Application\chrome.exe'))
  foreach ($c in $cands) {
    if ($c -and (Test-Path $c)) {
      Diga "abrindo a tela (Chrome)"
      Start-Process -FilePath $c -ArgumentList ("--app=$URL --user-data-dir=`"" + $Perfis[0] + "`" --start-maximized --no-first-run --no-default-browser-check --overscroll-history-navigation=0 --disable-gpu-compositing")
      return
    }
  }
  $edges = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'))
  foreach ($e in $edges) {
    if ($e -and (Test-Path $e)) {
      Diga "abrindo a tela (Edge)"
      Start-Process -FilePath $e -ArgumentList ("--app=$URL --user-data-dir=`"" + $Perfis[1] + "`" --start-maximized --no-first-run --disable-gpu-compositing")
      return
    }
  }
  # Navegador padrao: nao da para saber se esta aberto. Uma vez so'.
  if (-not $JaAbriuPadrao) {
    $script:JaAbriuPadrao = $true
    Diga "sem Chrome e sem Edge: abrindo no navegador padrao (uma vez so')"
    Start-Process $URL
  }
}

# --- o servidor nao responde: alguem ja cuida dele? ---
$UltimoSubir = [datetime]::MinValue
function PrecisaSubirServidor {
  foreach ($m in @('eko-atualizando.flag', 'eko-manutencao.flag')) {
    $f = Join-Path $Pasta $m
    if ((Test-Path $f) -and (((Get-Date) - (Get-Item $f).LastWriteTime).TotalMinutes -lt 15)) {
      Diga "servidor fora, mas ha $m com menos de 15 min - espero"
      return $false
    }
  }
  $procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe' or Name='cmd.exe'")
  $node = @($procs | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*server.js*' })
  $sup  = @($procs | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -like '*INICIAR.bat*' -and
                                    $_.CommandLine -notmatch 'INICIAR\.bat"?\s+"?(vigia|autostart|abrir)' })
  if ($node.Count -gt 0 -or $sup.Count -gt 0) {
    Diga ("servidor fora ha 30 s, mas ja ha quem cuide (node: " + $node.Count + ", INICIAR: " + $sup.Count + ") - espero")
    return $false
  }
  if (((Get-Date) - $UltimoSubir).TotalMinutes -lt 2) { return $false }
  return $true
}

function SubirServidor {
  $script:UltimoSubir = Get-Date
  Diga "servidor fora ha 30 s e ninguem cuidando: subindo INICIAR.bat servidor"
  Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\cmd.exe') `
    -ArgumentList ('/c ""' + $Iniciar + '" servidor"') -WorkingDirectory $Pasta -WindowStyle Minimized
}

Diga "vigia iniciado"
if (-not (TelaAberta)) { FecharTelasAntigas }

$falhas = 0
while ($true) {
  $aberta = TelaAberta
  $a = 0
  if ($aberta) { $a = 1 }
  $r = Perguntar 'GET' ("/sistema/tela?s=$Sessao&a=$a")
  $espera = 5
  if ($r.vivo) {
    $falhas = 0
    if ($r.texto -eq 'ABRIR') { AbrirTela }
    elseif ($r.texto -eq 'PAUSADA' -or $r.texto -eq 'DESISTIU') { $espera = 15 }
  } else {
    $falhas++
    if ($falhas -ge 6) {
      $falhas = 0
      if (PrecisaSubirServidor) { SubirServidor }
    }
  }
  Start-Sleep -Seconds $espera
}
[GC]::KeepAlive($Mutex)
