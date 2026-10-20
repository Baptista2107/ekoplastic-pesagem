// ════════════════════════════════════════════════════════════════════
//  IMPRESSÃO EPL2 — impressora, etiquetas e resumos
// ════════════════════════════════════════════════════════════════════

const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const { spawn } = require('child_process');

const { LOG_DIR, OUTRAS_CATALOGO, PA_CORES, PA_KG_FARDO, PRINTER_NAMES, PS_SCRIPT } = require('./config');
const { ensureDir, logI, logW, rangeUTCdoDiaLocal } = require('./log');
const { configGet, db, sessaoContaConsumida } = require('./db');

// ════════════════════════════════════════════════════════════════════
//  IMPRESSORA EPL2 (PowerShell + Win32 Spooler)
// ════════════════════════════════════════════════════════════════════

let PRINTER_ATIVA = PRINTER_NAMES[0];
let PRINTER_DETECTADA = false;

// ── Trava de segurança dos testes: EKO_PRINT_SIMULAR=1 ──────────────
// A detecção de impressora é ASSÍNCRONA (spawna um PowerShell e leva
// segundos). Até ela responder, PRINTER_DETECTADA é false e a impressão
// cai na simulação; depois que responde, passa a imprimir DE VERDADE.
// Numa máquina com a Zebra instalada isso faz um teste começar simulando
// e, no meio do caminho, começar a cuspir papel — foi o que aconteceu no
// PC de desenvolvimento em 01/09/2026.
// Esta variável de ambiente força a simulação desde o primeiro
// milissegundo, sem depender do banco nem da detecção. Em produção ela
// não existe, e nada muda.
const PRINT_SIMULAR_ENV = process.env.EKO_PRINT_SIMULAR === '1';

// Garante que o script de impressão (enviar_raw.ps1) exista. Se faltar
// (ex: não foi copiado pra esta máquina), gera automaticamente com o
// método RAW via spooler do Windows (winspool) — o mesmo comprovado em
// campo. Assim o sistema fica auto-contido e a impressão não depende de
// um arquivo externo ter sido copiado.
const ENVIAR_RAW_PS1 = String.raw`param(
  [Parameter(Mandatory=$true)][string]$EplFile,
  [Parameter(Mandatory=$true)][string]$PrinterName
)
$ErrorActionPreference = "Stop"
$code = @"
using System;
using System.Runtime.InteropServices;
public class RawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)]
  public class DOCINFOA { [MarshalAs(UnmanagedType.LPStr)] public string pDocName; [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile; [MarshalAs(UnmanagedType.LPStr)] public string pDataType; }
  [DllImport("winspool.Drv", EntryPoint="OpenPrinterA", SetLastError=true, CharSet=CharSet.Ansi)] public static extern bool OpenPrinter(string src, out IntPtr h, IntPtr pd);
  [DllImport("winspool.Drv", EntryPoint="ClosePrinter", SetLastError=true)] public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.Drv", EntryPoint="StartDocPrinterA", SetLastError=true, CharSet=CharSet.Ansi)] public static extern bool StartDocPrinter(IntPtr h, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);
  [DllImport("winspool.Drv", EntryPoint="EndDocPrinter", SetLastError=true)] public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.Drv", EntryPoint="StartPagePrinter", SetLastError=true)] public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.Drv", EntryPoint="EndPagePrinter", SetLastError=true)] public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.Drv", EntryPoint="WritePrinter", SetLastError=true)] public static extern bool WritePrinter(IntPtr h, byte[] buf, int count, out int written);
  public static string Send(string printer, byte[] bytes) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) throw new Exception("OpenPrinter falhou (err " + Marshal.GetLastWin32Error() + ") para: " + printer);
    var di = new DOCINFOA(); di.pDocName = "Etiqueta EPL"; di.pDataType = "RAW";
    if (!StartDocPrinter(h, 1, di)) { ClosePrinter(h); throw new Exception("StartDocPrinter falhou (err " + Marshal.GetLastWin32Error() + ")"); }
    StartPagePrinter(h);
    int written;
    bool ok = WritePrinter(h, bytes, bytes.Length, out written);
    EndPagePrinter(h); EndDocPrinter(h); ClosePrinter(h);
    if (!ok) throw new Exception("WritePrinter falhou (err " + Marshal.GetLastWin32Error() + ")");
    return "OK " + written + " bytes";
  }
}
"@
Add-Type -TypeDefinition $code -Language CSharp
$bytes = [System.IO.File]::ReadAllBytes($EplFile)
$r = [RawPrinter]::Send($PrinterName, $bytes)
Write-Output $r
`;

function garantirScriptImpressao() {
  try {
    let precisaEscrever = true;
    if (fs.existsSync(PS_SCRIPT)) {
      const atual = fs.readFileSync(PS_SCRIPT, 'utf8');
      if (atual === ENVIAR_RAW_PS1) {
        precisaEscrever = false;   // já é o método comprovado
      } else {
        // Versão diferente/antiga — faz backup antes de substituir pelo
        // método raw via spooler (winspool), comprovado em campo.
        try { fs.copyFileSync(PS_SCRIPT, PS_SCRIPT + '.bak'); } catch (e) {}
        logI('print', 'enviar_raw.ps1 antigo encontrado — backup em enviar_raw.ps1.bak e atualizado para o método raw comprovado');
      }
    } else {
      logI('print', 'enviar_raw.ps1 não existia — gerado automaticamente');
    }
    if (precisaEscrever) fs.writeFileSync(PS_SCRIPT, ENVIAR_RAW_PS1, 'utf8');
  } catch (e) {
    logW('print', `Não foi possível gerar enviar_raw.ps1: ${e.message}`);
  }
}

function detectarImpressora(cb) {
  const psCmd = 'Get-Printer | Select-Object Name,PortName,DriverName,PrinterStatus,JobCount | ConvertTo-Json -Compress';
  const ps = spawn('powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-Command', psCmd], { windowsHide: true });
  let stdout = '';
  ps.stdout.on('data', d => stdout += d.toString());
  let done = false;
  const finish = (m, inst) => { if (done) return; done = true; cb(m, inst); };
  ps.on('close', code => {
    if (code !== 0) return finish(null, []);
    let installed = [];
    try {
      const parsed = JSON.parse(stdout.trim() || '[]');
      installed = Array.isArray(parsed) ? parsed : [parsed];
    } catch(e) {
      installed = stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(n => ({Name:n}));
    }
    let match = null;
    for (const want of PRINTER_NAMES) {
      const wLow = want.toLowerCase();
      const found = installed.find(p => {
        const nLow = (p.Name||'').toLowerCase();
        return nLow === wLow || nLow.includes(wLow) || wLow.includes(nLow);
      });
      if (found) { match = found.Name; break; }
    }
    finish(match, installed);
  });
  ps.on('error', () => finish(null, []));
}

