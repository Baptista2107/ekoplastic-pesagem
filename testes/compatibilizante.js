// ════════════════════════════════════════════════════════════════════
//  COMPATIBILIZANTE PA/PE — SACO DE 20 KG E FORNECEDOR PARABOR (30/09/2026)
//  ------------------------------------------------------------------
//  O material foi criado pela tela Cadastros Bling como "Aditivo -
//  Compatibilizante PA/PE", por sacos de 25 kg e sem fornecedor. Pedido:
//    · nome sem "Aditivo";
//    · fornecedor PARABOR (contato Bling 18422042805, produto 16713041492);
//    · saco de 20 kg — só deste material; os demais continuam com 25 kg.
//
//  O material mora no banco da estação, com a sigla que foi digitada na
//  tela (PAPE). O ajuste único que o deixou assim já rodou na estação e
//  saiu do código (20/10/2026); o teste monta o banco já ajustado e
//  confere que o saco de 20 kg vale em todo lugar.
// ════════════════════════════════════════════════════════════════════
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const http = require('node:http');
const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');

const ROOT = path.join(__dirname, '..');
const PORT = 13931, PORT_CB = 18931;
const BASE = `http://localhost:${PORT}`;
const C = Date.now();
const DB1  = path.join(os.tmpdir(), `eko_cp_${C}.db`);
const DB2  = path.join(os.tmpdir(), `eko_cp2_${C}.db`);
const LOGS = path.join(os.tmpdir(), `eko_cp_${C}`);
const TOK  = path.join(os.tmpdir(), `eko_cp_tok_${C}.json`);

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
    console.log(' COMPATIBILIZANTE PA/PE — SACO DE 20 KG · PARABOR');
    console.log('═══════════════════════════════════════════════════\n');
    await subirFake();

    // ── Monta um banco como o da estação (o material como está cadastrado
    // lá: sigla PAPE, sacos de 20 kg, fornecedor PARABOR e os mapas do Bling)
    await subir(DB1);
    await derrubar();
    const m0 = cfg(DB1, 'mp_materiais') || {};
    m0.PAPE = { popular: 'Compatibilizante PA/PE', nomeEtiqueta: 'COMPATIBILIZANTE PA/PE',
                cores: [], corLabel: {}, porSacos: true, kgPorSaco: 20,
                apelidos: ['ADITIVO - COMPATIBILIZANTE PA/PE', 'COMPATIBILIZANTE'],
                criadoEm: '2026-09-30T13:00:00.000Z', origem: 'cadastros-bling' };
    cfgSet(DB1, 'mp_materiais', m0);
    const f0 = cfg(DB1, 'mp_fornecedores') || {}; f0.PAPE = ['PARABOR']; cfgSet(DB1, 'mp_fornecedores', f0);
    const mf0 = cfg(DB1, 'mapa_fornecedor_bling') || {}; mf0.PARABOR = '18422042805'; cfgSet(DB1, 'mapa_fornecedor_bling', mf0);
    const mp0 = cfg(DB1, 'mapa_produto_bling') || {}; mp0['PAPE::PARABOR'] = '16713041492'; cfgSet(DB1, 'mapa_produto_bling', mp0);

    await subir(DB1);
    await req('POST', '/config', { bling_simular: '0', bling_host_api: 'localhost:' + portaFake,
                                   bling_host_oauth: 'localhost:' + portaFake });

    // ── [1] O SACO DE 20 KG VALE EM TODO LUGAR ─────────────────────
    console.log('[1] O saco de 20 kg vale na retirada, no retorno, no inventário e no Bling');
    const inv = ((await req('GET', '/inventario/produtos')).body.produtos || []).find(p => p.chave === 'PAPE::PARABOR');
    ok(inv && inv.manual === true && inv.kgPorSaco === 20 && inv.materialNome === 'Compatibilizante PA/PE',
       'inventário: conta em sacos de 20 kg', inv);
    const sRet = (await req('POST', '/sessoes', { tipo: 'retirada', operador: 'Teste' })).body.sessao_id;
    const r1 = await req('POST', '/retirada/aditivo', { sessao_id: sRet, materialKey: 'PAPE', fornecedor: 'PARABOR', qtd_sacos: 3 });
    ok(r1.status === 200 && r1.body.etiqueta.peso === 60 && r1.body.etiqueta.material_nome === 'Compatibilizante PA/PE',
       'retirada: 3 sacos × 20 kg = 60 kg', r1.body);
    const r2 = await req('POST', '/retirada/aditivo', { sessao_id: sRet, materialKey: 'DESSEC', fornecedor: 'FG', qtd_sacos: 2 });
    ok(r2.status === 200 && r2.body.etiqueta.peso === 50, 'os outros aditivos continuam com 25 kg: 2 sacos de Dessecante = 50 kg', r2.body);
    pedidos.length = 0;
    const fim = await req('POST', `/sessoes/${sRet}/finalizar`);
    ok(fim.status === 200 && fim.body.bling && fim.body.bling.ok, 'a retirada fecha e vai ao Bling na hora', fim.body);
    const venda = pedidos.find(x => x.rota.startsWith('/Api/v3/pedidos/vendas'));
    const itens = (venda && venda.corpo.itens) || [];
    const itC = itens.find(i => i.produto && i.produto.id === 16713041492);
    ok(itC && itC.quantidade === 60 && /3 sacos × 20kg/.test(itC.descricao || ''),
       'no Bling: produto 16713041492, 60 kg, "3 sacos × 20kg"', itC || itens);
    const itD = itens.find(i => /Dessecante/i.test(i.descricao || ''));
    ok(itD && /2 sacos × 25kg/.test(itD.descricao || ''), 'e o Dessecante segue "× 25kg"', itD);
    const sRto = (await req('POST', '/sessoes', { tipo: 'retorno', operador: 'Teste' })).body.sessao_id;
    const r3 = await req('POST', '/retorno/aditivo', { sessao_id: sRto, materialKey: 'PAPE', fornecedor: 'PARABOR', qtd_sacos: 2 });
    ok(r3.status === 200 && r3.body.etiqueta.peso === 40 && r3.body.etiqueta.material_nome === 'Compatibilizante PA/PE',
       'retorno: 2 sacos × 20 kg = 40 kg', r3.body);

    // ── [2] CRIAR MATERIAL PELA TELA JÁ COM O PESO DO SACO ─────────
    console.log('\n[2] A tela de cadastro pede o peso do saco');
    const n1 = await req('POST', '/sync/mp/material', { matKey: 'SAC20', popular: 'Aditivo Vinte', unidade: 'sacos', kgPorSaco: 20 });
    ok(n1.status === 200 && n1.body.material.kgPorSaco === 20, 'material por sacos de 20 kg criado', n1.body);
    const n2 = await req('POST', '/sync/mp/material', { matKey: 'SAC225', popular: 'Aditivo Meio', unidade: 'sacos', kgPorSaco: '22,5' });
    ok(n2.status === 200 && n2.body.material.kgPorSaco === 22.5, 'aceita casa decimal (22,5 kg)', n2.body);
    const n3 = await req('POST', '/sync/mp/material', { matKey: 'SACZERO', popular: 'Aditivo Zero', unidade: 'sacos', kgPorSaco: 0 });
    ok(n3.status === 400, 'peso de saco inválido é recusado', n3.body);
    const n4 = await req('POST', '/sync/mp/material', { matKey: 'SACPAD', popular: 'Aditivo Padrão', unidade: 'sacos' });
    ok(n4.status === 200 && n4.body.material.kgPorSaco === 25, 'sem informar, fica o padrão de 25 kg', n4.body);

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
