# ============================================================
#  EKOPLASTIC PESAGEM - DESCOBRIR O ENDERECO DA ESTACAO
# ------------------------------------------------------------
#  Este script SO' LE. Ele nao mexe no sistema de pesagem, nao
#  reinicia nada, nao envia nada para o GitHub e nao toca no
#  Mini PC. A unica escrita possivel e' a linha "MINIPC" do
#  ENVIAR-ATUALIZACAO.bat, e somente se voce confirmar no fim.
#
#  IMPORTANTE - qual porta:
#  o servidor abre a porta 3000 SO' em 127.0.0.1, ou seja, so'
#  dentro da propria maquina. Quem atende a rede e' a porta 3443
#  (HTTPS), a mesma que o celular usa. E' nela que procuramos.
#  O certificado e' auto-assinado, entao a validacao e' ignorada.
#
#  Chamado pelo DESCOBRIR-MINIPC.bat.
# ============================================================

$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference    = 'SilentlyContinue'

$raiz = $PSScriptRoot
if (-not $raiz) { $raiz = Split-Path -Parent $MyInvocation.MyCommand.Path }
$log = Join-Path $raiz 'OUTPUT_DESCOBRIR_MINIPC.TXT'
Set-Content -Path $log -Value '' -Encoding ASCII

function Say([string]$t) {
  Write-Host $t
  Add-Content -Path $log -Value $t -Encoding ASCII
}

