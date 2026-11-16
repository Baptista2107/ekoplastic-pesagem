// ════════════════════════════════════════════════════════════════════
//  TESTE RODA ATRÁS DA PRODUÇÃO (16/11/2026, VPS)
//  O rodar-todos.js baixa a própria prioridade (CPU nice 19, disco ionice
//  best-effort 7) e cada arquivo de teste é filho dele. Aqui se confere
//  neste processo e num filho dele (o server.js e o Chrome herdam igual).
//  Só vale rodando pelo rodar-todos.js (npm test, pre-push) no Linux;
//  chamado sozinho ou no Windows, pula.
//
//  Como rodar:   node testes/rodar-todos.js
// ════════════════════════════════════════════════════════════════════

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');

function cmdlineDoPai() {
  try { return fs.readFileSync(`/proc/${process.ppid}/cmdline`, 'utf8').split('\0'); }
  catch { return []; }
}

if (process.platform !== 'linux' || !cmdlineDoPai().some(a => a.endsWith('rodar-todos.js'))) {
  console.log('  - pulado: só confere rodando pelo rodar-todos.js no Linux');
  process.exit(0);
}

let falhou = 0;
function ok(cond, nome, detalhe = '') {
  if (cond) console.log(`  \x1b[32m✓\x1b[0m ${nome}`);
  else { falhou++; console.log(`  \x1b[31m✗ ${nome}\x1b[0m ${detalhe}`); }
}

const nice = os.getPriority();
ok(nice === 19, 'processo de teste com nice 19', `(veio ${nice})`);

const disco = spawnSync('ionice', ['-p', String(process.pid)], { encoding: 'utf8', timeout: 10000 });
const temIonice = !disco.error;
const io = (disco.stdout || '').trim();
if (temIonice) ok(io === 'best-effort: prio 7' || io === 'idle', 'processo de teste com disco best-effort 7 (ou idle)', `(veio "${io}")`);
else console.log('  - pulado: sem o binário ionice nesta máquina (disco)');

const filho = spawnSync(process.execPath, ['-e', 'console.log(require("node:os").getPriority())'],
  { encoding: 'utf8', timeout: 30000 });
const niceFilho = (filho.stdout || '').trim();
ok(niceFilho === '19', 'filho do teste herda nice 19', `(veio "${niceFilho}")`);

if (temIonice) {
  const ioFilho = (spawnSync('ionice', [], { encoding: 'utf8', timeout: 10000 }).stdout || '').trim();
  ok(ioFilho === 'best-effort: prio 7' || ioFilho === 'idle', 'filho do teste herda o disco baixo', `(veio "${ioFilho}")`);
}

process.exit(falhou ? 1 : 0);
