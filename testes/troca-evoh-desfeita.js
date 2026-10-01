// ════════════════════════════════════════════════════════════════════
//  TROCA POLINYLON TALLPACK → RESINA EVOH — DESFEITA (30/09/2026, noite)
//  ------------------------------------------------------------------
//  Pedido do Frederico: "as etiquetas devem voltar a serem lidas como
//  POLINYLON CRISTAL TALLPACK ou POLINYLON LEITOSO TALLPACK".
//
//  Este teste monta um banco IGUAL ao da estação depois de algumas horas
//  com a troca ligada — etiquetas antigas de Polinylon, retiradas que
//  saíram como EVOH (já enviadas ao Bling), um retorno que a troca
//  converteu para EVOH e um recebimento feito como EVOH de propósito — e
//  instala a versão nova por cima. Confere:
//    · a leitura volta a ser Polinylon, e o recebimento volta a aceitar;
//    · o retorno convertido volta a ser Polinylon (ainda está em estoque);
//    · o recebido como EVOH de propósito NÃO é mexido; vai para o
//      relatório de acerto (arquivo + /healthcheck);
//    · roda uma vez só.
//
//  01/10/2026: a retirada que saiu como EVOH também volta a Polinylon. Na
//  estação ela travou o Bling — o pedido apontava para EVOH.CRISTAL.TALL,
//  sem saldo. Corrigida a etiqueta, a tela de Envios ao Bling guia: excluir
//  o pedido antigo e REENVIAR (FORÇAR) — o pedido novo sai como Polinylon.
//  A seção [8] reproduz a estação: a 1ª desfeita já rodou, esta não.
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
const DB   = path.join(os.tmpdir(), `eko_td_${C}.db`);
const LOGS = path.join(os.tmpdir(), `eko_td_${C}`);
const TOK  = path.join(os.tmpdir(), `eko_td_tok_${C}.json`);
const TROCAS = { 'POLI:Cristal:Tallpack': 'EVOH:Cristal:Tallpack', 'POLI:Leitoso:Tallpack': 'EVOH:Leitoso:Tallpack' };

let passou = 0, falhou = 0, servidor = null, fake, portaFake = 0;
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
function comBanco(fn) { const db = new DatabaseSync(DB); try { return fn(db); } finally { db.close(); } }
const cfg = k => comBanco(db => { const r = db.prepare('SELECT valor FROM config WHERE chave = ?').get(k); return r ? JSON.parse(r.valor) : null; });
const etq = id => comBanco(db => db.prepare('SELECT * FROM etiquetas WHERE id = ?').get(id));

