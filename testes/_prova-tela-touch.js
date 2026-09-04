// ════════════════════════════════════════════════════════════════════
//  PROVA: A TELA DO MINI PC NAO MUDOU
//  ------------------------------------------------------------------
//  O celular.css inteiro vive dentro de `@media (max-width: 900px)`.
//  Este script prova isso na pratica, nao no papel: abre cada tela em
//  901, 1024 e 1366 de largura DUAS vezes — uma com o arquivo de
//  verdade e outra com ele vazio — e compara elemento por elemento.
//
//  901 e' o primeiro pixel FORA do @media: e' o caso mais apertado
//  possivel. Se alguma regra vazasse, vazaria ali.
//
//  A comparacao NAO e' de pixels: telas com animacao (o "DESCONECTADA"
//  piscando, o aviso pulsando) nunca dao dois retratos iguais nem
//  quando nada mudou. O que se compara e' a POSICAO e o TAMANHO de
//  cada elemento, mais os estilos que mexem em layout. Isso e' estavel
//  e e' exatamente o que o operador enxerga como "a tela mudou".
//
//  Uso:  node testes/_prova-tela-touch.js
// ════════════════════════════════════════════════════════════════════
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');
// Playwright: usa o instalado no projeto se existir (`npm i -D playwright`),
// senao o global. Assim o script roda tanto no PC de Pesagem quanto fora dele.
const chromium = (function () {
  const tentativas = ['playwright', 'playwright-core',
                      '/home/claude/.npm-global/lib/node_modules/playwright'];
  for (const p of tentativas) { try { return require(p).chromium; } catch (e) {} }
  console.error('Playwright nao encontrado. Rode:  npm i -D playwright  e depois  npx playwright install chromium');
  process.exit(1);
})();
// Caminho do Chromium: o do container quando existir, senao o que o Playwright baixou.
const CHROMIUM = require('node:fs').existsSync('/opt/pw-browsers/chromium')
  ? { executablePath: '/opt/pw-browsers/chromium' } : {};

const ROOT = path.join(__dirname, '..');
const CSS  = path.join(ROOT, 'public', 'celular.css');
const PORT = 13997, PORT_CB = 18997;
const BASE = `http://localhost:${PORT}`;
const C = Date.now();
const TMP_DB = path.join(os.tmpdir(), `eko_touch_${C}.db`);
const TMP_LOGS = path.join(os.tmpdir(), `eko_touch_${C}`);

const TELAS = ['index.html', 'outras-pesagens.html', 'produto-acabado.html',
               'manutencao.html', 'dashboard.html',
               'enderecamento.html', 'inventario.html', 'retirada-bobinas.html'];
const LARGURAS = [901, 1024, 1366];

const sleep = ms => new Promise(r => setTimeout(r, ms));
let servidor, cssOriginal;

// Roda dentro do navegador: descreve o layout de cada elemento visivel.
function fotografarLayout() {
  const PROPS = ['display', 'position', 'flexWrap', 'flexDirection', 'gridTemplateColumns',
                 'fontSize', 'minHeight', 'minWidth', 'height', 'width', 'overflowX', 'overflowY',
                 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'top', 'right', 'bottom', 'left'];
  const linhas = [];
  const todos = document.querySelectorAll('body, body *');
  for (let i = 0; i < todos.length; i++) {
    const el = todos[i];
    const cs = getComputedStyle(el);
    const b = el.getBoundingClientRect();
    const chave = el.tagName.toLowerCase()
      + (el.id ? '#' + el.id : '')
      + ((el.className && typeof el.className === 'string') ? '.' + el.className.trim().split(/\s+/).join('.') : '');
    const geo = [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)].join(',');
    const est = PROPS.map(p => cs[p]).join('|');
    linhas.push(`${i}\t${chave}\t${geo}\t${est}`);
  }
  return linhas;
}

