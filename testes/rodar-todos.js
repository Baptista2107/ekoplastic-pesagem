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
const os   = require('node:os');

// 16/11/2026 (VPS): teste roda ATRÁS da produção — CPU nice 19 e disco ionice
// best-effort 7. Na VPS a carga passou de 6-10 à tarde com 3 suítes juntas e
// a produção (extrusao_viva, painel, crons, nice 0) disputava núcleo com teste.
// Os arquivos de teste, o server.js que cada um sobe e o Chrome dos testes de
// navegador são filhos deste processo e herdam. Disco best-effort 7, não idle
// (idle deixou a suíte do bling-claude atrás dos crons por mais de 10 min).
// Só Linux: no Mini PC (Windows) nada muda. Prova: testes/prioridade-baixa.js.
if (process.platform === 'linux') {
  try { os.setPriority(19); } catch { /* sem permissão: segue na prioridade atual */ }
  spawnSync('ionice', ['-c2', '-n7', '-p', String(process.pid)], { stdio: 'ignore', timeout: 10000 });
}

const arquivos = fs.readdirSync(__dirname)
  .filter(f => f.endsWith('.js') && !f.startsWith('_') && f !== path.basename(__filename))
  .sort((a, b) => (a === 'piso-testes.js' ? -1 : b === 'piso-testes.js' ? 1 : a.localeCompare(b)));

const falhas = [];
for (const f of arquivos) {
  console.log(`\n▶ ${f}`);
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit', timeout: 5 * 60 * 1000 });
  if (r.status !== 0) falhas.push(`${f} (código ${r.status === null ? 'tempo esgotado' : r.status})`);
}

console.log('\n═══════════════════════════════════════════════════');
console.log(` ${arquivos.length - falhas.length} de ${arquivos.length} arquivos de teste passaram`);
for (const f of falhas) console.log(`   ✗ ${f}`);
console.log('═══════════════════════════════════════════════════');
process.exit(falhas.length ? 1 : 0);
