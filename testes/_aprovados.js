// ════════════════════════════════════════════════════════════════════
//  JÁ APROVADO — marca de "a suíte inteira passou nesta ÁRVORE" (16/11/2026)
//
//  O pre-push rodava o rodar-todos.js inteiro a cada push, mesmo quando o
//  MESMO código tinha passado minutos antes (commit refeito só na mensagem,
//  rebase que dá a mesma árvore, o mesmo commit subindo em outro ramo).
//  Igual ao tools/rodar_testes.sh do bling-claude, mas a chave é a ÁRVORE,
//  não o SHA do commit:
//
//    chave = sha256( árvore do commit + versão do node + blob do package-lock )
//
//  A árvore já cobre todo arquivo versionado (inclusive node_modules, que é
//  versionado de propósito — ver .gitignore). A versão do node entra porque
//  o node:sqlite e o fetch mudam com ela. O package-lock entra por extenso,
//  a pedido, mesmo já estando na árvore.
//
//  GRAVA (rodar-todos.js): SÓ quando quem chama é o pre-push, na pasta
//  temporária que ele acabou de criar a partir do commit (EKO_APROVADOS_GRAVAR
//  = o commit), com 100% verde, a pasta limpa no começo e no fim (git status
//  sem nada, nem arquivo novo fora do .gitignore) e o mesmo HEAD do começo
//  ao fim. Rodado à mão no clone NÃO grava, nem limpo: no clone há arquivo
//  ignorado que a pasta do commit não tem (cert/, *.db, logs/), bit de
//  skip-worktree que o git status esconde e outra sessão editando no meio —
//  nos três casos a suíte passaria no clone com código que não é o commit
//  (achado do revisor de 210cd40, reproduzido nos três). Defesa a mais, para
//  a variável forjada à mão no clone: no COMEÇO a pasta tem de estar como o
//  git acabou de criar — nem arquivo ignorado (git status --ignored) nem bit
//  de skip-worktree/assume-unchanged (git ls-files -v). Edição de outra sessão
//  no meio da suíte com a variável forjada continua fora do alcance: quem
//  forja a variável no clone compartilhado assume esse risco.
//  APROVEITA (pre-push): só numa pasta limpa cujo HEAD é o commit perguntado
//  — o pre-push pergunta de dentro da pasta temporária do commit, sempre limpa.
//  Vale 24 h (o mesmo prazo do bling): teste que depende de data/hora volta a
//  rodar pelo menos uma vez por dia.
//
//  Repetir: gravar de novo a mesma chave só renova o prazo (gravação por
//  rename, duas suítes juntas não deixam arquivo pela metade).
//  Fora do pre-push (RODAR-TESTES.bat, ENVIAR-ATUALIZACAO.bat, npm test à
//  mão) nem chama o git: a suíte roda como sempre. Sem git ou fora de um
//  repositório: não grava nem aproveita, calado.
//
//  Uso pela linha de comando (pre-push):
//    node testes/_aprovados.js ja-aprovado <commit>   → 0 e uma linha se sim
// ════════════════════════════════════════════════════════════════════
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

const ROOT  = path.join(__dirname, '..');
const PRAZO_MS = 24 * 60 * 60 * 1000;

function pasta() {
  return process.env.EKO_TESTES_APROVADOS ||
         path.join(os.homedir(), '.cache', 'ekoplastic-pesagem-testes-ok');
}

// git SEMPRE sobre esta pasta: um GIT_DIR/GIT_INDEX_FILE herdado apontaria
// para outro repositório e não para a pasta temporária do commit (o git 2.43
// no pre-push exporta GIT_DIR quando o push sai de um worktree ligado — visto
// em 24/11/2026; o hook agora limpa, mas não dependemos disso).
// Por isso tira todo GIT_* do ambiente. --no-optional-locks: o git status não
// segura o .git/index.lock (um commit de outra sessão no mesmo repositório
// não falha por causa da consulta).
function git(args) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
  return execFileSync('git', ['--no-optional-locks', ...args], { cwd: ROOT, env, encoding: 'utf8',
                                     stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000 }).trim();
}

function chave({ arvore, node, lock }) {
  return crypto.createHash('sha256')
    .update(`arvore=${arvore}\nnode=${node}\nlock=${lock}\n`).digest('hex');
}

