// ════════════════════════════════════════════════════════════════════
//  PURGA — KG INDICADO, DE 5 EM 5 KG ATÉ 25 (15/10/2026)
//  ------------------------------------------------------------------
//  O Vinicius criou pela tela "Aditivo - Purga" (sacos de 25 kg, sem
//  fornecedor). O saco vem com 25 kg, 20 kg...: entra e sai por kg
//  indicado, num contador de 5 em 5 kg até 25 (cada item = um saco).
//  Fornecedor GILFLEX (contato 18292263741, produto 16719768728).
// ════════════════════════════════════════════════════════════════════
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const http = require('node:http');
const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');

const ROOT = path.join(__dirname, '..');
const PORT = 13941, PORT_CB = 18941;
const BASE = `http://localhost:${PORT}`;
const C = Date.now();
const DB1  = path.join(os.tmpdir(), `eko_pg_${C}.db`);
const DB2  = path.join(os.tmpdir(), `eko_pg2_${C}.db`);
const LOGS = path.join(os.tmpdir(), `eko_pg_${C}`);
const TOK  = path.join(os.tmpdir(), `eko_pg_tok_${C}.json`);

let passou = 0, falhou = 0, servidor = null, fake, portaFake = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function ok(cond, msg, extra) {
  if (cond) { passou++; console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
  else { falhou++; console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
         if (extra !== undefined) console.log('      →', JSON.stringify(extra).slice(0, 600)); }
}
async function req(metodo, rota, corpo) {
  const opc = { method: metodo, headers: {} };
  if (corpo !== undefined) { opc.body = JSON.stringify(corpo); opc.headers['Content-Type'] = 'application/json'; }
  const r = await fetch(BASE + rota, opc);
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, body: j };
}
function comBanco(arq, fn) { const db = new DatabaseSync(arq); try { return fn(db); } finally { db.close(); } }
const cfg = (arq, k) => comBanco(arq, db => { const r = db.prepare('SELECT valor FROM config WHERE chave = ?').get(k); return r ? JSON.parse(r.valor) : null; });
const cfgSet = (arq, k, v) => comBanco(arq, db => db.prepare('INSERT OR REPLACE INTO config (chave, valor) VALUES (?, ?)').run(k, JSON.stringify(v)));
const cfgDel = (arq, k) => comBanco(arq, db => db.prepare('DELETE FROM config WHERE chave = ?').run(k));

// Bling de mentira: só registra os pedidos para conferir o que foi mandado.
const pedidos = [];
function subirFake() {
  return new Promise(resolve => {
    fake = http.createServer((r, res) => {
      let corpo = '';
      r.on('data', c => corpo += c);
      r.on('end', () => {
        const responder = (st, obj) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
        if (r.url.startsWith('/Api/v3/oauth/token'))
          return responder(200, { access_token: 'tok', refresh_token: 'refresh-fake', expires_in: 21600 });
        if (r.method === 'POST' && r.url.startsWith('/Api/v3/pedidos/')) {
          let b = {}; try { b = JSON.parse(corpo); } catch (e) {}
          pedidos.push({ rota: r.url, corpo: b });
          return responder(201, { data: { id: 800000 + pedidos.length } });
        }
        return responder(200, { data: [] });
      });
    });
    fake.listen(0, '127.0.0.1', () => { portaFake = fake.address().port; resolve(); });
  });
}

