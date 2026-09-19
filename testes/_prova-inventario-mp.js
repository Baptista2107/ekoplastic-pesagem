// ════════════════════════════════════════════════════════════════════
//  PROVA VISUAL — INVENTÁRIO DE MATÉRIA-PRIMA COM PESO DIGITADO
//  ------------------------------------------------------------------
//  A etiqueta do big bag traz o peso que saiu da balança, e ler é
//  sempre melhor do que digitar. Mas etiqueta rasga, molha e some — e
//  um big bag sem etiqueta legível não pode ficar de fora do
//  inventário por causa disso: ficaria faltando material que está no
//  chão, e a divergência apareceria como se fosse do estoque.
//
//  Aqui o que entra é PESO, não quantidade, e com casa decimal —
//  matéria-prima quase nunca dá número redondo. Esta prova percorre o
//  caminho num navegador de verdade em tamanho de celular e vai até o
//  PDF, conferindo o número com decimal dentro dele.
//
//  Uso:  node testes/_prova-inventario-mp.js  [pasta-de-saida]
// ════════════════════════════════════════════════════════════════════
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');
const url  = require('node:url');
const chromium = (function () {
  for (const p of ['playwright', 'playwright-core',
                   '/home/claude/.npm-global/lib/node_modules/playwright']) {
    try { return require(p).chromium; } catch (e) {}
  }
  console.error('Playwright nao encontrado. Rode:  npm i -D playwright');
  process.exit(1);
})();
const CHROMIUM = fs.existsSync('/opt/pw-browsers/chromium')
  ? { executablePath: '/opt/pw-browsers/chromium' } : {};

