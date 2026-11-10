// ════════════════════════════════════════════════════════════════════
//  VARREDURA DE RECEBIMENTO × DE PRODUÇÃO — Ekoplastic (10/11/2026, Vinicius)
//  Sobe o server.js REAL (banco temporário, impressão simulada) e prova:
//
//   1. A lista de recebimentos do dia traz o último primeiro, com os
//      materiais (código + lote) de cada um; cancelada não conta.
//   2. Varredura de recebimento grava tipo + origem lida do BANCO
//      (fornecedor, material, código, lote, nº do recebimento).
//   3. Recusa: material/lote que o recebimento não tem, sessão que não é
//      de recebimento, tipo inválido, tipo em item que não é varredura.
//   4. Varredura de produção e varredura sem tipo (tela antiga) seguem.
//   5. A etiqueta impressa leva a origem; o pedido (simulação) separa na
//      observação cada material/lote e a de produção. Produto = RES.VARREDURA.
//   6. Repetir o mesmo clique (mesmo clientToken) não cria 2 etiquetas.
//
//  Como rodar:   node testes/varredura-recebimento.js
// ════════════════════════════════════════════════════════════════════

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');
const { DatabaseSync } = require('node:sqlite');

const ROOT     = path.join(__dirname, '..');
const SERVER   = path.join(ROOT, 'server.js');
const PORT     = 13965;
const PORT_CB  = 18965;
const BASE     = `http://localhost:${PORT}`;
const CARIMBO  = Date.now();
const TMP_DB   = path.join(os.tmpdir(), `eko_varredura_${CARIMBO}.db`);
const TMP_LOGS = path.join(os.tmpdir(), `eko_varredura_logs_${CARIMBO}`);
const DIR_EPL  = path.join(TMP_LOGS, 'print-simulado');