// Estado da pasta ou null (sem git / não é a raiz):
//   limpa    — git status sem nada (nem arquivo novo fora do .gitignore);
//   intocada — limpa E sem arquivo ignorado E sem bit de skip-worktree/
//              assume-unchanged: a pasta como o git acabou de criar do commit.
function estado() {
  try {
    if (path.resolve(git(['rev-parse', '--show-toplevel'])) !== path.resolve(ROOT)) return null;
    const sujo = git(['status', '--porcelain=v1', '--untracked-files=all']);
    const ignorados = git(['status', '--porcelain=v1', '--untracked-files=all', '--ignored']);
    const escondidos = git(['ls-files', '-v']).split('\n').some(l => /^(S|[a-z])/.test(l));
    const head = git(['rev-parse', 'HEAD']);
    return { limpa: sujo === '', intocada: ignorados === '' && !escondidos,
             head, chave: chaveDoCommit(head) };
  } catch (e) { return null; }
}

function chaveDoCommit(commit) {
  const arvore = git(['rev-parse', `${commit}^{tree}`]);
  let lock;
  try { lock = git(['rev-parse', `${commit}:package-lock.json`]); } catch (e) { lock = 'sem-package-lock'; }
  return chave({ arvore, node: process.version, lock });
}

// O pre-push passa o commit que acabou de pôr na pasta temporária. Lido UMA
// vez e tirado do ambiente: os testes filhos não herdam o pedido (achado do
// revisor de 36d7747 — o aprovados-por-arvore.js ficava vermelho no pre-push).
function tirarPedidoDoHook() {
  const pedido = process.env.EKO_APROVADOS_GRAVAR || '';
  delete process.env.EKO_APROVADOS_GRAVAR;
  return pedido;
}

// rodar-todos.js: grava se foi o pre-push que pediu para ESTE commit, a pasta
// estava intocada no começo, limpa no fim, e o HEAD é o mesmo.
function gravar(pedido, inicio, fim) {
  if (!pedido || !inicio || !fim || !inicio.intocada || !fim.limpa ||
      inicio.head !== fim.head) return false;
  try { if (git(['rev-parse', `${pedido}^{commit}`]) !== fim.head) return false; }
  catch (e) { return false; }
  try {
    fs.mkdirSync(pasta(), { recursive: true });
    const tmp = path.join(pasta(), `.${fim.chave}.${process.pid}`);
    fs.writeFileSync(tmp, `commit ${fim.head}\nnode ${process.version}\n${new Date().toISOString()}\n`);
    fs.renameSync(tmp, path.join(pasta(), fim.chave));
    return true;
  } catch (e) { return false; }
}

// pre-push: aprovado se a marca existe, tem menos de 24 h, e ESTA pasta está
// limpa com HEAD no commit perguntado. Devolve a data da marca ou null.
function jaAprovado(commit) {
  const e = estado();
  if (!e || !e.limpa) return null;
  let alvo;
  try { alvo = git(['rev-parse', `${commit}^{commit}`]); } catch (err) { return null; }
  if (alvo !== e.head) return null;
  try {
    const st = fs.statSync(path.join(pasta(), e.chave));
    if (Date.now() - st.mtimeMs > PRAZO_MS) return null;
    return st.mtime;
  } catch (err) { return null; }
}

function limparVencidas() {
  try {
    for (const f of fs.readdirSync(pasta())) {
      const p = path.join(pasta(), f);
      if (Date.now() - fs.statSync(p).mtimeMs > PRAZO_MS) fs.rmSync(p, { force: true });
    }
  } catch (e) { /* pasta ainda não existe */ }
}

module.exports = { chave, estado, gravar, jaAprovado, limparVencidas, pasta, tirarPedidoDoHook };

if (require.main === module) {
  const [cmd, commit] = process.argv.slice(2);
  if (cmd === 'ja-aprovado' && commit) {
    const quando = jaAprovado(commit);
    if (!quando) process.exit(1);
    const d = n => String(n).padStart(2, '0');
    console.log(`[pre-push] ja aprovado: a suite inteira passou nesta mesma arvore ` +
                `(${commit.slice(0, 7)}, node ${process.version}) em ` +
                `${d(quando.getDate())}/${d(quando.getMonth() + 1)} ${d(quando.getHours())}:${d(quando.getMinutes())} — nao repeti`);
    process.exit(0);
  }
  console.error('uso: node testes/_aprovados.js ja-aprovado <commit>');
  process.exit(2);
}
