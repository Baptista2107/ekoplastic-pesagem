// ════════════════════════════════════════════════════════════════════
//  MEDIDOR DE TELA NO CELULAR  (ferramenta de diagnóstico)
//  Abre cada tela do sistema num navegador de verdade, em vários
//  tamanhos de celular, e mede o que quebra:
//   · rolagem horizontal (o "tem que arrastar de lado")
//   · conteúdo cortado por altura fixa
//   · botões menores que o dedo (mínimo 44px, guia da Apple/Google)
//   · texto miúdo demais (menos de 12px)
//   · uso de 100vh, que no celular conta a barra de endereço
//
//  Uso:  node testes/_medir-celular.js  [pasta-de-saida]
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
const PORT = 13998, PORT_CB = 18998;
const BASE = `http://localhost:${PORT}`;
const C = Date.now();
const TMP_DB = path.join(os.tmpdir(), `eko_med_${C}.db`);
const TMP_LOGS = path.join(os.tmpdir(), `eko_med_${C}`);
const OUT = process.argv[2] || path.join(os.tmpdir(), 'medir-celular');
fs.mkdirSync(OUT, { recursive: true });

// Tamanhos reais, do menor celular ainda em uso ao maior comum.
const APARELHOS = [
  { nome: 'pequeno',  larg: 320, alt: 568 },   // iPhone SE 1a ger. / Android antigo
  { nome: 'comum',    larg: 375, alt: 667 },   // iPhone SE 2/3, base do mercado
  { nome: 'medio',    larg: 390, alt: 844 },   // iPhone 13/14/15
  { nome: 'grande',   larg: 430, alt: 932 },   // iPhone Pro Max
  { nome: 'android',  larg: 412, alt: 915 },   // Galaxy / Pixel
];

// As cinco que o Frederico confirmou que sao abertas pelo celular, mais
// as ja' responsivas como controle (elas nao podem piorar).
const TELAS = (process.env.TELAS || '').split(',').filter(Boolean).length
  ? process.env.TELAS.split(',')
  : ['index.html', 'outras-pesagens.html', 'produto-acabado.html',
     'manutencao.html', 'dashboard.html',
     'enderecamento.html', 'inventario.html', 'retirada-bobinas.html'];

const sleep = ms => new Promise(r => setTimeout(r, ms));
let servidor;

async function medir(frame, largJanela) {
  return await frame.evaluate((largJanela) => {
    const r = { larguraDoc: 0, overflowX: 0, culpados: [], alvosPequenos: 0, alvos: [],
                textoMiudo: 0, miudos: [], cortados: 0, fora: 0 };
    const doc = document.documentElement;
    r.larguraDoc = Math.max(doc.scrollWidth, document.body ? document.body.scrollWidth : 0);
    r.overflowX = Math.max(0, r.larguraDoc - largJanela);

    // Quem está estourando a largura da janela. Conta SEMPRE (não só quando
    // scrollWidth acusa) — assim um overflow-x:hidden no body não esconde o
    // problema da medição.
    {
      for (const el of document.querySelectorAll('body *')) {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        const b = el.getBoundingClientRect();
        if (b.width === 0 && b.height === 0) continue;
        if (b.right > largJanela + 1) {
          // ignora quem rola dentro de um container próprio (isso é ok)
          let pai = el.parentElement, contido = false;
          while (pai && pai !== document.body) {
            const ps = getComputedStyle(pai);
            if (ps.overflowX === 'auto' || ps.overflowX === 'scroll') { contido = true; break; }
            pai = pai.parentElement;
          }
          if (contido) continue;
          r.fora++;
          const id = el.id ? '#' + el.id : '';
          const cls = (el.className && typeof el.className === 'string')
            ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
          const chave = el.tagName.toLowerCase() + id + cls;
          if (!r.culpados.includes(chave) && r.culpados.length < 6) r.culpados.push(chave);
        }
      }
    }

    // Alvos de toque pequenos e texto miúdo
    for (const el of document.querySelectorAll('button, a, input, select, .opt, .vao, .chip, .cor-btn, .fmt-btn, .maq-btn, .quick-btn, .touch-btn, .btn, .btn-icon, .btn-ic')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const b = el.getBoundingClientRect();
      if (b.width === 0 && b.height === 0) continue;
      const chave = el.tagName.toLowerCase()
        + (el.id ? '#' + el.id : '')
        + ((el.className && typeof el.className === 'string')
            ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
      if (b.height < 44 || b.width < 40) {
        r.alvosPequenos++;
        if (!r.alvos.includes(chave) && r.alvos.length < 12) r.alvos.push(chave + '=' + Math.round(b.width) + 'x' + Math.round(b.height));
      }
      const fs2 = parseFloat(cs.fontSize) || 0;
      if (fs2 && fs2 < 12) {
        r.textoMiudo++;
        if (!r.miudos.includes(chave) && r.miudos.length < 12) r.miudos.push(chave + '=' + fs2 + 'px');
      }
    }

    // Conteúdo cortado: elemento com overflow hidden e filho maior
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      if (cs.overflow === 'hidden' || cs.overflowY === 'hidden') {
        if (el.scrollHeight > el.clientHeight + 4 && el.clientHeight > 40) r.cortados++;
      }
    }
    return r;
  }, largJanela);
}

