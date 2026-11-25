// ════════════════════════════════════════════════════════════════════
//  ETIQUETA "O" (OUTRAS PESAGENS) LEVA A DATA DA PESAGEM  (25/11/2026)
//  Revisor do merge main→bobina-alta-densidade: gerarEPLOutras usava
//  new Date() sem fuso. Reimprimir uma bobina AD (ou borra) pesada ontem
//  saía com a data de hoje, e numa máquina em UTC a hora vinha +3 h.
//  A etiqueta de MP já levava hora_impressao em hora de Brasília (1dbc9f3).
//
//   A) bobina AD reimpressa: "PESADA EM" = data/hora gravada, em Brasília
//   B) resíduo (borra) reimpresso: "DATA / HORA DA PESAGEM" idem
//   C) etiqueta nova (sem hora_impressao): data de hoje em Brasília
//
//  Roda sem servidor, com o processo em TZ=UTC de propósito.
//  Como rodar:   node testes/outras-data-pesagem.js
// ════════════════════════════════════════════════════════════════════
process.env.TZ = 'UTC';
const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');
const TMP  = fs.mkdtempSync(path.join(os.tmpdir(), 'eko_outras_data_'));
process.env.EKO_DB_FILE = path.join(TMP, 'etiquetas.db');
process.env.EKO_LOG_DIR = path.join(TMP, 'logs');
process.env.EKO_PRINT_SIMULAR = '1';
process.env.EKO_TOKEN_FILE = path.join(TMP, 'bling_tokens.json');

let passou = 0, falhou = 0;
function ok(cond, nome, detalhe) {
  if (cond) { passou++; console.log(`  \x1b[32m✓\x1b[0m ${nome}`); }
  else { falhou++; console.log(`  \x1b[31m✗ ${nome}\x1b[0m`, detalhe === undefined ? '' : JSON.stringify(detalhe).slice(0, 400)); }
}

const { gerarEPL } = require('../lib/impressao');
const { dadosReimpressao } = require('../lib/negocio');

// 24/11/2026 23:30 UTC = 24/11/2026 20:30 em Brasília
const PESADA = '2026-11-24T23:30:00.000Z';
const base = { tipo: 'outras', seq: 100087, seq_sessao: 1, status: 'consumida', hora_impressao: PESADA };

try {
  console.log('\nA) bobina AD reimpressa');
  const epl = gerarEPL(dadosReimpressao({ ...base, sku: 'BOB.VER.1,52', material_nome: 'Bobina AD Verde 1,52',
    cor: 'Verde', peso: 500 }));
  ok(epl.includes('"PESADA EM 24/11/2026  20:30"'), 'PESADA EM 24/11/2026 20:30 (data e hora de Brasília)',
     (epl.match(/"PESADA EM [^"]*"/) || [])[0]);
  ok(epl.includes('SACOLA 38 X 48 - MILHEIRO'), 'continua com SACOLA 38 X 48 - MILHEIRO');

  console.log('\nB) borra reimpressa');
  const eplB = gerarEPL(dadosReimpressao({ ...base, seq: 100090, sku: 'RES.BORRA', material_nome: 'Borra', peso: 42 }));
  ok(eplB.includes('"24/11/2026  20:30"'), 'DATA / HORA DA PESAGEM = 24/11/2026 20:30',
     (eplB.match(/"\d\d\/\d\d\/\d{4}  \d\d:\d\d"/) || [])[0]);

  console.log('\nC) etiqueta nova: hoje em Brasília');
  const BR = { timeZone: 'America/Sao_Paulo' };
  const hoje = new Date().toLocaleDateString('pt-BR', BR);
  const eplC = gerarEPL({ tipo: 'outras', seq: 100091, seq_sessao: 2, sku: 'BOB.PT.1,16',
    materialNomeEt: 'Bobina AD Preta 1,16', cor: 'Preta', peso: 400 });
  ok(eplC.includes(`"PESADA EM ${hoje}  `), `PESADA EM ${hoje}`, (eplC.match(/"PESADA EM [^"]*"/) || [])[0]);
} catch (e) {
  falhou++; console.log('  \x1b[31m✗ erro\x1b[0m', e && e.stack);
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
}
console.log(`\n${passou} ok, ${falhou} falha(s)`);
process.exit(falhou ? 1 : 0);
