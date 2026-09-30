// ════════════════════════════════════════════════════════════════════
//  TROCA DE PRODUTO — POLINYLON TALLPACK → RESINA EVOH (30/09/2026)
//  ------------------------------------------------------------------
//  Polinylon · Tallpack · Cristal/Leitoso passou a ser Resina EVOH ·
//  Tallpack · Cristal/Leitoso. O estoque físico (8.502 kg de Cristal) já
//  está etiquetado como Polinylon. O que o Frederico pediu:
//    · as MESMAS etiquetas continuam valendo, mas são LIDAS como Resina
//      EVOH — a retirada baixa EVOH no Bling;
//    · o Recebimento passa a ter RESINA EVOH (Tallpack, Cristal/Leitoso);
//    · Polinylon Tallpack Cristal/Leitoso não recebe mais entrada.
//
//  A regra que protege a operação: a troca só LIGA quando a EVOH está
//  mapeada no Bling. Os IDs/SKUs da EVOH vieram em 30/09/2026 e entram
//  com a atualização. Este teste prova os dois lados (sem mapa, nada muda)
//  e que dá para desligar.
//
//  30/09/2026 (noite): a troca foi DESFEITA a pedido do Frederico — o
//  padrão agora é SEM troca (ver troca-evoh-desfeita.js). O mecanismo
//  continua no código; aqui ele é ligado pela configuração, como seria
//  numa troca futura, para provar que segue funcionando.
//
//  O Bling aqui é de mentira: listagem, detalhe com variações, busca por
//  SKU e os pedidos de compra/venda são gravados para conferência.
// ════════════════════════════════════════════════════════════════════
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const http = require('node:http');
const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');

const ROOT = path.join(__dirname, '..');
const PORT = 13921, PORT_CB = 18921;
const BASE = `http://localhost:${PORT}`;
const C = Date.now();
const TMP_DB   = path.join(os.tmpdir(), `eko_te_${C}.db`);
const TMP_LOGS = path.join(os.tmpdir(), `eko_te_${C}`);
const TMP_TOK  = path.join(os.tmpdir(), `eko_te_tok_${C}.json`);

let passou = 0, falhou = 0, servidor, fake, portaFake = 0;
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
const lerDb = (sql, ...p) => {
  const db = new DatabaseSync(TMP_DB);
  try { return db.prepare(sql).get(...p); } finally { db.close(); }
};
const cfg = k => { const r = lerDb('SELECT valor FROM config WHERE chave = ?', k); return r ? JSON.parse(r.valor) : null; };

// ── O BLING DE MENTIRA ───────────────────────────────────────────────
// Como o Frederico cadastrou: um produto-pai RESINA EVOH (16711891720) com
// as cores como variação; o fornecedor só aparece na SKU ("...TALL"). Os
// ids das variações aqui são inventados — no envio eles vêm pela SKU.
const LISTAGEM = [
  { id: 16586065201, nome: 'RESINA POLINYLON CRISTAL TALLPACK', codigo: 'POLI.CRIS.TALLPACK', formato: 'S' },
  { id: 16711891720, nome: 'RESINA EVOH', codigo: 'EVOH', formato: 'V' },
];
const DETALHE = {
  16711891720: { id: 16711891720, nome: 'RESINA EVOH', codigo: 'EVOH', formato: 'V', variacoes: [
    { id: 16711891721, nome: 'RESINA EVOH Cor:CRISTAL', codigo: 'EVOH.CRISTAL.TALL', variacao: { nome: 'Cor:CRISTAL' } },
    { id: 16711891722, nome: 'RESINA EVOH Cor:LEITOSO', codigo: 'EVOH.LEI.TALL',     variacao: { nome: 'Cor:LEITOSO' } },
  ] },
};
const POR_SKU = { 'EVOH.CRISTAL.TALL': 16711891721, 'EVOH.LEI.TALL': 16711891722 };
const pedidos = [];
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
          return responder(201, { data: { id: 700000 + pedidos.length } });
        }
        const mDet = u.pathname.match(/^\/Api\/v3\/produtos\/(\d+)$/);
        if (mDet) { const d = DETALHE[mDet[1]]; return d ? responder(200, { data: d }) : responder(404, { error: {} }); }
        if (u.pathname === '/Api/v3/produtos') {
          const cod = u.searchParams.get('codigo');
          if (cod) return responder(200, { data: POR_SKU[cod] ? [{ id: POR_SKU[cod], codigo: cod }] : [] });
          const pag = parseInt(u.searchParams.get('pagina') || '1', 10);
          return responder(200, { data: pag === 1 ? LISTAGEM : [] });
        }
        if (u.pathname.startsWith('/Api/v3/contatos')) return responder(200, { data: [{ id: 17807369878, nome: 'TALLPACK' }] });
        return responder(200, { data: {} });
      });
    });
    fake.listen(0, '127.0.0.1', () => { portaFake = fake.address().port; resolve(); });
  });
}