function gerarEPL(dados) {
  // Encaminhamento pra função de bobina quando for extrusão
  if (dados.tipo === 'extrusao') return gerarEPLBobina(dados);
  if (dados.tipo === 'outras')   return gerarEPLOutras(dados);

  const tipo = dados.tipo || 'recebimento';
  const labelTopo = tipo === 'retorno' ? 'RETORNO:' : 'MATERIAL:';
  const materialLabel = dados.cor
    ? `${dados.cor.toUpperCase()} - ${(dados.materialNomeEt || dados.material_nome || '').toUpperCase()}`
    : (dados.materialNomeEt || dados.material_nome || '').toUpperCase();
  const pesoStr = `${Number(dados.peso).toFixed(1)} KG`;     // sem a palavra "PESO"
  const id      = (tipo === 'retorno' ? 'T' : 'R') + String(dados.seq).padStart(7, '0');
  const dataHora = `${new Date().toLocaleDateString('pt-BR')}  ${new Date().toLocaleTimeString('pt-BR').substring(0,5)}`;
  const pesoX   = Math.max(40, Math.floor((800 - pesoStr.length * 32) / 2));
  const codigoX = Math.max(40, Math.floor((800 - dados.codigo.length * 28) / 2));
  const skuX    = Math.max(40, Math.floor((800 - dados.sku.length * 12) / 2));

  // Selo "PESAGEM #N" no canto superior direito. Y=36 (não mais Y=3) pra
  // não cortar no topo (margem não imprimível da etiqueta).
  const seloPesagem = dados.seq_sessao
    ? `A520,44,0,4,1,2,N,"PESAGEM #${String(dados.seq_sessao).padStart(2,'0')}"\n`
    : '';

  // Layout descido (margem superior ~36 dots) pra eliminar o corte do topo.
  // Mantém material/fornecedor/lote/peso/código/barras/sku e acrescenta a
  // data e hora da pesagem no rodapé.
  // Etiqueta 100x150mm (800x1200 dots). Mesmas informações de antes, agora
  // distribuídas na altura maior e com letras mais altas (multiplicador
  // vertical 3 em vez de 2) — mais legível de longe, sem estourar a largura.
  return `N
q800
Q1200,24

${seloPesagem}LO30,88,740,3

A40,116,0,4,1,3,N,"${labelTopo} ${materialLabel}"

A40,232,0,4,1,3,N,"FORNECEDOR: ${dados.fornecedor.toUpperCase()}"

A40,348,0,4,1,3,N,"LOTE ${dados.lote}"

LO30,466,740,3

A${pesoX},500,0,5,1,3,N,"${pesoStr}"

LO30,672,740,3

A40,700,0,4,1,2,N,"CODIGO PARA EXTRUSAO"
A${codigoX},760,0,4,2,3,N,"${dados.codigo}"

LO30,888,740,3

B180,915,0,1,4,9,110,N,"${id}"

A40,1046,0,4,1,2,N,"ETIQUETA ${id}"
A${skuX},1106,0,3,1,1,N,"${dados.sku}"
A40,1146,0,3,1,1,N,"DATA / HORA: ${dataHora}"

P1
`;
}

// ──────────────────────────────────────────────────────────────────
// Layout EPL da ETIQUETA DE GAIOLA (Produto Acabado) — só para CONTAGEM.
// QR Code grande ocupando quase toda a etiqueta + a informação escrita.
// O QR carrega: EKOPA|<id>|<formato>|<corKey>|<fardos>|<kg>
// O <id> é único por gaiola, para o inventário bloquear leitura repetida.
// Nada disso vai ao Bling: o lançamento de produção continua como está.
// ──────────────────────────────────────────────────────────────────
function gerarEPLGaiolaPA(dados) {
  const cor = PA_CORES[dados.corKey] || { nome: dados.corKey };
  const fardos = Number(dados.fardos) || 0;
  const kg = fardos * PA_KG_FARDO;
  // 7º campo (04/09/2026): GRANDE ou PEQUENA — o endereçamento precisa
  // saber o tipo da gaiola para conferir o nível da prateleira. É
  // APÊNDICE de propósito: o leitor do inventário exige 6 campos ou
  // mais, então etiqueta antiga (6 campos) continua sendo lida.
  const tipo = String(dados.tipo_gaiola || '').toUpperCase() === 'GRANDE' ? 'GRANDE'
             : String(dados.tipo_gaiola || '').toUpperCase() === 'PEQUENA' ? 'PEQUENA' : '';
  const conteudo = `EKOPA|${dados.id}|${dados.formato}|${dados.corKey}|${fardos}|${kg}`
                 + (tipo ? `|${tipo}` : '');

  const LARG = 800, ALT = 1200;   // etiqueta 100x150mm (dots)

  // Larguras reais das fontes EPL (dots por caractere, antes do multiplicador).
  const LARG_FONTE = { 1: 8, 2: 10, 3: 12, 4: 14, 5: 32 };
  const centralizar = (txt, fonte, mult) => {
    const larg = txt.length * (LARG_FONTE[fonte] || 14) * mult;
    return Math.max(8, Math.round((LARG - larg) / 2));
  };

  // Quantos "quadradinhos" o QR terá (depende do tamanho do conteúdo).
  const modulos = conteudo.length <= 42 ? 29 : 33;

  const Y_TEXTO_FIM = 132;    // onde termina o texto do topo
  const Y_RODAPE    = 1150;   // linha final
  const MARGEM_X    = 24;

  // O QR fica o MAIOR possível e centralizado nos dois eixos.
  const escalaCfg = parseInt(configGet('pa_qr_escala', '0')) || 0;
  const escalaMax = Math.floor(Math.min(LARG - MARGEM_X * 2, Y_RODAPE - Y_TEXTO_FIM - 30) / modulos);
  const escala = Math.max(4, Math.min(escalaCfg > 0 ? escalaCfg : escalaMax, escalaMax));

  const ladoQR = modulos * escala;
  const xQR = Math.round((LARG - ladoQR) / 2);
  const yQR = Math.round(Y_TEXTO_FIM + ((Y_RODAPE - 20 - Y_TEXTO_FIM) - ladoQR) / 2);

  const linha1 = `${dados.formato.replace('x', ' X ')} ${cor.nome.toUpperCase()}`;
  const linha2 = `${fardos} FARDOS` + (tipo ? `  -  GAIOLA ${tipo}` : '');
  const rodape = `${dados.id}  -  CONTAGEM DE GAIOLA`;

  return `N
q${LARG}
Q${ALT},24

A${centralizar(linha1, 4, 2)},24,0,4,2,2,N,"${linha1}"
A${centralizar(linha2, 4, 1)},84,0,4,1,2,N,"${linha2}"

b${xQR},${yQR},Q,m2,s${escala},"${conteudo}"

A${centralizar(rodape, 3, 1)},${Y_RODAPE},0,3,1,1,N,"${rodape}"

P1
`;
}