# certificado auto-assinado do Mini PC: aceitar sem reclamar
try {
  [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
  [System.Net.ServicePointManager]::SecurityProtocol =
    [System.Net.SecurityProtocolType]::Tls12 -bor [System.Net.SecurityProtocolType]::Tls11
} catch {}

# ---------- teste de porta TCP com prazo curto ----------
function Porta([string]$ip, [int]$porta, [int]$ms) {
  $t = New-Object System.Net.Sockets.TcpClient
  try {
    $ar = $t.BeginConnect($ip, $porta, $null, $null)
    $ok = $ar.AsyncWaitHandle.WaitOne($ms, $false)
    if (-not $ok) { return $false }
    $t.EndConnect($ar)
    return $true
  } catch {
    return $false
  } finally {
    try { $t.Close() } catch {}
  }
}

# ---------- resolve nome -> IPv4 ----------
function ParaIp([string]$alvo) {
  if ($alvo -match '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$') { return $alvo }
  try {
    $r = [System.Net.Dns]::GetHostAddresses($alvo) |
         Where-Object { $_.AddressFamily -eq 'InterNetwork' } |
         Select-Object -First 1
    if ($r) { return $r.IPAddressToString }
  } catch {}
  return $null
}

# ---------- onde esta o curl do Windows (o mesmo que o .bat usa) ----------
$CURL = $null
foreach ($n in @('curl.exe', 'curl')) {
  $c = Get-Command $n -ErrorAction SilentlyContinue
  if ($c -and $c.CommandType -eq 'Application') { $CURL = $c.Source; break }
}

# ---------- pergunta ao /healthcheck pela 3443 ----------
#  Tres caminhos, porque o certificado e' auto-assinado e cada versao
#  do PowerShell aceita ignorar isso de um jeito diferente.
function Baixar([string]$ip) {
  $u   = 'https://' + $ip + ':3443/healthcheck'
  $txt = ''

  if ($CURL) {
    try { $txt = (& $CURL -s -k --max-time 8 $u 2>$null) -join '' } catch { $txt = '' }
  }

  if (-not $txt) {
    try {
      try { Add-Type -AssemblyName System.Net.Http -ErrorAction SilentlyContinue } catch {}
      $h = New-Object System.Net.Http.HttpClientHandler
      $p = [System.Net.Http.HttpClientHandler].GetProperty('DangerousAcceptAnyServerCertificateValidator')
      if ($p) { $h.ServerCertificateCustomValidationCallback = $p.GetValue($null) }
      else    { $h.ServerCertificateCustomValidationCallback = { param($a,$b,$c,$d) $true } }
      $cl = New-Object System.Net.Http.HttpClient($h)
      $cl.Timeout = [TimeSpan]::FromSeconds(8)
      $txt = $cl.GetStringAsync($u).GetAwaiter().GetResult()
      $cl.Dispose()
    } catch { $txt = '' }
  }

  if (-not $txt) {
    try {
      $req = [System.Net.HttpWebRequest]::Create($u)
      $req.Timeout          = 8000
      $req.ReadWriteTimeout = 8000
      $resp = $req.GetResponse()
      $sr   = New-Object System.IO.StreamReader($resp.GetResponseStream())
      $txt  = $sr.ReadToEnd()
      $sr.Close()
      $resp.Close()
    } catch { $txt = '' }
  }

  if (-not $txt) { return $null }
  try { return ($txt | ConvertFrom-Json) } catch { return $null }
}

Say '============================================================'
Say '  EKOPLASTIC - PROCURANDO A ESTACAO DE PESAGEM'
Say '============================================================'
Say ('Data..: ' + (Get-Date).ToString('dd/MM/yyyy HH:mm:ss'))
Say ('Pasta.: ' + $raiz)
Say ''
Say 'Somente leitura. Nada e alterado sem a sua confirmacao.'
Say 'Procuramos na porta 3443 (HTTPS). A porta 3000 do sistema'
Say 'escuta so em 127.0.0.1 e nunca responde de fora da maquina.'
Say ''

# ---------- enderecos deste proprio PC ----------
$meus = @('127.0.0.1')
try {
  foreach ($a in [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName())) {
    if ($a.AddressFamily -eq 'InterNetwork') { $meus += $a.IPAddressToString }
  }
} catch {}
$meus = $meus | Select-Object -Unique
Say ('Este PC (' + $env:COMPUTERNAME + ') responde em: ' + ($meus -join ', '))
Say ''

# ---------- lista de candidatos ----------
$cand = New-Object System.Collections.ArrayList
function AddCand([string]$valor, [string]$origem) {
  if (-not $valor) { return }
  $valor = $valor.Trim()
  if (-not $valor) { return }
  foreach ($c in $cand) { if ($c.Alvo -eq $valor) { return } }
  [void]$cand.Add([pscustomobject]@{ Alvo = $valor; Origem = $origem })
}

# ---------- [1] unidades de rede mapeadas ----------
Say '[1] Unidades de rede mapeadas neste PC'
$achou1 = $false
try {
  foreach ($d in (Get-CimInstance -ClassName Win32_LogicalDisk -Filter 'DriveType=4')) {
    $p = $d.ProviderName
    if ($p -and ($p -match '^\\\\([^\\]+)\\')) {
      Say ('    ' + $d.DeviceID + '  ->  ' + $p)
      AddCand $matches[1] ('unidade ' + $d.DeviceID)
      $achou1 = $true
    }
  }
} catch {}
if (-not $achou1) { Say '    (nenhuma unidade de rede encontrada)' }
Say ''

# ---------- [2] Tailscale ----------
Say '[2] Tailscale'
$ts = $null
$cmd = Get-Command tailscale -ErrorAction SilentlyContinue
if ($cmd) { $ts = $cmd.Source }
if (-not $ts) {
  foreach ($p in @(
      (Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'),
      (Join-Path ${env:ProgramFiles(x86)} 'Tailscale\tailscale.exe'))) {
    if ($p -and (Test-Path $p)) { $ts = $p; break }
  }
}
if ($ts) {
  $saida = & $ts status 2>$null
  $achou2 = $false
  if ($saida) {
    foreach ($l in $saida) {
      if ($l -match '^\s*(100\.\d{1,3}\.\d{1,3}\.\d{1,3})\s+(\S+)') {
        Say ('    ' + $matches[1] + '   ' + $matches[2])
        AddCand $matches[1] ('tailscale ' + $matches[2])
        $achou2 = $true
      }
    }
  }
  if (-not $achou2) { Say '    (instalado, mas sem maquinas na lista)' }
} else {
  Say '    (nao instalado neste PC)'
}
Say ''

# ---------- [3] testa cada candidato ----------
$achados = New-Object System.Collections.ArrayList
$noAr    = New-Object System.Collections.ArrayList

function Registrar([string]$ip, $dados, [string]$origem) {
  foreach ($a in $achados) { if ($a.Ip -eq $ip) { return } }
  [void]$achados.Add([pscustomobject]@{ Ip = $ip; Dados = $dados; Origem = $origem })
}

function Avaliar([string]$ip, [string]$origem) {
  $rot = $ip.PadRight(18)
  if (Porta $ip 3443 1500) {
    $hc = Baixar $ip
    if ($hc) {
      Say ('    ' + $rot + ' RESPONDEU o sistema na 3443   [' + $origem + ']')
      Registrar $ip $hc $origem
    } else {
      Say ('    ' + $rot + ' 3443 aberta, mas nao respondeu o healthcheck  [' + $origem + ']')
    }
    return
  }
  $viva = $false
  foreach ($p in @(445, 135, 3389, 139)) {
    if (Porta $ip $p 700) { $viva = $true; break }
  }
  if ($viva) {
    Say ('    ' + $rot + ' maquina NO AR, mas a porta 3443 esta fechada  [' + $origem + ']')
    [void]$noAr.Add($ip)
  } else {
    Say ('    ' + $rot + ' nao respondeu a nada  [' + $origem + ']')
  }
}

Say '[3] Perguntando a cada candidato se ele e a estacao'
if ($cand.Count -eq 0) { Say '    (nenhum candidato ate aqui)' }
foreach ($c in $cand) {
  $ip = ParaIp $c.Alvo
  if (-not $ip) {
    Say ('    ' + $c.Alvo.PadRight(18) + ' nao resolveu para um IP   [' + $c.Origem + ']')
    continue
  }
  if ($meus -contains $ip) {
    Say ('    ' + $ip.PadRight(18) + ' e este proprio PC - ignorado')
    continue
  }
  Avaliar $ip $c.Origem
}
Say ''

# ---------- [4] varredura da rede local ----------
if ($achados.Count -eq 0) {
  Say '[4] Varrendo a rede local na porta 3443'
  Say '    (somente leitura, uns 5 segundos por faixa)'
  foreach ($meu in $meus) {
    if ($meu -eq '127.0.0.1') { continue }
    if ($meu -like '100.*')   { continue }
    $base = $meu -replace '\.\d{1,3}$', ''
    Say ('    varrendo ' + $base + '.1 ate ' + $base + '.254 ...')
    $cli = @{}
    $asy = @{}
    for ($i = 1; $i -le 254; $i++) {
      $ip = $base + '.' + $i
      if ($meus -contains $ip) { continue }
      try {
        $t = New-Object System.Net.Sockets.TcpClient
        $cli[$ip] = $t
        $asy[$ip] = $t.BeginConnect($ip, 3443, $null, $null)
      } catch {}
    }
    Start-Sleep -Milliseconds 2500
    $abertos = @()
    foreach ($ip in @($cli.Keys)) {
      try {
        if ($asy[$ip].IsCompleted -and $cli[$ip].Client -and $cli[$ip].Client.Connected) { $abertos += $ip }
      } catch {}
      try { $cli[$ip].Close() } catch {}
    }
    if ($abertos.Count -eq 0) { Say '    nada atendeu na 3443 nessa faixa.' }
    foreach ($ip in $abertos) {
      $hc = Baixar $ip
      if ($hc) {
        Say ('    ' + $ip.PadRight(18) + ' RESPONDEU o sistema na 3443   [varredura]')
        Registrar $ip $hc 'varredura da rede'
      } else {
        Say ('    ' + $ip.PadRight(18) + ' 3443 aberta, mas nao e o sistema  [varredura]')
      }
    }
  }
  Say ''
}

# ---------- [5] resultado ----------
Say '============================================================'
Say '  RESULTADO'
Say '============================================================'

if ($achados.Count -eq 0) {
  Say ''
  Say 'Nao encontrei a estacao de pesagem a partir deste PC.'
  Say ''
  if ($noAr.Count -gt 0) {
    Say ('Mas estas maquinas estao NO AR e so nao atendem na 3443: ' + ($noAr -join ', '))
    Say ''
    Say 'Isso quase sempre e uma coisa so: o firewall do Mini PC nunca'
    Say 'liberou a porta 3443. La, uma unica vez, clique com o botao'
    Say 'direito no LIBERAR-ACESSO-CELULAR.bat e mande Executar como'
    Say 'administrador. Nao mexe no sistema, nao reinicia nada - so'
    Say 'cria a regra de firewall. Depois rode este descobridor de novo.'
  } else {
    Say 'Motivos possiveis:'
    Say '  - a estacao esta desligada, ou o INICIAR.bat nao esta rodando;'
    Say '  - as duas maquinas estao em redes diferentes;'
    Say '  - o firewall da estacao nao liberou a porta 3443.'
  }
  Say ''
  Say 'Confira tambem, na janela preta do servidor no Mini PC, se aparece'
  Say 'a linha:   HTTPS(rede): https://<ip-do-mini-pc>:3443'
  Say 'Se ali estiver escrito "desativado", o HTTPS nao subiu e a'
  Say 'atualizacao remota nao tem por onde entrar - me avise no chat.'
  Say ''
  Say '=== FIM ==='
  return
}

$i = 0
foreach ($a in $achados) {
  $i++
  $d = $a.Dados
  Say ''
  Say ('  [' + $i + ']  ' + $a.Ip + '     (achado por: ' + $a.Origem + ')')
  Say ('       versao ............ ' + $d.versao)
  if ($d.PSObject.Properties.Name -contains 'commit') {
    Say ('       commit ............ ' + $d.commit)
  } else {
    Say  '       commit ............ (versao antiga, sem esse campo)'
  }
  if ($d.banco) {
    Say ('       etiquetas no banco  ' + $d.banco.etiquetas)
    Say ('       sessoes no banco .. ' + $d.banco.sessoes)
    Say ('       pendentes no Bling  ' + $d.banco.pendentes_bling)
  }
  if ($d.balanca) {
    if ($d.balanca.portaAberta) { Say '       balanca ........... porta serial ABERTA  <== e a estacao real' }
    else                        { Say '       balanca ........... porta serial fechada' }
  }
  if ($d.impressora) { Say ('       impressora ........ ' + $d.impressora) }
  else               { Say  '       impressora ........ nao detectada' }
}

Say ''
if ($achados.Count -gt 1) {
  Say 'Achei mais de uma maquina. A estacao de verdade e a que esta com'
  Say 'a porta serial da balanca ABERTA e com o banco cheio de etiquetas.'
  Say ''
}

$escolha = $achados[0]
if ($achados.Count -gt 1) {
  $n = Read-Host ('Qual delas e a estacao? Digite 1 a ' + $achados.Count + ', ou ENTER para nenhuma')
  Add-Content -Path $log -Value ('escolha: ' + $n) -Encoding ASCII
  $num = 0
  if (-not [int]::TryParse($n, [ref]$num)) { $num = 0 }
  if ($num -lt 1 -or $num -gt $achados.Count) {
    Say 'Nenhuma escolhida. Nada foi alterado.'
    Say '=== FIM ==='
    return
  }
  $escolha = $achados[$num - 1]
}

Say ''
Say ('Endereco da estacao: ' + $escolha.Ip)
Say ''

# ---------- [6] gravar no ENVIAR-ATUALIZACAO.bat ----------
$bat = Join-Path $raiz 'ENVIAR-ATUALIZACAO.bat'
if (-not (Test-Path $bat)) {
  Say 'Nao achei o ENVIAR-ATUALIZACAO.bat nesta pasta.'
  Say ('Anote o endereco e escreva na mao a linha:   set "MINIPC=' + $escolha.Ip + '"')
  Say '=== FIM ==='
  return
}

$linhas = Get-Content -Path $bat
$atual  = ''
foreach ($l in $linhas) {
  if ($l -match '^\s*set\s+"MINIPC=(.*)"\s*$') { $atual = $matches[1]; break }
}
if ($atual -eq $escolha.Ip) {
  Say 'O ENVIAR-ATUALIZACAO.bat ja esta com esse endereco. Nada a fazer.'
  Say '=== FIM ==='
  return
}

if ($atual) { Say ('Hoje o ENVIAR-ATUALIZACAO.bat aponta para: ' + $atual) }
else        { Say  'Hoje a linha MINIPC do ENVIAR-ATUALIZACAO.bat esta vazia.' }
Say ''
$g = Read-Host ('Gravar ' + $escolha.Ip + ' nessa linha? (S para gravar, ENTER para nao)')
Add-Content -Path $log -Value ('gravar: ' + $g) -Encoding ASCII
if (-not $g -or $g.ToUpper() -ne 'S') {
  Say 'Nada foi alterado.'
  Say '=== FIM ==='
  return
}

$novo   = @()
$trocou = $false
foreach ($l in $linhas) {
  if (-not $trocou -and ($l -match '^\s*set\s+"MINIPC=')) {
    $novo  += ('set "MINIPC=' + $escolha.Ip + '"')
    $trocou = $true
  } else {
    $novo += $l
  }
}
if (-not $trocou) {
  Say 'Nao achei a linha MINIPC dentro do arquivo. Nada foi alterado.'
  Say ('Escreva na mao, no topo dele:   set "MINIPC=' + $escolha.Ip + '"')
  Say '=== FIM ==='
  return
}

try {
  Set-Content -Path $bat -Value $novo -Encoding ASCII -ErrorAction Stop
} catch {
  Say ('Nao consegui gravar: ' + $_.Exception.Message)
  Say ('Escreva na mao, no topo dele:   set "MINIPC=' + $escolha.Ip + '"')
  Say '=== FIM ==='
  return
}

# confere o que ficou gravado
$conf = ''
foreach ($l in (Get-Content -Path $bat)) {
  if ($l -match '^\s*set\s+"MINIPC=(.*)"\s*$') { $conf = $matches[1]; break }
}
if ($conf -eq $escolha.Ip) {
  Say ('GRAVADO. A linha agora e:   set "MINIPC=' + $conf + '"')
  Say ''
  Say 'Proximo passo: rode o ENVIAR-ATUALIZACAO.bat. Ele vai publicar'
  Say 'essa mudanca de linha no GitHub e, no fim, perguntar se voce quer'
  Say 'aplicar na estacao. Responda S.'
} else {
  Say 'A gravacao nao conferiu. Abra o arquivo e escreva na mao:'
  Say ('    set "MINIPC=' + $escolha.Ip + '"')
}
Say ''
Say '=== FIM ==='