const pedidos = [];
let nPedido = 0;   // número do pedido no Bling falso — nunca se repete, mesmo zerando a lista
function subirFake() {
  return new Promise(resolve => {
    fake = http.createServer((r, res) => {
      let corpo = '';
      r.on('data', c => corpo += c);
      r.on('end', () => {
        const responder = (st, obj) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
        const u = new URL(r.url, 'http://x');
        if (u.pathname.startsWith('/Api/v3/oauth/token'))
          return responder(200, { access_token: 'tok', refresh_token: 'refresh-fake', expires_in: 21600 });
        if (r.method === 'POST' && u.pathname.startsWith('/Api/v3/pedidos/')) {
          let b = {}; try { b = JSON.parse(corpo); } catch (e) {}
          pedidos.push({ rota: u.pathname, corpo: b });
          return responder(201, { data: { id: 900000 + (++nPedido) } });
        }
        if (u.pathname === '/Api/v3/produtos' && u.searchParams.get('codigo')) {
          const mapa = { 'EVOH.CRISTAL.TALL': 16711891721, 'EVOH.LEI.TALL': 16711891722 };
          const id = mapa[u.searchParams.get('codigo')];
          return responder(200, { data: id ? [{ id }] : [] });
        }
        return responder(200, { data: [] });
      });
    });
    fake.listen(0, '127.0.0.1', () => { portaFake = fake.address().port; resolve(); });
  });
}
async function subir() {
  if (!fs.existsSync(TOK))
    fs.writeFileSync(TOK, JSON.stringify({ accessToken: 'tok', refreshToken: 'refresh-fake', expiresAt: Date.now() + 3600e3 }));
  servidor = spawn('node', [path.join(ROOT, 'server.js')], {
    env: { ...process.env, EKO_PORT: String(PORT), EKO_PORT_CB: String(PORT_CB),
           EKO_DB_FILE: DB, EKO_LOG_DIR: LOGS, EKO_TOKEN_FILE: TOK,
           TZ: 'America/Sao_Paulo', EKO_PRINT_SIMULAR: '1', EKO_BLING_INSEGURO: '1',
           BLING_CLIENT_ID: 'id-teste', BLING_CLIENT_SECRET: 'segredo-teste' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  servidor.stdout.on('data', () => {}); servidor.stderr.on('data', () => {});
  for (let i = 0; i < 75; i++) {
    try { const r = await fetch(BASE + '/healthcheck'); if (r.ok) break; } catch (e) {}
    await sleep(200);
  }
  await req('POST', '/config', { bling_simular: '0', bling_host_api: 'localhost:' + portaFake, bling_host_oauth: 'localhost:' + portaFake });
}
async function derrubar() {
  if (!servidor) return;
  const p = servidor; servidor = null;
  await new Promise(r => { p.once('exit', r); p.kill('SIGKILL'); setTimeout(r, 3000); });
}
let nTok = 0;
function etiqueta(sessao_id, tipo, mat, nomeEt, cor, forn, peso, extra = {}) {
  const lab = cor === 'Cristal' ? 'CRIS' : 'LEI';
  return req('POST', '/etiquetas', {
    clientToken: `td-${C}-${++nTok}`, tipo, materialKey: mat, materialNomeEt: nomeEt, cor, fornecedor: forn, peso,
    lote: '300926', codigo: extra.codigo || 'NCRIS9', sku: `${mat}.${lab}.TALLPA | ${peso} | L300926`, sessao_id,
    ...(extra.ref_id ? { ref_id: extra.ref_id } : {}),
  });
}

(async () => {
  try {
    console.log('\n═══════════════════════════════════════════════════');
    console.log(' TROCA POLINYLON → RESINA EVOH — DESFEITA');
    console.log('═══════════════════════════════════════════════════\n');
    await subirFake();

    // ── MONTA O BANCO COMO O DA ESTAÇÃO (troca ligada por algumas horas) ──
    await subir();
    const hc0 = (await req('GET', '/healthcheck')).body;
    ok(!hc0.troca_evoh_desfeita, 'num banco novo, sem nada da troca, o /healthcheck não traz aviso nenhum', hc0.troca_evoh_desfeita);
    const sRec = (await req('POST', '/sessoes', { tipo: 'recebimento', operador: 'Teste', fornecedor: 'Tallpack' })).body.sessao_id;
    const ids = [];
    for (const [cor, peso] of [['Cristal', 900], ['Cristal', 910], ['Cristal', 920], ['Leitoso', 880]]) {
      const r = await etiqueta(sRec, 'recebimento', 'POLI', 'POLINYLON', cor, 'Tallpack', peso);
      ids.push(r.body.id); await req('POST', `/etiquetas/${r.body.id}/bipar`);
    }
    const [R1, R2, R3, R4] = ids;
    await req('POST', '/config', { mp_substituicoes: JSON.stringify(TROCAS) });      // a troca como estava na estação
    const sRet = (await req('POST', '/sessoes', { tipo: 'retirada', operador: 'Teste' })).body.sessao_id;
    const S1 = (await req('POST', `/etiquetas/${R1}/consumir`, { sessao_id: sRet })).body.etiqueta_virtual.id;
    const S2 = (await req('POST', `/etiquetas/${R2}/consumir`, { sessao_id: sRet })).body.etiqueta_virtual.id;
    const fimRet = (await req('POST', `/sessoes/${sRet}/finalizar`)).body;
    const sRto = (await req('POST', '/sessoes', { tipo: 'retorno', operador: 'Teste' })).body.sessao_id;
    const T1 = (await etiqueta(sRto, 'retorno', 'POLI', 'POLINYLON', 'Cristal', 'Tallpack', 300, { ref_id: R2 })).body.id;
    await req('POST', `/sessoes/${sRto}/finalizar`);
    const sRecE = (await req('POST', '/sessoes', { tipo: 'recebimento', operador: 'Teste', fornecedor: 'Tallpack' })).body.sessao_id;
    const R5 = (await etiqueta(sRecE, 'recebimento', 'EVOH', 'RESINA EVOH', 'Cristal', 'Tallpack', 500, { codigo: 'EVC1' })).body.id;
    await req('POST', `/etiquetas/${R5}/bipar`);
    const antes = { S1: etq(S1).material_key, T1: etq(T1).material_key, R5: etq(R5).material_key };
    ok(antes.S1 === 'EVOH' && antes.T1 === 'EVOH' && antes.R5 === 'EVOH' && fimRet.bling && fimRet.bling.ok,
       `cenário montado: retiradas ${S1}/${S2} e retorno ${T1} saíram como EVOH; ${R5} recebida como EVOH`, antes);
    await derrubar();
    comBanco(db => db.prepare(`DELETE FROM config WHERE chave IN ('patch_troca_evoh_desfeita','patch_troca_evoh_retiradas','patch_troca_evoh_conferencia')`).run());   // a estação ainda não tem as marcas
    // Pior caso que a conferência precisa pegar: o mapa do Polinylon Tallpack
    // Cristal apontando para a EVOH (produto e SKU da variação).
    comBanco(db => {
      const mp = JSON.parse(db.prepare(`SELECT valor FROM config WHERE chave = 'mapa_produto_bling'`).get().valor);
      mp['POLI:Cristal:Tallpack'] = '16711891720';
      db.prepare(`UPDATE config SET valor = ? WHERE chave = 'mapa_produto_bling'`).run(JSON.stringify(mp));
      const ms = JSON.parse(db.prepare(`SELECT valor FROM config WHERE chave = 'mapa_sku_variacao_mp'`).get().valor);
      ms['POLI:Cristal:Tallpack'] = 'EVOH.CRISTAL.TALL';
      db.prepare(`UPDATE config SET valor = ? WHERE chave = 'mapa_sku_variacao_mp'`).run(JSON.stringify(ms));
    });
    try { fs.rmSync(path.join(LOGS, 'troca-evoh-desfeita.txt'), { force: true }); } catch (e) {}

    // ── [1] INSTALAR A VERSÃO NOVA DESFAZ A TROCA ─────────────────
    console.log('[1] Instalando a versão nova por cima');
    await subir();
    ok(JSON.stringify(cfg('mp_substituicoes')) === '{}', 'a troca foi desligada no banco (mp_substituicoes vazio)', cfg('mp_substituicoes'));
    ok(((await req('GET', '/catalogo-mp')).body.substituicoes || []).length === 0, 'a tela não mostra mais troca nenhuma');
    const cat = (await req('GET', '/catalogo-mp')).body;
    ok(cat.materiais && cat.materiais.EVOH && (cfg('mapa_produto_bling') || {})['EVOH:Cristal:Tallpack'] === '16711891720',
       'a Resina EVOH continua cadastrada (material e Bling)');

    // ── [1B] CONFERÊNCIA DO MAPA DO POLINYLON TALLPACK ─────────────
    console.log('\n[1B] Conferência: o mapa do Polinylon Tallpack não pode apontar para a EVOH');
    ok((cfg('mapa_produto_bling') || {})['POLI:Cristal:Tallpack'] === '16586065201'
       && !(cfg('mapa_sku_variacao_mp') || {})['POLI:Cristal:Tallpack'],
       'o mapa que apontava para a EVOH voltou ao Polinylon Cristal Tallpack (16586065201), sem SKU da EVOH');
    const conf = cfg('patch_troca_evoh_conferencia') || {};
    ok((conf.corrigido || []).length === 2 && conf.mapa_antes['POLI:Cristal:Tallpack'].sku === 'EVOH.CRISTAL.TALL',
       'a conferência registrou o que estava errado (produto e SKU)', conf.corrigido);
    const lt = conf.retiradas || [];
    ok(lt.some(r => r.etiqueta === S1 && r.saiu_como_evoh && r.pedido && r.retirada_em && r.sessao_fim),
       'e a linha do tempo das retiradas de Tallpack, com hora, pedido e quem saiu como EVOH', lt);

    // ── [2] AS ETIQUETAS VOLTAM A SER LIDAS COMO POLINYLON ─────────
    console.log('\n[2] As etiquetas voltam a ser lidas como Polinylon');
    const g3 = (await req('GET', `/etiqueta/${R3}`)).body.etiqueta;
    ok(g3.material_key === 'POLI' && g3.cor === 'Cristal' && g3.fornecedor === 'Tallpack' && !g3.substituida_de,
       `${R3} → POLINYLON · Cristal · Tallpack`, g3);
    const g4 = (await req('GET', `/etiqueta/${R4}`)).body.etiqueta;
    ok(g4.material_key === 'POLI' && g4.cor === 'Leitoso' && !g4.substituida_de, `${R4} → POLINYLON · Leitoso · Tallpack`, g4);

    // ── [3] O RETORNO QUE A TROCA CONVERTEU VOLTA A SER POLINYLON ──
    console.log('\n[3] O retorno convertido pela troca, ainda em estoque, volta a ser Polinylon');
    const t1 = etq(T1), r2 = etq(R2);
    ok(t1.material_key === 'POLI' && t1.material_nome === r2.material_nome && t1.fornecedor === 'Tallpack',
       `${T1} voltou a POLINYLON (como a etiqueta de origem ${R2})`, t1);
    ok(/^POLI\.CRIS\.TALLPA \|/.test(t1.sku) && t1.codigo === r2.codigo && !!t1.alterado_em,
       `SKU e código da origem (${t1.sku} · ${t1.codigo}), com alterado_em carimbado`, t1);

    // ── [4] AS RETIRADAS VOLTAM A POLINYLON; O RECEBIDO COMO EVOH FICA ──
    console.log('\n[4] As retiradas que saíram como EVOH voltam a Polinylon; o recebido como EVOH fica');
    const s1 = etq(S1), s2 = etq(S2), r1 = etq(R1);
    ok(s1.material_key === 'POLI' && s2.material_key === 'POLI' && s1.material_nome === r1.material_nome,
       `${S1} e ${S2} voltaram a POLINYLON (como as etiquetas de origem)`, [s1, s2]);
    ok(s1.sku === r1.sku && s1.codigo === r1.codigo && !!s1.alterado_em, 'com SKU e código da origem, alterado_em carimbado', s1);
    ok(etq(R5).material_key === 'EVOH', `${R5}, recebida como EVOH de propósito, continua EVOH`);

    // ── [5] RELATÓRIO PARA O ACERTO NO BLING ───────────────────────
    console.log('\n[5] Relatório para o acerto no Bling');
    const marca = cfg('patch_troca_evoh_desfeita') || {};
    ok((marca.removidas || []).length === 2, 'registrou as duas trocas desligadas', marca.removidas);
    ok((marca.retornos_revertidos || []).map(x => x.id).join() === T1, 'registrou o retorno revertido', marca.retornos_revertidos);
    ok(marca.retiradas_evoh && marca.retiradas_evoh.etiquetas === 2 && marca.retiradas_evoh.kg_por_cor.Cristal === 1810,
       'e as retiradas que saíram como EVOH: 2 etiquetas, Cristal 1810 kg', marca.retiradas_evoh);
    ok((marca.evoh_em_estoque || []).some(e => e.id === R5), 'e o que ficou em estoque como EVOH', marca.evoh_em_estoque);
    const arq = path.join(LOGS, 'troca-evoh-desfeita.txt');
    const txt = fs.existsSync(arq) ? fs.readFileSync(arq, 'utf8') : '';
    ok(txt.includes(T1) && txt.includes(S1) && txt.includes(R5) && /ACERTO NO BLING/.test(txt),
       'o arquivo logs/troca-evoh-desfeita.txt traz retornos, retiradas, estoque EVOH e o acerto', txt.slice(0, 400));
    ok(/RETIRADAS CORRIGIDAS PARA POLINYLON/.test(txt) && /REENVIAR \(FORCAR\)/.test(txt),
       'e a seção das retiradas corrigidas, com o passo a passo do reenvio', txt.slice(-500));
    const hc = (await req('GET', '/healthcheck')).body.troca_evoh_desfeita || {};
    ok((hc.trocas_desligadas || []).length === 2 && hc.retiradas_evoh && hc.retiradas_evoh.kg_por_cor.Cristal === 1810
       && (hc.retiradas_evoh.pedidos_bling || []).length === 1 && (hc.retornos_revertidos || []).includes(T1),
       'o /healthcheck (que a FASE 5 mostra) traz o resumo', hc);
    ok((hc.retiradas_corrigidas || []).map(c => c.etiqueta).sort().join() === [S1, S2].sort().join()
       && hc.retiradas_corrigidas.every(c => c.pedido_antigo === String(fimRet.bling.bling_id) && c.retirada_em && c.enviada_em),
       `e as retiradas corrigidas, com o pedido antigo (${fimRet.bling.bling_id}) e os horários`, hc.retiradas_corrigidas);
    ok(hc.conferencia && (hc.conferencia.retiradas || []).length >= 2 && hc.conferencia.mapa_agora['POLI:Cristal:Tallpack'].produto === '16586065201',
       'e a conferência (mapa e linha do tempo) — dá para ler na saída do ENVIAR-ATUALIZACAO.bat', hc.conferencia);
    ok(/CONFERENCIA POS-TROCA/.test(fs.readFileSync(path.join(LOGS, 'troca-evoh-desfeita.txt'), 'utf8')),
       'o relatório também traz a conferência');

    // ── [5B] ENVIOS AO BLING: EXCLUIR O PEDIDO ANTIGO E REENVIAR ────
    console.log('\n[5B] Envios ao Bling guiam o reenvio — e o pedido novo sai como Polinylon');
    const rec = ((await req('GET', '/sessoes/finalizadas-recentes?horas=48')).body.sessoes || []).find(x => x.id === sRet) || {};
    const ct = rec.corrigida_troca_evoh || {};
    ok(ct.pedido_antigo === String(fimRet.bling.bling_id) && (ct.etiquetas || []).length === 2 && ct.kg === 1810 && ct.reenviada === false,
       'a sessão aparece marcada: pedido antigo, 2 etiquetas, 1810 kg, ainda não reenviada', ct);
    pedidos.length = 0;
    const rf = await req('POST', `/sessoes/${sRet}/reenviar-bling`, { forcar: true });
    const vendaR = pedidos.find(x => x.rota.startsWith('/Api/v3/pedidos/vendas'));
    const itR = (vendaR && vendaR.corpo.itens) || [];
    ok(rf.body.bling && rf.body.bling.ok && itR.length === 2 && itR.every(i => i.produto.id === 16586065201 && !i.codigo)
       && itR.every(i => /POLINYLON/i.test(i.descricao || '') && !/EVOH/i.test(i.descricao || '')),
       'REENVIAR (FORÇAR): o pedido novo leva Polinylon Cristal Tallpack (16586065201), sem EVOH', itR);
    const rec2 = ((await req('GET', '/sessoes/finalizadas-recentes?horas=48')).body.sessoes || []).find(x => x.id === sRet) || {};
    ok(rec2.corrigida_troca_evoh && rec2.corrigida_troca_evoh.reenviada === true, 'e a tela passa a mostrar "já reenviada"', rec2.corrigida_troca_evoh);

    // ── [6] A OPERAÇÃO VOLTA AO ORIGINAL ───────────────────────────
    console.log('\n[6] A operação volta a ser como era antes da troca');
    const sRec2 = (await req('POST', '/sessoes', { tipo: 'recebimento', operador: 'Teste', fornecedor: 'Tallpack' })).body.sessao_id;
    const b1 = await etiqueta(sRec2, 'recebimento', 'POLI', 'POLINYLON', 'Cristal', 'Tallpack', 930);
    ok(b1.status === 200, 'Polinylon Tallpack Cristal volta a entrar no Recebimento', b1.body);
    const sRet2 = (await req('POST', '/sessoes', { tipo: 'retirada', operador: 'Teste' })).body.sessao_id;
    const c3 = await req('POST', `/etiquetas/${R3}/consumir`, { sessao_id: sRet2 });
    const c5 = await req('POST', `/etiquetas/${T1}/consumir`, { sessao_id: sRet2 });
    ok(c3.body.etiqueta_virtual.material_key === 'POLI' && c5.body.etiqueta_virtual.material_key === 'POLI',
       `retiradas de ${R3} e do retorno ${T1} saem como Polinylon`, [c3.body, c5.body]);
    pedidos.length = 0;
    const fim = await req('POST', `/sessoes/${sRet2}/finalizar`);
    const venda = pedidos.find(x => x.rota.startsWith('/Api/v3/pedidos/vendas'));
    const itens = (venda && venda.corpo.itens) || [];
    ok(fim.body.bling && fim.body.bling.ok && itens.length === 2 && itens.every(i => i.produto.id === 16586065201)
       && itens.every(i => /POLINYLON/i.test(i.descricao || '')),
       'no Bling: produto Polinylon Cristal Tallpack (16586065201) nos dois itens', itens);

    // ── [7] RODA UMA VEZ SÓ ────────────────────────────────────────
    console.log('\n[7] Roda uma vez só — não desfaz uma troca que alguém ligar depois');
    await req('POST', '/config', { mp_substituicoes: JSON.stringify(TROCAS) });
    await derrubar(); await subir();
    ok(((await req('GET', '/catalogo-mp')).body.substituicoes || []).length === 2,
       'uma troca ligada DEPOIS continua ligada após reiniciar');
    await req('POST', '/config', { mp_substituicoes: '{}' });

    // ── [8] COMO NA ESTAÇÃO: A 1ª DESFEITA JÁ RODOU, ESTA AINDA NÃO ──
    console.log('\n[8] Na estação (desfeita de 30/09 já instalada), a retirada EVOH é corrigida ao instalar');
    const sRec3 = (await req('POST', '/sessoes', { tipo: 'recebimento', operador: 'Teste', fornecedor: 'Tallpack' })).body.sessao_id;
    const R6 = (await etiqueta(sRec3, 'recebimento', 'POLI', 'POLINYLON', 'Cristal', 'Tallpack', 1007.5)).body.id;
    await req('POST', `/etiquetas/${R6}/bipar`);
    await req('POST', '/config', { mp_substituicoes: JSON.stringify(TROCAS) });     // a troca ligada
    const sRet3 = (await req('POST', '/sessoes', { tipo: 'retirada', operador: 'Teste' })).body.sessao_id;
    const S3 = (await req('POST', `/etiquetas/${R6}/consumir`, { sessao_id: sRet3 })).body.etiqueta_virtual.id;
    const fim3 = (await req('POST', `/sessoes/${sRet3}/finalizar`)).body;
    await req('POST', '/config', { mp_substituicoes: '{}' });                        // a 1ª desfeita
    ok(etq(S3).material_key === 'EVOH' && fim3.bling && fim3.bling.ok, `cenário: ${S3} saiu como EVOH no pedido ${fim3.bling && fim3.bling.bling_id}`);
    await derrubar();
    comBanco(db => db.prepare(`DELETE FROM config WHERE chave = 'patch_troca_evoh_retiradas'`).run());
    await subir();
    ok(etq(S3).material_key === 'POLI' && etq(S3).material_nome === etq(R6).material_nome, `ao instalar, ${S3} volta a POLINYLON`, etq(S3));
    const rec3 = ((await req('GET', '/sessoes/finalizadas-recentes?horas=48')).body.sessoes || []).find(x => x.id === sRet3) || {};
    ok(rec3.corrigida_troca_evoh && rec3.corrigida_troca_evoh.pedido_antigo === String(fim3.bling.bling_id)
       && rec3.corrigida_troca_evoh.reenviada === false,
       'e a tela de Envios ao Bling pede para excluir o pedido antigo e reenviar', rec3.corrigida_troca_evoh);

  } catch (e) {
    falhou++;
    console.error('\n\x1b[31mERRO NO TESTE:\x1b[0m', e.stack || e.message);
  } finally {
    console.log('\n═══════════════════════════════════════════════════');
    console.log(` RESULTADO: ${passou} passou, ${falhou} falhou`);
    console.log('═══════════════════════════════════════════════════\n');
    try { servidor && servidor.kill('SIGKILL'); } catch (e) {}
    try { fake && fake.close(); } catch (e) {}
    for (const f of [DB, DB + '-wal', DB + '-shm', TOK]) { try { fs.rmSync(f, { force: true }); } catch (e) {} }
    try { fs.rmSync(LOGS, { recursive: true, force: true }); } catch (e) {}
    setTimeout(() => process.exit(falhou ? 1 : 0), 200);
  }
})();
