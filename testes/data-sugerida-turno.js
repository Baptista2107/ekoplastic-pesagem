// ════════════════════════════════════════════════════════════════════
//  DATA SUGERIDA DO TURNO — Produto Acabado (13/11/2026)
//  Vinicius: o turno EXTRA é lançado no dia seguinte, igual ao C; a data
//  sugerida dos dois é a de ONTEM. Turno A continua com a data de hoje.
//
//  Lê dataSugerida()/ymdLocal() direto de public/produto-acabado.html e
//  roda com o relógio fixo (vm + Date falso), sem servidor nem navegador.
//
//  Como rodar:   node testes/data-sugerida-turno.js
// ════════════════════════════════════════════════════════════════════

const fs     = require('node:fs');
const path   = require('node:path');
const vm     = require('node:vm');
const assert = require('node:assert');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'produto-acabado.html'), 'utf8');

function extrair(nome) {
  const ini = html.indexOf(`function ${nome}(`);
  assert.ok(ini >= 0, `função ${nome} não encontrada no HTML`);
  // corpo até a primeira linha "}" na coluna 0
  const fim = html.indexOf('\n}', ini);
  return html.slice(ini, fim + 2);
}
const codigo = extrair('ymdLocal') + '\n' + extrair('dataSugerida');

function sugerir(agoraIso, turno) {
  const Real = Date;
  class DateFixo extends Real {
    constructor(...a) { if (a.length) super(...a); else super(agoraIso); }
  }
  const ctx = { Date: DateFixo };
  vm.createContext(ctx);
  vm.runInContext(codigo, ctx);
  return vm.runInContext(`dataSugerida(${JSON.stringify(turno)})`, ctx);
}

let falhas = 0;
function caso(desc, fn) {
  try { fn(); console.log(`  ✓ ${desc}`); }
  catch (e) { falhas++; console.log(`  ✗ ${desc}\n      ${e.message}`); }
}

// Madrugada de 14/11 (lançamento do C / EXTRA que começou em 13/11)
const MADRUGADA = '2026-11-14T02:30:00';
caso('turno A sugere hoje',            () => assert.strictEqual(sugerir(MADRUGADA, 'A'), '2026-11-14'));
caso('turno C sugere ontem',           () => assert.strictEqual(sugerir(MADRUGADA, 'C'), '2026-11-13'));
caso('turno EXTRA sugere ontem (= C)', () => assert.strictEqual(sugerir(MADRUGADA, 'EXTRA'), '2026-11-13'));
// Virada de mês: lançado em 01/12 → data 30/11
caso('EXTRA na virada do mês',         () => assert.strictEqual(sugerir('2026-12-01T01:00:00', 'EXTRA'), '2026-11-30'));
caso('C na virada do ano',             () => assert.strictEqual(sugerir('2027-01-01T01:00:00', 'C'), '2026-12-31'));

console.log(falhas ? `\n${falhas} falha(s)` : '\ntodos passaram');
process.exit(falhas ? 1 : 0);