// ──────────────────────────────────────────────────────────────────
// Layout EPL específico de bobina (extrusão)
// Campos: cor, tipo_bobina (LEVE/REFORÇADA), largura, operador, máquina,
//         turno, peso, SKU, código de barras (E0000001)
// ──────────────────────────────────────────────────────────────────
function gerarEPLBobina(dados) {
  const id          = 'E' + String(dados.seq).padStart(7, '0');
  const cor         = (dados.cor || '').toUpperCase();
  const tipoBobina  = (dados.tipo_bobina || '').toUpperCase();
  const largura     = dados.largura || '';
  const operador    = (dados.operador || '—').toUpperCase().substring(0, 30);
  const maquina     = (dados.maquina || '—').toUpperCase();
  const peso        = Number(dados.peso).toFixed(1);

  const pesoStr  = `${peso} KG`;                       // sem a palavra "PESO"
  const tipoStr  = dados.sub_tipo === 'capa'
    ? `CAPA ${largura}`                                // capa: sem cor, ex "CAPA 70 x 90"
    : `${cor} ' ${tipoBobina} ' ${largura}`;
  // REFUGO (06/10/2026, Gustavo: "preciso gerar a etiqueta desse refugo"):
  // a MESMA etiqueta (mesmo número/código de barras, mesmos dados), com o
  // peso NOVO da repesagem, tarja REFUGO e o peso original da extrusão.
  const rf = dados.refugo || null;
  const quando = rf && rf.pesado_em ? new Date(rf.pesado_em) : new Date();
  const dataHora = `${quando.toLocaleDateString('pt-BR')}  ${quando.toLocaleTimeString('pt-BR').substring(0,5)}`
    + (rf ? `  ORIG. ${Number(rf.peso_original || 0).toFixed(1).replace('.', ',')} KG` : '');
  const tarjaRefugo = rf ? `A560,36,0,4,1,2,R," REFUGO "\n` : '';

  // Centralização (métricas das fontes EPL nativas, dots/char):
  // font 4 hmul1 ≈ 14 ; font 5 hmul2 ≈ 64
  const tipoX = Math.max(20, Math.floor((800 - tipoStr.length * 14) / 2));
  const pesoX = Math.max(20, Math.floor((800 - pesoStr.length * 64) / 2));
  // Número escrito embaixo das barras, como na etiqueta da MP (14/10/2026,
  // Gustavo): dá para achar/conferir a bobina sem leitor.
  const idX   = Math.max(20, Math.floor((800 - `ETIQUETA ${id}`.length * 14) / 2));

  // Layout 100x100mm (800x800 dots). Margem superior de 40 dots evita o
  // corte do topo. Cada bloco: rótulo pequeno (font 3) + valor (font 4),
  // separados por linha. Peso em destaque (font 5). Código de barras no
  // rodapé (necessário para a bipagem na finalização).
  // Etiqueta 100x150mm (800x1200 dots). A PARTE DE CIMA é idêntica à de antes
  // (mesmas informações, mesmas posições, ocupando os primeiros 100mm) — nada
  // muda para quem já usa. O espaço novo embaixo traz os campos onde as
  // sacoleiras anotam à mão o peso que a bobina rendeu em cada turno.
  return `N
q800
Q1200,24

${tarjaRefugo}A40,40,0,3,1,1,N,"TIPO DA BOBINA"
A${tipoX},74,0,4,1,2,N,"${tipoStr}"
LO30,148,740,2

A40,166,0,3,1,1,N,"OPERADOR"
A40,200,0,4,1,2,N,"${operador}"
LO30,270,740,2

A40,288,0,3,1,1,N,"MAQUINA"
A40,322,0,4,1,2,N,"${maquina}"
LO30,392,740,2

A40,410,0,3,1,1,N,"${rf ? 'DATA / HORA DO REFUGO' : 'DATA / HORA DA PESAGEM'}"
A40,444,0,4,1,2,N,"${dataHora}"
LO30,514,740,2

A${pesoX},534,0,5,2,2,N,"${pesoStr}"
LO30,652,740,2

B210,666,0,1,3,8,60,N,"${id}"
A${idX},736,0,4,1,1,N,"ETIQUETA ${id}"

LO30,772,740,3

A40,792,0,3,1,1,N,"PESO EM SACOLA - ANOTAR"

A40,838,0,4,2,2,N,"TURNO A"
A400,846,0,4,1,2,N,"PESO:"
LO400,942,370,3

LO30,972,740,2

A40,1000,0,4,2,2,N,"TURNO C"
A400,1008,0,4,1,2,N,"PESO:"
LO400,1104,370,3

P1
`;
}

// ──────────────────────────────────────────────────────────────────
// Layout EPL específico de OUTRAS PESAGENS (aparas/borra/varredura).
// Sem operador/máquina; mostra o item, data/hora, peso e código de barras
// (O#######) pra bipagem. SKU no rodapé. Não imprime "código para extrusão".
// ──────────────────────────────────────────────────────────────────
function gerarEPLOutras(dados) {
  const id       = 'O' + String(dados.seq).padStart(7, '0');
  const itemStr  = _eplSafe((dados.materialNomeEt || dados.material_nome || dados.sku || '').toUpperCase(), 28);
  const skuStr   = _eplSafe(dados.sku || '', 40);
  const pesoStr  = `${Number(dados.peso).toFixed(1)} KG`;
  const dataHora = `${new Date().toLocaleDateString('pt-BR')}  ${new Date().toLocaleTimeString('pt-BR').substring(0,5)}`;

  const selo = dados.seq_sessao
    ? `A500,48,0,4,1,2,N,"PESAGEM #${String(dados.seq_sessao).padStart(2,'0')}"\n`
    : '';

  // Métricas das fontes EPL nativas (dots/char): font4 hmul1≈14, font5 hmul2≈64, font3 hmul1≈12
  const itemX = Math.max(20, Math.floor((800 - itemStr.length * 14) / 2));
  const pesoX = Math.max(20, Math.floor((800 - pesoStr.length * 64) / 2));
  const skuX  = Math.max(20, Math.floor((800 - skuStr.length  * 12) / 2));

  // Etiqueta 100x150mm (800x1200 dots) — mesmas informações, distribuídas
  // na altura maior e com letras mais altas.
  return `N
q800
Q1200,24

A40,44,0,3,1,1,N,"RESIDUOS"
${selo}LO30,110,740,3

A40,138,0,3,1,1,N,"ITEM"
A${itemX},182,0,4,1,3,N,"${itemStr}"
LO30,306,740,3

A40,334,0,3,1,1,N,"DATA / HORA DA PESAGEM"
A40,378,0,4,1,3,N,"${dataHora}"
LO30,500,740,3

A${pesoX},536,0,5,2,3,N,"${pesoStr}"
LO30,730,740,3

B210,760,0,1,3,8,110,N,"${id}"

A${skuX},1000,0,3,1,2,N,"${skuStr}"
A40,1060,0,3,1,1,N,"ETIQUETA ${id}"

P1
`;
}