let servidor;
let passou = 0, falhou = 0;
function ok(cond, nome, detalhe = '') {
  if (cond) { passou++; console.log(`  \x1b[32m✓\x1b[0m ${nome}`); }
  else      { falhou++; console.log(`  \x1b[31m✗ ${nome}\x1b[0m ${typeof detalhe === 'string' ? detalhe : JSON.stringify(detalhe)}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function req(metodo, caminho, corpo) {
  const r = await fetch(BASE + caminho, {
    method: metodo,
    headers: corpo ? { 'Content-Type': 'application/json' } : {},
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  let json = null; try { json = await r.json(); } catch(e) {}
  return { status: r.status, json };
}
function comBanco(fn) {
  const db = new DatabaseSync(TMP_DB);
  try { return fn(db); } finally { db.close(); }
}

async function subirServidor() {
  servidor = spawn('node', [SERVER], {
    env: { ...process.env, EKO_PORT: String(PORT), EKO_PORT_CB: String(PORT_CB),
           EKO_DB_FILE: TMP_DB, EKO_LOG_DIR: TMP_LOGS, TZ: 'America/Sao_Paulo',
           EKO_PRINT_SIMULAR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  servidor.stdout.on('data', () => {});
  servidor.stderr.on('data', d => { if (process.env.VERBOSE) process.stderr.write(d); });
  for (let i = 0; i < 75; i++) {
    try { const r = await fetch(BASE + '/healthcheck'); if (r.ok) return; } catch(e) {}
    await sleep(200);
  }
  throw new Error('Servidor não subiu em 15s');
}
function encerrar() {
  try { servidor && servidor.kill('SIGKILL'); } catch(e) {}
  for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.rmSync(f, { force: true }); } catch(e) {} }
  try { fs.rmSync(TMP_LOGS, { recursive: true, force: true }); } catch(e) {}
}
function eplsImpressos() {
  if (!fs.existsSync(DIR_EPL)) return [];
  return fs.readdirSync(DIR_EPL).map(f => fs.readFileSync(path.join(DIR_EPL, f), 'latin1'));
}

// Recebimento com N big bags: [{codigo, lote, peso, nome?, key?, cor?}]
async function recebimento(fornecedor, bags, finalizar = true) {
  const s = await req('POST', '/sessoes', { tipo: 'recebimento', operador: 'Teste', fornecedor });
  const sid = s.json.sessao_id;
  const ids = [];
  for (const b of bags) {
    const r = await req('POST', '/etiquetas', {
      clientToken: `rb-${CARIMBO}-${Math.random()}`, tipo: 'recebimento',
      materialKey: b.key || 'GBD', materialNomeEt: b.nome || 'BAIXA DENSIDADE', cor: b.cor || null,
      fornecedor, peso: b.peso, lote: b.lote, codigo: b.codigo,
      sku: `GBD.${b.codigo} | ${b.peso} | L${b.lote}`, sessao_id: sid,
    });
    ids.push(r.json.id);
    await req('POST', `/etiquetas/${r.json.id}/bipar`);
  }
  if (finalizar) await req('POST', `/sessoes/${sid}/finalizar`);
  return { sid, ids };
}

(async () => {
  try {
    await subirServidor();
    const h = await req('GET', '/healthcheck');
    if (!h.json || h.json.impressao_simulada_forcada !== true) throw new Error('ABORTADO: impressão não está travada em simulação');

    console.log('\n[1] Lista de recebimentos do dia');
    let r = await req('GET', '/etiquetas/outras/recebimentos-do-dia');
    ok(r.status === 200 && Array.isArray(r.json.recebimentos) && r.json.recebimentos.length === 0, 'sem recebimento: lista vazia', r.json);

    const rA = await recebimento('Cedro', [{ codigo: 'CAN1', lote: '101126', peso: 1000 }]);
    const rB = await recebimento('Piquiri', [
      { codigo: 'COL3', lote: '101126', peso: 1250 }, { codigo: 'COL3', lote: '101126', peso: 1240 },
      { codigo: 'PT4', lote: '101126', peso: 1200 }, { codigo: 'PT4', lote: '091126', peso: 900 },
    ]);
    // big bag cancelado não entra na lista
    const rC = await recebimento('Ycaro', [{ codigo: 'NCRIS1', lote: '101126', peso: 1000 }, { codigo: 'NLEI4', lote: '101126', peso: 1100 }], false);
    await req('POST', `/etiquetas/${rC.ids[1]}/cancelar`);
    await req('POST', `/sessoes/${rC.sid}/finalizar`);

    r = await req('GET', '/etiquetas/outras/recebimentos-do-dia');
    const lista = (r.json && r.json.recebimentos) || [];
    ok(lista.length === 3, '3 recebimentos hoje', lista.map(x => x.sessao_id));
    ok(lista[0] && lista[0].sessao_id === rC.sid, 'o último recebimento vem primeiro', lista.map(x => x.sessao_id));
    const piq = lista.find(x => x.sessao_id === rB.sid) || { materiais: [] };
    ok(piq.fornecedor === 'Piquiri' && piq.materiais.length === 3, 'Piquiri: 3 materiais (COL3 101126, PT4 091126, PT4 101126)', piq.materiais);
    const col3 = piq.materiais.find(m => m.codigo === 'COL3') || {};
    ok(col3.n === 2 && col3.kg === 2490 && col3.lote === '101126', 'COL3 soma 2 big bags, 2.490 kg', col3);
    const yc = lista.find(x => x.sessao_id === rC.sid) || { materiais: [] };
    ok(yc.materiais.length === 1 && yc.materiais[0].codigo === 'NCRIS1', 'big bag cancelado (NLEI4) não aparece', yc.materiais);
    r = await req('GET', '/etiquetas/outras/recebimentos-do-dia?data=2020-01-01');
    ok(r.status === 200 && r.json.recebimentos.length === 0, 'outro dia: nada', r.json);
    r = await req('GET', '/etiquetas/outras/recebimentos-do-dia?data=amanha');
    ok(r.status === 400, 'data inválida: 400', r.json);
    r = await req('GET', '/etiquetas/outras/recebimentos-do-dia?data=2026-13-45');
    ok(r.status === 400, 'data impossível (mês 13): 400, não 500', r.json);

    console.log('\n[2] Varredura de recebimento grava a origem do banco');
    const so = await req('POST', '/sessoes', { tipo: 'outras', operador: 'Teste' });
    const sidO = so.json.sessao_id;
    const base = { sessao_id: sidO, item_codigo: 'RES.VARREDURA' };
    r = await req('POST', '/etiquetas/outras', { ...base, clientToken: 'v1', peso: 30.5, varredura_tipo: 'recebimento',
      varredura_origem: { sessao_id: rB.sid, codigo: 'PT4', lote: '091126', fornecedor: 'FORJADO' } });
    ok(r.status === 200 && r.json.ok, 'varredura de recebimento (PT4 091126) impressa', r.json);
    const v1 = comBanco(db => db.prepare('SELECT * FROM etiquetas WHERE id = ?').get(r.json && r.json.id)) || {};
    let o1 = {}; try { o1 = JSON.parse(v1.varredura_origem); } catch(e) {}
    ok(v1.varredura_tipo === 'recebimento' && o1.sessao_id === rB.sid && o1.codigo === 'PT4' && o1.lote === '091126',
       'grava tipo + sessão + código + lote', v1);
    ok(o1.fornecedor === 'Piquiri' && o1.material_nome === 'BAIXA DENSIDADE',
       'fornecedor e material vêm do banco (o "FORJADO" da tela é ignorado)', o1);
    ok(v1.sku === 'RES.VARREDURA' && v1.fornecedor === 'EKOPLASTIC', 'continua RES.VARREDURA, contato EKOPLASTIC', v1);

    // mesma varredura repetida (clique duplo / retry): uma etiqueta só
    const antes = comBanco(db => db.prepare("SELECT COUNT(*) n FROM etiquetas WHERE tipo='outras'").get().n);
    r = await req('POST', '/etiquetas/outras', { ...base, clientToken: 'v1', peso: 30.5, varredura_tipo: 'recebimento',
      varredura_origem: { sessao_id: rB.sid, codigo: 'PT4', lote: '091126' } });
    const depois = comBanco(db => db.prepare("SELECT COUNT(*) n FROM etiquetas WHERE tipo='outras'").get().n);
    ok(r.status === 200 && r.json.idempotente === true && depois === antes, 'mesmo clientToken 2x: 1 etiqueta só', { r: r.json, antes, depois });
    // retry com a resposta perdida: o 2º envio NÃO revalida a origem (senão um
    // big bag cancelado no meio faria o retry falhar mesmo com a etiqueta impressa)
    r = await req('POST', '/etiquetas/outras', { ...base, clientToken: 'v1', peso: 30.5, varredura_tipo: 'recebimento',
      varredura_origem: { sessao_id: rB.sid, codigo: 'NAO-EXISTE', lote: 'x' } });
    ok(r.status === 200 && r.json.idempotente === true, 'retry do mesmo token devolve a etiqueta já impressa (sem revalidar)', r.json);

    for (const [tok, cod, lote, peso] of [['v2', 'COL3', '101126', 20], ['v3', 'COL3', '101126', 12.5], ['v4', 'CAN1', '101126', 8]]) {
      const sid = cod === 'CAN1' ? rA.sid : rB.sid;
      r = await req('POST', '/etiquetas/outras', { ...base, clientToken: tok, peso, varredura_tipo: 'recebimento',
        varredura_origem: { sessao_id: sid, codigo: cod, lote } });
      ok(r.status === 200, `varredura ${cod} ${peso} kg impressa`, r.json);
    }

    console.log('\n[3] Recusas');
    r = await req('POST', '/etiquetas/outras', { ...base, clientToken: 'x1', peso: 5, varredura_tipo: 'recebimento',
      varredura_origem: { sessao_id: rB.sid, codigo: 'CAN1', lote: '101126' } });
    ok(r.status === 400, 'material que o recebimento não tem: 400', r.json);
    r = await req('POST', '/etiquetas/outras', { ...base, clientToken: 'x2', peso: 5, varredura_tipo: 'recebimento',
      varredura_origem: { sessao_id: rC.sid, codigo: 'NLEI4', lote: '101126' } });
    ok(r.status === 400, 'material só de big bag cancelado: 400', r.json);
    r = await req('POST', '/etiquetas/outras', { ...base, clientToken: 'x3', peso: 5, varredura_tipo: 'recebimento',
      varredura_origem: { sessao_id: sidO, codigo: 'RES.VARREDURA', lote: '101126' } });
    ok(r.status === 400, 'sessão que não é de recebimento: 400', r.json);
    r = await req('POST', '/etiquetas/outras', { ...base, clientToken: 'x4', peso: 5, varredura_tipo: 'recebimento' });
    ok(r.status === 400, 'recebimento sem origem: 400', r.json);
    r = await req('POST', '/etiquetas/outras', { ...base, clientToken: 'x5', peso: 5, varredura_tipo: 'outra' });
    ok(r.status === 400, 'tipo inválido: 400', r.json);
    r = await req('POST', '/etiquetas/outras', { sessao_id: sidO, item_codigo: 'RES.BORRA', clientToken: 'x6', peso: 5, varredura_tipo: 'producao' });
    ok(r.status === 400, 'tipo de varredura em BORRA: 400', r.json);
    const recusadas = comBanco(db => db.prepare("SELECT COUNT(*) n FROM etiquetas WHERE tipo='outras'").get().n);
    ok(recusadas === depois + 3, 'nenhuma recusa virou etiqueta', { recusadas, esperado: depois + 3 });

    console.log('\n[4] Produção e tela antiga');
    r = await req('POST', '/etiquetas/outras', { ...base, clientToken: 'p1', peso: 40, varredura_tipo: 'producao' });
    const vp = comBanco(db => db.prepare('SELECT varredura_tipo, varredura_origem FROM etiquetas WHERE id = ?').get(r.json && r.json.id)) || {};
    ok(r.status === 200 && vp.varredura_tipo === 'producao' && vp.varredura_origem === null, 'varredura de produção: tipo producao, sem origem', vp);
    r = await req('POST', '/etiquetas/outras', { ...base, clientToken: 'p2', peso: 10 });
    const va = comBanco(db => db.prepare('SELECT varredura_tipo FROM etiquetas WHERE id = ?').get(r.json && r.json.id)) || {};
    ok(r.status === 200 && va.varredura_tipo === null, 'sem tipo (tela antiga): grava como antes', va);
    r = await req('POST', '/etiquetas/outras', { sessao_id: sidO, item_codigo: 'RES.BORRA', clientToken: 'p3', peso: 15 });
    ok(r.status === 200, 'BORRA segue igual', r.json);

    console.log('\n[5] Etiqueta e pedido');
    const epls = eplsImpressos();
    const eplRec = epls.find(t => t.includes('VARREDURA DE RECEBIMENTO') && t.includes('PIQUIRI - PT4 - LOTE 091126'));
    ok(!!eplRec, 'etiqueta da varredura de recebimento traz fornecedor - código - lote');
    ok(eplRec && eplRec.includes(`BAIXA DENSIDADE - RECEB. #${rB.sid}`), 'e o material + nº do recebimento');
    ok(epls.some(t => t.includes('"VARREDURA DE PRODUCAO"')), 'etiqueta da varredura de produção diz PRODUCAO');
    ok(epls.some(t => /A\d+,182,0,4,1,3,N,"VARREDURA"/.test(t)), 'varredura sem tipo: etiqueta igual à de antes');

    const pend = comBanco(db => db.prepare("SELECT id FROM etiquetas WHERE sessao_id = ? AND status = 'aguardando_bipe'").all(sidO));
    for (const e of pend) await req('POST', `/etiquetas/${e.id}/bipar`);
    const fim = await req('POST', `/sessoes/${sidO}/finalizar`);
    ok(fim.status === 200 && fim.json.ok, 'sessão de resíduos finaliza', fim.json);
    const payload = comBanco(db => { const x = db.prepare('SELECT valor FROM config WHERE chave = ?').get(`payload_sessao_${sidO}`); return x ? JSON.parse(x.valor) : null; }) || {};
    const obs = payload.observacoes || '';
    ok(obs.includes(`VARREDURA DE RECEBIMENTO · PIQUIRI · BAIXA DENSIDADE COL3 · LOTE 101126 · RECEB. #${rB.sid}: 32,5 KG`),
       'observação: Piquiri COL3 lote 101126 = 20 + 12,5 kg numa linha', obs);
    ok(obs.includes(`VARREDURA DE RECEBIMENTO · PIQUIRI · BAIXA DENSIDADE PT4 · LOTE 091126 · RECEB. #${rB.sid}: 30,5 KG`),
       'observação: Piquiri PT4 lote 091126 em linha separada', obs);
    ok(obs.includes(`VARREDURA DE RECEBIMENTO · CEDRO · BAIXA DENSIDADE CAN1 · LOTE 101126 · RECEB. #${rA.sid}: 8,0 KG`),
       'observação: Cedro CAN1 em linha separada', obs);
    ok(obs.includes('VARREDURA DE PRODUÇÃO: 40,0 KG'), 'observação: varredura de produção à parte', obs);
    ok(/\nVARREDURA: 10,0 KG/.test(obs), 'observação: varredura sem tipo como antes', obs);
    const itensVar = (payload.itens || []).filter(i => i.chave_produto === 'RES.VARREDURA');
    ok(itensVar.length === 6 && itensVar.every(i => i.produto.id === '16572867344'), '6 itens de varredura, todos no produto RES.VARREDURA', itensVar);
    ok(itensVar.some(i => new RegExp(`rec #${rB.sid} PT4 L091126 Piquiri`).test(i.descricao_local)),
       'descrição do item leva a origem curta', itensVar.map(i => i.descricao_local));

    console.log('\n[6] Reimpressão, resumo com fornecedor de nome longo, desempate por cor');
    const v1id = v1.id;
    r = await req('POST', `/etiquetas/${v1id}/reimprimir`, {});
    await sleep(300);
    // a original + a reimpressão, as duas com a origem
    const novas = eplsImpressos().filter(t => t.includes(v1id) && t.includes('VARREDURA DE RECEBIMENTO'));
    ok(r.status === 200 && novas.length >= 2, 'reimprimir a varredura de recebimento: a cópia sai com a origem', { r: r.json, n: novas.length });
    ok(novas.every(t => t.includes('PIQUIRI - PT4 - LOTE 091126')), 'as duas vias com fornecedor - código - lote');

    const rL = await recebimento('Cristal Master Industria e Comercio', [
      { codigo: 'COL9', lote: '101126', peso: 1000, cor: 'Natural' }, { codigo: 'COL9', lote: '101126', peso: 1000, cor: 'Azul' }]);
    r = await req('GET', '/etiquetas/outras/recebimentos-do-dia');
    const cm = (r.json.recebimentos || []).find(x => x.sessao_id === rL.sid) || { materiais: [] };
    ok(cm.materiais.length === 2, 'mesmo código+lote com cores diferentes: 2 materiais na lista', cm.materiais);
    const so2 = await req('POST', '/sessoes', { tipo: 'outras', operador: 'Teste' });
    r = await req('POST', '/etiquetas/outras', { sessao_id: so2.json.sessao_id, item_codigo: 'RES.VARREDURA', clientToken: 'c1', peso: 9,
      varredura_tipo: 'recebimento', varredura_origem: { sessao_id: rL.sid, codigo: 'COL9', lote: '101126', material_key: 'GBD', cor: 'Azul' } });
    const vc = comBanco(db => db.prepare('SELECT varredura_origem FROM etiquetas WHERE id = ?').get(r.json && r.json.id)) || {};
    let oc = {}; try { oc = JSON.parse(vc.varredura_origem); } catch(e) {}
    ok(r.status === 200 && oc.cor === 'Azul', 'a escolha "Azul" grava Azul (não a primeira que achar)', oc);
    r = await req('POST', '/etiquetas/outras', { sessao_id: so2.json.sessao_id, item_codigo: 'RES.VARREDURA', clientToken: 'c2', peso: 1,
      varredura_tipo: 'recebimento', varredura_origem: 'texto' });
    ok(r.status === 400, 'origem que não é objeto: 400', r.json);
    const pend2 = comBanco(db => db.prepare("SELECT id FROM etiquetas WHERE sessao_id = ? AND status = 'aguardando_bipe'").all(so2.json.sessao_id));
    for (const e of pend2) await req('POST', `/etiquetas/${e.id}/bipar`);
    await req('POST', `/sessoes/${so2.json.sessao_id}/finalizar`);
    const nR = eplsImpressos().length;
    r = await req('POST', '/resumo-dia', { tipo: 'outras' });
    await sleep(300);
    const resumo = eplsImpressos().filter(t => /A30,24,0,4,1,1,N,"RESUMO/.test(t)).pop() || '';
    ok(r.status === 200 && eplsImpressos().length > nR, 'resumo do dia de resíduos impresso', r.json);
    ok(resumo.includes(`VARREDURA REC #${rL.sid} COL9 L101126 CRISTAL`),
       'resumo: fornecedor de nome longo não come o lote (nº do recebimento, código e lote primeiro)',
       (resumo.match(/"VARREDURA[^"]*"/g) || []).join(' | '));
    ok(resumo.includes(`VARREDURA REC #${rB.sid} COL3 L101126 PIQUIRI`), 'resumo: grupo do Piquiri COL3');
  } catch (e) {
    ok(false, 'exceção no teste: ' + e.message);
  } finally {
    encerrar();
  }
  console.log(`\n${passou} ok, ${falhou} falha(s)\n`);
  process.exit(falhou ? 1 : 0);
})();
