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
// Valida o "fora do pedido" como a VPS de verdade (bling-claude,
// mp_pedido_retirada.registrar_fora_do_pedido): etiqueta [RST]+7, motivo
// obrigatório ≤ 200, pedido_id texto ≤ 30 ou null, teto de 30 por hora,
// idempotente pela etiqueta. Até 16/11 respondia ok para qualquer corpo, e o
// motivo de 300 caracteres que travava a fila passava verde.
const VPS = { no_ar: true, modo: 'teste', pedidos: [], recebidos: [], recusados: [],
              atraso_ms: 0, teto_hora: 30, aceitos_hora: 0, ja: new Set(), erro500: new Set() };
function validarFora(b) {
  if (typeof b.etiqueta_id !== 'string' || !/^[RST]\d{7}$/.test(b.etiqueta_id)) return 'etiqueta inválida';
  const motivo = typeof b.motivo === 'string' ? b.motivo.trim() : '';
  if (!motivo) return 'motivo é obrigatório';
  if (motivo.length > 200) return 'motivo com mais de 200 caracteres';
  if (b.pedido_id != null && (typeof b.pedido_id !== 'string' || b.pedido_id.length > 30)) return 'pedido inválido';
  return null;
}
function subirVps() {
  return new Promise(resolve => {
    vps = http.createServer((r, res) => {
      let corpo = '';
      r.on('data', c => corpo += c);
      r.on('end', async () => {
        const responder = (st, obj) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
        if (!VPS.no_ar) return responder(503, { ok: false, erro: 'fora do ar' });
        if (r.method === 'GET' && r.url === '/api/mp/retirada/abertos') {
          if (VPS.atraso_ms) await sleep(VPS.atraso_ms);
          return responder(200, { ok: true, modo: VPS.modo, pedidos: VPS.pedidos });
        }
        if (r.method === 'POST' && r.url === '/api/mp/retirada/fora-do-pedido') {
          let b = {}; try { b = JSON.parse(corpo); } catch (e) {}
          if (VPS.erro500.has(b.etiqueta_id)) return responder(500, { ok: false, erro: 'erro interno' });
          const erro = validarFora(b);
          if (erro) { VPS.recusados.push({ b, erro }); return responder(400, { ok: false, erro }); }
          if (VPS.ja.has(b.etiqueta_id)) { VPS.recebidos.push(b); return responder(200, { ok: true, novo: false }); }
          if (VPS.aceitos_hora >= VPS.teto_hora) return responder(400, { ok: false, erro: 'muitos registros na última hora' });
          VPS.aceitos_hora++; VPS.ja.add(b.etiqueta_id);
          VPS.recebidos.push(b);
          return responder(200, { ok: true, novo: true });
        }
        return responder(404, { ok: false });
      });
    });
    vps.listen(0, '127.0.0.1', () => { portaVps = vps.address().port; resolve(); });
  });
}
// Troca a lista da VPS e renova a do Mini PC (o que a tela faz a cada 15 s):
// desde 16/11 o bipe não espera a VPS — decide com a lista guardada.
async function pedidosVps(lista, modo) {
  VPS.pedidos = lista;
  if (modo) VPS.modo = modo;
  await req('GET', '/retirada/pedidos');
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
    VPS.modo = 'producao'; VPS.pedidos = []; await req('GET', '/retirada/pedidos');
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

    console.log('\n[2] Modo TESTE, pedido de 2 bags do lote 021026 (e outro pedido aberto, P1x)');
    await req('POST', '/config', { vps_sacoleiras_url: `http://127.0.0.1:${portaVps}/api/sacoleiras/agora` });
    // P1x fica aberto o tempo todo: com algum pedido aberto, bag que não é
    // de nenhum pede motivo (sem nenhum aberto, em teste, sai direto — [11]).
    VPS.pedidos = [pedido('P1', '021026', 2), pedido('P1x', '029999', 5, { criado_em: '2026-11-06T11:00:00-03:00' })]; await req('GET', '/retirada/pedidos');
    const g1 = await req('GET', '/retirada/pedidos');
    const P1de = g => g.body.pedidos.find(p => p.id === 'P1');
    ok(g1.body.modo === 'teste' && g1.body.pedidos.length === 2 && P1de(g1).bags_atendidos === 0 && !g1.body.desatualizado,
       'a tela recebe o pedido P1 (0 de 2)', g1.body);
    const [a1, a2, a3] = [await bag('021026'), await bag('021026'), await bag('021026')];
    const c1 = await consumir(a1, sRet, { checar_pedido: true });
    ok(c1.status === 200 && registro(c1.body.etiqueta_virtual.id)?.pedido_id === 'P1', 'bag do lote pedido sai e conta para P1', c1.body);
    const g2 = await req('GET', '/retirada/pedidos');
    // A lista leva o id da S (saída), como a VPS (16/11: antes ia o R e o
    // mesmo bag contava 2x quando a VPS listava a S — ver [8]).
    ok(P1de(g2).bags_atendidos === 1 && P1de(g2).etiquetas_atendidas.includes(c1.body.etiqueta_virtual.id),
       'a lista já mostra 1 de 2 antes da VPS saber (conta local, pela S como a VPS)', P1de(g2));
    await consumir(a2, sRet, { checar_pedido: true });
    const g3 = await req('GET', '/retirada/pedidos');
    ok(P1de(g3).status === 'atendido', 'com 2 de 2 o pedido fica atendido', P1de(g3));
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
    VPS.modo = 'producao'; VPS.pedidos = []; await req('GET', '/retirada/pedidos'); VPS.recebidos = [];
    await req('GET', '/retirada/pedidos');
    const p1 = await bag('030326');
    const cp1 = await consumir(p1, sRet);
    ok(cp1.status === 409 && cp1.body.sem_pedido === true, 'sem pedido aberto nenhum, o bag NÃO sai (409)', cp1.body);
    VPS.pedidos = [pedido('P2', '040426', 1)]; await req('GET', '/retirada/pedidos');
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
    await pedidosVps([pedido('P3', '070726', 1)], 'teste');
    const e1 = await bag('070726');
    const ce = await consumir(e1, sRet, { checar_pedido: true });
    ok(ce.status === 200 && registro(ce.body.etiqueta_virtual.id)?.pedido_id === 'P3',
       'pedido novo no painel vale assim que a lista renova (a tela renova a cada 15 s)', ce.body);
    ok((await req('GET', '/retirada/pedidos')).body.pedidos[0].status === 'atendido', 'bag tirado: P3 atendido');
    await req('POST', `/etiquetas/${ce.body.etiqueta_virtual.id}/estornar`);
    const ge = await req('GET', '/retirada/pedidos');
    ok(ge.body.pedidos[0].status === 'aberto' && ge.body.pedidos[0].bags_atendidos === 0, 'estornado: P3 volta a aberto (0 de 1)', ge.body.pedidos[0]);

    console.log('\n[6] Pedido por PESO (10/11/2026): só o bag daquele peso conta');
    VPS.modo = 'producao'; VPS.recebidos = [];
    VPS.pedidos = [pedido('P4', '080826', 1, { peso: 614.5 })]; await req('GET', '/retirada/pedidos');
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
                   pedido('P6', '090926', 1, { peso: 360, criado_em: '2026-11-10T10:00:00-03:00' })]; await req('GET', '/retirada/pedidos');
    await req('GET', '/retirada/pedidos');
    const w3 = await bag('090926', 'GBD', 'Preto', 'Ecorafia', 360);
    const cw3 = await consumir(w3, sRet, { checar_pedido: true });
    ok(cw3.status === 200 && registro(cw3.body.etiqueta_virtual.id)?.pedido_id === 'P6',
       'bag de 360 kg vai para o pedido de 360 kg, não para o "qualquer peso" mais antigo', cw3.body);
    const w4 = await bag('090926', 'GBD', 'Preto', 'Ecorafia', 999);
    const cw4 = await consumir(w4, sRet, { checar_pedido: true });
    ok(cw4.status === 200 && registro(cw4.body.etiqueta_virtual.id)?.pedido_id === 'P5',
       'bag de outro peso do mesmo lote atende o pedido de qualquer peso', cw4.body);

    console.log('\n[7] Pedido em KG (produto por saco, 12/11/2026)');
    VPS.modo = 'producao'; VPS.recebidos = [];
    const pkg = (id, extra = {}) => pedido(id, '', null, { material_key: 'DESSEC', cor: null, material_nome: 'DESSECANTE',
      fornecedor: 'Cristal Master', lote_fmt: '', unidade: 'kg', kg_pedidos: 2000, kg_atendidos: 0, kg_saco: 25,
      etiquetas_atendidas: [], ...extra });
    const paraQuem = c => c.body && c.body.etiqueta_virtual && registro(c.body.etiqueta_virtual.id)?.pedido_id;
    const doPedido = async id => (await req('GET', '/retirada/pedidos')).body.pedidos.find(p => p.id === id);
    VPS.pedidos = [pkg('K1')]; await req('GET', '/retirada/pedidos');
    const k1 = await doPedido('K1');
    ok(k1.unidade === 'kg' && k1.kg_pedidos === 2000 && k1.kg_atendidos === 0 && k1.status === 'aberto',
       'a tela recebe o pedido em kg como veio (unidade, kg pedidos e atendidos)', k1);
    const ck1 = await consumir(await bag('111126', 'DESSEC', null, 'Cristal Master', 1000), sRet, { checar_pedido: true });
    ok(ck1.status === 200 && paraQuem(ck1) === 'K1',
       'em PRODUÇÃO o palete inteiro de Dessecante (qualquer lote) sai e conta para o pedido em kg', ck1.body);
    const s1 = ck1.body.etiqueta_virtual.id;
    const gk1 = await doPedido('K1');
    ok(gk1.status === 'aberto' && gk1.kg_atendidos === 1000 && gk1.etiquetas_atendidas.includes(s1),
       'antes da VPS saber, a conta daqui já mostra 1.000 de 2.000 kg', gk1);
    const ck2 = await consumir(await bag('111126', 'DESSEC', null, 'Karina', 1000), sRet, { checar_pedido: true });
    ok(ck2.status === 409 && ck2.body.sem_pedido === false && ck2.body.peso_diferente === false,
       'Dessecante de OUTRO fornecedor não é do pedido (409)', ck2.body);
    const pk = ck2.body.pedidos && ck2.body.pedidos[0];
    ok(pk && pk.unidade === 'kg' && pk.kg_pedidos === 2000 && pk.kg_saco === 25,
       'a recusa traz o pedido em kg com kg pedidos e o kg do saco (o modal mostra em kg)', pk);
    const ck3 = await consumir(await bag('111126', 'DESSEC', null, 'Cristal Master', 1000), sRet, { checar_pedido: true });
    ok(ck3.status === 200 && paraQuem(ck3) === 'K1' && (await doPedido('K1')).status === 'atendido',
       '2º palete enche o pedido: 2.000 de 2.000 kg, atendido aqui mesmo', await doPedido('K1'));
    const ck4 = await consumir(await bag('111126', 'DESSEC', null, 'Cristal Master', 1000), sRet, { checar_pedido: true });
    ok(ck4.status === 409 && ck4.body.sem_pedido === true,
       '3º palete logo depois (VPS ainda não sabe de nada): NÃO é do pedido, pede motivo (409)', ck4.body);
    // a VPS recebeu a 1ª S pelo envio ao vivo: não conta duas vezes
    VPS.pedidos = [pkg('K1', { kg_atendidos: 1000, etiquetas_atendidas: [s1] })]; await req('GET', '/retirada/pedidos');
    const gk3 = await doPedido('K1');
    ok(gk3.kg_atendidos === 2000 && gk3.status === 'atendido' && gk3.etiquetas_atendidas.length === 2,
       'S que a VPS já contou não soma de novo (2.000, não 3.000)', gk3);

    // folga de meio saco, igual à VPS
    VPS.pedidos = [pkg('K3', { kg_pedidos: 1000 })]; await req('GET', '/retirada/pedidos');
    const ck5 = await consumir(await bag('111126', 'DESSEC', null, 'Cristal Master', 987.6), sRet, { checar_pedido: true });
    ok(ck5.status === 200 && (await doPedido('K3')).status === 'atendido',
       '987,6 de 1.000 kg (falta menos de meio saco de 25): atendido', await doPedido('K3'));
    VPS.pedidos = [pkg('K3b', { kg_pedidos: 1000 })]; await req('GET', '/retirada/pedidos');
    await consumir(await bag('111126', 'DESSEC', null, 'Cristal Master', 987.4), sRet, { checar_pedido: true });
    ok((await doPedido('K3b')).status === 'aberto', '987,4 de 1.000 kg (falta 12,6): continua aberto', await doPedido('K3b'));

    // a chave é a da VPS: sem acento, espaços juntos, apelido do fornecedor
    VPS.pedidos = [pkg('K4', { material_key: 'PIG', cor: 'Verde Limão', material_nome: 'PIGMENTO VERDE LIMAO',
                               fornecedor: 'FG RESINAS' })]; await req('GET', '/retirada/pedidos');
    const ck6 = await consumir(await bag('111126', 'PIG', 'VERDE  LIMAO', 'FG', 1000), sRet, { checar_pedido: true });
    ok(ck6.status === 200 && paraQuem(ck6) === 'K4',
       'palete "VERDE  LIMAO" do "FG" casa com o pedido de "Verde Limão" do "FG RESINAS"', ck6.body);

    // dois pedidos em kg do mesmo produto: o mais antigo primeiro (a VPS manda o mais novo antes)
    VPS.pedidos = [pkg('K6', { criado_em: '2026-11-12T13:00:00.000Z' }), pkg('K5', { criado_em: '2026-11-12T12:00:00.000Z' })]; await req('GET', '/retirada/pedidos');
    const ck7 = await consumir(await bag('111126', 'DESSEC', null, 'Cristal Master', 1000), sRet, { checar_pedido: true });
    ok(ck7.status === 200 && paraQuem(ck7) === 'K5', 'vai para o pedido mais antigo (FIFO, como a VPS)', ck7.body);

    // saída por SACOS (a mais comum): não passa pelo avaliar, mas conta aqui
    // como na VPS — senão o palete seguinte entrava como "do pedido"
    VPS.pedidos = [pkg('K7', { kg_pedidos: 200 })]; await req('GET', '/retirada/pedidos');
    const sc = await req('POST', '/retirada/aditivo', { sessao_id: sRet, materialKey: 'DESSEC', fornecedor: 'Cristal Master', qtd_sacos: 8 });
    const k7 = await doPedido('K7');
    ok(sc.status === 200 && k7.kg_atendidos === 200 && k7.status === 'atendido' && k7.etiquetas_atendidas.includes(sc.body.etiqueta.id),
       '8 sacos (200 kg) lançados aqui fecham o pedido de 200 kg antes da VPS saber', k7);
    const ck9 = await consumir(await bag('111126', 'DESSEC', null, 'Cristal Master', 1000), sRet, { checar_pedido: true });
    ok(ck9.status === 409 && ck9.body.sem_pedido === true, 'e o palete logo depois NÃO é do pedido (409)', ck9.body);
    // a VPS já contou esses sacos (pedido de 400 kg, ainda aberto lá): não soma de novo
    VPS.pedidos = [pkg('K7', { kg_pedidos: 400, kg_atendidos: 200, etiquetas_atendidas: [sc.body.etiqueta.id] })]; await req('GET', '/retirada/pedidos');
    const k7b = await doPedido('K7');
    ok(k7b.kg_atendidos === 200 && k7b.status === 'aberto', 'a VPS contou os sacos: 200 de 400 kg, não 400 (nem fecha)', k7b);
    // sacos de antes do pedido não são dele
    VPS.pedidos = [pkg('K8', { kg_pedidos: 200, criado_em: new Date(Date.now() + 3600e3).toISOString() })]; await req('GET', '/retirada/pedidos');
    await req('POST', '/retirada/aditivo', { sessao_id: sRet, materialKey: 'DESSEC', fornecedor: 'Cristal Master', qtd_sacos: 8 });
    const k8 = await doPedido('K8');
    ok(k8.kg_atendidos === 0 && k8.status === 'aberto', 'sacos lançados antes do pedido não contam para ele', k8);

    // dois pedidos em kg: os sacos vão ao mais antigo, inteiros, e o
    // seguinte só depois que ele fechou (a VPS manda o mais novo antes)
    const t0 = Date.now();
    VPS.pedidos = [pkg('K12', { kg_pedidos: 100, criado_em: new Date(t0 + 1).toISOString() }),
                   pkg('K11', { kg_pedidos: 100, criado_em: new Date(t0).toISOString() })]; await req('GET', '/retirada/pedidos');
    const sa = await req('POST', '/retirada/aditivo', { sessao_id: sRet, materialKey: 'DESSEC', fornecedor: 'Cristal Master', qtd_sacos: 8 });
    const sb = await req('POST', '/retirada/aditivo', { sessao_id: sRet, materialKey: 'DESSEC', fornecedor: 'Cristal Master', qtd_sacos: 4 });
    const [k11, k12] = [await doPedido('K11'), await doPedido('K12')];
    ok(k11.kg_atendidos === 200 && k11.status === 'atendido' && k11.etiquetas_atendidas.join() === sa.body.etiqueta.id
       && k12.kg_atendidos === 100 && k12.status === 'atendido' && k12.etiquetas_atendidas.join() === sb.body.etiqueta.id,
       '8 sacos inteiros no mais antigo (fecha), os 4 seguintes no outro', { k11, k12 });
    // a VPS já deu os 8 sacos ao K11: aqui eles não sobram para o K12
    VPS.pedidos = [pkg('K12', { kg_pedidos: 400, criado_em: new Date(t0 + 1).toISOString() }),
                   pkg('K11', { kg_pedidos: 100, criado_em: new Date(t0).toISOString(), kg_atendidos: 200,
                                status: 'atendido', etiquetas_atendidas: [sa.body.etiqueta.id] })]; await req('GET', '/retirada/pedidos');
    const k12b = await doPedido('K12');
    ok(k12b.kg_atendidos === 100 && k12b.status === 'aberto',
       'sacos que a VPS já deu a outro pedido não entram neste (100 de 400, não 300)', k12b);

    // S de peso 0: a VPS descarta, aqui também (não vira "1 saída")
    VPS.pedidos = [pkg('K9', { kg_pedidos: 10, criado_em: new Date().toISOString() })]; await req('GET', '/retirada/pedidos');   // depois dos sacos acima
    { const db = new DatabaseSync(TMP_DB);
      try { db.prepare(`INSERT INTO etiquetas (id, seq, tipo, material_key, fornecedor, lote, peso, codigo, sku, status, hora_impressao, pedido_retirada)
                        VALUES ('S9999999', 9999999, 'retirada', 'DESSEC', 'Cristal Master', '111126', 0, 'X', 'X', 'bipada', ?, ?)`)
              .run(new Date().toISOString(), JSON.stringify({ pedido_id: 'K9', fora: false, modo: 'producao' })); }
      finally { db.close(); } }
    const k9 = await doPedido('K9');
    ok(k9.status === 'aberto' && k9.bags_atendidos === 0 && k9.kg_atendidos === 0,
       'S de 0 kg não conta nem fecha o pedido de 10 kg', k9);

    // troca de produto ativa: a S sai como o produto NOVO, e é ele que casa
    const velho = await bag('111126', 'DESSEC', null, 'Velho', 1000);
    await req('POST', '/config', { mp_substituicoes: JSON.stringify({ 'DESSEC::Velho': 'DESSEC::Karina' }),
                                   mapa_produto_bling: JSON.stringify({ 'DESSEC::Karina': '99999' }) });
    VPS.pedidos = [pkg('K10', { fornecedor: 'Karina' })]; await req('GET', '/retirada/pedidos');
    const ck10 = await consumir(velho, sRet, { checar_pedido: true });
    ok(ck10.status === 200 && paraQuem(ck10) === 'K10' && ck10.body.etiqueta_virtual.fornecedor === 'Karina',
       'palete do produto trocado (Velho → Karina) casa com o pedido em kg de Karina', ck10.body);
    await req('POST', '/config', { mp_substituicoes: '{}', mapa_produto_bling: '{}' });

    VPS.pedidos = [pkg('K2', { lote: '111126' })]; await req('GET', '/retirada/pedidos');
    await req('GET', '/retirada/pedidos');
    const ck8 = await consumir(await bag('121226', 'DESSEC', null, 'Cristal Master', 1000), sRet, { checar_pedido: true });
    ok(ck8.status === 200 && paraQuem(ck8) === 'K2', 'pedido em kg não olha o lote', ck8.body);

    // ── [8] Pedido POR PRODUTO (lote vazio, o único que a tela da VPS cria
    // desde 11/11) e a conta sem dobrar (16/11/2026). Formato copiado do que
    // a VPS manda hoje (RM-20261116-002: CARBONATO Karina, 3 bags, lote "").
    console.log('\n[8] Pedido por PRODUTO (qualquer lote) e bag contado uma vez só');
    {
    VPS.modo = 'producao'; VPS.recebidos = [];
    const agoraIso = () => new Date(Date.now() - 1000).toISOString();
    const pprod = (id, n, extra = {}) => pedido(id, '', n, { material_key: 'CARBO', cor: '', material_nome: 'CARBONATO',
      fornecedor: 'Karina', lote_fmt: '', peso: null, qualquer_lote: true, unidade: 'bag', bags: [],
      criado_em: agoraIso(), ...extra });
    VPS.pedidos = [pprod('Q1', 3)]; await req('GET', '/retirada/pedidos');
    const q1 = await consumir(await bag('051126', 'CARBO', '', 'Karina', 1250), sRet, { checar_pedido: true });
    ok(q1.status === 200 && paraQuem(q1) === 'Q1',
       'em PRODUÇÃO, bag de Carbonato Karina de QUALQUER lote sai e conta para o pedido por produto', q1.body);
    const sQ1 = q1.body && q1.body.etiqueta_virtual && q1.body.etiqueta_virtual.id;
    // a VPS já viu essa S (envio ao vivo) e lista ela no pedido
    VPS.pedidos = [pprod('Q1', 3, { etiquetas_atendidas: [sQ1], bags_atendidos: 1, criado_em: VPS.pedidos[0].criado_em })]; await req('GET', '/retirada/pedidos');
    const gq1 = await doPedido('Q1');
    ok(gq1 && gq1.bags_atendidos === 1 && gq1.status === 'aberto',
       'o bag que a VPS já contou (S) e o daqui (mesmo bag) contam UMA vez: 1 de 3, não 2', gq1);
    const q2 = await consumir(await bag('061126', 'CARBO', '', 'Karina', 1300), sRet, { checar_pedido: true });
    ok(q2.status === 200 && paraQuem(q2) === 'Q1', '2º bag (outro lote) também é do pedido', q2.body);
    const q3 = await consumir(await bag('071126', 'CARBO', '', 'Karina', 1280), sRet, { checar_pedido: true });
    ok(q3.status === 200 && paraQuem(q3) === 'Q1',
       '3º bag de um pedido de 3 ainda é do pedido (antes, a conta dobrada fechava no 2º e o 3º levava 409)', q3.body);
    ok((await doPedido('Q1')).status === 'atendido', 'com 3 de 3 o pedido fica atendido', await doPedido('Q1'));
    const q4 = await consumir(await bag('081126', 'CARBO', '', 'Karina', 1250), sRet, { checar_pedido: true });
    ok(q4.status === 409 && q4.body.fora_do_pedido === true, '4º bag já é fora do pedido (409)', q4.body);
    const q5 = await consumir(await bag('051126', 'CARBO', '', 'Ecorafia', 1250), sRet, { checar_pedido: true });
    ok(q5.status === 409, 'Carbonato de OUTRO fornecedor não é do pedido por produto', q5.body);

    // S que a VPS deu a OUTRO pedido não conta neste (a VPS decide a fila)
    VPS.pedidos = [pprod('Q2', 2), pprod('Q3', 2)]; await req('GET', '/retirada/pedidos');
    const q6 = await consumir(await bag('091126', 'CARBO', '', 'Karina', 1250), sRet, { checar_pedido: true });
    const sQ6 = q6.body && q6.body.etiqueta_virtual && q6.body.etiqueta_virtual.id;
    ok(q6.status === 200 && paraQuem(q6) === 'Q2', 'com 2 pedidos do mesmo produto, o bag vai para o mais antigo', q6.body);
    VPS.pedidos = [pprod('Q2', 2, { criado_em: VPS.pedidos[0].criado_em }),
                   pprod('Q3', 2, { criado_em: VPS.pedidos[1].criado_em, etiquetas_atendidas: [sQ6], bags_atendidos: 1 })]; await req('GET', '/retirada/pedidos');
    const lq = (await req('GET', '/retirada/pedidos')).body.pedidos;
    const q2v = lq.find(p => p.id === 'Q2'), q3v = lq.find(p => p.id === 'Q3');
    ok(q2v.bags_atendidos === 0 && q3v.bags_atendidos === 1,
       'a VPS pôs a S no Q3: aqui ela sai do Q2 (não conta em dois pedidos)', { q2v, q3v });

    // bag ESCOLHIDO no painel (bags: [{id}]): só ele é do pedido
    const escolhido = await bag('101126', 'CARBO', '', 'Karina', 1250);
    const outro = await bag('101126', 'CARBO', '', 'Karina', 1250);
    VPS.pedidos = [pprod('Q4', 1, { bags: [{ id: escolhido, peso: 1250, entrada: '', saiu: false }] })]; await req('GET', '/retirada/pedidos');
    const q7 = await consumir(outro, sRet, { checar_pedido: true });
    ok(q7.status === 409, 'pedido com bag escolhido: outro bag do mesmo produto é fora do pedido', q7.body);
    const q8 = await consumir(escolhido, sRet, { checar_pedido: true });
    ok(q8.status === 200 && paraQuem(q8) === 'Q4', 'o bag escolhido sai e conta para o pedido', q8.body);

    // Pedido em kg com o formato real de hoje (RM-20261116-001: cor "", lote "", sacos)
    VPS.pedidos = [pedido('K20', '', null, { material_key: 'DESSEC', cor: '', material_nome: 'DESSECANTE',
      fornecedor: 'Cristal Master', lote_fmt: '', peso: null, unidade: 'kg', kg_pedidos: 300, kg_saco: 25,
      kg_atendidos: 0, sacos_pedidos: 12, sacos_atendidos: 0, qualquer_lote: true, bags: [], criado_em: agoraIso() })]; await req('GET', '/retirada/pedidos');
    const k20 = await consumir(await bag('091126', 'DESSEC', '', 'Cristal Master', 300), sRet, { checar_pedido: true });
    ok(k20.status === 200 && paraQuem(k20) === 'K20',
       'palete de Dessecante (lote 091126) casa com o pedido em kg sem lote (sem 409)', k20.body);
    }

    // ── [9] O mesmo bag bipado 2x com a VPS lenta (revisor 16/11, B1) ──
    // Antes o /consumir esperava a VPS (até 3 s) ENTRE "o bag já saiu?" e a
    // gravação: o 2º bipe passava pela conferência e os dois gravavam uma S.
    console.log('\n[9] Bag bipado 2x com a VPS lenta: UMA saída só, e o bipe não espera a VPS');
    {
    await pedidosVps([], 'teste');
    const dup = await bag('151126');
    VPS.atraso_ms = 1500;
    const t0 = Date.now();
    const [r1, r2] = await Promise.all([consumir(dup, sRet, { checar_pedido: true }), consumir(dup, sRet, { checar_pedido: true })]);
    const ms = Date.now() - t0;
    VPS.atraso_ms = 0;
    const st = [r1.status, r2.status].sort();
    const nS = lerDb(`SELECT COUNT(*) AS n FROM etiquetas WHERE tipo='retirada' AND ref_id = ? AND status != 'cancelada'`, dup).n;
    ok(st[0] === 200 && st[1] === 409 && [r1, r2].some(r => r.body && r.body.ja_consumida === true),
       'dois bipes juntos do mesmo bag: um sai (200), o outro leva "já foi retirada" (409)', { r1: r1.body, r2: r2.body });
    ok(nS === 1, 'e só existe UMA saída (S) desse bag — nada de baixa dupla no Bling', { nS });
    ok(ms < 1200, `o bipe não esperou a VPS lenta (${ms} ms com a VPS levando 1.500 ms)`, { ms });
    await sleep(1700);   // deixa a busca de fundo terminar
    }

    // ── [10] Fila de motivos: recusa de vez não trava a fila (B2) ────────
    console.log('\n[10] Fila de motivos: limites iguais aos da VPS e recusa permanente não trava a fila');
    {
    await pedidosVps([pedido('PF', '161126', 1)], 'teste');
    VPS.recebidos = []; VPS.recusados = [];
    const longo = 'x'.repeat(201);
    const rl = await req('POST', '/retirada/fora-do-pedido', { etiqueta_id: 'R0000001', motivo: longo });
    ok(rl.status === 400, 'rota de reenvio recusa motivo com mais de 200 caracteres (a VPS recusaria)', rl.body);
    const re = await req('POST', '/retirada/fora-do-pedido', { etiqueta_id: 'E0000001', motivo: 'teste' });
    ok(re.status === 400, 'rota de reenvio recusa etiqueta fora de R/S/T (a VPS recusaria)', re.body);
    // motivo de 250 pelo bipe: chega à VPS cortado em 200 (antes ia 300 e era recusado)
    const fb = await bag('171126');
    const cf = await consumir(fb, sRet, { fora_do_pedido: { motivo: 'm'.repeat(250), pedido_id: 'PF' } });
    await sleep(400);
    const chegou = VPS.recebidos.find(b => b.etiqueta_id === fb);
    ok(cf.status === 200 && chegou && chegou.motivo.length === 200, 'motivo longo dado no bipe chega à VPS com 200 caracteres', { st: cf.status, chegou, rec: VPS.recusados });
    // item que a VPS recusa de vez (versão antiga deixou na fila) + um bom depois
    const cfg = (await req('GET', '/config')).body.config;
    const filaVelha = { R0999001: { em: '2026-11-16T10:00:00.000Z', corpo: { etiqueta_id: 'R0999001', motivo: 'ok', pedido_id: 12345 } } };
    await req('POST', '/config', { retirada_fora_fila: JSON.stringify({ ...JSON.parse(cfg.retirada_fora_fila || '{}'), ...filaVelha }) });
    VPS.recebidos = [];
    const bom = await bag('181126');
    await consumir(bom, sRet, { fora_do_pedido: { motivo: 'Lote pedido acabou', pedido_id: 'PF' } });
    await sleep(500);
    ok(VPS.recebidos.some(b => b.etiqueta_id === bom), 'o motivo seguinte chega à VPS mesmo com um item antigo na frente', VPS.recebidos);
    const cfg2 = (await req('GET', '/config')).body.config;
    const fila = JSON.parse(cfg2.retirada_fora_fila || '{}');
    ok(!fila.R0999001 || VPS.recebidos.some(b => b.etiqueta_id === 'R0999001'),
       'o item antigo (pedido_id número) sai da fila: vai como texto e a VPS aceita', { fila, rec: VPS.recebidos });
    // recusa permanente de verdade: etiqueta que a VPS não aceita, enfiada na fila
    const filaRuim = { O0000009: { em: '2026-11-16T10:00:00.000Z', corpo: { etiqueta_id: 'O0000009', motivo: 'velho' } } };
    await req('POST', '/config', { retirada_fora_fila: JSON.stringify(filaRuim) });
    VPS.recebidos = [];
    const bom2 = await bag('191126');
    await consumir(bom2, sRet, { fora_do_pedido: { motivo: 'Bag do lote não achado', pedido_id: 'PF' } });
    await sleep(500);
    const cfg3 = (await req('GET', '/config')).body.config;
    const fila3 = JSON.parse(cfg3.retirada_fora_fila || '{}');
    const recus = JSON.parse(cfg3.retirada_fora_recusados || '{}');
    ok(VPS.recebidos.some(b => b.etiqueta_id === bom2) && !fila3.O0000009 && recus.O0000009 && recus.O0000009.status === 400,
       'recusa permanente (400) sai da fila, fica guardada à parte, e o seguinte chega', { fila3, recus, rec: VPS.recebidos });
    // teto por hora: passageiro — fica na fila e chega quando a VPS libera
    VPS.teto_hora = VPS.aceitos_hora; VPS.recebidos = [];
    const bom3 = await bag('201126');
    await consumir(bom3, sRet, { fora_do_pedido: { motivo: 'Teto', pedido_id: 'PF' } });
    await sleep(400);
    const fila4 = JSON.parse((await req('GET', '/config')).body.config.retirada_fora_fila || '{}');
    ok(fila4[bom3] && VPS.recebidos.length === 0, '"muitos registros na última hora" não descarta: fica na fila', fila4);
    VPS.teto_hora = 1000;
    await req('GET', '/retirada/pedidos'); await sleep(400);
    ok(VPS.recebidos.some(b => b.etiqueta_id === bom3), 'e chega quando a VPS volta a aceitar', VPS.recebidos);
    }

    // ── [11] Teste e NENHUM pedido aberto: o bag sai como sempre (B4) ────
    console.log('\n[11] Modo TESTE sem nenhum pedido aberto: sai direto, sem janela e sem aviso por bag');
    {
    await pedidosVps([], 'teste');
    VPS.recebidos = [];
    const sb = await bag('211126');
    const cs = await consumir(sb, sRet, { checar_pedido: true });
    ok(cs.status === 200 && registro(cs.body.etiqueta_virtual.id) === null,
       'em teste, sem pedido aberto, o bag sai (200) sem registro de pedido — a tela não abre a janela', cs.body);
    await sleep(300);
    ok(VPS.recebidos.length === 0, 'e nenhum "fora do pedido" vai à VPS (o aviso juntado de lá já cobre)', VPS.recebidos);
    await pedidosVps([], 'producao');
    const cp = await consumir(await bag('221126'), sRet, { checar_pedido: true });
    ok(cp.status === 409 && cp.body.sem_pedido === true, 'em PRODUÇÃO, sem pedido aberto, continua não saindo (409)', cp.body);
    }

    // ── [12] Lista estranha da VPS não para a retirada (B5) ──────────────
    console.log('\n[12] Pedido null / campos estranhos na lista: o bipe sai, a tela não quebra');
    {
    await pedidosVps([null, 'x', pedido('PN', '231126', 1, { etiquetas_atendidas: 'nao-e-lista' })], 'producao');
    const gl = await req('GET', '/retirada/pedidos');
    ok(gl.status === 200 && Array.isArray(gl.body.pedidos) && gl.body.pedidos.length === 1 && gl.body.pedidos[0].id === 'PN',
       'GET /retirada/pedidos ignora o que não é pedido', gl.body);
    const cn = await consumir(await bag('231126'), sRet, { checar_pedido: true });
    ok(cn.status === 200 && registro(cn.body.etiqueta_virtual.id)?.pedido_id === 'PN', 'o bag do pedido sai e conta (sem erro 500)', cn.body);
    }

    // ── [13] Fila de motivos: 5xx repetido não trava, recusados têm teto ─
    console.log('\n[13] Item que a VPS devolve 500 sempre sai da fila na 5ª vez; recusados guardam só os 200 últimos');
    {
    await pedidosVps([], 'teste');
    VPS.recebidos = []; VPS.teto_hora = 100000;
    // 205 recusados antigos já guardados
    const velhos = {};
    for (let i = 0; i < 205; i++) {
      const id = 'R08' + String(i).padStart(5, '0');
      velhos[id] = { em: '2026-11-01T00:00:00.000Z', corpo: { etiqueta_id: id, motivo: 'x' },
                     recusado_em: '2026-11-01T00:00:' + String(i % 60).padStart(2, '0') + '.' + String(i).padStart(3, '0') + 'Z', status: 400 };
    }
    VPS.erro500.add('R0999500');
    const fila = {
      R0999500: { em: '2026-11-16T10:00:00.000Z', corpo: { etiqueta_id: 'R0999500', motivo: 'quebra a VPS' } },
      R0999501: { em: '2026-11-16T10:00:01.000Z', corpo: { etiqueta_id: 'R0999501', motivo: 'normal' } },
    };
    await req('POST', '/config', { retirada_fora_fila: JSON.stringify(fila), retirada_fora_recusados: JSON.stringify(velhos) });
    for (let i = 0; i < 4; i++) { await req('GET', '/retirada/pedidos'); await sleep(250); }
    let cfg = (await req('GET', '/config')).body.config;
    let f = JSON.parse(cfg.retirada_fora_fila || '{}');
    ok(f.R0999500 && f.R0999500.falhas_5xx === 4 && !VPS.recebidos.some(b => b.etiqueta_id === 'R0999501'),
       'até a 4ª falha 5xx o item fica na fila (passageiro) e conta as falhas', f);
    await req('GET', '/retirada/pedidos'); await sleep(400);
    cfg = (await req('GET', '/config')).body.config;
    f = JSON.parse(cfg.retirada_fora_fila || '{}');
    const rec = JSON.parse(cfg.retirada_fora_recusados || '{}');
    ok(!f.R0999500 && rec.R0999500 && rec.R0999500.status === 500,
       'na 5ª falha 5xx sai da fila e vai para os recusados', { f, r: rec.R0999500 });
    ok(VPS.recebidos.some(b => b.etiqueta_id === 'R0999501'), 'e o item seguinte chega à VPS', VPS.recebidos);
    ok(Object.keys(rec).length === 200 && !rec.R0800000 && rec.R0800204,
       'recusados guardam só os 200 mais recentes (o mais velho sai)', Object.keys(rec).length);
    VPS.erro500.clear();
    }
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