async function medirTudo(browser) {
  const mapa = {};
  for (const larg of LARGURAS) {
    const ctx = await browser.newContext({ viewport: { width: larg, height: 768 } });
    await ctx.route('**', r => {
      const u = r.request().url();
      return (u.startsWith(BASE) || u.startsWith('data:') || u.startsWith('blob:')) ? r.continue() : r.abort();
    });
    await ctx.addInitScript(() => {
      const lib = JSON.stringify({ nome: 'Medicao', id: 1, ts: Date.now() });
      try { for (const t of ['mp', 'pa', 'bobinas']) sessionStorage.setItem('eko_liberado_' + t, lib); } catch (e) {}
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(9000);
    for (const tela of TELAS) {
      try { await page.goto(`${BASE}/${tela}`, { waitUntil: 'domcontentloaded', timeout: 15000 }); } catch (e) {}
      // Na tela larga varias paginas se redirecionam para dentro do casco
      // (index.html + <iframe id="eko-frame">). Medir so' o quadro principal
      // mediria o casco e nao a tela — por isso percorremos TODOS os quadros.
      await sleep(2300);
      const linhas = [];
      const quadros = page.frames().slice().sort((a, b) => a.url().localeCompare(b.url()));
      for (const f of quadros) {
        let parte;
        try { parte = await f.evaluate(fotografarLayout); } catch (e) { parte = ['ERRO ' + e.message]; }
        const rotulo = f.url().replace(BASE, '');
        linhas.push(`══ ${rotulo} (${parte.length}) ══`, ...parte);
      }
      mapa[`${tela}@${larg}`] = linhas;
    }
    await ctx.close();
  }
  return mapa;
}

(async () => {
  let falhas = 0, comparados = 0;
  const detalhes = [];
  try {
    cssOriginal = fs.readFileSync(CSS, 'utf8');

    servidor = spawn('node', [path.join(ROOT, 'server.js')], {
      env: { ...process.env, EKO_PORT: String(PORT), EKO_PORT_CB: String(PORT_CB),
             EKO_DB_FILE: TMP_DB, EKO_LOG_DIR: TMP_LOGS, TZ: 'America/Sao_Paulo', EKO_PRINT_SIMULAR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    servidor.stdout.on('data', () => {});
    for (let i = 0; i < 75; i++) { try { const r = await fetch(BASE + '/healthcheck'); if (r.ok) break; } catch (e) {} await sleep(200); }

    const browser = await chromium.launch(CHROMIUM);

    console.log('  [1/2] medindo COM o celular.css ...');
    const comCss = await medirTudo(browser);

    console.log('  [2/2] medindo SEM o celular.css (arquivo vazio) ...');
    fs.writeFileSync(CSS, '/* vazio durante a prova */\n');
    const semCss = await medirTudo(browser);
    fs.writeFileSync(CSS, cssOriginal);

    await browser.close();

    console.log('\n════════ TELA LARGA: COM x SEM o celular.css ════════');
    for (const chave of Object.keys(comCss)) {
      comparados++;
      const a = comCss[chave], b = semCss[chave];
      const difs = [];
      const n = Math.max(a.length, b.length);
      for (let i = 0; i < n && difs.length < 4; i++) {
        if (a[i] !== b[i]) difs.push(`      com: ${a[i] || '(ausente)'}\n      sem: ${b[i] || '(ausente)'}`);
      }
      const igual = a.length === b.length && difs.length === 0;
      if (!igual) { falhas++; detalhes.push(`  ${chave}\n${difs.join('\n')}`); }
      console.log(`  ${igual ? '✓' : '✗'} ${chave.padEnd(34)} ${igual ? `identico (${a.length} elementos)` : 'MUDOU'}`);
    }
    if (detalhes.length) { console.log('\n════════ ONDE MUDOU ════════'); detalhes.forEach(d => console.log(d)); }
    console.log('\n═══════════════════════════════════════════════════');
    console.log(` RESULTADO: ${comparados - falhas} identicas, ${falhas} mudaram`);
    console.log('═══════════════════════════════════════════════════');
    if (falhas) process.exitCode = 1;
  } catch (e) {
    console.error('ERRO:', e.stack || e.message);
    process.exitCode = 1;
  } finally {
    // Devolve o arquivo original aconteca o que acontecer.
    try { if (cssOriginal && fs.readFileSync(CSS, 'utf8') !== cssOriginal) fs.writeFileSync(CSS, cssOriginal); } catch (e) {}
    try { servidor && servidor.kill('SIGKILL'); } catch (e) {}
    for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.rmSync(f, { force: true }); } catch (e) {} }
    try { fs.rmSync(TMP_LOGS, { recursive: true, force: true }); } catch (e) {}
    setTimeout(() => process.exit(process.exitCode || 0), 200);
  }
})();