async function subir(arqDb) {
  if (!fs.existsSync(TOK))
    fs.writeFileSync(TOK, JSON.stringify({ accessToken: 'tok', refreshToken: 'refresh-fake', expiresAt: Date.now() + 3600e3 }));
  servidor = spawn('node', [path.join(ROOT, 'server.js')], {
    env: { ...process.env, EKO_PORT: String(PORT), EKO_PORT_CB: String(PORT_CB),
           EKO_DB_FILE: arqDb, EKO_LOG_DIR: LOGS, EKO_TOKEN_FILE: TOK,
           TZ: 'America/Sao_Paulo', EKO_PRINT_SIMULAR: '1', EKO_BLING_INSEGURO: '1',
           BLING_CLIENT_ID: 'id-teste', BLING_CLIENT_SECRET: 'segredo-teste' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  servidor.stdout.on('data', () => {}); servidor.stderr.on('data', () => {});
  for (let i = 0; i < 75; i++) {
    try { const r = await fetch(BASE + '/healthcheck'); if (r.ok) return; } catch (e) {}
    await sleep(200);
  }
  throw new Error('servidor não subiu');
}
async function derrubar() {
  if (!servidor) return;
  const p = servidor; servidor = null;
  await new Promise(r => { p.once('exit', r); p.kill('SIGKILL'); setTimeout(r, 3000); });
}

(async () => {
  try {
    console.log('\n═══════════════════════════════════════════════════');
    console.log(' PURGA — KG INDICADO · GILFLEX');
    console.log('═══════════════════════════════════════════════════\n');
    await subirFake();

    // banco como o da estação: PURGA por kg indicado (5 em 5 kg até 25),
    // fornecedor GILFLEX, mapas do Bling e código PG1
    await subir(DB1);
    await derrubar();
    const m0 = cfg(DB1, 'mp_materiais') || {};
    m0.PURGA = { popular: 'Aditivo - Purga', nomeEtiqueta: 'ADITIVO - PURGA', cores: [], corLabel: {},
                 porSacos: true, kgPorSaco: 5, kgIndicado: true, kgMax: 25, apelidos: ['ADITIVO -  PURGA'],
                 criadoEm: '2026-10-15T17:37:23.069Z', origem: 'cadastros-bling' };
    cfgSet(DB1, 'mp_materiais', m0);
    const f0 = cfg(DB1, 'mp_fornecedores') || {}; f0.PURGA = ['GILFLEX']; cfgSet(DB1, 'mp_fornecedores', f0);
    const mf0 = cfg(DB1, 'mapa_fornecedor_bling') || {}; mf0.GILFLEX = '18292263741'; cfgSet(DB1, 'mapa_fornecedor_bling', mf0);
    const mp0 = cfg(DB1, 'mapa_produto_bling') || {}; mp0['PURGA::GILFLEX'] = '16719768728'; cfgSet(DB1, 'mapa_produto_bling', mp0);
    const cg0 = cfg(DB1, 'mp_codigos_gravimetricos') || [];
    cg0.push({ matKey: 'PURGA', cor: null, forn: 'GILFLEX', codigo: 'PG1' }); cfgSet(DB1, 'mp_codigos_gravimetricos', cg0);

    await subir(DB1);
    await req('POST', '/config', { bling_simular: '0', bling_host_api: 'localhost:' + portaFake,
                                   bling_host_oauth: 'localhost:' + portaFake });

    console.log('[1] Retirada e retorno por kg indicado');
    const sRet = (await req('POST', '/sessoes', { tipo: 'retirada', operador: 'Teste' })).body.sessao_id;
    const r1 = await req('POST', '/retirada/aditivo', { sessao_id: sRet, materialKey: 'PURGA', fornecedor: 'GILFLEX', qtd_sacos: 3 });
    ok(r1.status === 200 && r1.body.etiqueta.peso === 15, 'retirada: saco de 15 kg', r1.body);
    const r2 = await req('POST', '/retirada/aditivo', { sessao_id: sRet, materialKey: 'PURGA', fornecedor: 'GILFLEX', qtd_sacos: 6 });
    ok(r2.status === 400, 'retirada: 30 kg num item é recusado (teto 25)', r2.body);
    const r3 = await req('POST', '/retirada/aditivo', { sessao_id: sRet, materialKey: 'PURGA', fornecedor: 'GILFLEX', qtd_sacos: 0, peso_avulso: 12 });
    ok(r3.status === 400, 'retirada: peso avulso recusado (só de 5 em 5)', r3.body);
    const r4 = await req('POST', '/retirada/aditivo', { sessao_id: sRet, materialKey: 'DESSEC', fornecedor: 'FG', qtd_sacos: 2 });
    ok(r4.status === 200 && r4.body.etiqueta.peso === 50, 'Dessecante segue 2 × 25 kg', r4.body);
    pedidos.length = 0;
    const fim = await req('POST', `/sessoes/${sRet}/finalizar`);
    ok(fim.status === 200 && fim.body.bling && fim.body.bling.ok, 'a retirada vai ao Bling', fim.body);
    const venda = pedidos.find(x => x.rota.startsWith('/Api/v3/pedidos/vendas'));
    const itens = (venda && venda.corpo.itens) || [];
    const itP = itens.find(i => i.produto && i.produto.id === 16719768728);
    ok(itP && itP.quantidade === 15 && /1 saco de 15kg/.test(itP.descricao || ''),
       'no Bling: produto 16719768728, 15 kg, "1 saco de 15kg"', itP || itens);
    const itD = itens.find(i => /Dessecante/i.test(i.descricao || ''));
    ok(itD && /2 sacos × 25kg/.test(itD.descricao || ''), 'Dessecante segue "2 sacos × 25kg"', itD);
    const sRto = (await req('POST', '/sessoes', { tipo: 'retorno', operador: 'Teste' })).body.sessao_id;
    const r5 = await req('POST', '/retorno/aditivo', { sessao_id: sRto, materialKey: 'PURGA', fornecedor: 'GILFLEX', qtd_sacos: 4 });
    ok(r5.status === 200 && r5.body.etiqueta.peso === 20, 'retorno: saco de 20 kg', r5.body);
    const r6 = await req('POST', '/retorno/aditivo', { sessao_id: sRto, materialKey: 'PURGA', fornecedor: 'GILFLEX', qtd_sacos: 7 });
    ok(r6.status === 400, 'retorno: 35 kg recusado', r6.body);
  } catch (e) {
    falhou++;
    console.error('\n\x1b[31mERRO NO TESTE:\x1b[0m', e.stack || e.message);
  } finally {
    console.log('\n═══════════════════════════════════════════════════');
    console.log(` RESULTADO: ${passou} passou, ${falhou} falhou`);
    console.log('═══════════════════════════════════════════════════\n');
    try { servidor && servidor.kill('SIGKILL'); } catch (e) {}
    try { fake && fake.close(); } catch (e) {}
    for (const f of [DB1, DB1 + '-wal', DB1 + '-shm', DB2, DB2 + '-wal', DB2 + '-shm', TOK]) { try { fs.rmSync(f, { force: true }); } catch (e) {} }
    try { fs.rmSync(LOGS, { recursive: true, force: true }); } catch (e) {}
    setTimeout(() => process.exit(falhou ? 1 : 0), 200);
  }
})();