(async () => {
  const erros = [];
  const linhas = [];
  try {
    servidor = spawn('node', [path.join(ROOT, 'server.js')], {
      env: { ...process.env, EKO_PORT: String(PORT), EKO_PORT_CB: String(PORT_CB),
             EKO_DB_FILE: TMP_DB, EKO_LOG_DIR: TMP_LOGS, TZ: 'America/Sao_Paulo', EKO_PRINT_SIMULAR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    servidor.stdout.on('data', () => {});
    for (let i = 0; i < 75; i++) { try { const r = await fetch(BASE + '/healthcheck'); if (r.ok) break; } catch (e) {} await sleep(200); }

    const browser = await chromium.launch(CHROMIUM);

    for (const ap of APARELHOS) {
      const ctx = await browser.newContext({
        viewport: { width: ap.larg, height: ap.alt },
        deviceScaleFactor: 2, isMobile: true, hasTouch: true,
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      });
      await ctx.route('**', r => {
        const u = r.request().url();
        return (u.startsWith(BASE) || u.startsWith('data:') || u.startsWith('blob:')) ? r.continue() : r.abort();
      });
      await ctx.addInitScript(() => {
        const lib = JSON.stringify({ nome: 'Medicao', id: 1, ts: Date.now() });
        try { for (const t of ['mp','pa','bobinas']) sessionStorage.setItem('eko_liberado_' + t, lib); } catch (e) {}
      });
      const page = await ctx.newPage();
      page.setDefaultTimeout(9000);
      page.on('pageerror', e => erros.push(`${ap.nome}: pageerror ${e.message}`));

      for (const tela of TELAS) {
        try { await page.goto(`${BASE}/${tela}`, { waitUntil: 'domcontentloaded', timeout: 15000 }); } catch (e) {}
        await sleep(1600);
        // A tela pode abrir dentro do casco (index + iframe)
        let f = page.frames().find(x => x.url().includes(tela) && x !== page.mainFrame()) || page.mainFrame();
        let m;
        try { m = await medir(f, ap.larg); } catch (e) { m = { erro: e.message }; }
        linhas.push({ aparelho: ap.nome, larg: ap.larg, tela, ...m });
        if (ap.nome === 'comum') {
          try { await page.screenshot({ path: path.join(OUT, `${tela.replace('.html','')}-375.png`) }); } catch (e) {}
        }
      }
      await ctx.close();
    }
    await browser.close();

    // ── Relatório ──
    console.log('\n════════ ROLAGEM HORIZONTAL (px estourados) ════════');
    console.log('tela'.padEnd(30) + APARELHOS.map(a => (a.nome + '/' + a.larg).padStart(13)).join(''));
    for (const tela of TELAS) {
      const cel = APARELHOS.map(a => {
        const l = linhas.find(x => x.tela === tela && x.aparelho === a.nome);
        return String(l && l.overflowX ? '+' + l.overflowX : (l ? 'ok' : '?')).padStart(13);
      }).join('');
      console.log(tela.padEnd(30) + cel);
    }

    console.log('\n════════ CULPADOS DO ESTOURO (celular comum, 375) ════════');
    for (const tela of TELAS) {
      const l = linhas.find(x => x.tela === tela && x.aparelho === 'comum');
      if (l && l.overflowX > 1) console.log(`  ${tela.padEnd(30)} +${l.overflowX}px  ${(l.culpados||[]).join('  ')}`);
    }

    console.log('\n════════ ELEMENTOS PARA FORA DA TELA (contagem, 375) ════════');
    for (const tela of TELAS) {
      const l = linhas.find(x => x.tela === tela && x.aparelho === 'comum');
      if (l && l.fora) console.log(`  ${tela.padEnd(30)} ${String(l.fora).padStart(4)} elemento(s)`);
    }

    console.log('\n════════ DETALHE DOS ALVOS PEQUENOS E TEXTO MIÚDO (375) ════════');
    for (const tela of TELAS) {
      const l = linhas.find(x => x.tela === tela && x.aparelho === 'comum');
      if (!l) continue;
      if (l.alvos && l.alvos.length)  console.log(`  ${tela}\n     alvos:  ${l.alvos.join('  ')}`);
      if (l.miudos && l.miudos.length) console.log(`     texto:  ${l.miudos.join('  ')}`);
    }

    console.log('\n════════ ALVOS DE TOQUE PEQUENOS / TEXTO MIÚDO / CORTADO (375) ════════');
    console.log('tela'.padEnd(30) + 'alvos<44'.padStart(10) + 'texto<12'.padStart(10) + 'cortado'.padStart(9));
    for (const tela of TELAS) {
      const l = linhas.find(x => x.tela === tela && x.aparelho === 'comum');
      if (!l) continue;
      console.log(tela.padEnd(30) + String(l.alvosPequenos).padStart(10) + String(l.textoMiudo).padStart(10) + String(l.cortados).padStart(9));
    }

    fs.writeFileSync(path.join(OUT, 'medicao.json'), JSON.stringify(linhas, null, 1));
    console.log('\nprints e medicao.json em ' + OUT);
    if (erros.length) { console.log('\nERROS DE PÁGINA:'); [...new Set(erros)].slice(0, 10).forEach(e => console.log('  - ' + e)); }
  } catch (e) {
    console.error('ERRO:', e.stack || e.message);
    process.exitCode = 1;
  } finally {
    try { servidor && servidor.kill('SIGKILL'); } catch (e) {}
    for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.rmSync(f, { force: true }); } catch (e) {} }
    try { fs.rmSync(TMP_LOGS, { recursive: true, force: true }); } catch (e) {}
    setTimeout(() => process.exit(process.exitCode || 0), 200);
  }
})();
