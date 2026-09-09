// ════════════════════════════════════════════════════════════════════
//  PROVA VISUAL DA ABA SEPARAÇÃO  (ferramenta de diagnóstico)
//  ------------------------------------------------------------------
//  Abre a tela num navegador de verdade, em tamanho de celular, e
//  percorre o caminho do operador: fotografar a guia, conferir os
//  pedidos, mexer na ordem de carregamento e ler o plano.
//
//  Suíte automatizada prova que a ROTA responde certo. Isto aqui prova
//  que a TELA funciona — que o botão existe, que o clique faz o que
//  promete e que o resultado aparece legível no tamanho do aparelho.
//
//  Uso:  node testes/_prova-separacao.js  [pasta-de-saida]
// ════════════════════════════════════════════════════════════════════
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');
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
const PORT = 13904, PORT_CB = 18904;
const BASE = `http://localhost:${PORT}`;
const C = Date.now();
const TMP_DB   = path.join(os.tmpdir(), `eko_ps_${C}.db`);
const TMP_LOGS = path.join(os.tmpdir(), `eko_ps_${C}`);
const TMP_GUIA = path.join(os.tmpdir(), `eko_psg_${C}`);
const OUT = process.argv[2] || path.join(os.tmpdir(), 'prova-separacao');
fs.mkdirSync(OUT, { recursive: true });

const { pdfDeItens } = require('./_pdf-falso.js');   // guia em matriz fabricada

const sleep = ms => new Promise(r => setTimeout(r, ms));
let servidor, falhas = 0, passos = 0;
const ok = (cond, msg) => {
  passos++;
  console.log((cond ? '  \x1b[32m✓\x1b[0m ' : '  \x1b[31m✗\x1b[0m ') + msg);
  if (!cond) falhas++;
};