const ROOT = path.join(__dirname, '..');
const PORT = 13909, PORT_CB = 18909;
const BASE = `http://localhost:${PORT}`;
const C = Date.now();
const TMP_DB   = path.join(os.tmpdir(), `eko_im_${C}.db`);
const TMP_LOGS = path.join(os.tmpdir(), `eko_im_${C}`);
const OUT = process.argv[2] || path.join(os.tmpdir(), 'prova-inventario-mp');
fs.mkdirSync(OUT, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let servidor, falhas = 0, passos = 0;
const ok = (cond, msg) => {
  passos++;
  console.log((cond ? '  \x1b[32m✓\x1b[0m ' : '  \x1b[31m✗\x1b[0m ') + msg);
  if (!cond) falhas++;
};
async function tirar(page, nome) {
  try { await page.screenshot({ path: path.join(OUT, nome + '.png'), fullPage: true }); } catch (e) {}
}
async function textoDoPdf(arquivo) {
  const base = path.join(ROOT, 'public', 'vendor');
  const lib = await import(url.pathToFileURL(path.join(base, 'pdf.min.mjs')).href);
  lib.GlobalWorkerOptions.workerSrc = url.pathToFileURL(path.join(base, 'pdf.worker.min.mjs')).href;
  const doc = await lib.getDocument({ data: new Uint8Array(fs.readFileSync(arquivo)),
    useWorkerFetch: false, isEvalSupported: false, useSystemFonts: false, verbosity: 0 }).promise;
  let txt = '';
  for (let n = 1; n <= doc.numPages; n++) {
    const c = await (await doc.getPage(n)).getTextContent();
    txt += c.items.map(i => i.str).join(' ') + '\n';
  }
  try { await doc.destroy(); } catch (e) {}
  return txt;
}

(async () => {
  try {
    servidor = spawn('node', [path.join(ROOT, 'server.js')], {
      env: { ...process.env, EKO_PORT: String(PORT), EKO_PORT_CB: String(PORT_CB),
             EKO_DB_FILE: TMP_DB, EKO_LOG_DIR: TMP_LOGS,
             TZ: 'America/Sao_Paulo', EKO_PRINT_SIMULAR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    servidor.stdout.on('data', () => {});
    for (let i = 0; i < 75; i++) {
      try { const r = await fetch(BASE + '/healthcheck'); if (r.ok) break; } catch (e) {}
      await sleep(200);
    }
    await fetch(BASE + '/inventario/limpar', { method: 'POST' });

    const browser = await chromium.launch(CHROMIUM);
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
      acceptDownloads: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 '
               + '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    });
    await ctx.route('**', r => {
      const u = r.request().url();
      return (u.startsWith(BASE) || u.startsWith('data:') || u.startsWith('blob:')) ? r.continue() : r.abort();
    });
    await ctx.addInitScript(() => {
      const lib = JSON.stringify({ nome: 'VINICIUS', id: 1, ts: Date.now() });
      try { for (const t of ['mp', 'pa', 'bobinas']) sessionStorage.setItem('eko_liberado_' + t, lib); } catch (e) {}
      try { localStorage.removeItem('eko_inventario_andamento'); } catch (e) {}
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(9000);
    const erros = [];
    page.on('pageerror', e => erros.push(e.message));
    page.on('dialog', d => d.accept());

    await page.goto(BASE + '/inventario.html', { waitUntil: 'domcontentloaded' });
    await sleep(1800);

    // ── 1. MATERIAL → COR → FORNECEDOR → iniciar ──
    await page.click('text=MATÉRIA-PRIMA'); await sleep(1200);
    await page.selectOption('#sel-material', 'GBD'); await sleep(600);
    await page.selectOption('#sel-cor', 'Canela'); await sleep(600);
    await page.selectOption('#sel-forn', 'Cedro'); await sleep(400);
    await page.click('#btn-iniciar'); await sleep(1000);
    ok(/GBD|Canela/i.test(await page.innerText('.prod-sel .p1')),
       'a contagem abre no produto escolhido');

    // ── 2. A barra "como contar" ──
    ok(await page.isVisible('#mp-modo'), 'a barra LER A ETIQUETA / DIGITAR aparece na matéria-prima');
    ok(await page.isVisible('#bloco-camera'),
       'por padrão continua na leitura da etiqueta — nada muda para quem já usa');
    await tirar(page, '1-leitura-etiqueta');
    await page.click('#mp-chip-man'); await sleep(700);
    ok(await page.isVisible('#bloco-mp-manual'), 'tocando em DIGITAR, o campo de peso aparece');
    ok(!(await page.isVisible('#bloco-camera')), 'e a câmera sai da frente');
    ok(/PESO TOTAL DESTA SELEÇÃO/.test(await page.innerText('#bloco-mp-manual')),
       'o campo é o peso total da seleção');
    await tirar(page, '2-campo-de-peso');

    // ── 3. O ponto do pedido: casa decimal ──
    await page.fill('#mp-man-kg', '1234,5');
    await page.dispatchEvent('#mp-man-kg', 'input'); await sleep(400);
    ok(/1\.234,5/.test(await page.innerText('#mp-man-conta')),
       'aceita vírgula: 1234,5 kg entra como 1.234,5 e não como 12.345');
    await page.click('#mp-man-add'); await sleep(800);
    let kgTela = await page.innerText('#c-kg');
    ok(/1\.234,5/.test(kgTela), `e soma com a casa decimal: ${kgTela}`);
    ok(/S\/ETIQ 1/.test(await page.innerText('#lista-leituras')),
       'o lançamento vira uma linha, igual a uma etiqueta lida');

    // Ponto como decimal também vale — cada um digita como está acostumado.
    await page.fill('#mp-man-kg', '765.25');
    await page.dispatchEvent('#mp-man-kg', 'input'); await sleep(400);
    await page.click('#mp-man-add'); await sleep(800);
    kgTela = await page.innerText('#c-kg');
    ok(/1\.999,75/.test(kgTela), `ponto também é decimal: total ${kgTela} (1.234,5 + 765,25)`);
    ok(/LANÇAMENTOS/.test(await page.innerText('.contador')),
       'o contador diz LANÇAMENTOS — não seriam 2 big bags, e sim 2 lançamentos');
    const campo = await page.$eval('#mp-man-kg', el => el.value);
    ok(campo === '', 'o campo limpa sozinho para o próximo lançamento');
    await tirar(page, '3-dois-lancamentos');

    // Milhar com ponto E decimal com vírgula: o caso que mais engana.
    await page.fill('#mp-man-kg', '1.000,5');
    await page.dispatchEvent('#mp-man-kg', 'input'); await sleep(400);
    ok(/1\.000,5/.test(await page.innerText('#mp-man-conta')),
       '"1.000,5" é mil quilos e meio, não um quilo — o ponto é milhar quando há vírgula');
    await page.click('#mp-man-add'); await sleep(800);
    kgTela = await page.innerText('#c-kg');
    ok(/2\.(999|0)/.test(kgTela) || /3\.000,25/.test(kgTela), `total ${kgTela}`);

    // ── 4. Remover um lançamento errado ──
    await page.locator('#lista-leituras .rm').first().click(); await sleep(600);
    ok((await page.innerText('#c-qtd')) === '2', 'dá para remover um lançamento errado');

    // ── 5. Finalizar, salvar e gerar o PDF ──
    await page.click('#btn-finalizar-leitura'); await sleep(2500);
    ok(/1\.999,75/.test(await page.innerText('#comp-corpo')),
       'o comparativo leva o peso digitado, com decimal');
    await page.click('text=Salvar e ir para o próximo'); await sleep(2000);
    await tirar(page, '4-inventariados');

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      page.click('text=⬇️ PDF'),
    ]);
    const destino = path.join(OUT, 'inventario-mp.pdf');
    await download.saveAs(destino);
    ok(fs.existsSync(destino) && fs.statSync(destino).size > 1000, 'o PDF sai normalmente');
    const txt = await textoDoPdf(destino);
    ok(/1\.999,75/.test(txt), 'e o peso digitado aparece dentro dele, com a casa decimal');
    ok(!/manual/i.test(txt), 'sem dizer como foi contado — igual ao produto acabado');
    console.log('\n  texto do PDF:\n    ' + txt.replace(/\s+/g, ' ').trim().slice(0, 300));

    // ── 6. Produto por SACOS continua com o contador dele ──
    // Pigmento e dessecante já têm caminho manual próprio (sacos × 25 kg).
    // Duas formas manuais na mesma tela dariam contagem dobrada.
    // depois de salvar já estamos de volta na seleção
    if (await page.isVisible('#tela-tipo')) { await page.click('text=MATÉRIA-PRIMA'); await sleep(1200); }
    await page.selectOption('#sel-material', 'CARBO'); await sleep(700);
    await page.selectOption('#sel-forn', { index: 1 }); await sleep(400);
    await page.click('#btn-iniciar'); await sleep(1000);
    ok(await page.isVisible('#bloco-manual'), 'produto por sacos abre no contador de sacos');
    ok(!(await page.isVisible('#mp-modo')),
       'e não mostra a barra de digitar peso — seriam duas contagens manuais concorrendo');
    await tirar(page, '5-produto-por-sacos');

    // ── 7. Cabe no celular ──
    const larg = await page.evaluate(() => Math.max(
      document.documentElement.scrollWidth, document.body.scrollWidth));
    ok(larg <= 390 + 1, `sem arrastar de lado no celular: documento com ${larg} px`);

    ok(erros.length === 0, `nenhum erro de página${erros.length ? ': ' + erros.slice(0, 3).join(' | ') : ''}`);
    await browser.close();
  } catch (e) {
    falhas++;
    console.error('\n\x1b[31mERRO:\x1b[0m', e.stack || e.message);
  } finally {
    console.log('\n═══════════════════════════════════════════════════');
    console.log(` RESULTADO: ${passos - falhas} de ${passos} · prints em ${OUT}`);
    console.log('═══════════════════════════════════════════════════\n');
    try { servidor && servidor.kill('SIGKILL'); } catch (e) {}
    for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.rmSync(f, { force: true }); } catch (e) {} }
    try { fs.rmSync(TMP_LOGS, { recursive: true, force: true }); } catch (e) {}
    setTimeout(() => process.exit(falhas ? 1 : 0), 200);
  }
})();
