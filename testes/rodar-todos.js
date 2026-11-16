// ════════════════════════════════════════════════════════════════════
//  RODA TODOS OS TESTES — portão do ENVIAR-ATUALIZACAO.bat e do npm test
//  Cada arquivo testes/<nome>.js (menos os _auxiliares) sobe o server.js
//  real com banco temporário, Bling e impressão simulados. Roda um por vez
//  (portas de teste fixas) e mostra a saída de cada um.
//
//  Como rodar:   node testes/rodar-todos.js
//  Saída:        código 0 se todos passaram, 1 se algum falhou
// ════════════════════════════════════════════════════════════════════

const { spawnSync } = require('node:child_process');
const fs   = require('node:fs');
const path = require('node:path');
const aprovados = require('./_aprovados');   // marca "já passou nesta árvore" (16/11/2026)

const arquivos = fs.readdirSync(__dirname)
  .filter(f => f.endsWith('.js') && !f.startsWith('_') && f !== path.basename(__filename))
  .sort((a, b) => (a === 'piso-testes.js' ? -1 : b === 'piso-testes.js' ? 1 : a.localeCompare(b)));

// Fotografia da pasta ANTES de rodar: a marca só vale se a pasta estava limpa
// e continua igual no fim (ver testes/_aprovados.js).
aprovados.limparVencidas();
const inicio = aprovados.estado();

const falhas = [];
for (const f of arquivos) {
  console.log(`\n▶ ${f}`);
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit', timeout: 5 * 60 * 1000 });
  if (r.status !== 0) falhas.push(`${f} (código ${r.status === null ? 'tempo esgotado' : r.status})`);
}

console.log('\n═══════════════════════════════════════════════════');
console.log(` ${arquivos.length - falhas.length} de ${arquivos.length} arquivos de teste passaram`);
for (const f of falhas) console.log(`   ✗ ${f}`);
if (!falhas.length) {
  if (aprovados.gravar(inicio, aprovados.estado()))
    console.log(' marca de aprovado gravada para esta árvore (o pre-push não repete por 24 h)');
  else if (inicio)
    console.log(' pasta com arquivo não commitado (ou mudou durante a suíte): marca de aprovado NÃO gravada');
}
console.log('═══════════════════════════════════════════════════');
process.exit(falhas.length ? 1 : 0);