// ──────────────────────────────────────────────────────────────────
// RESUMO DE FINALIZAÇÃO (impresso na térmica 100x100 ao finalizar)
//  - Recebimento (MP): nº do big bag, material, cor, peso + total geral.
//  - Extrusão:        máquina, largura, tipo, cor, peso + total geral.
// Gera UM job EPL com 1+ etiquetas 100x100 — se houver muitos itens, pagina
// automaticamente (cada "página" é uma etiqueta 100x100 dentro do mesmo job).
// Fonte pequena de propósito (cabe ~24 itens por etiqueta).
// ──────────────────────────────────────────────────────────────────
function _eplSafe(v, max) {
  let s = (v == null ? '' : String(v))
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // remove acentos (codepage da impressora)
    .replace(/["\r\n]/g, ' ')
    .replace(/[^\x20-\x7E]/g, ' ');
  if (max && s.length > max) s = s.substring(0, max);
  return s;
}
const _pad  = (v, n) => (_eplSafe(v) + ' '.repeat(n)).substring(0, n);
const _padR = (v, n) => (' '.repeat(n) + _eplSafe(v)).slice(-n);

// Agrupa etiquetas de RECEBIMENTO por tipo de material (material + cor).
// Retorna [{label, kg, count, itens}] ordenado pelo rótulo. O rótulo é "cru"
// (com acentos): quem imprime aplica _eplSafe; quem manda pro Bling usa direto.
function _grupoMP(itens) {
  const mapa = new Map();
  for (const it of itens) {
    const chave = `${it.material_key || ''}|${it.cor || ''}`;
    if (!mapa.has(chave)) {
      const base = it.material_nome || it.material_key || '?';
      mapa.set(chave, { label: (base + (it.cor ? ' ' + it.cor : '')).trim(), kg: 0, count: 0, itens: [] });
    }
    const g = mapa.get(chave);
    g.kg += Number(it.peso || 0); g.count++; g.itens.push(it);
  }
  return [...mapa.values()].sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
}

// Agrupa etiquetas de EXTRUSÃO por máquina, sempre com C1 e C2 primeiro.
function _grupoMaq(itens) {
  const mapa = new Map();
  for (const it of itens) {
    const m = (it.maquina || '—').toUpperCase();
    if (!mapa.has(m)) mapa.set(m, { label: m, kg: 0, count: 0, itens: [] });
    const g = mapa.get(m);
    g.kg += Number(it.peso || 0); g.count++; g.itens.push(it);
  }
  const ordem = ['C1', 'C2'];
  return [...mapa.values()].sort((a, b) => {
    const ia = ordem.indexOf(a.label), ib = ordem.indexOf(b.label);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.label.localeCompare(b.label);
  });
}

// Agrupa CAPAS (sub_tipo='capa') por tipo de capa (SKU). Rótulo = nome da capa.
function _grupoCapa(itens) {
  const mapa = new Map();
  for (const it of itens) {
    const chave = it.sku || it.material_nome || '?';
    if (!mapa.has(chave)) mapa.set(chave, { label: (it.material_nome || it.sku || 'CAPA'), kg: 0, count: 0, itens: [] });
    const g = mapa.get(chave);
    g.kg += Number(it.peso || 0); g.count++; g.itens.push(it);
  }
  return [...mapa.values()].sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
}

// Agrupa etiquetas de OUTRAS PESAGENS por item (Apara Amarela/Verde/Preta/
// Branca, Borra, Varredura). Rótulo = nome do item. Aparas vêm antes dos
// resíduos (ordem por categoria; dentro da categoria, alfabético).
function _grupoOutras(itens) {
  const mapa = new Map();
  for (const it of itens) {
    const chave = it.material_nome || it.sku || '?';
    if (!mapa.has(chave)) {
      const cat = (OUTRAS_CATALOGO[it.sku] && OUTRAS_CATALOGO[it.sku].categoria) || 'ZZZ';
      mapa.set(chave, { label: (it.material_nome || it.sku || 'ITEM'), categoria: cat, kg: 0, count: 0, itens: [] });
    }
    const g = mapa.get(chave);
    g.kg += Number(it.peso || 0); g.count++; g.itens.push(it);
  }
  const ordemCat = { APARA: 0, RESIDUO: 1, ZZZ: 9 };
  return [...mapa.values()].sort((a, b) => {
    const ca = ordemCat[a.categoria] ?? 9, cb = ordemCat[b.categoria] ?? 9;
    return ca - cb || a.label.localeCompare(b.label, 'pt-BR');
  });
}

// ── Resumo de PRODUTO ACABADO no formato da mensagem do WhatsApp (v93) ──
// Agrupa por MÁQUINA (P1, P2); dentro de cada máquina, consolida por
// FORMATO + COR somando fardos e kg; imprime o subtotal por máquina e o
// total do turno. Espelha a mensagem que os operadores mandam no grupo,
// para a conferência ficar lado a lado. Ex.:
//   P1
//   40 x 50 Colorida: 24 fardos = 600 kg
//   Total P1 = 1.100 kg
//   ...
//   Total do Turno = 1.400 kg
function montarResumoProdutoAcabadoEPL(s, itens, dataHora, parcial) {
  const fmtKgPA = kg => {
    const n = Number(kg || 0);
    const t = Number.isInteger(n)
      ? n.toLocaleString('pt-BR')
      : n.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    return t + ' kg';
  };
  const fmtFormato = f => String(f || '').replace('x', ' x ');   // 40x50 -> 40 x 50

  // Consolida: máquina -> combos (formato|cor -> {formato, cor, fardos, kg}).
  const maquinas = new Map();
  for (const it of itens) {
    const maq = (it.maquina || '?').toUpperCase();
    if (!maquinas.has(maq)) maquinas.set(maq, { kg: 0, combos: new Map() });
    const M = maquinas.get(maq);
    const formato = it.lote || '?';
    const cor     = it.material_nome || it.material_key || '?';
    const chave   = formato + '|' + cor;
    if (!M.combos.has(chave)) M.combos.set(chave, { formato, cor, fardos: 0, kg: 0 });
    const C = M.combos.get(chave);
    C.fardos += Number(it.qtd_sacos || 0);
    C.kg     += Number(it.peso || 0);
    M.kg     += Number(it.peso || 0);
  }
  const maqsOrdenadas = [...maquinas.entries()].sort((a, b) => a[0].localeCompare(b[0], 'pt-BR'));
  const totalTurno    = itens.reduce((a, b) => a + Number(b.peso || 0), 0);

  // Paginação por cursor Y (mesma lógica do resumo genérico).
  const ALT = { maq: 46, combo: 34, totalmaq: 42, espaco: 16, totalturno: 78 };
  const Y_TOPO = 160, Y_FIM = 1170;   // etiqueta 100x150mm (1200 dots)
  const paginas = [];
  let cur = [], y = Y_TOPO;
  const fecharPagina = () => { if (cur.length) paginas.push(cur); cur = []; y = Y_TOPO; };
  const push = (k, txt) => { cur.push({ k, y, txt }); y += ALT[k]; };

  for (const [maq, M] of maqsOrdenadas) {
    if (y + ALT.maq + ALT.combo > Y_FIM) fecharPagina();   // não separa a máquina do 1º combo
    push('maq', maq);
    const combos = [...M.combos.values()];   // ordem de adição (1ª aparição) — igual à digitação do operador
    for (const c of combos) {
      if (y + ALT.combo > Y_FIM) { fecharPagina(); push('maq', maq + ' (CONT.)'); }
      push('combo', `${fmtFormato(c.formato)} ${c.cor}: ${c.fardos} fardos = ${fmtKgPA(c.kg)}`);
    }
    if (y + ALT.totalmaq > Y_FIM) fecharPagina();
    push('totalmaq', `Total ${maq} = ${fmtKgPA(M.kg)}`);
    push('espaco', '');
  }
  if (y + ALT.totalturno > Y_FIM) fecharPagina();
  push('totalturno', `Total do Turno = ${fmtKgPA(totalTurno)}`);
  fecharPagina();

  const titulo   = 'RESUMO PRODUTO ACABADO' + (parcial ? ' - PARCIAL' : '');
  const sub1     = s.operador
                   ? `Turno: ${_eplSafe(s.turno_codigo || '-')}  Resp: ${_eplSafe(s.operador, 14)}`
                   : `Turno: ${_eplSafe(s.turno_codigo || '-')}  ·  Entrada de estoque`;
  const nPaginas = paginas.length;
  let epl = '';
  paginas.forEach((linhas, pi) => {
    let bloco = 'N\nq800\nQ1200,24\n';
    bloco += `A30,24,0,4,1,1,N,"${_eplSafe(titulo)}"\n`;
    bloco += `A30,82,0,3,1,1,N,"${sub1}"\n`;
    bloco += `A30,120,0,2,1,1,N,"${dataHora}   Pag ${pi + 1}/${nPaginas}"\n`;
    bloco += 'LO20,150,760,3\n';
    for (const ln of linhas) {
      if (ln.k === 'maq') {
        bloco += `LO20,${ln.y + 2},760,1\n`;
        bloco += `A30,${ln.y + 12},0,4,1,1,N,"${_eplSafe(ln.txt, 42)}"\n`;
      } else if (ln.k === 'combo') {
        bloco += `A50,${ln.y},0,3,1,1,N,"${_eplSafe(ln.txt, 46)}"\n`;
      } else if (ln.k === 'totalmaq') {
        bloco += `A50,${ln.y},0,3,1,1,N,"${_eplSafe(ln.txt, 46)}"\n`;
      } else if (ln.k === 'espaco') {
        /* linha em branco entre máquinas */
      } else {   // total do turno
        bloco += `LO20,${ln.y},760,3\n`;
        bloco += `A30,${ln.y + 14},0,4,1,1,N,"${_eplSafe(ln.txt)}"\n`;
      }
    }
    bloco += 'P1\n';
    epl += bloco;
  });
  return { epl, nPaginas };
}

// ── Layout genérico do resumo (etiqueta 100 x 150 mm) ──────────────
// O MESMO desenho serve para o resumo de UMA sessão e para o RESUMO DO
// DIA (que soma várias sessões do mesmo tipo). Recebe os grupos já
// montados e a função que desenha cada linha de item; devolve o job EPL
// paginado. Foi extraído de imprimirResumoSessao sem mudar uma vírgula
// do desenho — a prova está em testes/resumo-opcional.js, que compara o
// EPL gerado byte a byte com a fotografia do layout anterior.
function montarResumoGenericoEPL({ titulo, sub1, dataHora, parcial, grupos, itemLinha, totalItens, totalKg }) {
  const fmtKg = kg => Number(kg || 0).toFixed(1).replace('.', ',') + ' kg';

  // Cada etiqueta 100x150 reserva o topo p/ título/sub/data; o corpo recebe
  // os grupos (cabeçalho + itens + subtotal) e, no fim, o total geral.
  // Fontes: título/total = font4, grupo/subtotal = font3, itens = font2.
  // Quebra em 2+ etiquetas quando não couber; grupo que vira de página
  // repete o cabeçalho com (CONT.).
  const ALT    = { grupo: 40, item: 30, subtotal: 40, total: 60 };
  const Y_TOPO = 160;
  const Y_FIM  = 1170;   // etiqueta 100x150mm (1200 dots)
  const paginas = [];
  let cur = [], y = Y_TOPO, nGlobal = 0;
  const fecharPagina = () => { if (cur.length) paginas.push(cur); cur = []; y = Y_TOPO; };
  const push = (k, txt) => { cur.push({ k, y, txt }); y += ALT[k]; };

  for (const g of grupos) {
    const rotulo = _eplSafe(g.label.toUpperCase(), 42);
    if (y + ALT.grupo + ALT.item > Y_FIM) fecharPagina();   // não separa cabeçalho do 1º item
    push('grupo', rotulo);
    for (const it of g.itens) {
      if (y + ALT.item > Y_FIM) { fecharPagina(); push('grupo', rotulo + ' (CONT.)'); }
      nGlobal++;
      push('item', itemLinha(it, nGlobal));
    }
    if (y + ALT.subtotal > Y_FIM) fecharPagina();
    push('subtotal', `Subtotal: ${g.count} itens   ${fmtKg(g.kg)}`);
  }
  if (y + ALT.total > Y_FIM) fecharPagina();
  push('total', `TOTAL GERAL: ${totalItens} itens   ${fmtKg(totalKg)}`);
  fecharPagina();

  const nPaginas = paginas.length;
  let epl = '';
  paginas.forEach((linhas, pi) => {
    let bloco = 'N\nq800\nQ1200,24\n';
    bloco += `A30,24,0,4,1,1,N,"${_eplSafe(titulo + (parcial ? ' - PARCIAL' : ''))}"\n`;
    bloco += `A30,82,0,3,1,1,N,"${sub1}"\n`;
    bloco += `A30,120,0,2,1,1,N,"${dataHora}   Pag ${pi + 1}/${nPaginas}"\n`;
    bloco += 'LO20,150,760,3\n';
    for (const ln of linhas) {
      if (ln.k === 'grupo') {
        bloco += `LO20,${ln.y + 2},760,1\n`;
        bloco += `A30,${ln.y + 10},0,3,1,1,N,"${ln.txt}"\n`;
      } else if (ln.k === 'item') {
        bloco += `A50,${ln.y},0,2,1,1,N,"${ln.txt}"\n`;
      } else if (ln.k === 'subtotal') {
        bloco += `A50,${ln.y},0,3,1,1,N,"${ln.txt}"\n`;
      } else {   // total geral
        bloco += `LO20,${ln.y},760,3\n`;
        bloco += `A30,${ln.y + 12},0,4,1,1,N,"${ln.txt}"\n`;
      }
    }
    bloco += 'P1\n';
    epl += bloco;
  });
  return { epl, nPaginas };
}

function imprimirResumoSessao(s, opts) {
  try {
    const parcial = !!(opts && opts.parcial);
    if (!s || (s.tipo !== 'recebimento' && s.tipo !== 'retorno' && s.tipo !== 'extrusao' && s.tipo !== 'outras' && s.tipo !== 'retirada' && s.tipo !== 'produto-acabado')) return { ok: false, motivo: 'tipo_nao_aplicavel' };
    const itens = db.prepare(
      // Mesma regra do envio ao Bling: no recebimento/retorno, big bag já
      // retirado ('consumida') continua fazendo parte da ENTRADA — some do
      // resumo seria esconder do conferente algo que foi lançado.
      `SELECT * FROM etiquetas WHERE sessao_id = ? AND status IN ${
        sessaoContaConsumida(s.tipo) ? `('bipada','consumida')` : `('bipada')`
      } ORDER BY id`
    ).all(s.id);
    if (!itens.length) return { ok: false, motivo: 'sem_itens_bipados' };   // nada bipado → nada a imprimir

    const dataHora = `${new Date().toLocaleDateString('pt-BR')} ${new Date().toLocaleTimeString('pt-BR').substring(0,5)}`;
    const totalKg  = itens.reduce((a, b) => a + (b.peso || 0), 0);

    const fmtKg = kg => Number(kg || 0).toFixed(1).replace('.', ',') + ' kg';
    // Hora da bipagem (HH:MM, horário local) — em branco se a etiqueta não foi bipada.
    // 'consumida': hora_bipagem passou a ser a da SAÍDA (retirada / sacoleira);
    // a da entrada é a de impressão (mesma regra do resumo do dia).
    const horaBip = it => {
      const h = it.status === 'consumida' ? it.hora_impressao : it.hora_bipagem;
      return h ? new Date(h).toLocaleTimeString('pt-BR', { hour12: false }).slice(0, 5) : '--:--';
    };

    // PRODUTO ACABADO usa um resumo próprio (agrupado por MÁQUINA, consolidando
    // por formato+cor) para espelhar a mensagem do WhatsApp — tratado à parte.
    if (s.tipo === 'produto-acabado') {
      const { epl, nPaginas } = montarResumoProdutoAcabadoEPL(s, itens, dataHora, parcial);
      imprimir(epl, null, (ok, out, err, printer) => {
        if (ok) logI('resumo', `Resumo PA da sessão #${s.id} impresso — ${itens.length} itens, ${nPaginas} pág.`, { printer });
        else    logW('resumo', `Falha ao imprimir resumo PA da sessão #${s.id}`, { erro: err });
      });
      return { ok: true, itens: itens.length, paginas: nPaginas };
    }

    // Agrupa os itens e define como cada item é renderizado:
    //   recebimento → por tipo de material (material + cor)
    //   extrusao    → por máquina (C1 / C2)
    // Com o agrupamento, a coluna do material/máquina sai de cada linha (vai
    // pro cabeçalho do grupo), sobrando espaço pra fonte maior.
    let titulo, sub1, grupos, itemLinha;
    if (s.tipo === 'recebimento' || s.tipo === 'retorno') {
      titulo    = s.tipo === 'retorno' ? 'RESUMO RETORNO' : 'RESUMO RECEBIMENTO';
      sub1      = s.operador
                  ? `Forn: ${_eplSafe(s.fornecedor || '-', 16)}  Resp: ${_eplSafe(s.operador, 12)}`
                  : `Fornecedor: ${_eplSafe(s.fornecedor || '-')}`;
      grupos    = _grupoMP(itens);
      itemLinha = (it, n) => _pad(horaBip(it), 6) + _pad('#' + n, 4) + _pad(it.id, 10) + _padR(fmtKg(it.peso), 12);
    } else if (s.tipo === 'outras') {
      titulo    = 'RESUMO OUTRAS PESAGENS';
      sub1      = s.operador ? `Inventario/Residuos  Resp: ${_eplSafe(s.operador, 14)}` : `Inventario / Residuos`;
      // Um grupo por item (Apara Amarela/Verde/Preta/Branca, Borra, Varredura).
      // TOTAL GERAL soma tudo. (Borra/Varredura vão ao Bling; aparas só aqui.)
      grupos    = _grupoOutras(itens);
      itemLinha = (it, n) => _pad(horaBip(it), 6) + _pad('#' + n, 4) + _pad(it.id, 10) + _padR(fmtKg(it.peso), 12);
    } else if (s.tipo === 'retirada') {
      titulo    = 'RESUMO RETIRADA';
      sub1      = s.operador ? `Saida de estoque  Resp: ${_eplSafe(s.operador, 14)}` : `Saida de estoque · Pedido de Venda`;
      // Agrupa por material + cor (grãos consumidos e aditivos contados).
      // TOTAL GERAL soma tudo. Vai ao Bling como pedido de VENDA.
      // Cada linha: hora da bipagem · fornecedor · nº da pesagem do big bag
      // (ref_id = etiqueta original de recebimento) · peso.
      grupos    = _grupoMP(itens);
      itemLinha = (it, n) => {
        // A etiqueta de retirada nasce no /consumir com hora_impressao = momento
        // da retirada; usa hora_bipagem se existir, senão hora_impressao.
        const h = it.hora_bipagem || it.hora_impressao;
        const hhmm = h ? new Date(h).toLocaleTimeString('pt-BR', { hour12: false }).slice(0, 5) : '--:--';
        return _pad(hhmm, 6) + _pad(it.fornecedor || '-', 15) + _pad(it.ref_id || it.id, 10) + _padR(fmtKg(it.peso), 12);
      };
    } else {
      titulo    = 'RESUMO EXTRUSAO';
      sub1      = `Turno: ${_eplSafe(s.turno_codigo || '-')}  Op: ${_eplSafe(s.operador || '-', 14)}`;
      // Bobinas regulares agrupadas por máquina (C1/C2); capas (sub_tipo='capa')
      // em grupos próprios por tipo de capa. TOTAL GERAL soma tudo.
      const bobinasReg = itens.filter(it => it.sub_tipo !== 'capa');
      const capas      = itens.filter(it => it.sub_tipo === 'capa');
      grupos    = _grupoMaq(bobinasReg).concat(_grupoCapa(capas));
      itemLinha = (it, n) => it.sub_tipo === 'capa'
        ? _pad(horaBip(it), 6) + _pad('#' + n, 4) + _pad('Maq ' + (it.maquina || '-'), 9) + _padR(fmtKg(it.peso), 12)
        : _pad(horaBip(it), 6) + _pad('#' + n, 4) + _pad('L' + (it.largura || '-'), 6) + _pad(it.tipo_bobina, 7) + _pad(it.cor, 8) + _padR(fmtKg(it.peso), 11);
    }

    // Desenho e paginação ficam em montarResumoGenericoEPL — o mesmo layout
    // é reaproveitado pelo RESUMO DO DIA.
    const { epl, nPaginas } = montarResumoGenericoEPL({
      titulo, sub1, dataHora, parcial, grupos, itemLinha,
      totalItens: itens.length, totalKg,
    });

    imprimir(epl, null, (ok, out, err, printer) => {
      if (ok) logI('resumo', `Resumo da sessão #${s.id} (${s.tipo}) impresso — ${itens.length} itens, ${nPaginas} pág.`, { printer });
      else    logW('resumo', `Falha ao imprimir resumo da sessão #${s.id}`, { erro: err });
    });
    return { ok: true, itens: itens.length, paginas: nPaginas };
  } catch (e) {
    logW('resumo', 'Erro ao gerar resumo da sessão', { erro: e && e.message });
    return { ok: false, motivo: 'erro', erro: e && e.message };
  }
}

// ══════════════════════════════════════════════════════════════════
//  RESUMO AUTOMÁTICO  x  RESUMO DO DIA        (decisão de 01/09/2026)
// ------------------------------------------------------------------
//  EXTRUSÃO, RECEBIMENTO de MP e PRODUTO ACABADO seguem imprimindo o
//  resumo ao finalizar. São fechamentos: turno, carga recebida,
//  produção do turno. O papel é o comprovante daquele fechamento e
//  alguém confere com ele na mão.
//
//  RETIRADA de MP, RETORNO de MP e RESÍDUOS (Outras Pesagens) NÃO
//  imprimem mais nada ao finalizar. Ao longo do dia são muitas
//  operações curtas — um papel por operação vira lixo. No lugar, cada
//  uma dessas telas ganhou o botão "Resumo do dia", que imprime de uma
//  vez tudo o que foi pesado naquele dia, somando TODAS as sessões
//  daquele tipo. O efeito é o mesmo, com um papel só.
//
//  Nada foi removido do sistema: o resumo por sessão continua
//  existindo (é o "Relatório atual", enquanto a sessão está aberta) e
//  a lista de tipos que imprimem sozinhos é configurável pela chave
//  resumo_auto_tipos — mudar de ideia não exige mexer no código.
// ══════════════════════════════════════════════════════════════════
const RESUMO_AUTO_PADRAO = 'recebimento,extrusao,produto-acabado';
const RESUMO_DIA_TIPOS   = ['retirada', 'retorno', 'outras'];
const RESUMO_DIA_TITULO  = { retirada: 'RESUMO DO DIA - RETIRADA',
                             retorno:  'RESUMO DO DIA - RETORNO',
                             outras:   'RESUMO DO DIA - RESIDUOS' };

function resumoAutomaticoAtivo(tipo) {
  const lista = String(configGet('resumo_auto_tipos', RESUMO_AUTO_PADRAO) || '')
    .split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  return lista.includes(String(tipo || '').toLowerCase());
}

// Junta tudo o que foi pesado num DIA LOCAL, dentro de um tipo de
// operação, somando TODAS as sessões daquele dia (fechadas ou ainda
// abertas). Não imprime nada — só devolve os números, para a tela poder
// mostrar a prévia antes de gastar etiqueta.
//
// O que define o dia é a hora da PESAGEM, não a hora em que a sessão
// foi aberta ou fechada: uma sessão que atravessa a meia-noite cai,
// corretamente, nos dois dias. Etiqueta já 'consumida' usa a hora de
// impressão, porque nela o campo hora_bipagem passou a marcar a hora da
// RETIRADA — usá-lo jogaria uma entrada antiga para o dia da saída.
function coletarResumoDia(tipo, dia) {
  const { ini, fim } = rangeUTCdoDiaLocal(dia);
  const statusOk = sessaoContaConsumida(tipo)
    ? `('bipada','consumida')`
    : `('bipada')`;
  const QUANDO = `CASE WHEN e.status = 'consumida' THEN e.hora_impressao
                       ELSE COALESCE(e.hora_bipagem, e.hora_impressao) END`;
  const itens = db.prepare(`
    SELECT e.* FROM etiquetas e
      JOIN sessoes s ON s.id = e.sessao_id
     WHERE s.tipo = ?
       AND e.status IN ${statusOk}
       AND ${QUANDO} >= ? AND ${QUANDO} < ?
     ORDER BY ${QUANDO}, e.id`).all(tipo, ini, fim);

  const idsSessao = [...new Set(itens.map(it => it.sessao_id).filter(Boolean))];
  let abertas = 0;
  if (idsSessao.length) {
    const r = db.prepare(
      `SELECT COUNT(*) AS n FROM sessoes WHERE fim IS NULL AND id IN (${idsSessao.map(() => '?').join(',')})`
    ).get(...idsSessao);
    abertas = (r && r.n) || 0;
  }
  const totalKg = itens.reduce((a, b) => a + (b.peso || 0), 0);
  const grupos  = (tipo === 'outras') ? _grupoOutras(itens) : _grupoMP(itens);
  return { itens, grupos, totalKg, sessoes: idsSessao.length, abertas };
}

function imprimirResumoDia(tipo, dia) {
  try {
    tipo = String(tipo || '').toLowerCase();
    if (!RESUMO_DIA_TIPOS.includes(tipo)) return { ok: false, motivo: 'tipo_nao_aplicavel' };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dia || ''))) return { ok: false, motivo: 'data_invalida' };

    const d = coletarResumoDia(tipo, dia);
    if (!d.itens.length) return { ok: false, motivo: 'sem_itens', dia, tipo };

    const [aa, mm, dd] = dia.split('-');
    const diaBR    = `${dd}/${mm}/${aa}`;
    const dataHora = `${new Date().toLocaleDateString('pt-BR')} ${new Date().toLocaleTimeString('pt-BR').substring(0,5)}`;
    const fmtKg    = kg => Number(kg || 0).toFixed(1).replace('.', ',') + ' kg';

    // Cada linha traz a HORA da pesagem — é o que permite conferir o dia
    // inteiro item a item, já que o número da sessão não aparece.
    const hora = it => {
      const h = (it.status === 'consumida') ? it.hora_impressao : (it.hora_bipagem || it.hora_impressao);
      return h ? new Date(h).toLocaleTimeString('pt-BR', { hour12: false }).slice(0, 5) : '--:--';
    };
    const itemLinha = (tipo === 'retirada')
      ? (it, n) => _pad(hora(it), 6) + _pad(it.fornecedor || '-', 15) + _pad(it.ref_id || it.id, 10) + _padR(fmtKg(it.peso), 12)
      : (it, n) => _pad(hora(it), 6) + _pad('#' + n, 4) + _pad(it.id, 10) + _padR(fmtKg(it.peso), 12);

    const sub1 = _eplSafe(
      `Dia ${diaBR}   ${d.sessoes} ${d.sessoes === 1 ? 'operacao' : 'operacoes'}`
      + (d.abertas ? ` (${d.abertas} aberta${d.abertas > 1 ? 's' : ''})` : ''), 46);

    const { epl, nPaginas } = montarResumoGenericoEPL({
      titulo: RESUMO_DIA_TITULO[tipo], sub1, dataHora, parcial: false,
      grupos: d.grupos, itemLinha, totalItens: d.itens.length, totalKg: d.totalKg,
    });

    imprimir(epl, null, (ok, out, err, printer) => {
      if (ok) logI('resumo', `Resumo do DIA ${dia} (${tipo}) impresso — ${d.itens.length} itens de ${d.sessoes} operacao(oes), ${nPaginas} pág.`, { printer });
      else    logW('resumo', `Falha ao imprimir resumo do dia ${dia} (${tipo})`, { erro: err });
    });
    return { ok: true, tipo, dia, itens: d.itens.length, sessoes: d.sessoes,
             abertas: d.abertas, total_kg: Number(d.totalKg.toFixed(3)), paginas: nPaginas };
  } catch (e) {
    logW('resumo', 'Erro ao gerar resumo do dia', { erro: e && e.message });
    return { ok: false, motivo: 'erro', erro: e && e.message };
  }
}

