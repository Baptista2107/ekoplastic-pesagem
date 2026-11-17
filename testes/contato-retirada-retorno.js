// ════════════════════════════════════════════════════════════════════
//  CONTATO DA RETIRADA E DO RETORNO DE MP NO BLING (17/11/2026)
//  ------------------------------------------------------------------
//  Vinicius: "toda retirada (pedido de venda) de matéria-prima feita no
//  sistema de pesagem cair no Bling com o nome Retiradas MP Ekoplastic; a
//  mesma lógica no retorno (pedido de compra) com Retornos MP Ekoplastic".
//  Até aqui os dois saíam com a EKOPLASTIC INDÚSTRIA (id_ekoplastic_bling).
//
//   [1] Banco novo: as chaves id_retirada_mp_bling / id_retorno_mp_bling
//       nascem com os ids do Bling (18523718529 / 18524168362).
//   [2] Retirada → pedido de VENDA com contato 18523718529.
//   [3] Retorno  → pedido de COMPRA com fornecedor 18524168362.
//   [4] Outras pesagens (borra) continuam com a EKOPLASTIC.
//   [5] Banco sem as chaves novas (estação antiga, chave apagada): cai na
//       EKOPLASTIC, nunca manda contato vazio.
//   [6] Chave nova preenchida e id_ekoplastic_bling vazio: envia com a nova
//       (antes a checagem olhava só o id da EKOPLASTIC → pendente_config).
//
//  Como rodar:   node testes/contato-retirada-retorno.js
// ════════════════════════════════════════════════════════════════════
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const http = require('node:http');
const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');

const ROOT = path.join(__dirname, '..');
const PORT = 13996, PORT_CB = 18996;
const BASE = `http://localhost:${PORT}`;
const C = Date.now();
const DB1  = path.join(os.tmpdir(), `eko_crr_${C}.db`);
const LOGS = path.join(os.tmpdir(), `eko_crr_${C}`);
const TOK  = path.join(os.tmpdir(), `eko_crr_tok_${C}.json`);

const ID_EKO      = 17804838271;
const ID_RETIRADA = 18523718529;
const ID_RETORNO  = 18524168362;

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
const cfgRaw = (arq, k) => comBanco(arq, db => { const r = db.prepare('SELECT valor FROM config WHERE chave = ?').get(k); return r ? r.valor : null; });
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
          return responder(201, { data: { id: 900000 + pedidos.length } });
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
async function ligarBlingFalso() {
  await req('POST', '/config', { bling_simular: '0', bling_host_api: 'localhost:' + portaFake,
                                 bling_host_oauth: 'localhost:' + portaFake });
}

// Uma retirada com 2 sacos de pigmento (o caminho de aditivo não precisa de
// recebimento antes) e fecha. Devolve o pedido mandado ao Bling.
async function retirada() {
  const sid = (await req('POST', '/sessoes', { tipo: 'retirada', operador: 'Teste' })).body.sessao_id;
  const a = await req('POST', '/retirada/aditivo', { sessao_id: sid, materialKey: 'PIG', cor: 'Preto', fornecedor: 'Karina', qtd_sacos: 2 });
  ok(a.status === 200, 'retirada: 2 sacos de pigmento entram', a.body);
  pedidos.length = 0;
  const fim = await req('POST', `/sessoes/${sid}/finalizar`);
  ok(fim.status === 200 && fim.body.bling && fim.body.bling.ok, 'retirada fecha e vai ao Bling', fim.body);
  return pedidos.find(x => x.rota.startsWith('/Api/v3/pedidos/vendas'));
}
async function retorno() {
  const sid = (await req('POST', '/sessoes', { tipo: 'retorno', operador: 'Teste' })).body.sessao_id;
  const a = await req('POST', '/retorno/aditivo', { sessao_id: sid, materialKey: 'PIG', cor: 'Preto', fornecedor: 'Karina', qtd_sacos: 1 });
  ok(a.status === 200, 'retorno: 1 saco de pigmento entra', a.body);
  pedidos.length = 0;
  const fim = await req('POST', `/sessoes/${sid}/finalizar`);
  ok(fim.status === 200 && fim.body.bling && fim.body.bling.ok, 'retorno fecha e vai ao Bling', fim.body);
  return pedidos.find(x => x.rota.startsWith('/Api/v3/pedidos/compras'));
}
async function outras() {
  const sid = (await req('POST', '/sessoes', { tipo: 'outras', operador: 'Teste' })).body.sessao_id;
  const e = await req('POST', '/etiquetas/outras', { clientToken: 'crr-borra-' + C, sessao_id: sid, item_codigo: 'RES.BORRA', peso: 30 });
  ok(e.status === 200 && e.body && e.body.id, 'outras: etiqueta de borra impressa', e.body);
  await req('POST', `/etiquetas/${e.body.id}/bipar`);
  pedidos.length = 0;
  const fim = await req('POST', `/sessoes/${sid}/finalizar`);
  ok(fim.status === 200 && fim.body.bling && fim.body.bling.ok, 'outras fecha e vai ao Bling', fim.body);
  return pedidos.find(x => x.rota.startsWith('/Api/v3/pedidos/compras'));
}

