// ════════════════════════════════════════════════════════════════════
//  PEDIDO DE RETIRADA DE MP (06/11/2026, Gustavo)
//  ------------------------------------------------------------------
//  O Willian pede no painel da VPS material + lote + nº de bags. A tela de
//  Retirada mostra os pedidos e cada bag bipado conta para um deles. O que
//  este teste prova, com uma VPS de mentira:
//    · VPS fora e nunca houve lista: nada trava (a fábrica não para);
//    · bag do pedido sai e conta; o 3º bag de um pedido de 2 já é "fora";
//    · modo TESTE: tela nova vê 409 (abre o modal) e pode seguir sem motivo;
//    · modo PRODUÇÃO: sem pedido não sai; bag fora só sai com motivo, que
//      fica gravado na retirada e vai para a VPS;
//    · VPS cai: a tela recebe o último bom (desatualizado) e o motivo fica
//      na fila; a VPS volta e recebe UMA vez só;
//    · aditivo por sacos não entra na regra;
//    · pedido por PESO (10/11/2026): só o bag daquele peso conta; mesmo lote
//      com outro peso é fora do pedido; o de peso escolhido é servido antes
//      do de "qualquer peso".
// ════════════════════════════════════════════════════════════════════
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const http = require('node:http');
const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');

const ROOT = path.join(__dirname, '..');
const PORT = 13961, PORT_CB = 18961;
const BASE = `http://localhost:${PORT}`;
const C = Date.now();
const TMP_DB   = path.join(os.tmpdir(), `eko_rp_${C}.db`);
const TMP_LOGS = path.join(os.tmpdir(), `eko_rp_${C}`);
const TMP_TOK  = path.join(os.tmpdir(), `eko_rp_tok_${C}.json`);

let passou = 0, falhou = 0, servidor, vps, portaVps = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function ok(cond, msg, extra) {
  if (cond) { passou++; console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
  else { falhou++; console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
         if (extra !== undefined) console.log('      →', JSON.stringify(extra).slice(0, 700)); }
}
async function req(metodo, rota, corpo) {
  const opc = { method: metodo, headers: {} };
  if (corpo !== undefined) { opc.body = JSON.stringify(corpo); opc.headers['Content-Type'] = 'application/json'; }
  const r = await fetch(BASE + rota, opc);
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, body: j };
}
const lerDb = (sql, ...p) => {
  const db = new DatabaseSync(TMP_DB);
  try { return db.prepare(sql).get(...p); } finally { db.close(); }
};

// ── A VPS DE MENTIRA ─────────────────────────────────────────────────
const VPS = { no_ar: true, modo: 'teste', pedidos: [], recebidos: [] };
function subirVps() {
  return new Promise(resolve => {
    vps = http.createServer((r, res) => {
      let corpo = '';
      r.on('data', c => corpo += c);
      r.on('end', () => {
        const responder = (st, obj) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
        if (!VPS.no_ar) return responder(503, { ok: false, erro: 'fora do ar' });
        if (r.method === 'GET' && r.url === '/api/mp/retirada/abertos')
          return responder(200, { ok: true, modo: VPS.modo, pedidos: VPS.pedidos });
        if (r.method === 'POST' && r.url === '/api/mp/retirada/fora-do-pedido') {
          let b = {}; try { b = JSON.parse(corpo); } catch (e) {}
          VPS.recebidos.push(b);
          return responder(200, { ok: true });
        }
        return responder(404, { ok: false });
      });
    });
    vps.listen(0, '127.0.0.1', () => { portaVps = vps.address().port; resolve(); });
  });
}
const pedido = (id, lote, n, extra = {}) => ({
  id, criado_em: '2026-11-06T10:00:00-03:00', autor_nome: 'Willian', material_key: 'GBD', cor: 'Preto',
  material_nome: 'GRÃO BAIXA DENSIDADE', fornecedor: 'Ecorafia', lote, bags_pedidos: n, bags_atendidos: 0,
  etiquetas_atendidas: [], status: 'aberto', ...extra });

