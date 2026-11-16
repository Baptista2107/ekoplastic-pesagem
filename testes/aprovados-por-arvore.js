// ════════════════════════════════════════════════════════════════════
//  JÁ APROVADO POR ÁRVORE (16/11/2026) — tools/hooks/pre-push +
//  testes/rodar-todos.js + testes/_aprovados.js
//  Prova, com o hook e o rodar-todos.js DE VERDADE num repositório de
//  mentira (um teste falso que conta quantas vezes rodou e passa/falha
//  conforme um arquivo versionado), empurrando para um "origin" local:
//   - 1º push roda e grava a marca; 2º push da MESMA árvore (commit novo,
//     mesmo conteúdo; ou o mesmo commit em outro ramo) NÃO roda e diz isso;
//   - arquivo mudado → roda de novo;
//   - suíte vermelha → push recusado, marca NÃO gravada, e o push repetido
//     roda de novo (não aproveita nada);
//   - rodado à mão no clone NÃO grava (arquivo ignorado só do clone e
//     skip-worktree: verde no clone, e o push testa o commit e recusa);
//   - pedido do hook com arquivo solto → passa mas NÃO grava, e não aproveita;
//   - GIT_DIR herdado não desvia a consulta; dois refs num push só;
//   - marca com mais de 24 h → roda de novo;
//   - outra versão do node → outra chave.
//  Só na VPS (Linux): o pre-push é bash e só existe no caminho da VPS.
// ════════════════════════════════════════════════════════════════════
const { spawnSync } = require('node:child_process');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
if (process.platform !== 'linux') {
  console.log('  pulado: o pre-push só roda na VPS (Linux)');
  process.exit(0);
}