(async () => {
  try {
    console.log('\n═══════════════════════════════════════════════════');
    console.log(' CONTATO DA RETIRADA E DO RETORNO DE MP NO BLING');
    console.log('═══════════════════════════════════════════════════\n');
    await subirFake();
    await subir(DB1);
    await ligarBlingFalso();

    console.log('[1] Banco novo já nasce com os contatos novos');
    ok(String(cfgRaw(DB1, 'id_retirada_mp_bling')) === String(ID_RETIRADA), 'id_retirada_mp_bling = 18523718529', cfgRaw(DB1, 'id_retirada_mp_bling'));
    ok(String(cfgRaw(DB1, 'id_retorno_mp_bling')) === String(ID_RETORNO), 'id_retorno_mp_bling = 18524168362', cfgRaw(DB1, 'id_retorno_mp_bling'));
    ok(String(cfgRaw(DB1, 'id_ekoplastic_bling')) === String(ID_EKO), 'id_ekoplastic_bling segue 17804838271', cfgRaw(DB1, 'id_ekoplastic_bling'));

    console.log('\n[2] Retirada sai com RETIRADAS MP EKOPLASTIC');
    const v = await retirada();
    ok(v && v.corpo.contato && v.corpo.contato.id === ID_RETIRADA, 'pedido de venda com contato 18523718529', v && v.corpo.contato);

    console.log('\n[3] Retorno sai com RETORNOS MP EKOPLASTIC');
    const c = await retorno();
    ok(c && c.corpo.fornecedor && c.corpo.fornecedor.id === ID_RETORNO, 'pedido de compra com fornecedor 18524168362', c && c.corpo.fornecedor);
    ok(c && /RETORNO DE PRODUCAO/.test(c.corpo.observacoes || ''), 'a observação continua "RETORNO DE PRODUCAO" (a VPS reconhece o retorno por ela)', c && c.corpo.observacoes);

    console.log('\n[4] Outras pesagens continuam com a EKOPLASTIC');
    const o = await outras();
    ok(o && o.corpo.fornecedor && o.corpo.fornecedor.id === ID_EKO, 'borra: fornecedor 17804838271', o && o.corpo.fornecedor);

    console.log('\n[5] Sem as chaves novas no banco: cai na EKOPLASTIC (nunca vazio)');
    await derrubar();
    cfgDel(DB1, 'id_retirada_mp_bling'); cfgDel(DB1, 'id_retorno_mp_bling');
    // O servidor semeia de novo na subida; para simular a chave ausente
    // com o servidor no ar, apaga depois que ele subir.
    await subir(DB1);
    ok(String(cfgRaw(DB1, 'id_retirada_mp_bling')) === String(ID_RETIRADA), 'estação antiga ganha a chave nova ao subir', cfgRaw(DB1, 'id_retirada_mp_bling'));
    cfgDel(DB1, 'id_retirada_mp_bling'); cfgDel(DB1, 'id_retorno_mp_bling');
    const v2 = await retirada();
    ok(v2 && v2.corpo.contato && v2.corpo.contato.id === ID_EKO, 'retirada sem a chave: contato 17804838271', v2 && v2.corpo.contato);
    const c2 = await retorno();
    ok(c2 && c2.corpo.fornecedor && c2.corpo.fornecedor.id === ID_EKO, 'retorno sem a chave: fornecedor 17804838271', c2 && c2.corpo.fornecedor);

    console.log('\n[6] Chave nova preenchida e a da EKOPLASTIC vazia: envia mesmo assim');
    await req('POST', '/config', { id_retirada_mp_bling: String(ID_RETIRADA), id_retorno_mp_bling: String(ID_RETORNO) });
    cfgDel(DB1, 'id_ekoplastic_bling');
    const v3 = await retirada();
    ok(v3 && v3.corpo.contato && v3.corpo.contato.id === ID_RETIRADA, 'retirada vai com 18523718529 (não fica pendente_config)', v3 && v3.corpo.contato);
    const c3 = await retorno();
    ok(c3 && c3.corpo.fornecedor && c3.corpo.fornecedor.id === ID_RETORNO, 'retorno vai com 18524168362 (não fica pendente_config)', c3 && c3.corpo.fornecedor);
  } catch (e) {
    falhou++;
    console.error('\n\x1b[31mERRO NO TESTE:\x1b[0m', e.stack || e.message);
  } finally {
    console.log('\n═══════════════════════════════════════════════════');
    console.log(` RESULTADO: ${passou} passou, ${falhou} falhou`);
    console.log('═══════════════════════════════════════════════════\n');
    try { servidor && servidor.kill('SIGKILL'); } catch (e) {}
    try { fake && fake.close(); } catch (e) {}
    for (const f of [DB1, DB1 + '-wal', DB1 + '-shm', TOK]) { try { fs.rmSync(f, { force: true }); } catch (e) {} }
    try { fs.rmSync(LOGS, { recursive: true, force: true }); } catch (e) {}
    setTimeout(() => process.exit(falhou ? 1 : 0), 200);
  }
})();