async function subirServidor() {
  fs.writeFileSync(TMP_TOK, JSON.stringify({ accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3600e3 }));
  servidor = spawn('node', [path.join(ROOT, 'server.js')], {
    env: { ...process.env, EKO_PORT: String(PORT), EKO_PORT_CB: String(PORT_CB),
           EKO_DB_FILE: TMP_DB, EKO_LOG_DIR: TMP_LOGS, EKO_TOKEN_FILE: TMP_TOK,
           EKO_RETIRADA_CACHE_MS: '0', EKO_RETIRADA_PAUSA_MS: '0',
           TZ: 'America/Sao_Paulo', EKO_PRINT_SIMULAR: '1', EKO_BLING_INSEGURO: '1',
           BLING_CLIENT_ID: 'id-teste', BLING_CLIENT_SECRET: 'segredo-teste' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  servidor.stdout.on('data', () => {});
  servidor.stderr.on('data', () => {});
  for (let i = 0; i < 75; i++) {
    try { const r = await fetch(BASE + '/healthcheck'); if (r.ok) return; } catch (e) {}
    await sleep(200);
  }
  throw new Error('servidor não subiu');
}

let nTok = 0, sRec;
async function bag(lote, mat = 'GBD', cor = 'Preto', forn = 'Ecorafia', peso = 900) {
  const r = await req('POST', '/etiquetas', {
    clientToken: `rp-${C}-${++nTok}`, tipo: 'recebimento', materialKey: mat, materialNomeEt: 'GRÃO BAIXA DENSIDADE',
    cor, fornecedor: forn, peso, lote, codigo: 'X1', sku: `${mat}.PRE.ECORAF | ${peso} | L${lote}`, sessao_id: sRec });
  const id = r.body && r.body.id;
  if (id) await req('POST', `/etiquetas/${id}/bipar`);
  return id;
}
const consumir = (id, s, extra = {}) => req('POST', `/etiquetas/${id}/consumir`, { sessao_id: s, ...extra });
const registro = virtId => { const l = lerDb('SELECT pedido_retirada FROM etiquetas WHERE id = ?', virtId); return l && l.pedido_retirada ? JSON.parse(l.pedido_retirada) : null; };

(async () => {
  try {
    console.log('\n═══════════════════════════════════════════════════');
    console.log(' PEDIDO DE RETIRADA DE MP (painel → Mini PC)');
    console.log('═══════════════════════════════════════════════════\n');
    await subirVps();
    await subirServidor();
    // [0] Chave local desligada (padrão): nem pergunta à VPS, nada muda.
    await req('POST', '/config', { vps_sacoleiras_url: `http://127.0.0.1:${portaVps}/api/sacoleiras/agora` });
    VPS.modo = 'producao'; VPS.pedidos = [];
    console.log('[0] Chave local desligada (padrão de quem atualiza o sistema)');
    const gd0 = await req('GET', '/retirada/pedidos');
    ok(gd0.status === 200 && gd0.body.desligado === true && gd0.body.pedidos.length === 0, 'a tela recebe "desligado"', gd0.body);
    const sRec0 = (await req('POST', '/sessoes', { tipo: 'recebimento', operador: 'Teste', fornecedor: 'Ecorafia' })).body.sessao_id;
    const sRet0 = (await req('POST', '/sessoes', { tipo: 'retirada', operador: 'Bruno' })).body.sessao_id;
    sRec = sRec0;
    const d0 = await bag('010125');
    const cd0 = await consumir(d0, sRet0, { checar_pedido: true });
    ok(cd0.status === 200 && registro(cd0.body.etiqueta_virtual.id) === null,
       'com a VPS em PRODUÇÃO e sem pedido, o bag sai igual a hoje (a chave manda)', cd0.body);
    await sleep(300);
    ok(VPS.recebidos.length === 0, 'e nada vai para a VPS', VPS.recebidos);
    VPS.modo = 'teste';
    await req('POST', '/config', { retirada_pedidos_ligado: '1' });
    console.log('');

    // Primeiro, a VPS num endereço morto (porta fechada).
    await req('POST', '/config', { vps_sacoleiras_url: 'http://127.0.0.1:1/api/sacoleiras/agora' });
    sRec = (await req('POST', '/sessoes', { tipo: 'recebimento', operador: 'Teste', fornecedor: 'Ecorafia' })).body.sessao_id;
    const sRet = (await req('POST', '/sessoes', { tipo: 'retirada', operador: 'Bruno' })).body.sessao_id;

    console.log('[1] VPS fora e nunca houve lista: nada trava');
    const g0 = await req('GET', '/retirada/pedidos');
    ok(g0.status === 200 && g0.body.indisponivel === true && g0.body.pedidos.length === 0,
       'a tela recebe "indisponível" (sem quebrar)', g0.body);
    const b0 = await bag('010126');
    const c0 = await consumir(b0, sRet, { checar_pedido: true });
    ok(c0.status === 200, 'o bag sai normalmente', c0.body);
    ok(c0.body.etiqueta_virtual && registro(c0.body.etiqueta_virtual.id) === null, 'e a retirada fica sem registro de pedido');

    console.log('\n[2] Modo TESTE, pedido de 2 bags do lote 021026');
    await req('POST', '/config', { vps_sacoleiras_url: `http://127.0.0.1:${portaVps}/api/sacoleiras/agora` });
    VPS.pedidos = [pedido('P1', '021026', 2)];
    const g1 = await req('GET', '/retirada/pedidos');
    ok(g1.body.modo === 'teste' && g1.body.pedidos.length === 1 && g1.body.pedidos[0].bags_atendidos === 0 && !g1.body.desatualizado,
       'a tela recebe o pedido P1 (0 de 2)', g1.body);
    const [a1, a2, a3] = [await bag('021026'), await bag('021026'), await bag('021026')];
    const c1 = await consumir(a1, sRet, { checar_pedido: true });
    ok(c1.status === 200 && registro(c1.body.etiqueta_virtual.id)?.pedido_id === 'P1', 'bag do lote pedido sai e conta para P1', c1.body);
    const g2 = await req('GET', '/retirada/pedidos');
    ok(g2.body.pedidos[0].bags_atendidos === 1 && g2.body.pedidos[0].etiquetas_atendidas.includes(a1),
       'a lista já mostra 1 de 2 antes da VPS saber (conta local)', g2.body.pedidos[0]);
    await consumir(a2, sRet, { checar_pedido: true });
    const g3 = await req('GET', '/retirada/pedidos');
    ok(g3.body.pedidos[0].status === 'atendido', 'com 2 de 2 o pedido fica atendido', g3.body.pedidos[0]);
    const c3 = await consumir(a3, sRet, { checar_pedido: true });
    ok(c3.status === 409 && c3.body.fora_do_pedido === true && c3.body.modo === 'teste',
       'o 3º bag do mesmo lote já é FORA do pedido: tela nova recebe 409 e abre o modal', c3.body);
    ok(lerDb('SELECT status FROM etiquetas WHERE id = ?', a3).status === 'bipada', 'e o bag NÃO foi consumido');
    const c3b = await consumir(a3, sRet, { fora_do_pedido: {} });
    const r3 = c3b.body && c3b.body.etiqueta_virtual && registro(c3b.body.etiqueta_virtual.id);
    ok(c3b.status === 200 && r3 && r3.fora === true && r3.motivo === null && r3.modo === 'teste',
       'em teste, "seguir sem motivo" deixa sair e registra fora do pedido', { st: c3b.status, r3 });
    await sleep(300);
    ok(VPS.recebidos.length === 1 && VPS.recebidos[0].etiqueta_id === a3 && /teste/.test(VPS.recebidos[0].motivo),
       'a VPS recebe o aviso de fora do pedido (motivo "(teste) seguiu sem motivo")', VPS.recebidos);
    const b4 = await bag('999999');
    const c4 = await consumir(b4, sRet);
    ok(c4.status === 200, 'tela antiga (sem checar_pedido) em teste não é barrada', c4.body);
    await sleep(300);
    ok(VPS.recebidos.length === 2 && VPS.recebidos[1].etiqueta_id === b4, 'e também avisa a VPS', VPS.recebidos);

    console.log('\n[3] Modo PRODUÇÃO');
    VPS.modo = 'producao'; VPS.pedidos = []; VPS.recebidos = [];
    await req('GET', '/retirada/pedidos');
    const p1 = await bag('030326');
    const cp1 = await consumir(p1, sRet);
    ok(cp1.status === 409 && cp1.body.sem_pedido === true, 'sem pedido aberto nenhum, o bag NÃO sai (409)', cp1.body);
    VPS.pedidos = [pedido('P2', '040426', 1)];
    await req('GET', '/retirada/pedidos');
    const cp2 = await consumir(p1, sRet, { fora_do_pedido: {} });
    ok(cp2.status === 409 && cp2.body.fora_do_pedido === true && cp2.body.pedidos.length === 1,
       'bag de outro lote sem motivo: 409, e a resposta traz o pedido aberto', cp2.body);
    const cp3 = await consumir(p1, sRet, { fora_do_pedido: { motivo: 'Lote pedido acabou', pedido_id: 'P2' } });
    const rp3 = cp3.body && cp3.body.etiqueta_virtual && registro(cp3.body.etiqueta_virtual.id);
    ok(cp3.status === 200 && rp3 && rp3.fora && rp3.motivo === 'Lote pedido acabou' && rp3.pedido_id === 'P2' && rp3.modo === 'producao',
       'com motivo sai, e o motivo fica gravado na retirada', { st: cp3.status, rp3 });
    await sleep(300);
    ok(VPS.recebidos.length === 1 && VPS.recebidos[0].motivo === 'Lote pedido acabou' && VPS.recebidos[0].operador === 'Bruno'
       && VPS.recebidos[0].sessao_id === sRet && VPS.recebidos[0].pedido_id === 'P2',
       'e chega à VPS com etiqueta, sessão, operador, motivo e pedido', VPS.recebidos);
    const ad = await req('POST', '/retirada/aditivo', { sessao_id: sRet, materialKey: 'CARBO', fornecedor: 'Karina', qtd_sacos: 2 });
    ok(ad.status === 200, 'aditivo contado por sacos não entra na regra (sai sem pedido)', ad.body);

    console.log('\n[4] VPS cai: último bom na tela, motivo na fila, entrega UMA vez');
    VPS.no_ar = false; VPS.recebidos = [];
    const gd = await req('GET', '/retirada/pedidos');
    ok(gd.body.desatualizado === true && gd.body.pedidos.length === 1 && gd.body.pedidos[0].id === 'P2' && gd.body.modo === 'producao',
       'a tela recebe o último bom, marcado desatualizado, com a idade', gd.body);
    const q1 = await bag('050526');
    const cq = await consumir(q1, sRet, { fora_do_pedido: { motivo: 'Bag do lote pedido não está no estoque' } });
    ok(cq.status === 200, 'a regra continua valendo com a lista guardada (motivo dado → sai)', cq.body);
    const q2 = await bag('060626');
    ok((await consumir(q2, sRet)).status === 409, 'e sem motivo continua barrado');
    await sleep(300);
    const fila = JSON.parse((await req('GET', '/config')).body.config.retirada_fora_fila || '{}');
    ok(Object.keys(fila).length === 1 && fila[q1], 'o motivo ficou na fila (1 item)', fila);
    const fr = await req('POST', '/retirada/fora-do-pedido', { etiqueta_id: q1, sessao_id: sRet, operador: 'Bruno', motivo: 'Bag do lote pedido não está no estoque' });
    ok(fr.status === 200 && fr.body.na_fila === true, 'reenviar a mesma etiqueta pela rota não duplica a fila', fr.body);
    const fila2 = JSON.parse((await req('GET', '/config')).body.config.retirada_fora_fila || '{}');
    ok(Object.keys(fila2).length === 1, 'continua 1 na fila', fila2);
    VPS.no_ar = true;
    await req('GET', '/retirada/pedidos');
    await sleep(300);
    await req('GET', '/retirada/pedidos');
    await sleep(300);
    ok(VPS.recebidos.length === 1 && VPS.recebidos[0].etiqueta_id === q1, 'a VPS voltou e recebeu o motivo UMA vez só', VPS.recebidos);
    const fila3 = JSON.parse((await req('GET', '/config')).body.config.retirada_fora_fila || '{}');
    ok(Object.keys(fila3).length === 0, 'e a fila esvaziou', fila3);
    const ruim = await req('POST', '/retirada/fora-do-pedido', { etiqueta_id: q1, motivo: '' });
    ok(ruim.status === 400, 'rota de reenvio sem motivo é recusada', ruim.body);

    console.log('\n[5] Estorno devolve a vaga do pedido');
    VPS.modo = 'teste'; VPS.pedidos = [pedido('P3', '070726', 1)];
    const e1 = await bag('070726');
    const ce = await consumir(e1, sRet, { checar_pedido: true });
    ok(ce.status === 200, 'pedido criado agora no painel já vale no bipe seguinte (sem esperar a tela)', ce.body);
    ok((await req('GET', '/retirada/pedidos')).body.pedidos[0].status === 'atendido', 'bag tirado: P3 atendido');
    await req('POST', `/etiquetas/${ce.body.etiqueta_virtual.id}/estornar`);
    const ge = await req('GET', '/retirada/pedidos');
    ok(ge.body.pedidos[0].status === 'aberto' && ge.body.pedidos[0].bags_atendidos === 0, 'estornado: P3 volta a aberto (0 de 1)', ge.body.pedidos[0]);

    console.log('\n[6] Pedido por PESO (10/11/2026): só o bag daquele peso conta');
    VPS.modo = 'producao'; VPS.recebidos = [];
    VPS.pedidos = [pedido('P4', '080826', 1, { peso: 614.5 })];
    await req('GET', '/retirada/pedidos');
    const w1 = await bag('080826', 'GBD', 'Preto', 'Ecorafia', 1000);
    const cw1 = await consumir(w1, sRet, { checar_pedido: true });
    ok(cw1.status === 409 && cw1.body.peso_diferente === true && /peso/.test(cw1.body.erro || ''),
       'mesmo lote com OUTRO peso é fora do pedido (409, peso_diferente)', cw1.body);
    ok(cw1.body.pedidos && cw1.body.pedidos[0] && cw1.body.pedidos[0].peso === 614.5,
       'a recusa traz o peso do pedido (o modal mostra)', cw1.body.pedidos);
    ok(lerDb('SELECT status FROM etiquetas WHERE id = ?', w1).status === 'bipada', 'e o bag de 1000 kg NÃO foi consumido');
    const w2 = await bag('080826', 'GBD', 'Preto', 'Ecorafia', 614.5);
    const cw2 = await consumir(w2, sRet, { checar_pedido: true });
    ok(cw2.status === 200 && registro(cw2.body.etiqueta_virtual.id)?.pedido_id === 'P4',
       'o bag de 614,5 kg sai e conta para P4', cw2.body);
    VPS.pedidos = [pedido('P5', '090926', 1),
                   pedido('P6', '090926', 1, { peso: 360, criado_em: '2026-11-10T10:00:00-03:00' })];
    await req('GET', '/retirada/pedidos');
    const w3 = await bag('090926', 'GBD', 'Preto', 'Ecorafia', 360);
    const cw3 = await consumir(w3, sRet, { checar_pedido: true });
    ok(cw3.status === 200 && registro(cw3.body.etiqueta_virtual.id)?.pedido_id === 'P6',
       'bag de 360 kg vai para o pedido de 360 kg, não para o "qualquer peso" mais antigo', cw3.body);
    const w4 = await bag('090926', 'GBD', 'Preto', 'Ecorafia', 999);
    const cw4 = await consumir(w4, sRet, { checar_pedido: true });
    ok(cw4.status === 200 && registro(cw4.body.etiqueta_virtual.id)?.pedido_id === 'P5',
       'bag de outro peso do mesmo lote atende o pedido de qualquer peso', cw4.body);
  } catch (e) {
    falhou++; console.log('  \x1b[31m✗ ERRO\x1b[0m', e.stack || e.message);
  } finally {
    if (servidor) servidor.kill('SIGKILL');
    if (vps) vps.close();
    for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm', TMP_TOK]) { try { fs.unlinkSync(f); } catch (e) {} }
    try { fs.rmSync(TMP_LOGS, { recursive: true, force: true }); } catch (e) {}
    console.log(`\n ${passou} passaram, ${falhou} falharam`);
    process.exit(falhou ? 1 : 0);
  }
})();
