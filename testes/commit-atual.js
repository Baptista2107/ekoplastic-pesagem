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

  const vazio = path.join(tmp, 'sem-git');
  fs.mkdirSync(vazio);
  ok(commitAtual(vazio) === null, 'sem .git: null', commitAtual(vazio));
} catch (e) {
  falhou++; console.log('  \x1b[31m✗\x1b[0m erro:', e.message);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n ${passou} passaram, ${falhou} falharam`);
process.exit(falhou ? 1 : 0);
