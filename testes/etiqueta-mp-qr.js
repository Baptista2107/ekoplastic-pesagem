// ════════════════════════════════════════════════════════════════════
//  ETIQUETA DE MP COM QR  (25/11/2026, desenho do Gustavo)
//  ------------------------------------------------------------------
//  Recebimento (R) e retorno (T): material, fornecedor, lote e etiqueta à
//  esquerda; peso à direita; QR grande no meio; data/hora no rodapé. Sem
//  código para extrusão, sem SKU, sem "PESAGEM #N", sem código de barras.
//
//  O que este teste prova (só o gerador do EPL, sem servidor):
//   1. o QR leva SÓ o número da etiqueta (o mesmo texto do código de barras
//      antigo), e não há mais código de barras nem os campos que saíram
//   2. R no recebimento, T no retorno (com "RETORNO" no topo), VARREDURA
//      continua aparecendo
//   3. nada passa da coluna esquerda, do divisor, da largura ou do rodapé —
//      nem com material/fornecedor enormes
//   4. o QR fica entre a linha de baixo do topo e o rodapé, sem encostar
//   5. a etiqueta de bobina (extrusão) não mudou: segue com código de barras
// ════════════════════════════════════════════════════════════════════
const path = require('node:path');
const os   = require('node:os');

// Banco temporário: carregar lib/impressao abre o config (e o banco).
process.env.EKO_DB_FILE = path.join(os.tmpdir(), `eko_etq_mp_${Date.now()}.db`);
process.env.EKO_LOG_DIR = path.join(os.tmpdir(), `eko_etq_mp_${Date.now()}`);
process.env.EKO_PRINT_SIMULAR = '1';

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
    } else if (/^B\d/.test(l)) barras.push(l);
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
  ok(e.barras.length === 0, 'sem código de barras', e.barras);
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
  ok(q && linhaQR && q.y > linhaQR[1] + 3 && q.y + q.lado < rodape.y - 8, `${nome}: QR entre a linha do topo e o rodapé`,
     { q, linhaQR, rodape: rodape && rodape.y });
  ok(q && q.x >= 16 && q.x + q.lado <= LARG - 16, `${nome}: QR dentro da largura`, q);
  ok(q && q.s >= 15, `${nome}: QR grande (módulo ≥ 15 dots ≈ 1,9 mm)`, q && q.s);
  ok(topo.every(x => x.y < linhaQR[1]), `${nome}: textos do topo acima da linha do QR`);
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
