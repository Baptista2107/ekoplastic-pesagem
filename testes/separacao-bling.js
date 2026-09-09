// ════════════════════════════════════════════════════════════════════
//  SEPARAÇÃO A PARTIR DOS PEDIDOS DO BLING
//  ------------------------------------------------------------------
//  A guia de separação é um RETRATO de um dado que já existe: sai do
//  painel de carteira, que existe porque os pedidos estão no Bling.
//  Fotografar a guia obrigava a redigitar a carga inteira — o oposto
//  de automação.
//
//  Aqui se prova que a estação lê os pedidos na fonte: quantidade
//  exata, sem OCR e sem digitação. E, principalmente, que item que ela
//  NÃO souber traduzir não some calado.
//
//  Um Bling de mentira sobe em localhost e o servidor fala HTTP com
//  ele (EKO_BLING_INSEGURO=1) — mesmo padrão da suíte bling-endpoint.
// ════════════════════════════════════════════════════════════════════
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');

const ROOT = path.join(__dirname, '..');
const PORT = 13906, PORT_CB = 18906;
const BASE = `http://localhost:${PORT}`;
const C = Date.now();
const TMP_DB   = path.join(os.tmpdir(), `eko_sb_${C}.db`);
const TMP_LOGS = path.join(os.tmpdir(), `eko_sb_${C}`);
const TMP_GUIA = path.join(os.tmpdir(), `eko_sbg_${C}`);
const TMP_TOK  = path.join(os.tmpdir(), `eko_sb_tok_${C}.json`);

let passou = 0, falhou = 0, servidor, blingFake;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function ok(cond, msg, extra) {
  if (cond) { passou++; console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
  else { falhou++; console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
         if (extra !== undefined) console.log('      →', JSON.stringify(extra).slice(0, 300)); }
}
async function req(metodo, rota, corpo) {
  const opc = { method: metodo, headers: {} };
  if (corpo !== undefined) { opc.body = JSON.stringify(corpo); opc.headers['Content-Type'] = 'application/json'; }
  const r = await fetch(BASE + rota, opc);
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, body: j };
}

// ── Pedidos que o Bling de mentira devolve ──
// Descrições e SKUs no formato real da fábrica.
const PEDIDOS = {
  9001: { id: 9001, numero: 1201, data: '2026-09-08', total: 7700,
    contato: { nome: 'ILHA PLASTIC COMERCIO', endereco: { municipio: 'Teresina', uf: 'PI' } },
    itens: [
      { codigo: 'BC.5060.5K', descricao: 'SACOLA SEMI VIRGEM BRANCA 50X60 (LEITOSA)', quantidade: 750 },
      { codigo: 'PT.4050.5K', descricao: 'SACOLA RECICLADA PRETA 40X50', quantidade: 500 },
    ] },
  9002: { id: 9002, numero: 1202, data: '2026-09-08', total: 3000,
    contato: { nome: 'EMBALO EMBALAGENS', endereco: { municipio: 'Parnaiba', uf: 'PI' } },
    itens: [
      // SEM código: tem que cair na descrição e ainda assim ser reconhecido
      { codigo: '', descricao: 'SACOLA SEMI VIRGEM BRANCA 50X60 (LEITOSA)', quantidade: 350 },
      // Produto que NÃO é do galpão: tem que voltar como não reconhecido
      { codigo: 'XX.9999.9K', descricao: 'BOBINA TECNICA 1,60M 6 MICRAS', quantidade: 120 },
    ] },
  9003: { id: 9003, numero: 1203, data: '2026-09-07', total: 1000,
    contato: { nome: 'CLIENTE JA FATURADO', endereco: { municipio: 'Timon', uf: 'MA' } },
    itens: [{ codigo: 'AM.3040.5K', descricao: 'SACOLA SEMI VIRGEM AMARELA 30X40', quantidade: 250 }] },
};

