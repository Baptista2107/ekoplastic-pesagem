// ════════════════════════════════════════════════════════════════════
//  ETIQUETA DE MP COM QR  (25/11/2026, desenho do Gustavo)
//  ------------------------------------------------------------------
//  Recebimento (R) e retorno (T): material, fornecedor, lote e etiqueta à
//  esquerda; peso à direita; QR grande no meio; código de barras PEQUENO
//  embaixo do QR (o leitor da mesa do Mini PC não lê QR — Gustavo, mesmo
//  dia); data/hora no rodapé. Sem código para extrusão, SKU e "PESAGEM #N".
//
//  O que este teste prova (só o gerador do EPL, sem servidor):
//   1. o QR e o código de barras levam SÓ o número da etiqueta (o mesmo
//      texto das barras antigas), e os campos que saíram não voltam
//   2. R no recebimento, T no retorno (com "RETORNO" no topo), VARREDURA
//      continua aparecendo
//   3. nada passa da coluna esquerda, do divisor, da largura ou do rodapé —
//      nem com material/fornecedor enormes
//   4. o QR fica entre a linha de baixo do topo e as barras, com a margem
//      livre de 4 módulos; as barras ficam entre o QR e a data
//   5. a etiqueta de bobina (extrusão) não mudou: segue com código de barras
// ════════════════════════════════════════════════════════════════════
const path = require('node:path');
const os   = require('node:os');

const fs   = require('node:fs');

// Banco temporário: carregar lib/impressao abre o config (e o banco). Tudo
// numa pasta só, apagada no fim (o /tmp da VPS já encheu de lixo de teste).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'eko_etq_mp_'));
process.env.EKO_DB_FILE = path.join(TMP, 'etiquetas.db');
process.env.EKO_LOG_DIR = path.join(TMP, 'logs');
process.env.EKO_PRINT_SIMULAR = '1';
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

const { gerarEPL } = require(path.join(__dirname, '..', 'lib', 'impressao'));

