// ════════════════════════════════════════════════════════════════════
//  commitAtual() — a versão que o /healthcheck e o retrato do mapa mostram
//  ------------------------------------------------------------------
//  23/11/2026 (revisor de dd687c3): só lia o ref solto .git/refs/heads/main.
//  Depois de um `git gc`/`pack-refs` (o merge/fetch do Mini PC roda gc --auto)
//  o arquivo solto some e a versão virava null para sempre: o vigia da VPS
//  calava ("pesagem anterior a 23/11") e o /healthcheck sem commit parecia
//  servidor velho. Em worktree (.git é arquivo, como no pre-push) também era
//  null. Prova, num repositório de mentira:
//    · ref solto → sha de 7;
//    · depois de `git pack-refs --all` → o mesmo sha;
//    · worktree destacada → o sha dela;
//    · sem .git → null.
// ════════════════════════════════════════════════════════════════════
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { commitAtual } = require('../lib/log');

let passou = 0, falhou = 0;
function ok(cond, msg, extra) {
  if (cond) { passou++; console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
  else { falhou++; console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
         if (extra !== undefined) console.log('      →', JSON.stringify(extra)); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eko_commit_'));
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't',
              GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1', HOME: tmp };
const git = (cwd, ...a) => execFileSync('git', a, { cwd, env, encoding: 'utf8', timeout: 20000 }).trim();

try {
  console.log('\n[commitAtual] ref solto, compactado, worktree, sem .git');
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'a');
  const sha = git(repo, 'rev-parse', 'HEAD');

  ok(commitAtual(repo) === sha.slice(0, 7), 'ref solto: sha de 7', commitAtual(repo));

  git(repo, 'pack-refs', '--all');
  ok(!fs.existsSync(path.join(repo, '.git', 'refs', 'heads', 'main')), '(ensaio) pack-refs tirou o ref solto');
  ok(commitAtual(repo) === sha.slice(0, 7), 'depois de pack-refs (gc): o mesmo sha', commitAtual(repo));

  const wt = path.join(tmp, 'wt');
  git(repo, 'worktree', 'add', '--detach', '-q', wt, sha);
  ok(commitAtual(wt) === sha.slice(0, 7), 'worktree destacada (.git é arquivo, como no pre-push): o sha', commitAtual(wt));

  // gitdir: relativo (worktree --relative-paths, ou .git reescrito à mão)
  const absoluto = fs.readFileSync(path.join(wt, '.git'), 'utf8').match(/^gitdir:\s*(.+)$/m)[1].trim();
  fs.writeFileSync(path.join(wt, '.git'), 'gitdir: ' + path.relative(wt, absoluto) + '\n');
  ok(commitAtual(wt) === sha.slice(0, 7), 'worktree com gitdir: RELATIVO: o sha', commitAtual(wt));

  const vazio = path.join(tmp, 'sem-git');
  fs.mkdirSync(vazio);
  ok(commitAtual(vazio) === null, 'sem .git: null', commitAtual(vazio));

  // ── a versão mostrada é a do BOOT, não a do disco (2º revisor de dd687c3) ──
  console.log('\n[COMMIT_NO_AR] git mexido com o node no ar não muda a versão mostrada');
  const app = path.join(tmp, 'app');
  fs.mkdirSync(app);
  fs.cpSync(path.join(__dirname, '..', 'lib'), path.join(app, 'lib'), { recursive: true });
  fs.symlinkSync(path.join(__dirname, '..', 'node_modules'), path.join(app, 'node_modules'));
  git(app, 'init', '-q', '-b', 'main');
  git(app, 'commit', '-q', '--allow-empty', '-m', 'v1');
  const v1 = git(app, 'rev-parse', 'HEAD');
  const filho = `
    const { execFileSync } = require('node:child_process');
    const L = require(${JSON.stringify(path.join(app, 'lib', 'log.js'))});
    const antes = L.COMMIT_NO_AR;
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'v2'], { cwd: ${JSON.stringify(app)} });
    console.log(JSON.stringify({ antes, depois: L.COMMIT_NO_AR, disco: L.commitAtual() }));`;
  const r = JSON.parse(execFileSync(process.execPath, ['-e', filho], { env, encoding: 'utf8', timeout: 30000 }).trim().split('\n').pop());
  const v2 = git(app, 'rev-parse', 'HEAD');
  ok(r.antes === v1.slice(0, 7) && r.depois === v1.slice(0, 7), 'COMMIT_NO_AR fica na versão do boot', r);
  ok(r.disco === v2.slice(0, 7), '(ensaio) o disco mudou mesmo', r);

  // quem MOSTRA versão (healthcheck, atualizar, retrato) usa a do boot
  const raiz = path.join(__dirname, '..');
  const fontes = ['server.js', ...['lib', 'rotas'].flatMap(d =>
    fs.readdirSync(path.join(raiz, d)).filter(f => f.endsWith('.js')).map(f => path.join(d, f)))];
  const disco = fontes.filter(f => f !== path.join('lib', 'log.js') &&
    /commitAtual\s*\(/.test(fs.readFileSync(path.join(raiz, f), 'utf8')));
  ok(disco.length === 0, 'nenhuma rota/lib mostra a versão do disco (commitAtual())', disco);
} catch (e) {
  falhou++; console.log('  \x1b[31m✗\x1b[0m erro:', e.message);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n ${passou} passaram, ${falhou} falharam`);
process.exit(falhou ? 1 : 0);