let passou = 0, falhou = 0;
function ok(cond, msg, extra) {
  if (cond) { passou++; console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
  else { falhou++; console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
         if (extra !== undefined) console.log('      →', String(extra).slice(-1500)); }
}

const base  = fs.mkdtempSync(path.join(os.tmpdir(), 'eko_aprovados_'));
const repo  = path.join(base, 'repo');
const orig  = path.join(base, 'origin.git');
const marcas = path.join(base, 'marcas');
const log   = path.join(base, 'rodou.log');

// Ambiente sem GIT_* (este teste pode estar rodando DENTRO de um pre-push).
const env = { EKO_TESTES_APROVADOS: marcas, EKO_FALSO_LOG: log,
              GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
// Nem o pedido do pre-push de FORA (este teste roda dentro dele no push real).
for (const [k, v] of Object.entries(process.env))
  if (!k.startsWith('GIT_') && k !== 'EKO_APROVADOS_GRAVAR' && !(k in env)) env[k] = v;

function sh(cmd, args, cwd = repo) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', timeout: 120000 });
  return { rc: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const g = (...a) => sh('git', a);
const vezes  = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0;
const nMarcas = () => fs.existsSync(marcas) ? fs.readdirSync(marcas).filter(f => !f.startsWith('.')).length : 0;
const escrever = (f, s) => fs.writeFileSync(path.join(repo, f), s);
function commit(msg, ...extra) {
  g('add', '-A');
  const r = g('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', msg, ...extra);
  if (r.rc !== 0) throw new Error('commit falhou: ' + r.out);
}
const push = (ref = 'main') => g('push', 'origin', `HEAD:refs/heads/${ref}`);

try {
  // ── montagem: hook, rodar-todos e o auxiliar REAIS; um teste falso ──
  fs.mkdirSync(path.join(repo, 'testes'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'tools', 'hooks'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'tools/hooks/pre-push'), path.join(repo, 'tools/hooks/pre-push'));
  fs.chmodSync(path.join(repo, 'tools/hooks/pre-push'), 0o755);
  for (const f of ['rodar-todos.js', '_aprovados.js'])
    fs.copyFileSync(path.join(__dirname, f), path.join(repo, 'testes', f));
  escrever('testes/falso.js',
    "const fs=require('fs');fs.appendFileSync(process.env.EKO_FALSO_LOG," +
    "'rodou pedido='+(process.env.EKO_APROVADOS_GRAVAR||'nenhum')+'\\n');" +
    "process.exit(fs.readFileSync(__dirname+'/../resultado.txt','utf8').trim()==='passa'?0:1);\n");
  escrever('resultado.txt', 'passa\n');
  escrever('arquivo.txt', 'v1\n');
  escrever('package-lock.json', '{"lockfileVersion":3}\n');
  escrever('.gitignore', 'ignorado.txt\n');
  sh('git', ['init', '-q', '--bare', orig], base);
  g('init', '-q', '-b', 'main');
  g('config', 'user.name', 'teste'); g('config', 'user.email', 'teste@teste');
  g('config', 'core.hooksPath', 'tools/hooks');
  g('remote', 'add', 'origin', orig);
  commit('c1');

  // 1. primeiro push: roda e grava
  let r = push();
  ok(r.rc === 0 && /testando/.test(r.out), '1º push roda a suíte e passa', r.out);
  ok(vezes() === 1, `1º push: a suíte rodou 1 vez (rodou ${vezes()})`);
  ok(nMarcas() === 1, `1º push verde grava 1 marca (há ${nMarcas()})`);
  ok(fs.readFileSync(log, 'utf8').trim() === 'rodou pedido=nenhum',
     'o teste chamado pelo rodar-todos do hook NÃO herda o pedido de gravar', fs.readFileSync(log, 'utf8'));

  // 2. mesma árvore em commit NOVO (só a mensagem muda) → pula, e diz numa linha
  commit('c1 de novo, mesma árvore', '--allow-empty');
  r = push();
  ok(r.rc === 0 && /ja aprovado: a suite inteira passou nesta mesma arvore/.test(r.out) &&
     !/testando/.test(r.out), '2º push da mesma árvore NÃO roda e diz "ja aprovado"', r.out);
  ok(r.out.split('\n').filter(l => /ja aprovado/.test(l)).length === 1, 'o aviso é UMA linha', r.out);
  ok(vezes() === 1, `2º push: a suíte não rodou de novo (rodou ${vezes()})`);
  r = push('outro-ramo');
  ok(r.rc === 0 && /ja aprovado/.test(r.out) && vezes() === 1, 'o mesmo commit em outro ramo também pula', r.out);

  // 3. arquivo mudado → roda
  escrever('arquivo.txt', 'v2\n'); commit('c2');
  r = push();
  ok(r.rc === 0 && /testando/.test(r.out) && vezes() === 2, `arquivo mudado: roda de novo (rodou ${vezes()})`, r.out);
  ok(nMarcas() === 2, `árvore nova verde grava a 2ª marca (há ${nMarcas()})`);

  // 4. suíte vermelha → recusa, não grava, e repetir roda de novo
  escrever('resultado.txt', 'falha\n'); commit('c3 vermelho');
  r = push();
  ok(r.rc !== 0 && /push RECUSADO/.test(r.out), 'suíte vermelha: push recusado', r.out);
  ok(nMarcas() === 2, `suíte vermelha NÃO grava marca (há ${nMarcas()})`);
  r = push();
  ok(r.rc !== 0 && /testando/.test(r.out) && vezes() === 4,
     `vermelho repetido roda de novo e recusa de novo (rodou ${vezes()})`, r.out);

  // 5. fora do pre-push (rodado à mão no clone) NÃO grava, nem com a pasta
  //    limpa: o clone tem arquivo ignorado / skip-worktree que o commit não tem
  escrever('resultado.txt', 'passa\n'); escrever('arquivo.txt', 'v3\n'); commit('c4');
  r = sh('node', ['testes/rodar-todos.js']);
  ok(r.rc === 0 && nMarcas() === 2 && !/marca de aprovado/.test(r.out),
     `à mão no clone limpo: verde, NÃO grava e não fala de marca (há ${nMarcas()})`, r.out);
  //    arquivo IGNORADO que só existe no clone: verde no clone, vermelho no commit
  escrever('testes/falso.js', fs.readFileSync(path.join(repo, 'testes/falso.js'), 'utf8')
    .replace("==='passa'", "==='passa'||require('fs').existsSync(__dirname+'/../ignorado.txt')"));
  escrever('resultado.txt', 'precisa do ignorado\n'); commit('c5 depende de arquivo ignorado');
  escrever('ignorado.txt', 'só no clone\n');
  r = sh('node', ['testes/rodar-todos.js']);
  ok(r.rc === 0 && nMarcas() === 2, `arquivo ignorado no clone: verde à mão e NÃO grava (há ${nMarcas()})`, r.out);
  r = push();
  ok(r.rc !== 0 && /push RECUSADO/.test(r.out), 'e o push testa o commit de verdade: recusado', r.out);
  //    skip-worktree: o commit diz falha, o disco diz passa e o git status cala
  fs.rmSync(path.join(repo, 'ignorado.txt'));
  escrever('resultado.txt', 'falha\n'); commit('c6 vermelho');
  g('update-index', '--skip-worktree', 'resultado.txt');
  escrever('resultado.txt', 'passa\n');
  ok(g('status', '--porcelain').out.trim() === '', '(montagem: git status não mostra o skip-worktree)');
  r = sh('node', ['testes/rodar-todos.js']);
  ok(r.rc === 0 && nMarcas() === 2, `skip-worktree: verde à mão e NÃO grava (há ${nMarcas()})`, r.out);
  r = push();
  ok(r.rc !== 0 && /push RECUSADO/.test(r.out), 'e o push com skip-worktree é recusado', r.out);
  g('update-index', '--no-skip-worktree', 'resultado.txt');

  //    o mesmo pedido do hook (EKO_APROVADOS_GRAVAR) com a pasta suja: não grava
  escrever('resultado.txt', 'passa\n'); escrever('arquivo.txt', 'v4\n'); commit('c7');
  const head = g('rev-parse', 'HEAD').out.trim();
  const comoHook = (extra = {}) => spawnSync('node', ['testes/rodar-todos.js'],
    { cwd: repo, env: { ...env, EKO_APROVADOS_GRAVAR: head, ...extra }, encoding: 'utf8', timeout: 120000 });
  escrever('solto.txt', 'não commitado\n');
  r = comoHook();
  ok(r.status === 0 && nMarcas() === 2 && /NÃO gravada/.test(r.stdout),
     `pedido do hook + arquivo solto: verde mas NÃO grava (há ${nMarcas()})`, r.stdout);
  fs.rmSync(path.join(repo, 'solto.txt'));
  r = comoHook({ EKO_APROVADOS_GRAVAR: g('rev-parse', 'HEAD~1').out.trim() });
  ok(r.status === 0 && nMarcas() === 2, `pedido do hook para OUTRO commit: NÃO grava (há ${nMarcas()})`, r.stdout);
  //    pedido forjado à mão no clone: arquivo ignorado ou skip-worktree no começo → não grava
  escrever('ignorado.txt', 'só no clone\n');
  r = comoHook();
  ok(r.status === 0 && nMarcas() === 2 && /NÃO gravada/.test(r.stdout),
     `pedido forjado + arquivo IGNORADO na pasta: NÃO grava (há ${nMarcas()})`, r.stdout);
  fs.rmSync(path.join(repo, 'ignorado.txt'));
  g('update-index', '--skip-worktree', 'arquivo.txt');
  r = comoHook();
  ok(r.status === 0 && nMarcas() === 2 && /NÃO gravada/.test(r.stdout),
     `pedido forjado + skip-worktree: NÃO grava (há ${nMarcas()})`, r.stdout);
  g('update-index', '--no-skip-worktree', 'arquivo.txt');
  r = comoHook();
  ok(r.status === 0 && nMarcas() === 3 && /marca de aprovado gravada/.test(r.stdout),
     `pedido do hook + pasta como o git criou: grava (há ${nMarcas()})`, r.stdout);
  ok(sh('node', ['testes/_aprovados.js', 'ja-aprovado', 'HEAD']).rc === 0, 'árvore aprovada + pasta limpa: aproveita');
  escrever('solto.txt', 'não commitado\n');
  ok(sh('node', ['testes/_aprovados.js', 'ja-aprovado', 'HEAD']).rc === 1, 'árvore aprovada + arquivo solto: NÃO aproveita');
  escrever('arquivo.txt', 'v4 editado sem commit\n'); fs.rmSync(path.join(repo, 'solto.txt'));
  ok(sh('node', ['testes/_aprovados.js', 'ja-aprovado', 'HEAD']).rc === 1, 'árvore aprovada + arquivo editado: NÃO aproveita');
  g('checkout', '-q', '--', 'arquivo.txt');
  ok(sh('node', ['testes/_aprovados.js', 'ja-aprovado', 'HEAD~1']).rc === 1, 'pergunta por outro commit que não o HEAD da pasta: NÃO aproveita');
  const comGitDir = spawnSync('node', ['testes/_aprovados.js', 'ja-aprovado', 'HEAD'],
    { cwd: repo, env: { ...env, GIT_DIR: path.join(base, 'nao-existe'), GIT_INDEX_FILE: path.join(base, 'nao-existe-idx') } });
  ok(comGitDir.status === 0, 'GIT_DIR/GIT_INDEX_FILE herdados não desviam a consulta para outro repositório');
  const antes = vezes();
  r = push();
  ok(r.rc === 0 && /ja aprovado/.test(r.out) && vezes() === antes, 'push da árvore aprovada pula', r.out);

  //    dois refs num push só: o aprovado pula, o vermelho roda e recusa
  const verde = head;
  escrever('resultado.txt', 'falha\n'); commit('c8 vermelho');
  r = g('push', 'origin', `${verde}:refs/heads/verde`, 'HEAD:refs/heads/vermelho');
  ok(r.rc !== 0 && /ja aprovado/.test(r.out) && /push RECUSADO/.test(r.out) && vezes() === antes + 1,
     'dois refs num push: o aprovado pula e o vermelho é testado e recusado', r.out);
  g('reset', '-q', '--hard', verde);

  // 6. marca vencida (> 24 h) → roda
  const velho = new Date(Date.now() - 25 * 3600 * 1000);
  for (const f of fs.readdirSync(marcas)) fs.utimesSync(path.join(marcas, f), velho, velho);
  commit('c7 de novo', '--allow-empty');
  r = push();
  ok(r.rc === 0 && /testando/.test(r.out) && vezes() === antes + 2, 'marca com mais de 24 h: roda de novo', r.out);
  ok(nMarcas() === 1, `marcas vencidas são apagadas e a nova fica (há ${nMarcas()})`);

  // 7. a chave muda com o node e com o package-lock
  const { chave } = require('./_aprovados');
  const k = { arvore: 'a'.repeat(40), node: 'v22.23.4', lock: 'b'.repeat(40) };
  ok(chave(k) !== chave({ ...k, node: 'v24.0.0' }), 'outra versão do node = outra chave');
  ok(chave(k) !== chave({ ...k, lock: 'c'.repeat(40) }), 'outro package-lock = outra chave');
} catch (e) {
  ok(false, 'o teste quebrou: ' + e.message, e.stack);
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}

console.log(`\n  ${passou} passaram, ${falhou} falharam`);
process.exit(falhou ? 1 : 0);