function imprimir(eplString, printerOverride, callback) {
  const printer = printerOverride || PRINTER_ATIVA;

  // ── Modo simulação de impressão ──
  // Ativo se config print_simular='1' OU se nenhuma impressora foi detectada
  // (auto-fallback pra que testes/demos rodem sem Zebra física).
  // Em ambos os casos: pula PowerShell e retorna sucesso imediato,
  // gravando o EPL gerado em logs/print-simulado/ pra auditoria.
  const simExplicito = PRINT_SIMULAR_ENV || configGet('print_simular', '0') === '1';
  const simAutomatico = !PRINTER_DETECTADA;
  if (simExplicito || simAutomatico) {
    try {
      const dir = path.join(LOG_DIR, 'print-simulado');
      ensureDir(dir);
      const fpath = path.join(dir, `etq_${Date.now()}_${Math.random().toString(36).slice(2,8)}.epl`);
      fs.writeFileSync(fpath, eplString, 'latin1');
      const motivo = simExplicito ? 'config print_simular=1' : 'sem impressora detectada';
      logI('print', `SIMULADA (${motivo}) — EPL salvo em ${path.basename(fpath)}`);
    } catch(e) {
      logW('print', `Falha ao gravar EPL simulado: ${e.message}`);
    }
    // Pequeno delay pra emular tempo de impressão (~50ms)
    return setTimeout(() => callback(true, 'SIMULADO', '', printer || 'SIMULADA'), 50);
  }

  // ── Impressão real (PowerShell + Zebra) ──
  const tempFile = path.join(os.tmpdir(), `mp_etq_${Date.now()}.epl`);
  try { fs.writeFileSync(tempFile, eplString, 'latin1'); }
  catch(e) { return callback(false, '', 'Erro tmpfile: ' + e.message, printer); }
  let done = false;
  const finish = (ok, out, err) => {
    if (done) return; done = true;
    try { fs.unlinkSync(tempFile); } catch(e) {}
    callback(ok, out, err, printer);
  };
  const ps = spawn('powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-File', PS_SCRIPT, '-EplFile', tempFile, '-PrinterName', printer], { windowsHide: true });
  let stdout = '', stderr = '';
  ps.stdout.on('data', d => stdout += d.toString());
  ps.stderr.on('data', d => stderr += d.toString());
  ps.on('close', code => finish(code === 0, stdout, stderr));
  ps.on('error', e => finish(false, stdout, 'Spawn error: ' + e.message));
}

module.exports = { _grupoMP, _grupoOutras, coletarResumoDia, detectarImpressora,
  garantirScriptImpressao, gerarEPL, gerarEPLGaiolaPA, imprimir, imprimirResumoDia,
  imprimirResumoSessao, PRINT_SIMULAR_ENV, RESUMO_AUTO_PADRAO, RESUMO_DIA_TIPOS,
  resumoAutomaticoAtivo, };
Object.defineProperty(module.exports, 'PRINTER_ATIVA', { enumerable: true, get: () => PRINTER_ATIVA, set: v => { PRINTER_ATIVA = v; } });
Object.defineProperty(module.exports, 'PRINTER_DETECTADA', { enumerable: true, get: () => PRINTER_DETECTADA, set: v => { PRINTER_DETECTADA = v; } });