function subirBlingFake() {
  return new Promise(resolve => {
    const s = http.createServer((r, res) => {
      const responder = (cod, obj) => {
        res.writeHead(cod, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (r.url.startsWith('/Api/v3/oauth/token')) {
        let b = ''; r.on('data', c => b += c);
        return r.on('end', () => responder(200,
          { access_token: 'tok-' + Date.now(), refresh_token: 'refresh-fake', expires_in: 21600 }));
      }
      const mDet = r.url.match(/^\/Api\/v3\/pedidos\/vendas\/(\d+)/);
      if (mDet) {
        const p = PEDIDOS[mDet[1]];
        return p ? responder(200, { data: p }) : responder(404, { error: 'nao existe' });
      }
      if (r.url.startsWith('/Api/v3/pedidos/vendas')) {
        const pagina = Number((r.url.match(/pagina=(\d+)/) || [])[1] || 1);
        if (pagina > 1) return responder(200, { data: [] });
        return responder(200, { data: [
          { ...PEDIDOS[9001], notaFiscal: null },
          { ...PEDIDOS[9002], notaFiscal: null },
          // já faturado — não pode aparecer para separar
          { ...PEDIDOS[9003], notaFiscal: { id: 55512 } },
          // pedido interno de produção — também não é carga de cliente
          { id: 9004, numero: 1204, data: '2026-09-06', notaFiscal: null,
            contato: { nome: 'SACOLEIRAS EKOPLASTIC' }, itens: [] },
        ] });
      }
      responder(404, { error: 'rota nao mapeada: ' + r.url });
    });
    s.listen(0, '127.0.0.1', () => resolve({ servidor: s, porta: s.address().port }));
  });
}

async function endereçar(posicao, corKey, formato, fardos) {
  const g = await req('POST', '/produto-acabado/etiqueta-gaiola',
                      { corKey, formato, fardos, tipo_gaiola: 'GRANDE' });
  await req('POST', '/enderecamento/ocupar',
            { posicao, gaiola_id: g.body.id, tipo_gaiola: 'GRANDE' });
  return g.body.id;
}

(async () => {
  try {
    console.log('\n═══════════════════════════════════════════════════');
    console.log(' SEPARAÇÃO A PARTIR DO BLING — Ekoplastic');
    console.log('═══════════════════════════════════════════════════\n');

    const fake = await subirBlingFake();
    blingFake = fake.servidor;
    console.log(`Bling de mentira em localhost:${fake.porta}`);
    fs.writeFileSync(TMP_TOK, JSON.stringify({
      accessToken: 'tok-inicial', refreshToken: 'refresh-fake',
      expiresAt: Date.now() + 3600000 }));

    servidor = spawn('node', [path.join(ROOT, 'server.js')], {
      env: { ...process.env, EKO_PORT: String(PORT), EKO_PORT_CB: String(PORT_CB),
             EKO_DB_FILE: TMP_DB, EKO_LOG_DIR: TMP_LOGS, EKO_GUIAS_DIR: TMP_GUIA,
             EKO_TOKEN_FILE: TMP_TOK, EKO_BLING_INSEGURO: '1',
             TZ: 'America/Sao_Paulo', EKO_PRINT_SIMULAR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    servidor.stdout.on('data', () => {});
    for (let i = 0; i < 75; i++) {
      try { const r = await fetch(BASE + '/healthcheck'); if (r.ok) break; } catch (e) {}
      await sleep(200);
    }
    await req('POST', '/config', { bling_host_api: 'localhost:' + fake.porta });

    // ── [1] LISTAR OS PEDIDOS EM ABERTO ─────────────────────────────
    console.log('[1] A estação lê os pedidos na fonte, sem foto nenhuma');
    const lst = await req('GET', '/separacao/bling/pedidos?dias=60');
    ok(lst.status === 200 && Array.isArray(lst.body.pedidos), 'a lista veio do Bling', lst.body);
    const ids = (lst.body.pedidos || []).map(p => p.bling_id);
    ok(ids.includes(9001) && ids.includes(9002), `traz os pedidos em aberto: ${ids.join(', ')}`);
    ok(!ids.includes(9003), 'e NÃO traz pedido já faturado — esse já saiu da fábrica');
    ok(!ids.includes(9004), 'nem o pedido interno de produção (SACOLEIRAS)');
    const p1 = lst.body.pedidos.find(p => p.bling_id === 9001);
    ok(p1 && p1.cliente === 'ILHA PLASTIC COMERCIO', 'com o nome do cliente pronto para escolher');

    // ── [2] OS ITENS TRADUZIDOS PARA O GALPÃO ───────────────────────
    console.log('\n[2] Os itens do Bling viram cor e formato do galpão');
    const det = await req('GET', '/separacao/bling/pedido/9001');
    const it = det.body.pedido.itens;
    ok(it[0].reconhecido && it[0].cor_key === 'BC' && it[0].formato === '50x60',
       `pela SKU: ${it[0].codigo} → ${it[0].cor_key} ${it[0].formato}`);
    ok(it[0].kg === 750 && it[0].fardos === 30, '750 kg viram 30 fardos, sem ninguém dividir na mão');
    ok(it[0].via === 'sku', 'reconhecido pela SKU, que é o caminho exato');
    const det2 = await req('GET', '/separacao/bling/pedido/9002');
    const it2 = det2.body.pedido.itens;
    ok(it2[0].reconhecido && it2[0].via === 'descricao' && it2[0].formato === '50x60',
       'item SEM código ainda é reconhecido pela descrição');
    ok(!it2[1].reconhecido && /não reconheci/.test(it2[1].motivo || ''),
       `produto que não é do galpão volta marcado: ${it2[1].motivo}`);
    ok(det.body.pedido.cidade === 'Teresina' && det.body.pedido.uf === 'PI',
       'cidade e UF vêm junto, para a ordem de carregamento');

    // ── [3] MONTAR A CARGA — ZERO DIGITAÇÃO ─────────────────────────
    console.log('\n[3] A carga é montada só marcando os pedidos');
    const cri = await req('POST', '/separacao/de-bling', { pedidos: [
      { bling_id: 9002, ordem: 1 },   // Parnaíba primeiro a carregar
      { bling_id: 9001, ordem: 2 },
    ], operador: 'FREDERICO' });
    ok(cri.status === 200 && cri.body.id, 'a separação nasceu direto do Bling', cri.body);
    const SEP = cri.body.id;
    ok(cri.body.status === 'conferida', 'já nasce CONFERIDA — não há o que conferir, o dado é da fonte');
    ok(cri.body.nao_reconhecidos.length === 1,
       'o item não reconhecido é reportado em vez de sumir calado', cri.body.nao_reconhecidos);
    ok(/BOBINA/.test(cri.body.nao_reconhecidos[0].descricao || ''),
       'dizendo qual item e de qual cliente');

    const est = await req('GET', `/separacao/${SEP}`);
    const peds = est.body.pedidos;
    ok(peds.length === 2, 'dois pedidos gravados');
    ok(peds[0].ordem === 1 && peds[0].cliente === 'EMBALO EMBALAGENS',
       'a ordem de carregamento é a que o gestor escolheu, não a do Bling');
    const somaFardos = peds.reduce((a, p) => a + p.itens.reduce((x, i) => x + i.fardos, 0), 0);
    ok(somaFardos === 14 + 30 + 20, `as quantidades vieram exatas do Bling: ${somaFardos} fardos`);
    ok(!peds.some(p => p.itens.some(i => i.formato === '9999')), 'e o item estranho não entrou');

    // ── [4] O PLANO SAI DIRETO, SEM PASSO MANUAL ────────────────────
    console.log('\n[4] Do Bling ao plano de coleta, sem digitar nada');
    await endereçar('01-01-001', 'BC', '50x60', 24);
    await sleep(5);
    await endereçar('01-01-002', 'BC', '50x60', 20);
    await endereçar('01-01-003', 'PT', '40x50', 20);
    const pl = await req('POST', `/separacao/${SEP}/planejar`);
    ok(pl.status === 200 && pl.body.coletas.length > 0, 'plano gerado', pl.body && pl.body.erro);
    ok(pl.body.falta.fardos === 0, 'nada faltando: o galpão cobre a carga');
    const compart = pl.body.coletas.filter(c => Object.keys(c.reparticao).length > 1);
    ok(compart.length === 1, 'e o alocador continua achando a gaiola que serve os dois pedidos');

    // ── [5] A FOTO VIRA COMPROVANTE, NÃO FONTE ──────────────────────
    console.log('\n[5] A foto da guia continua possível — como comprovante');
    const foto = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(2048, 0x20)]);
    const anex = await fetch(`${BASE}/separacao/${SEP}/guia`,
      { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: foto });
    const aj = await anex.json();
    ok(anex.status === 200 && aj.arquivo, 'dá para anexar a guia depois, como registro', aj);
    const volta = await fetch(`${BASE}/separacao/${SEP}/guia`);
    ok(volta.status === 200, 'e ela volta pela mesma rota de sempre');

    // ── [6] BLING FORA DO AR NÃO TRAVA A OPERAÇÃO ───────────────────
    console.log('\n[6] Se o Bling não responder, o caminho manual continua');
    await new Promise(r => blingFake.close(r));
    blingFake = null;
    const semBling = await req('GET', '/separacao/bling/pedidos');
    ok(semBling.status === 502 && /Bling/.test(semBling.body.erro || ''),
       'a estação diz claramente que não falou com o Bling', semBling.body);
    const fotoNova = await fetch(`${BASE}/separacao/nova`,
      { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: foto });
    ok(fotoNova.status === 200, 'e a separação pela foto continua funcionando como plano B');

  } catch (e) {
    falhou++;
    console.error('\n\x1b[31mERRO NO TESTE:\x1b[0m', e.stack || e.message);
  } finally {
    console.log('\n═══════════════════════════════════════════════════');
    console.log(` RESULTADO: ${passou} passou, ${falhou} falhou`);
    console.log('═══════════════════════════════════════════════════\n');
    try { servidor && servidor.kill('SIGKILL'); } catch (e) {}
    try { blingFake && blingFake.close(); } catch (e) {}
    for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm', TMP_TOK]) { try { fs.rmSync(f, { force: true }); } catch (e) {} }
    for (const d of [TMP_LOGS, TMP_GUIA]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }
    setTimeout(() => process.exit(falhou ? 1 : 0), 200);
  }
})();