// Uma "guia de separação" de mentira, só para haver o que fotografar.
function guiaFalsa() {
  const L = 800, A = 1000;
  const linhas = [
    'PEDIDOS DA SELECAO', '',
    'CLIENTE A - TERESINA/PI', '  BC 50x60 ............ 750 kg',
    'CLIENTE B - PARNAIBA/PI', '  BC 50x60 ............ 350 kg',
  ];
  // SVG -> data URL; o navegador desenha e o canvas da tela reduz.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${L}" height="${A}">
    <rect width="100%" height="100%" fill="#fff"/>
    ${linhas.map((t, i) => `<text x="40" y="${80 + i * 46}" font-family="monospace"
      font-size="26" fill="#000">${t}</text>`).join('')}</svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

async function tirar(page, nome) {
  try { await page.screenshot({ path: path.join(OUT, nome + '.png') }); } catch (e) {}
}

(async () => {
  try {
    servidor = spawn('node', [path.join(ROOT, 'server.js')], {
      env: { ...process.env, EKO_PORT: String(PORT), EKO_PORT_CB: String(PORT_CB),
             EKO_DB_FILE: TMP_DB, EKO_LOG_DIR: TMP_LOGS, EKO_GUIAS_DIR: TMP_GUIA,
             TZ: 'America/Sao_Paulo', EKO_PRINT_SIMULAR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    servidor.stdout.on('data', () => {});
    for (let i = 0; i < 75; i++) {
      try { const r = await fetch(BASE + '/healthcheck'); if (r.ok) break; } catch (e) {}
      await sleep(200);
    }

    // Estoque: 24 + 20 = 44 exatos para a demanda, e uma de 16 que não
    // deve ser tocada. É o cenário que mostra a soma exata na tela.
    const post = async (rota, corpo) => (await fetch(BASE + rota, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo) })).json();
    const gaiolas = [];
    for (const [pos, fardos] of [['01-01-001', 24], ['01-01-002', 20], ['02-01-005', 16]]) {
      const g = await post('/produto-acabado/etiqueta-gaiola',
                           { corKey: 'BC', formato: '50x60', fardos, tipo_gaiola: 'GRANDE' });
      await post('/enderecamento/ocupar', { posicao: pos, gaiola_id: g.id, tipo_gaiola: 'GRANDE' });
      gaiolas.push(g.id);
    }
    console.log(`  estoque montado: ${gaiolas.join(', ')}`);

    const browser = await chromium.launch(CHROMIUM);
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
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
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(9000);
    const erros = [];
    page.on('pageerror', e => erros.push(e.message));

    await page.goto(BASE + '/enderecamento.html', { waitUntil: 'domcontentloaded' });
    await sleep(1500);

    // ── 1. A aba existe e abre ──
    await page.click('#ab-sep');
    await sleep(700);
    ok(await page.isVisible('#pg-sep'), 'a aba SEPARAÇÃO abre');
    const abertura = await page.innerText('#sep-corpo');
    ok(/IMPORTAR A GUIA/.test(abertura), 'a ação principal é importar o PDF da guia');
    ok(/foto da guia/.test(abertura), 'a foto continua como alternativa, em segundo plano');
    await tirar(page, '1-abertura');

    // ── 1b. IMPORTAR O PDF DE VERDADE, COM O pdf.js ──
    // Este é o ponto: o navegador abre o PDF, extrai o texto e a carga
    // sai montada. Nenhuma digitação.
    // A guia REAL da fábrica: 4 cargas, 11.700 kg, formato matriz.
    const pdfGuia = fs.readFileSync(path.join(ROOT, 'testes', 'dados', 'guia-imperatriz.pdf'));
    await page.setInputFiles('#arq-pdf', {
      name: 'Guia separacao Imperatriz.pdf', mimeType: 'application/pdf', buffer: pdfGuia });
    await sleep(5000);
    const previa = await page.innerText('#sep-corpo');
    ok(/F E A LIMA/.test(previa), 'o servidor leu a guia real e a prévia mostra os clientes');
    ok(/CASA DO TEMPERO/.test(previa) && /T C DE SOUSA/.test(previa), 'as 4 cargas da guia');
    ok(/Confere com a guia/.test(previa),
       'e a tela mostra que a leitura BATE com os totais impressos no documento');
    ok(/468/.test(previa), 'os 468 fardos da guia');
    ok(/Ped\.1063/.test(previa), 'com o número do pedido de cada carga');
    await tirar(page, '1c-previa-do-pdf');

    await page.click('text=CONFERE — MONTAR A CARGA');
    await sleep(3000);
    const plano0 = await page.innerText('#sep-corpo');
    ok(/A CARREGAR/.test(plano0), 'e vai direto para o plano de coleta');
    ok(/FALTAM/.test(plano0), 'apontando o que ainda está em produção');
    await tirar(page, '1d-plano-do-pdf');
    await page.click('text=fechar'); await sleep(800);

    // ── 1e. QUANDO O PDF NÃO É RECONHECIDO, A TELA DIZ POR QUÊ ──
    // "O layout é diferente do que eu conheço" é um beco sem saída para
    // quem está no galpão: não dá para agir. A tela precisa dizer QUAL
    // peça faltou — e mostrar as que achou, para provar que leu.
    await page.click('#ab-sep'); await sleep(500);
    await page.setInputFiles('#arq-pdf', {
      name: 'guia-de-outro-sistema.pdf', mimeType: 'application/pdf',
      buffer: pdfDeItens([
        { x:  60, y: 520, t: 'RELATORIO DE CARGA - OUTRO SISTEMA' },
        { x:  60, y: 500, t: 'SACOLA SEMI-VIRGEM BRANCA (25KG)' },
        { x:  70, y: 485, t: 'TAMANHO:40X50' },
        { x: 300, y: 485, t: '40 frd' },
      ]) });
    await sleep(4000);
    const diag = await page.innerText('#sep-corpo');
    ok(/número do pedido/.test(diag),
       'a tela nomeia a peça que faltou: o número do pedido no topo da coluna');
    ok(/Ped\.1063/.test(diag), 'com um exemplo do que ela procurava');
    ok(/O que eu procurei no arquivo/.test(diag), 'e mostra a lista das quatro peças');
    ok(/produtos/.test(diag) && /quantidades/.test(diag),
       'dizendo também o que ACHOU — não é um "não entendi" cego');
    ok(/tentar outro PDF/.test(diag), 'com uma saída à mão, sem sair da tela');
    await tirar(page, '1e-diagnostico-do-pdf');
    await page.click('text=✕'); await sleep(800);

    // ── 2. Fotografar a guia ──
    // setInputFiles simula o que a câmera do celular entrega ao campo.
    const svgUrl = guiaFalsa();
    const png = await page.evaluate(async (url) => {
      // desenha o SVG num canvas e devolve PNG — é o que a câmera daria
      const img = new Image();
      await new Promise((ok2, err) => { img.onload = ok2; img.onerror = err; img.src = url; });
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      c.getContext('2d').drawImage(img, 0, 0);
      return c.toDataURL('image/png').split(',')[1];
    }, svgUrl);
    await page.setInputFiles('#arq-guia', {
      name: 'guia.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    await sleep(1800);

    ok(await page.isVisible('.guia-mini'), 'pelo caminho da foto, ela aparece no alto da conferência');
    const temImg = await page.getAttribute('.guia-mini img', 'src');
    ok(temImg && temImg.includes('/guia'), 'a miniatura aponta para a guia guardada no servidor');
    ok(await page.isVisible('.ped'), 'a conferência já nasce com um pedido para preencher');
    await tirar(page, '2-conferencia-vazia');

    // Dois arquivos: o PDF importado no passo 1b e esta foto.
    const arqs = fs.readdirSync(TMP_GUIA).sort();
    ok(arqs.length === 2 && arqs.some(a => a.endsWith('.pdf')) && arqs.some(a => a.endsWith('.jpg')),
       `guias guardadas no servidor: ${arqs.join(', ')}`);
    const bytes = fs.statSync(path.join(TMP_GUIA, arqs.find(a => a.endsWith('.jpg')))).size;
    ok(bytes > 500 && bytes < 900000, `a foto foi reduzida antes de subir: ${Math.round(bytes/1024)} KB`);

    // ── 3. Conferir dois pedidos ──
    // `.ped` são irmãos de outras divs, então nth-of-type não serve —
    // é o locator do Playwright que conta só os elementos que casam.
    const ped = i => page.locator('.ped').nth(i);
    await ped(0).locator('.ped-cli').fill('CLIENTE A');
    await ped(0).locator('.qtd').fill('750');                    // 750 kg = 30 fardos
    await page.click('text=+ PEDIDO');
    await sleep(400);
    ok(await page.locator('.ped').count() === 2, 'dá para acrescentar pedidos');
    await ped(1).locator('.ped-cli').fill('CLIENTE B');
    await ped(1).locator('.qtd').fill('350');                    // 350 kg = 14 fardos
    await tirar(page, '3-conferencia-preenchida');

    // ── 4. Ordem de carregamento ──
    const ordensAntes = await page.$$eval('.ped-ordem', ns => ns.map(n => n.textContent.trim()));
    await ped(1).locator('.btn-ic[title="Carregar antes"]').click();
    await sleep(400);
    const nomes = await page.$$eval('.ped-cli', ns => ns.map(n => n.value));
    ok(nomes[0] === 'CLIENTE B' && nomes[1] === 'CLIENTE A',
       `a seta muda a ordem de carregamento: ${nomes.join(' → ')}`);
    const ordensDepois = await page.$$eval('.ped-ordem', ns => ns.map(n => n.textContent.trim()));
    ok(ordensDepois.join() === ordensAntes.join(),
       'a numeração continua 1, 2 — quem muda é a posição, não o número');
    // volta ao original para a conferência do plano ficar previsível
    await ped(0).locator('.btn-ic[title="Carregar depois"]').click();
    await sleep(400);

    // ── 5. Gerar o plano ──
    await page.click('text=CONFERIDO — GERAR PLANO');
    await sleep(2000);
    ok(await page.isVisible('.cl'), 'o plano de coleta apareceu');
    const texto = await page.innerText('#sep-corpo');
    ok(texto.includes('01-01-001') && texto.includes('01-01-002'),
       'o plano manda nos dois endereços que somam exato');
    ok(!texto.includes('02-01-005'),
       'e NÃO encosta na terceira gaiola — a soma exata evitou abrir uma a mais');
    ok(/atende também/.test(texto),
       'a tela avisa que uma gaiola atende também o outro pedido — é o que evita abrir gaiola nova');
    ok(!/sobram \d+ fardo/.test(texto), 'sobra zero: nenhuma reetiquetagem nesta carga');
    const cards = await page.$$eval('#pg-sep .rz b', ns => ns.map(n => n.textContent.trim()));
    ok(cards[0] === '0/2' && cards[1] === '44',
       `resumo: ${cards.join(' · ')} (nenhuma das 2 coletadas, 44 fardos)`);
    await tirar(page, '4-plano');

    // ── 6. A tela cabe no celular ──
    const larg = await page.evaluate(() => Math.max(
      document.documentElement.scrollWidth, document.body.scrollWidth));
    ok(larg <= 390 + 1, `sem arrastar de lado no celular: documento com ${larg} px`);
    const pequenos = await page.$$eval('#pg-sep button, #pg-sep input, #pg-sep select', els =>
      els.filter(e => {
        const b = e.getBoundingClientRect();
        return b.width > 0 && b.height > 0 && b.height < 44;
      }).map(e => (e.id || e.className) + '=' + Math.round(e.getBoundingClientRect().height)));
    ok(pequenos.length === 0, `nenhum alvo de toque abaixo de 44 px${pequenos.length ? ': ' + pequenos.join(', ') : ''}`);

    // ── 7. Voltar, corrigir e refazer ──
    await page.click('text=corrigir a guia');
    await sleep(600);
    ok(await page.isVisible('.ped'), 'dá para voltar à conferência e corrigir');
    await page.click('text=CONFERIDO — GERAR PLANO');
    await sleep(1800);
    ok(await page.isVisible('.cl'),
       'e gerar o plano de novo — corrigir a guia continua livre enquanto ninguém coletou');

    // ── 8. Reabrir uma separação já criada ──
    await page.click('.guia-mini .btn');       // fecha
    await sleep(600);
    ok(await page.isVisible('.foto-alvo'), 'fechando, volta para a tela de fotografar');
    const recentes = await page.innerText('#sep-corpo');
    ok(recentes.includes('SEPARAÇÕES RECENTES'), 'a separação aberta fica listada para retomar');
    await page.locator('#pg-sep .hist-item').first().click();
    await sleep(1200);
    ok(await page.isVisible('.ped') || await page.isVisible('.cl'), 'e reabre de onde parou');
    await tirar(page, '5-lista');

    // ── 9. O CICLO COMPLETO: bipar, sobra, etiqueta nova ──
    // Nova separação com uma sobra garantida (pede 30, gaiolas de 24 e 20)
    // e um produto que ainda está em produção.
    await page.click('#ab-sep'); await sleep(400);
    if (await page.isVisible('.guia-mini .btn')) { await page.click('.guia-mini .btn'); await sleep(500); }
    await page.setInputFiles('#arq-guia', {
      name: 'guia2.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    await sleep(1600);
    await ped(0).locator('.ped-cli').fill('CLIENTE C');
    await ped(0).locator('.qtd').fill('750');                    // 30 fardos de BC 50x60
    await page.click('text=+ item'); await sleep(400);
    // segundo item: um formato que NÃO existe no galpão — é o "em produção"
    await ped(0).locator('.sel-fmt').nth(1).selectOption('80x100');
    await ped(0).locator('.qtd').nth(1).fill('250');             // 10 fardos que não existem
    await page.click('text=CONFERIDO — GERAR PLANO');
    await sleep(2200);

    const t2 = await page.innerText('#sep-corpo');
    ok(/FALTAM 10 FARDO/.test(t2), 'a tela avisa em destaque o que ainda está em produção');
    ok(/QUEM FICA FALTANDO/.test(t2) && /CLIENTE C/.test(t2), 'e diz de qual pedido é a falta');
    ok(/80x100/.test(t2), 'nomeando o produto que falta');
    ok(await page.isVisible('#btn-cam-sep'), 'o botão de bipar a coleta está na tela');
    await tirar(page, '6-falta-em-producao');

    // Bipe manual da primeira coleta (a câmera não existe no navegador de teste)
    const antesMapa = await (await fetch(BASE + '/enderecamento/mapa')).json();
    const ocupadasAntes = antesMapa.posicoes.filter(p => p.ocupada).length;
    await page.locator('text=✓ COLETEI').first().click();
    await sleep(1600);
    const t3 = await page.innerText('#sep-msg');
    ok(/liberado no mapa|Sobram/.test(t3), `confirmar a coleta responde na tela: ${t3.slice(0, 60)}`);
    const depoisMapa = await (await fetch(BASE + '/enderecamento/mapa')).json();
    ok(depoisMapa.posicoes.filter(p => p.ocupada).length === ocupadasAntes - 1,
       'e o endereço saiu do mapa na hora — a baixa é automática');
    await tirar(page, '7-coletada');

    // A segunda coleta deixa sobra (24+20=44 para 30 → sobra 14)
    if (await page.isVisible('text=✓ COLETEI')) {
      await page.locator('text=✓ COLETEI').first().click();
      await sleep(1600);
    }
    await tirar(page, '8-com-sobra');

    // ── 10. A aba SOBRAS ──
    await page.click('#ab-sob'); await sleep(1200);
    const t4 = await page.innerText('#sob-corpo');
    ok(/fardo\(s\)/.test(t4) && /Endereço sugerido/.test(t4),
       'a aba SOBRAS lista a pendência com o endereço sugerido');
    ok(/01-/.test(t4), 'o endereço sugerido é um vão de verdade');
    await tirar(page, '9-sobras');

    await page.click('text=IMPRIMIR ETIQUETA'); await sleep(1800);
    const t5 = await page.innerText('#sob-msg');
    ok(/Etiqueta G\d{7}/.test(t5), `a etiqueta nova foi gerada: ${t5.slice(0, 80)}`);
    ok(/fardo/.test(t5), 'com a quantidade nova');
    await tirar(page, '10-etiqueta-nova');

    const sobras = await (await fetch(BASE + '/sobras')).json();
    const nova = sobras.sobras[0];
    // endereça a etiqueta nova pelo caminho normal, como o operador faria
    const okEnd = await (await fetch(BASE + '/enderecamento/ocupar', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ posicao: nova.posicao_sugerida, gaiola_id: nova.gaiola_nova }) })).json();
    ok(okEnd.ok && okEnd.sobra && okEnd.sobra.id === nova.id,
       'endereçar a etiqueta nova fecha a pendência sozinho');
    await page.click('#ab-sob'); await sleep(1000);
    ok(/Nada pendente/.test(await page.innerText('#sob-corpo')), 'a fila de sobras esvaziou');

    ok(erros.length === 0, `nenhum erro de página${erros.length ? ': ' + erros.slice(0, 3).join(' | ') : ''}`);

    await browser.close();
  } catch (e) {
    falhas++;
    console.error('\n\x1b[31mERRO:\x1b[0m', e.stack || e.message);
  } finally {
    console.log('\n═══════════════════════════════════════════════════');
    console.log(` RESULTADO: ${passos - falhas} de ${passos} · prints em ${OUT}`);
    console.log('═══════════════════════════════════════════════════');
    try { servidor && servidor.kill('SIGKILL'); } catch (e) {}
    for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.rmSync(f, { force: true }); } catch (e) {} }
    for (const d of [TMP_LOGS, TMP_GUIA]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }
    setTimeout(() => process.exit(falhas ? 1 : 0), 200);
  }
})();
