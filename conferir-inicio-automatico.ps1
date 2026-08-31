# ============================================================
#  INICIO AUTOMATICO - conferencia e auto-correcao
# ------------------------------------------------------------
#  Chamado pelo INICIAR.bat toda vez que o sistema sobe, em
#  segundo plano. Nao atrasa o servidor.
#
#  O PROBLEMA QUE ISTO RESOLVE
#  Em 29/08/2026 o Mini PC foi reiniciado e subiu o sistema
#  ANTIGO. Motivo: quem manda no que sobe e' o atalho dentro da
#  pasta Inicializar do Windows, e ele continuava apontando para
#  "Desktop\PROJETO AUTOMACAO". Mudar a pasta de onde o sistema
#  roda nao mexe nesse atalho.
#
#  Pior: com DOIS atalhos, os dois sistemas sobem juntos no boot
#  e quem chega primeiro na porta 3000 ganha. Vira cara ou coroa
#  a cada reinicio.
#
#  O QUE ELE FAZ
#   1. garante que o atalho oficial aponta para ESTA pasta;
#   2. desativa (renomeia para .desativado) qualquer outro atalho
#      da Inicializar que aponte para um INICIAR.bat de outra
#      pasta - nada e' apagado, so' renomeado;
#   3. lista o que achou no Registro (chaves Run) e no Agendador,
#      sem alterar nada, so' para diagnostico.
#
#  Variaveis vindas do .bat: ALVO, PASTA, LINK
# ============================================================

$ErrorActionPreference = 'SilentlyContinue'

function Diga([string]$t) { Write-Output ((Get-Date).ToString('HH:mm:ss') + '  ' + $t) }

$alvo  = $env:ALVO
$pasta = $env:PASTA
$link  = $env:LINK

Diga '============================================================'
Diga '  INICIO AUTOMATICO - CONFERENCIA'
Diga '============================================================'
Diga ("Pasta desta instalacao: " + $pasta)
Diga ("Deve iniciar..........: " + $alvo)
Diga ''

if (-not $alvo -or -not (Test-Path $alvo)) {
  Diga 'ERRO: nao encontrei o INICIAR.bat desta pasta. Nada foi alterado.'
  exit 1
}

$shell = New-Object -ComObject WScript.Shell

# ?? 1. o atalho oficial ????????????????????????????????????????
$alvoAtual = $null
if (Test-Path $link) {
  try { $alvoAtual = $shell.CreateShortcut($link).TargetPath } catch {}
  Diga ("Atalho oficial aponta para: " + ($(if ($alvoAtual) { $alvoAtual } else { '(ilegivel)' })))
} else {
  Diga 'Atalho oficial: NAO EXISTE.'
}

if ($alvoAtual -and ($alvoAtual.TrimEnd('\') -ieq $alvo.TrimEnd('\'))) {
  Diga 'OK: o atalho ja aponta para esta pasta. Nada a fazer.'
} else {
  try {
    $s = $shell.CreateShortcut($link)
    $s.TargetPath        = $alvo
    $s.WorkingDirectory  = $pasta
    $s.WindowStyle       = 7
    $s.Description       = 'Inicia o sistema Ekoplastic automaticamente'
    $s.Save()
    $conf = $shell.CreateShortcut($link).TargetPath
    if ($conf.TrimEnd('\') -ieq $alvo.TrimEnd('\')) {
      Diga 'CORRIGIDO: o atalho de inicializacao agora aponta para esta pasta.'
    } else {
      Diga ('FALHOU a gravacao. O atalho continua em: ' + $conf)
    }
  } catch {
    Diga ('ERRO ao gravar o atalho: ' + $_.Exception.Message)
  }
}
Diga ''

# ?? 2. outros atalhos na Inicializar ???????????????????????????
Diga 'Outros itens na pasta Inicializar:'
$pastas = @(
  [Environment]::GetFolderPath('Startup'),
  [Environment]::GetFolderPath('CommonStartup')
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique

$achouOutro = $false
foreach ($dir in $pastas) {
  foreach ($f in (Get-ChildItem -Path $dir -File -ErrorAction SilentlyContinue)) {
    if ($f.FullName -ieq $link) { continue }
    $destino = ''
    if ($f.Extension -ieq '.lnk') {
      try { $destino = $shell.CreateShortcut($f.FullName).TargetPath } catch {}
    } elseif ($f.Extension -ieq '.bat' -or $f.Extension -ieq '.cmd') {
      $destino = $f.FullName
    }
    $suspeito = $destino -and (
      ($destino -imatch 'INICIAR\.bat$') -or
      ($destino -imatch 'ekoplastic') -or
      ($destino -imatch 'etiquetas') -or
      ($f.Name -imatch 'ekoplastic|etiqueta|automa')
    )
    if (-not $suspeito) { continue }
    $achouOutro = $true
    if ($destino.TrimEnd('\') -ieq $alvo.TrimEnd('\')) {
      Diga ('  ' + $f.Name + ' -> mesma pasta, inofensivo.')
      continue
    }
    Diga ('  ' + $f.Name + ' -> ' + $destino)
    Diga '     Este aponta para OUTRA instalacao e disputaria a porta 3000 no boot.'
    $novo = $f.FullName + '.desativado'
    try {
      $i = 1
      while (Test-Path $novo) { $novo = $f.FullName + '.desativado' + $i; $i++ }
      Rename-Item -LiteralPath $f.FullName -NewName (Split-Path $novo -Leaf) -ErrorAction Stop
      Diga ('     DESATIVADO: renomeado para ' + (Split-Path $novo -Leaf) + ' (nada foi apagado).')
    } catch {
      Diga ('     NAO consegui desativar: ' + $_.Exception.Message)
    }
  }
}
if (-not $achouOutro) { Diga '  (nenhum outro item relacionado ao sistema)' }
Diga ''

# ?? 3. diagnostico: Registro e Agendador (so' leitura) ?????????
Diga 'Chaves Run do Registro (apenas diagnostico, nada e alterado):'
$chaves = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run'
)
$achouReg = $false
foreach ($k in $chaves) {
  if (-not (Test-Path $k)) { continue }
  $p = Get-ItemProperty -Path $k
  foreach ($n in ($p.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' })) {
    if ("$($n.Value)" -imatch 'ekoplastic|etiqueta|INICIAR\.bat|PROJETO AUTOMA') {
      Diga ('  ' + $k + ' :: ' + $n.Name + ' = ' + $n.Value)
      $achouReg = $true
    }
  }
}
if (-not $achouReg) { Diga '  (nada relacionado ao sistema)' }
Diga ''

Diga 'Tarefas agendadas (apenas diagnostico):'
$achouTar = $false
try {
  foreach ($t in (Get-ScheduledTask -ErrorAction SilentlyContinue)) {
    $acoes = ($t.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -join ' | '
    if ("$($t.TaskName) $acoes" -imatch 'ekoplastic|etiqueta|INICIAR\.bat|PROJETO AUTOMA') {
      Diga ('  ' + $t.TaskName + ' [' + $t.State + '] -> ' + $acoes)
      $achouTar = $true
    }
  }
} catch { Diga '  (nao consegui consultar o Agendador)' }
if (-not $achouTar) { Diga '  (nada relacionado ao sistema)' }

Diga ''
Diga 'Lembrete: para o sistema abrir sozinho apos queda de energia, o'
Diga 'Windows precisa ENTRAR SOZINHO na conta (Windows+R, netplwiz,'
Diga 'desmarcar "Os usuarios devem digitar um nome e senha").'
Diga '=== FIM ==='