async function subirServidor() {
  if (!fs.existsSync(TMP_TOK))
    fs.writeFileSync(TMP_TOK, JSON.stringify({ accessToken: 'tok', refreshToken: 'refresh-fake', expiresAt: Date.now() + 3600e3 }));
  servidor = spawn('node', [path.join(ROOT, 'server.js')], {
    env: { ...process.env, EKO_PORT: String(PORT), EKO_PORT_CB: String(PORT_CB),
           EKO_DB_FILE: TMP_DB, EKO_LOG_DIR: TMP_LOGS, EKO_TOKEN_FILE: TMP_TOK,
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
async function derrubarServidor() {
  if (!servidor) return;
  const p = servidor; servidor = null;
  await new Promise(r => { p.once('exit', r); p.kill('SIGKILL'); setTimeout(r, 3000); });
}

let nToken = 0;
async function etiqueta(sessao_id, tipo, mat, nomeEt, cor, forn, peso, extra = {}) {
  const pref = `${mat}${cor ? '.' + (cor === 'Cristal' ? 'CRIS' : cor === 'Leitoso' ? 'LEI' : cor.slice(0, 3).toUpperCase()) : ''}`
             + `.${forn.replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase()}`;
  return req('POST', '/etiquetas', {
    clientToken: extra.clientToken || `te-${C}-${++nToken}`, tipo, materialKey: mat, materialNomeEt: nomeEt,
    cor, fornecedor: forn, peso, lote: '300926', codigo: extra.codigo || 'X1',
    sku: `${pref} | ${peso} | L300926`, sessao_id, ...(extra.ref_id ? { ref_id: extra.ref_id } : {}),
  });
}

(async () => {
  try {
    console.log('\n═══════════════════════════════════════════════════');
    console.log(' TROCA DE PRODUTO — POLINYLON TALLPACK → RESINA EVOH');
    console.log('═══════════════════════════════════════════════════\n');
    await subirFake();
    await subirServidor();
    await req('POST', '/config', { bling_simular: '0', bling_host_api: 'localhost:' + portaFake,
                                   bling_host_oauth: 'localhost:' + portaFake });

    // ── [1] O CATÁLOGO JÁ TEM A RESINA EVOH ────────────────────────
    console.log('[1] A Resina EVOH vem no catálogo, já mapeada no Bling; a troca só vale se for configurada');
    const cat = await req('GET', '/catalogo-mp');
    const evoh = (cat.body.materiais || {}).EVOH || {};
    ok(evoh.popular === 'Resina EVOH' && JSON.stringify(evoh.cores) === '["Cristal","Leitoso"]',
       'material RESINA EVOH, cores Cristal e Leitoso', evoh);
    ok(JSON.stringify((cat.body.fornecedores || {}).EVOH) === '["Tallpack"]', 'fornecedor Tallpack', cat.body.fornecedores);
    const mapa0 = cfg('mapa_produto_bling') || {}, skus0 = cfg('mapa_sku_variacao_mp') || {};
    ok(mapa0['EVOH:Cristal:Tallpack'] === '16711891720' && mapa0['EVOH:Leitoso:Tallpack'] === '16711891720',
       'mapeada no Bling: produto 16711891720 (as duas cores)', mapa0);
    ok(skus0['EVOH:Cristal:Tallpack'] === 'EVOH.CRISTAL.TALL' && skus0['EVOH:Leitoso:Tallpack'] === 'EVOH.LEI.TALL',
       'com as SKUs das variações: EVOH.CRISTAL.TALL e EVOH.LEI.TALL', skus0);
    ok((cat.body.substituicoes || []).length === 0,
       'por padrão NÃO há troca nenhuma (desfeita em 30/09/2026)', cat.body.substituicoes);
    await req('POST', '/config', { mp_substituicoes: JSON.stringify({
      'POLI:Cristal:Tallpack': 'EVOH:Cristal:Tallpack', 'POLI:Leitoso:Tallpack': 'EVOH:Leitoso:Tallpack' }) });
    const subs0 = (await req('GET', '/catalogo-mp')).body.substituicoes || [];
    ok(subs0.length === 2 && subs0.every(t => t.ativa === true),
       'configurada, a troca vale (o mecanismo continua disponível)', subs0);

    // ── [2] SEM A EVOH MAPEADA: NADA MUDA ──────────────────────────
    console.log('\n[2] Sem a EVOH mapeada, tudo segue exatamente como hoje');
    const semEvoh = { ...mapa0 }; delete semEvoh['EVOH:Cristal:Tallpack']; delete semEvoh['EVOH:Leitoso:Tallpack'];
    await req('POST', '/config', { mapa_produto_bling: JSON.stringify(semEvoh) });
    ok(((await req('GET', '/catalogo-mp')).body.substituicoes || []).every(t => t.ativa === false),
       'tirando a EVOH do mapa, a troca PARA sozinha');
    const sRec = (await req('POST', '/sessoes', { tipo: 'recebimento', operador: 'Teste', fornecedor: 'Tallpack' })).body.sessao_id;
    const ids = [];
    for (const [cor, peso, tok] of [['Cristal', 900, 'antes-1'], ['Cristal', 910], ['Cristal', 920], ['Leitoso', 880]]) {
      const r = await etiqueta(sRec, 'recebimento', 'POLI', 'POLINYLON', cor, 'Tallpack', peso, tok ? { clientToken: tok } : {});
      ids.push(r.body && r.body.id);
      if (r.body && r.body.id) await req('POST', `/etiquetas/${r.body.id}/bipar`);
    }
    ok(ids.every(Boolean), `Polinylon Tallpack ainda entra normalmente: ${ids.join(', ')}`, ids);
    const [R1, R2, R3] = ids;
    const g0 = await req('GET', `/etiqueta/${R1}`);
    ok(g0.body.etiqueta.material_key === 'POLI' && !g0.body.etiqueta.substituida_de,
       'a etiqueta é lida como Polinylon, como sempre', g0.body.etiqueta);
    const sRet0 = (await req('POST', '/sessoes', { tipo: 'retirada', operador: 'Teste' })).body.sessao_id;
    const c0 = await req('POST', `/etiquetas/${R1}/consumir`, { sessao_id: sRet0 });
    ok(c0.status === 200 && c0.body.etiqueta_virtual.material_key === 'POLI',
       'e a retirada sai como Polinylon', c0.body);

    // ── [3] A EVOH MAPEADA LIGA A TROCA ────────────────────────────
    console.log('\n[3] Com a EVOH mapeada de novo, a troca liga');
    await req('POST', '/config', { mapa_produto_bling: JSON.stringify(mapa0) });
    ok(((await req('GET', '/catalogo-mp')).body.substituicoes || []).every(t => t.ativa === true), 'as duas trocas valem');
    const b0 = await etiqueta(sRec, 'recebimento', 'POLI', 'POLINYLON', 'Cristal', 'Tallpack', 900, { clientToken: 'antes-1' });
    ok(b0.status === 200 && b0.body.idempotente && b0.body.id === R1,
       'uma nova tentativa de etiqueta impressa ANTES da troca não é barrada (devolve a mesma)', b0.body);
    // Instalar a atualização num banco sem a EVOH: o seed põe o mapa de volta.
    await req('POST', '/config', { mapa_produto_bling: JSON.stringify(semEvoh) });
    await derrubarServidor();
    await subirServidor();
    const subsR = (await req('GET', '/catalogo-mp')).body.substituicoes || [];
    ok(subsR.length === 2 && subsR.every(t => t.ativa === true),
       'reiniciando, a EVOH volta ao mapa e a troca configurada continua valendo', subsR);
    const p = await req('GET', '/sync/mp/procurar');
    const novos = (p.body && p.body.novos) || [];
    ok(p.status === 200 && !novos.length && p.body.ja_cadastrados === 3,
       `Cadastros Bling reconhece as duas EVOH como já cadastradas (${p.body && p.body.ja_cadastrados} já cadastrados, ${novos.length} novos)`,
       { novos, nr: p.body && p.body.nao_reconhecidos });
    ok(!(p.body.nao_reconhecidos || []).length, 'e nada fica sem reconhecer', p.body.nao_reconhecidos);

    // ── [4] AS ETIQUETAS ANTIGAS SÃO LIDAS COMO EVOH ───────────────
    console.log('\n[4] As etiquetas antigas passam a ser lidas como Resina EVOH');
    const g1 = (await req('GET', `/etiqueta/${R2}`)).body.etiqueta;
    ok(g1.material_key === 'EVOH' && g1.material_nome === 'RESINA EVOH' && g1.cor === 'Cristal' && g1.fornecedor === 'Tallpack',
       `${R2} é lida como RESINA EVOH · Cristal · Tallpack`, g1);
    ok(g1.codigo === 'X1' && /^EVOH\.CRIS\.TALLPA \|/.test(g1.sku),
       `sem código gravimétrico da EVOH cadastrado, fica o da etiqueta (${g1.codigo}); SKU impressa da EVOH (${g1.sku})`, g1);
    const cod = await req('POST', '/catalogo-mp/codigo', { matKey: 'EVOH', cor: 'Cristal', forn: 'Tallpack', codigo: 'EVC1' });
    ok(cod.status === 200, 'cadastrando o código da EVOH Cristal pela tela…', cod.body);
    ok((await req('GET', `/etiqueta/${R2}`)).body.etiqueta.codigo === 'EVC1', '…a etiqueta passa a mostrar o código da EVOH');
    ok(g1.substituida_de && g1.substituida_de.material_key === 'POLI', 'e diz de onde veio (substituida_de)', g1.substituida_de);
    const reg = lerDb('SELECT material_key, material_nome, cor FROM etiquetas WHERE id = ?', R2);
    ok(reg.material_key === 'POLI' && reg.material_nome === 'POLINYLON',
       'o registro da etiqueta no banco NÃO foi alterado', reg);

    // ── [5] A RETIRADA BAIXA EVOH NO BLING ─────────────────────────
    console.log('\n[5] A retirada de uma etiqueta antiga baixa Resina EVOH no Bling');
    const sRet = (await req('POST', '/sessoes', { tipo: 'retirada', operador: 'Teste' })).body.sessao_id;
    const c1 = await req('POST', `/etiquetas/${R3}/consumir`, { sessao_id: sRet });
    const v = c1.body.etiqueta_virtual || {};
    ok(c1.status === 200 && v.material_key === 'EVOH' && v.cor === 'Cristal' && v.fornecedor === 'Tallpack' && v.ref_id === R3,
       `a retirada ${v.id} sai como EVOH · Cristal · Tallpack, apontando para ${R3}`, c1.body);
    const orig = lerDb('SELECT material_key, status FROM etiquetas WHERE id = ?', R3);
    ok(orig.material_key === 'POLI' && orig.status === 'consumida', 'a etiqueta original ficou consumida e intacta', orig);
    pedidos.length = 0;
    const fim = await req('POST', `/sessoes/${sRet}/finalizar`);
    ok(fim.status === 200 && fim.body.bling && fim.body.bling.ok, 'a sessão fecha e envia ao Bling na hora', fim.body);
    const venda = pedidos.find(x => x.rota === '/Api/v3/pedidos/vendas');
    const item = venda && venda.corpo.itens && venda.corpo.itens[0];
    ok(item && item.produto && item.produto.id === 16711891721 && item.codigo === 'EVOH.CRISTAL.TALL',
       'o pedido de venda leva a variação EVOH Cristal, resolvida pela SKU EVOH.CRISTAL.TALL', venda && venda.corpo);
    ok(item && /RESINA EVOH/.test(item.descricao || ''), 'com "RESINA EVOH" na descrição', item && item.descricao);

    // ── [6] ENTRADA NOVA DO PRODUTO ANTIGO É RECUSADA ──────────────
    console.log('\n[6] Polinylon Tallpack Cristal/Leitoso não recebe mais entrada');
    const sRec2 = (await req('POST', '/sessoes', { tipo: 'recebimento', operador: 'Teste', fornecedor: 'Tallpack' })).body.sessao_id;
    const b1 = await etiqueta(sRec2, 'recebimento', 'POLI', 'POLINYLON', 'Cristal', 'Tallpack', 900);
    ok(b1.status === 409 && b1.body.trava === 'produto_substituido' && /Resina EVOH/.test(b1.body.erro || ''),
       `recebimento de Polinylon Tallpack Cristal: recusado — "${b1.body && b1.body.erro}"`, b1.body);
    const b2 = await etiqueta(sRec2, 'recebimento', 'POLI', 'POLINYLON', 'Leitoso', 'Tallpack', 900);
    ok(b2.status === 409, 'Polinylon Tallpack Leitoso: recusado', b2.body);
    const b3 = await etiqueta(sRec2, 'recebimento', 'POLI', 'POLINYLON', 'Canela', 'Tallpack', 900);
    ok(b3.status === 200, 'Polinylon Tallpack CANELA continua entrando (só Cristal e Leitoso foram trocados)', b3.body);
    const b4 = await etiqueta(sRec2, 'recebimento', 'POLI', 'POLINYLON', 'Cristal', 'Ycaro', 900);
    ok(b4.status === 200, 'Polinylon Cristal da YCARO continua entrando', b4.body);
    const b5 = await etiqueta(sRec2, 'recebimento', 'EVOH', 'RESINA EVOH', 'Cristal', 'Tallpack', 930, { codigo: 'EVC1' });
    ok(b5.status === 200 && lerDb('SELECT material_key FROM etiquetas WHERE id = ?', b5.body.id).material_key === 'EVOH',
       'Resina EVOH Cristal Tallpack entra', b5.body);
    const sRto = (await req('POST', '/sessoes', { tipo: 'retorno', operador: 'Teste' })).body.sessao_id;
    const b7 = await etiqueta(sRto, 'retorno', 'POLI', 'POLINYLON', 'Cristal', 'Tallpack', 300);
    ok(b7.status === 409, 'retorno SEM etiqueta de Polinylon Tallpack Cristal: recusado', b7.body);
    const b8 = await etiqueta(sRto, 'retorno', 'POLI', 'POLINYLON', 'Cristal', 'Tallpack', 300, { ref_id: R2 });
    const t8 = b8.body && b8.body.id ? lerDb('SELECT material_key, material_nome, cor, fornecedor, ref_id FROM etiquetas WHERE id = ?', b8.body.id) : null;
    ok(b8.status === 200 && t8 && t8.material_key === 'EVOH' && t8.material_nome === 'RESINA EVOH' && t8.ref_id === R2,
       'retorno COM etiqueta de origem passa — e volta como Resina EVOH', { resp: b8.body, gravado: t8 });
    const b9 = await req('POST', `/etiquetas/${b5.body.id}/corrigir`,
      { materialKey: 'POLI', materialNomeEt: 'POLINYLON', cor: 'Cristal', fornecedor: 'Tallpack', codigo: 'X', sku: 'POLI.CRIS.TALLPA | 930 | L1' });
    ok(b9.status === 409, 'e não dá para "corrigir" uma etiqueta para o produto antigo', b9.body);

    // ── [7] INVENTÁRIO ─────────────────────────────────────────────
    console.log('\n[7] O inventário conta EVOH, não o produto trocado');
    const inv = (await req('GET', '/inventario/produtos')).body.produtos || [];
    const chaves = inv.map(p => p.chave);
    ok(chaves.includes('EVOH:Cristal:Tallpack') && chaves.includes('EVOH:Leitoso:Tallpack'), 'EVOH Cristal e Leitoso na lista', chaves);
    ok(!chaves.includes('POLI:Cristal:Tallpack') && !chaves.includes('POLI:Leitoso:Tallpack'),
       'Polinylon Tallpack Cristal/Leitoso saíram da lista', chaves.filter(c => /Tallpack/.test(c)));
    ok(chaves.includes('POLI:Canela:Tallpack'), 'Polinylon Tallpack Canela continua');

    // ── [8] RETORNO DE ADITIVOS POR SACOS (mesma lista da retirada) ─
    console.log('\n[8] Retorno de aditivos em sacos segue a mesma lista da retirada');
    const sAd = (await req('POST', '/sessoes', { tipo: 'retorno', operador: 'Teste' })).body.sessao_id;
    const a1 = await req('POST', '/retorno/aditivo', { sessao_id: sAd, materialKey: 'AUXFLUX', fornecedor: 'Cristal Master', qtd_sacos: 2 });
    ok(a1.status === 200 && a1.body.etiqueta.peso === 50 && a1.body.etiqueta.material_nome === 'Auxiliar de Fluxo',
       'Auxiliar de Fluxo volta por sacos: 2 × 25 = 50 kg', a1.body);
    const a2 = await req('POST', '/retorno/aditivo', { sessao_id: sAd, materialKey: 'PIG', fornecedor: 'FG', qtd_sacos: 1 });
    ok(a2.status === 400 && /cor obrigatória para PIG/.test(a2.body.erro || ''), 'Pigmento sem cor: recusado como antes', a2.body);
    const a3 = await req('POST', '/retorno/aditivo', { sessao_id: sAd, materialKey: 'DESSEC', fornecedor: 'FG', qtd_sacos: 1 });
    ok(a3.status === 200 && a3.body.etiqueta.material_nome === 'Dessecante', 'Dessecante igual a antes', a3.body);
    const a4 = await req('POST', '/retorno/aditivo', { sessao_id: sAd, materialKey: 'CARBO', fornecedor: 'FG', qtd_sacos: 1 });
    ok(a4.status === 400, 'Carbonato continua fora do retorno em sacos', a4.body);

    // ── [9] DESLIGAR A TROCA ───────────────────────────────────────
    console.log('\n[9] A troca pode ser desligada — e uma atualização não a religa');
    await req('POST', '/config', { mp_substituicoes: '{}' });
    const g2 = (await req('GET', `/etiqueta/${R2}`)).body.etiqueta;
    ok(g2.material_key === 'POLI' && !g2.substituida_de, 'desligada: a etiqueta volta a ser lida como Polinylon', g2);
    await derrubarServidor();
    await subirServidor();
    const cat2 = await req('GET', '/catalogo-mp');
    ok((cat2.body.substituicoes || []).length === 0, 'depois de reiniciar, a troca continua desligada', cat2.body.substituicoes);
    ok((cat2.body.materiais || {}).EVOH, 'e a Resina EVOH continua no catálogo');

  } catch (e) {
    falhou++;
    console.error('\n\x1b[31mERRO NO TESTE:\x1b[0m', e.stack || e.message);
  } finally {
    console.log('\n═══════════════════════════════════════════════════');
    console.log(` RESULTADO: ${passou} passou, ${falhou} falhou`);
    console.log('═══════════════════════════════════════════════════\n');
    try { servidor && servidor.kill('SIGKILL'); } catch (e) {}
    try { fake && fake.close(); } catch (e) {}
    for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm', TMP_TOK]) { try { fs.rmSync(f, { force: true }); } catch (e) {} }
    try { fs.rmSync(TMP_LOGS, { recursive: true, force: true }); } catch (e) {}
    setTimeout(() => process.exit(falhou ? 1 : 0), 200);
  }
})();
