// ════════════════════════════════════════════════════════════════════
//  PROVA VISUAL — INVENTÁRIO DE PRODUTO ACABADO SEM QR CODE
//  ------------------------------------------------------------------
//  O inventário nasceu contando gaiolas pelo QR. Só que o QR só existe
//  depois que TODAS as gaiolas foram etiquetadas — e o galpão começa
//  sem nenhuma. Exigir QR é não ter inventário justamente quando ele
//  mais vale: é a primeira contagem que dá a fotografia do estoque.
//
//  Esta prova percorre o caminho de quem conta à mão, num navegador de
//  verdade em tamanho de celular, e vai até o fim que importa: o PDF
//  SAINDO, com os números certos dentro.
//
//  Uso:  node testes/_prova-inventario-pa.js  [pasta-de-saida]
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
const PORT = 13908, PORT_CB = 18908;
const BASE = `http://localhost:${PORT}`;
const C = Date.now();
const TMP_DB   = path.join(os.tmpdir(), `eko_ip_${C}.db`);
const TMP_LOGS = path.join(os.tmpdir(), `eko_ip_${C}`);
const OUT = process.argv[2] || path.join(os.tmpdir(), 'prova-inventario-pa');
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

// Lê o texto de um PDF com o mesmo pdf.js que a estação já serve.
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
  const paginas = doc.numPages;
  try { await doc.destroy(); } catch (e) {}
  return { txt, paginas };
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
    // Nada de rede externa: o jsPDF e o leitor de QR são servidos pela estação.
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

    // ── 1. A entrada: dois botões e mais nada ──
    const tipo = (await page.innerText('#tela-tipo')).replace(/\s+/g, ' ').trim();
    ok(tipo === 'O que você vai contar? MATÉRIA-PRIMA PRODUTO ACABADO',
       `a entrada tem só a pergunta e os dois botões: "${tipo}"`);
    ok((await page.$$('#tela-tipo .tipo-bt')).length === 2, 'dois botões, em formato de app');
    ok(!/📦|🏷️|big bags|gaiolas/.test(tipo), 'sem ícone e sem a linha de explicação');
    const alturas = await page.$$eval('#tela-tipo .tipo-bt',
      els => els.map(e => Math.round(e.getBoundingClientRect().height)));
    ok(alturas.every(h => h >= 90),
       `com altura de botão de app, não de linha de lista: ${alturas.join(' e ')} px`);
    await tirar(page, '0-entrada');

    await page.click('text=PRODUTO ACABADO'); await sleep(900);
    await page.selectOption('#pa-formato', '50x60');
    await page.selectOption('#pa-cor', { index: 1 });
    const corEscolhida = await page.$eval('#pa-cor', el => el.value);
    await page.click('#pa-btn-iniciar'); await sleep(900);
    ok(/50 × 60/.test(await page.innerText('.prod-sel .p1')),
       'a tela da contagem mostra o formato e a cor escolhidos');
    ok(!(await page.isVisible('.prod-sel .p2')),
       'e nada mais — a linha de explicação saiu da frente da contagem');
    await tirar(page, '1-contagem-qr');

    // ── 2. A chave: trocar para DIGITAR ──
    ok(await page.isVisible('#pa-modo'), 'a barra "como contar" aparece no produto acabado');
    ok(await page.isVisible('#bloco-camera'), 'por padrão continua no QR — nada mudou para quem já usa');
    await page.click('#pa-chip-man'); await sleep(700);
    ok(await page.isVisible('#bloco-pa-manual'), 'tocando em DIGITAR, o lançamento manual aparece');
    ok(!(await page.isVisible('#bloco-camera')),
       'e a câmera some — sem QR na gaiola ela só atrapalha e gasta bateria');
    await tirar(page, '2-lancamento-manual');

    // ── 3. Lançar duas gaiolas ──
    await page.fill('#pa-man-fardos', '24');
    await page.dispatchEvent('#pa-man-fardos', 'change'); await sleep(300);
    ok(/600/.test(await page.innerText('#pa-man-conta')),
       'a conta aparece antes de incluir: 24 fardos × 25 kg = 600 kg');
    await page.click('#pa-man-add'); await sleep(700);
    await page.fill('#pa-man-fardos', '20');
    await page.dispatchEvent('#pa-man-fardos', 'change'); await sleep(300);
    await page.click('#pa-man-add'); await sleep(700);

    const lista = await page.innerText('#lista-leituras');
    ok(/S\/QR 1/.test(lista) && /S\/QR 2/.test(lista),
       'cada lançamento vira uma linha, numerada, igual a uma gaiola bipada');
    ok(/24 fardos/.test(lista) && /20 fardos/.test(lista), 'com os fardos de cada uma');
    const contQtd = await page.innerText('#c-qtd');
    const contKg  = await page.innerText('#c-kg');
    ok(contQtd === '2', `o contador soma as duas gaiolas: ${contQtd}`);
    ok(/1\.100/.test(contKg), `e os quilos: ${contKg} (44 fardos × 25)`);
    ok(/44 FARDOS/.test(await page.innerText('.contador')), 'o rótulo mostra os 44 fardos');
    const campo = await page.$eval('#pa-man-fardos', el => el.value);
    ok(campo === '0', 'o campo zera sozinho para a próxima gaiola — não repete o número anterior');
    ok((await page.$$('#bloco-pa-manual .pa-man-dica')).length === 0,
       'sem texto explicativo embaixo do botão de incluir');

    // A fileira de botões tem largura fixa e estourava a caixa no
    // celular: os "−10" e "+10" das pontas saíam cortados.
    const cabe = await page.evaluate(() => {
      const l = document.querySelector('#bloco-pa-manual .manual-linha');
      const cx = document.querySelector('#bloco-pa-manual .manual-cx');
      if (!l || !cx) return null;
      const a = l.getBoundingClientRect(), b = cx.getBoundingClientRect();
      return { linha: Math.round(a.width), caixa: Math.round(b.width),
               esq: Math.round(a.left - b.left), dir: Math.round(b.right - a.right) };
    });
    ok(cabe && cabe.esq >= -1 && cabe.dir >= -1,
       `os botões −10…+10 cabem na caixa: linha ${cabe && cabe.linha} px em caixa de ${cabe && cabe.caixa} px`);
    await tirar(page, '3-duas-gaiolas-lancadas');

    // ── 4. Remover um lançamento errado ──
    await page.locator('#lista-leituras .rm').first().click(); await sleep(500);
    ok((await page.innerText('#c-qtd')) === '1', 'dá para remover um lançamento errado da lista');
    await page.fill('#pa-man-fardos', '20');
    await page.dispatchEvent('#pa-man-fardos', 'change');
    await page.click('#pa-man-add'); await sleep(700);
    ok((await page.innerText('#c-qtd')) === '2', 'e lançar de novo no lugar');

    // ── 5. Finalizar e salvar (o Bling não responde no teste) ──
    await page.click('#btn-finalizar-leitura'); await sleep(2500);
    const comp = await page.innerText('#comp-corpo');
    ok(/Contagem física/.test(comp), 'o comparativo abre com a contagem física');
    ok(/1\.100/.test(comp), 'com os 1.100 kg contados à mão');
    await tirar(page, '4-comparativo');
    await page.click('text=Salvar e ir para o próximo'); await sleep(2000);
    const fin = await page.innerText('#sec-finalizados');
    ok(/50 × 60/.test(fin) || /50x60/.test(fin), 'o produto entra na lista de já inventariados');
    await tirar(page, '5-inventariados');

    // ── 6. O PDF — que é o motivo de tudo isto ──
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      page.click('text=⬇️ PDF'),
    ]);
    const destino = path.join(OUT, 'inventario.pdf');
    await download.saveAs(destino);
    ok(fs.existsSync(destino) && fs.statSync(destino).size > 1000,
       `o PDF é gerado mesmo com a contagem toda digitada: ${Math.round(fs.statSync(destino).size/1024)} KB`);

    const { txt, paginas } = await textoDoPdf(destino);
    ok(paginas >= 1, `o PDF tem ${paginas} página(s) de verdade`);
    ok(/Invent[áa]rio de Produto Acabado/.test(txt), 'com o título certo');
    ok(/1\.100/.test(txt), 'e os 1.100 kg contados aparecem dentro dele');
    ok(!/contagem manual/i.test(txt) && !/manual/i.test(txt),
       'e SEM marcar como foi contado — para quem recebe o PDF o número é o mesmo');
    console.log('\n  texto do PDF:\n    ' + txt.replace(/\s+/g, ' ').trim().slice(0, 400));

    // ── 7. O MESMO, NA LEITURA LIVRE ──
    // Na livre não há produto escolhido antes: cada lançamento precisa
    // dizer de qual produto é, senão os fardos entram no grupo errado e
    // o inventário sai trocado.
    await page.click('#bloco-pa button[onclick="paIniciarLivre()"]'); await sleep(1400);
    await page.click('#pa-chip-man'); await sleep(600);
    ok(await page.isVisible('#pa-man-produto'),
       'na leitura livre, o lançamento manual pede o produto');
    const btTexto = await page.innerText('#pa-man-add');
    ok(/ESCOLHA O PRODUTO/.test(btTexto),
       'e o botão diz o que falta, em vez de ficar mudo e desabilitado');
    await page.selectOption('#pa-man-formato', '30x40');
    await page.selectOption('#pa-man-cor', { index: 2 });
    await page.fill('#pa-man-fardos', '12');
    await page.dispatchEvent('#pa-man-fardos', 'change'); await sleep(300);
    await page.click('#pa-man-add'); await sleep(900);
    const livre = await page.innerText('#lista-livre');
    ok(/30 × 40/.test(livre), 'o lançamento entra agrupado no produto escolhido');
    ok(/300/.test(await page.innerText('#c-kg')) || /12/.test(livre),
       'com os 12 fardos · 300 kg');
    await tirar(page, '6-livre-digitado');

    // ── 8. Cabe no celular ──
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
