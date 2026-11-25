// ════════════════════════════════════════════════════════════════════
//  TROCA DAS ETIQUETAS DE MP (25/11/2026) — lógica de lib/troca-etiquetas.js
//   1. entram só R/T no galpão (bipada); consumida, cancelada, bobina e S ficam fora
//   2. separado por fornecedor, sem diferença de maiúscula/acento/espaço
//   3. ordem: fornecedor; dentro, material, cor, lote, número
//   4. etiqueta de separação: nome, quantidade, kg, grupo i de n; EPL que fecha
// ════════════════════════════════════════════════════════════════════
const path = require('node:path');
const { etiquetasDaTroca, agruparPorFornecedor, eplSeparador } = require(path.join(__dirname, '..', 'lib', 'troca-etiquetas'));

let passou = 0, falhou = 0;
function ok(cond, msg, extra) {
  if (cond) { passou++; console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
  else { falhou++; console.log(`  \x1b[31m✗\x1b[0m ${msg}`); if (extra !== undefined) console.log('      →', JSON.stringify(extra).slice(0, 400)); }
}

const E = (id, o = {}) => ({ id, tipo: id[0] === 'T' ? 'retorno' : 'recebimento', status: 'bipada',
  fornecedor: 'Piquiri', material_nome: 'BAIXA DENSIDADE', cor: 'Canela', lote: '1', peso: 1000, ...o });
const base = [
  E('R0000010', { fornecedor: 'piquiri ', cor: 'Preto' }),
  E('R0000003', { fornecedor: 'PIQUIRI', lote: '2' }),
  E('R0000002', { fornecedor: 'Piquirí' }),
  E('T0000005', { fornecedor: 'Tallpack', material_nome: 'POLINYLON', peso: 450.5 }),
  E('R0000007', { fornecedor: 'Karina', material_nome: 'DESSECANTE', peso: 25 }),
  E('R0000001', { fornecedor: 'Karina', material_nome: 'CARBONATO' }),
  E('R0000020', { status: 'consumida' }),
  E('R0000021', { status: 'cancelada' }),
  { id: 'E0002600', tipo: 'extrusao', status: 'bipada', fornecedor: 'EXT-C2' },
  { id: 'S0001300', tipo: 'retirada', status: 'bipada', fornecedor: 'Piquiri' },
  E('R12', {}),                                  // número fora do formato
];

console.log('\n1. quem entra');
const entra = etiquetasDaTroca(base).map(e => e.id).sort();
ok(JSON.stringify(entra) === JSON.stringify(['R0000001', 'R0000002', 'R0000003', 'R0000007', 'R0000010', 'T0000005']),
   'só R/T bipadas com número certo', entra);

console.log('\n2 e 3. grupos e ordem');
const g = agruparPorFornecedor(base);
ok(JSON.stringify(g.map(x => x.fornecedor)) === JSON.stringify(['KARINA', 'PIQUIRI', 'TALLPACK']),
   'um grupo por fornecedor, em ordem alfabética, "piquiri "/"PIQUIRI"/"Piquirí" juntos', g.map(x => x.fornecedor));
ok(JSON.stringify(g[0].itens.map(e => e.id)) === JSON.stringify(['R0000001', 'R0000007']), 'Karina: CARBONATO antes de DESSECANTE', g[0].itens.map(e => e.id));
ok(JSON.stringify(g[1].itens.map(e => e.id)) === JSON.stringify(['R0000002', 'R0000003', 'R0000010']),
   'Piquiri: Canela lote 1, Canela lote 2, depois Preto', g[1].itens.map(e => e.id));
ok(g[2].kg === 450.5 && g[1].kg === 3000, 'kg somado por grupo', g.map(x => x.kg));
ok(agruparPorFornecedor([E('R0000001', { fornecedor: null })])[0].fornecedor === '(SEM FORNECEDOR)', 'sem fornecedor vira grupo próprio');

console.log('\n4. etiqueta de separação');
const epl = eplSeparador(g[1], 2, 3);
ok(/"PIQUIRI"/.test(epl) && /"3 ETIQUETAS"/.test(epl) && /"3\.000 KG"/.test(epl) && /"GRUPO 2 DE 3"/.test(epl),
   'nome, quantidade, kg e grupo', epl);
ok(/"R0000002 ATE R0000010"/.test(epl), 'faixa de números do grupo');
const sep2 = eplSeparador({ fornecedor: 'ACME "X" \\ LTDA COMERCIO DE PLASTICOS RECICLADOS DO BRASIL', itens: [E('R0000001')], kg: 1 }, 1, 1);
const cmdsA = sep2.split('\n').filter(l => l.startsWith('A'));
ok(cmdsA.every(l => /^A\d+,\d+,0,\d,\d,\d,N,"[^"\\]*"$/.test(l)), 'aspas e barra não quebram o EPL', cmdsA);
ok(/"1 ETIQUETA"/.test(sep2), 'singular com 1 etiqueta');
ok(cmdsA.every(l => { const m = l.match(/^A(\d+),\d+,0,4,(\d),\d,N,"(.*)"$/); return !m || Number(m[1]) + m[3].length * 14 * Number(m[2]) <= 784; }),
   'nenhuma linha passa da largura', cmdsA);

console.log(`\n RESULTADO: ${passou} passaram, ${falhou} falharam`);
process.exit(falhou ? 1 : 0);