let passou = 0, falhou = 0;
function ok(cond, msg, extra) {
  if (cond) { passou++; console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
  else { falhou++; console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
         if (extra !== undefined) console.log('      →', JSON.stringify(extra).slice(0, 400)); }
}

const LARG = 800, ALT = 1200, DIVISOR_X = 520;
const LARG_FONTE = { 1: 8, 2: 10, 3: 12, 4: 14, 5: 32 };
const ALT_FONTE  = { 1: 12, 2: 16, 3: 20, 4: 24, 5: 48 };

// Lê os comandos A (texto), b (QR), B (barras) e LO (linha) do EPL.
function ler(epl) {
  const textos = [], qrs = [], barras = [], linhas = [];
  for (const l of epl.split('\n')) {
    let m;
    if ((m = l.match(/^A(\d+),(\d+),0,(\d),(\d+),(\d+),N,"(.*)"$/))) {
      const [x, y, f, mh, mv] = m.slice(1, 6).map(Number);
      textos.push({ x, y, txt: m[6], fim_x: x + m[6].length * LARG_FONTE[f] * mh, fim_y: y + ALT_FONTE[f] * mv });
    } else if ((m = l.match(/^b(\d+),(\d+),Q,m2,s(\d+),"(.*)"$/))) {
      const [x, y, s] = m.slice(1, 4).map(Number);
      qrs.push({ x, y, s, dado: m[4], lado: 21 * s });
    } else if ((m = l.match(/^B(\d+),(\d+),0,1,(\d+),(\d+),(\d+),N,"(.*)"$/))) {
      const [x, y, estreita, larga, alt] = m.slice(1, 6).map(Number);
      // Code 128 B, pior caso: 11 módulos por caractere + início, checagem e fim.
      barras.push({ x, y, estreita, larga, alt, dado: m[6], fim_x: x + (11 * (m[6].length + 3) + 2) * estreita });
    } else if (/^B\d/.test(l)) barras.push({ cru: l });
    else if ((m = l.match(/^LO(\d+),(\d+),(\d+),(\d+)$/))) linhas.push(m.slice(1, 5).map(Number));
  }
  return { textos, qrs, barras, linhas };
}

const BASE = { tipo: 'recebimento', seq: 1256, cor: 'colorido', materialNomeEt: 'Baixa Densidade',
  fornecedor: 'Piquiri', lote: '250826', peso: 1083.5, codigo: 'COL3', sku: 'GBD.COL.PIQUIRI', seq_sessao: 3 };

console.log('\n1. QR com o número da etiqueta; o que saiu não volta');
{
  const epl = gerarEPL(BASE), e = ler(epl);
  ok(e.qrs.length === 1 && e.qrs[0].dado === 'R0001256', 'um QR só, com R0001256', e.qrs);
  ok(e.barras.length === 1 && e.barras[0].dado === 'R0001256', 'um código de barras só, com R0001256', e.barras);
  ok(e.barras[0] && e.barras[0].estreita === 3 && e.barras[0].alt <= 90, 'código de barras PEQUENO (barra 3 dots, ≤ 90 de altura)', e.barras[0]);
  ok(!/CODIGO PARA EXTRUSAO/.test(epl) && !/"COL3"/.test(epl), 'sem o código para extrusão');
  ok(!/GBD\.COL\.PIQUIRI/.test(epl), 'sem o SKU');
  ok(!/PESAGEM #/.test(epl), 'sem o selo PESAGEM #N');
  for (const t of ['COLORIDO - BAIXA DENSIDADE', 'FORNECEDOR: PIQUIRI', 'LOTE: 250826', 'ETIQUETA: R0001256', '1083.5', 'KG'])
    ok(e.textos.some(x => x.txt === t), `tem "${t}"`, e.textos.map(x => x.txt));
  ok(e.textos.some(x => /^DATA \/ HORA: \d{2}\/\d{2}\/\d{4}  \d{2}:\d{2}$/.test(x.txt)), 'tem a data/hora no rodapé');
  const peso = e.textos.find(x => x.txt === '1083.5');
  ok(peso && peso.x > DIVISOR_X, 'peso fica à direita do divisor', peso);
}

console.log('\n2. retorno (T) e varredura');
{
  const t = ler(gerarEPL({ ...BASE, tipo: 'retorno', seq: 121 }));
  ok(t.qrs[0] && t.qrs[0].dado === 'T0000121', 'retorno: QR com T0000121', t.qrs);
  ok(t.textos[0] && t.textos[0].txt === 'RETORNO', 'retorno: "RETORNO" na 1ª linha', t.textos[0]);
  const v = ler(gerarEPL({ ...BASE, sub_tipo: 'varredura' }));
  ok(v.textos.some(x => x.txt === 'VARREDURA'), 'varredura continua marcada');
}

console.log('\n3 e 4. tudo dentro da etiqueta, inclusive com texto enorme');
const CASOS = [
  ['normal', BASE],
  ['material e fornecedor enormes', { ...BASE,
    materialNomeEt: 'Polietileno de Baixa Densidade Linear Reciclado Pós-Consumo Lavado e Granulado Extra',
    fornecedor: 'Piquiri Reciclagem e Comércio de Materiais Plásticos e Derivados do Paraná Ltda ME',
    lote: 'LOTE-2025-08-26-PRODUCAO-NOTURNA-TURNO-C-CAMINHAO-2', cor: 'colorido', peso: 99999.9 }],
  ['o máximo: retorno com tudo enorme (9 linhas)', { ...BASE, tipo: 'retorno', seq: 77,
    materialNomeEt: 'Polietileno de Baixa Densidade Linear Reciclado Pós-Consumo Lavado e Granulado Extra',
    fornecedor: 'Piquiri Reciclagem e Comércio de Materiais Plásticos e Derivados do Paraná Ltda ME',
    lote: 'LOTE-2025-08-26-PRODUCAO-NOTURNA-TURNO-C-CAMINHAO-2' }],
  ['palavra sem espaço maior que a linha', { ...BASE, materialNomeEt: 'X'.repeat(80), fornecedor: 'Y'.repeat(60) }],
  ['peso pequeno, retorno', { ...BASE, tipo: 'retorno', seq: 1, peso: 0.5 }],
];
for (const [nome, dados] of CASOS) {
  const e = ler(gerarEPL(dados));
  const esq = e.textos.filter(x => x.x < DIVISOR_X);
  const rodape = e.textos.find(x => x.txt.startsWith('DATA / HORA'));
  const topo = esq.filter(x => x !== rodape);
  ok(topo.every(x => x.fim_x < DIVISOR_X - 4), `${nome}: coluna esquerda não passa do divisor`,
     topo.filter(x => x.fim_x >= DIVISOR_X - 4));
  ok(e.textos.every(x => x.fim_x <= LARG - 16 && x.fim_y <= ALT - 8), `${nome}: nenhum texto sai da etiqueta`,
     e.textos.filter(x => x.fim_x > LARG - 16 || x.fim_y > ALT - 8));
  const q = e.qrs[0];
  const linhaQR = e.linhas.find(l => l[3] === 3 && l[2] > 600);      // a linha horizontal
  const b = e.barras[0];
  ok(q && linhaQR && b && q.y > linhaQR[1] + 3 && q.y + q.lado < b.y, `${nome}: QR entre a linha do topo e as barras`,
     { q, linhaQR, barras: b });
  ok(b && b.dado === q.dado && b.x >= 16 && b.fim_x <= LARG - 16 && b.y + b.alt < rodape.y - 8,
     `${nome}: barras com o mesmo número, dentro da largura e acima da data`, { b, rodape: rodape && rodape.y });
  ok(q && q.x >= 16 && q.x + q.lado <= LARG - 16, `${nome}: QR dentro da largura`, q);
  ok(q && q.s >= 15, `${nome}: QR grande (módulo ≥ 15 dots ≈ 1,9 mm)`, q && q.s);
  ok(topo.every(x => x.y < linhaQR[1]), `${nome}: textos do topo acima da linha do QR`);
  // Zona de silêncio: 4 módulos livres entre o QR e a linha de cima / as barras.
  ok(q && linhaQR && b && q.y - (linhaQR[1] + 3) >= 4 * q.s && b.y - (q.y + q.lado) >= 4 * q.s,
     `${nome}: 4 módulos livres em cima e embaixo do QR`,
     q && b && { acima: q.y - (linhaQR[1] + 3), abaixo: b.y - (q.y + q.lado), quatro_modulos: 4 * q.s });
  const loteL = e.textos.filter(x => x.txt.startsWith('LOTE:'));
  ok(loteL.length === 1 && loteL[0].txt.length <= 33, `${nome}: lote numa linha só, sem passar de 33 caracteres`, loteL.map(x => x.txt));
  ok(q && /^[RT]\d{7}$/.test(q.dado), `${nome}: QR com o formato que os leitores aceitam`, q && q.dado);
}

console.log('\n6. texto que quebraria o EPL e campos vazios');
{
  const epl = gerarEPL({ ...BASE, tipo: 'retorno', fornecedor: 'ACME \\"LTDA\\', lote: 'L\\1"2\\' });
  const cmdsA = epl.split('\n').filter(l => l.startsWith('A'));
  ok(cmdsA.every(l => /^A\d+,\d+,0,\d,\d+,\d+,N,"[^"\\]*"$/.test(l)),
     'nenhum texto com " ou \\ dentro (o comando A sempre fecha)', cmdsA.filter(l => !/^A\d+,\d+,0,\d,\d+,\d+,N,"[^"\\]*"$/.test(l)));
  let e2, erro = null;
  try { e2 = ler(gerarEPL({ ...BASE, fornecedor: null, lote: undefined, cor: '' })); } catch (x) { erro = x.message; }
  ok(!erro && e2.textos.some(x => x.txt === 'FORNECEDOR:') && e2.textos.some(x => x.txt === 'LOTE:'),
     'fornecedor/lote vazios não derrubam a impressão (a antiga dava TypeError)', erro || e2.textos.map(x => x.txt));
}

console.log('\n5. etiqueta de bobina não mudou');
{
  const epl = gerarEPL({ tipo: 'extrusao', seq: 2657, cor: 'BRANCA', tipo_bobina: 'REFORCADA', largura: 60,
    operador: 'DAVI', maquina: 'C2', turno: 'A', peso: 379, sku: 'BOB.BC.REF.1,60', codigo: 'BOB.BC.REF.1,60',
    fornecedor: 'EXT-A1', lote: 'EXT-A1' });
  ok(/^B\d+,\d+,0,1,\d+,\d+,\d+,N,"E0002657"$/m.test(epl), 'bobina segue com código de barras E0002657');
}

console.log(`\n${passou} passaram, ${falhou} falharam`);
process.exit(falhou ? 1 : 0);
