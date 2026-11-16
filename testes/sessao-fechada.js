// ════════════════════════════════════════════════════════════════════
//  SESSÃO FECHADA NÃO RECEBE ITEM (16/11/2026, revisão dos cartões do
//  pedido de retirada, achado 1)
//  ------------------------------------------------------------------
//  O bipe feito com a confirmação de Finalizar/Cancelar aberta saía logo
//  depois do CONFIRMAR, ainda com o número da sessão que estava fechando.
//  O servidor aceitava: a S entrava numa sessão já enviada ao Bling (bag fora
//  do barracão sem baixa) ou numa sessão cancelada (bag preso como
//  'consumida' para sempre). Este teste prova que o servidor recusa com 409
//  sessao_fechada, em todos os caminhos que gravam item em sessão de MP:
//    · /etiquetas/:id/consumir (retirada bipada), finalizada e cancelada;
//    · /retirada/aditivo (saída por sacos);
//    · /retorno/aditivo e /print/etiqueta (recebimento e retorno);
//    · /etiquetas/:id/bipar de etiqueta de MP de sessão cancelada (voltava
//      a 'bipada' sem entrar em pedido nenhum);
//  e que o bag recusado continua livre para sair na sessão nova, e o
//  "já foi retirada" conta de qual sessão foi (a tela ressincroniza).
// ════════════════════════════════════════════════════════════════════
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');

const ROOT = path.join(__dirname, '..');
const PORT = 13981, PORT_CB = 18981;
const BASE = `http://localhost:${PORT}`;
const C = Date.now();
const TMP_DB   = path.join(os.tmpdir(), `eko_sf_${C}.db`);
const TMP_LOGS = path.join(os.tmpdir(), `eko_sf_${C}`);
const TMP_TOK  = path.join(os.tmpdir(), `eko_sf_tok_${C}.json`);

let passou = 0, falhou = 0, servidor;
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
async function subirServidor() {
  fs.writeFileSync(TMP_TOK, JSON.stringify({ accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3600e3 }));
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

let nTok = 0;
const sessao = (tipo, extra = {}) => req('POST', '/sessoes', { tipo, operador: 'Teste', ...extra }).then(r => r.body.sessao_id);
const imprimir = (tipo, sessao_id, lote = '161126') => req('POST', '/print/etiqueta', {
  clientToken: `sf-${C}-${++nTok}`, tipo, materialKey: 'GBD', materialNomeEt: 'GRÃO BAIXA DENSIDADE',
  cor: 'Preto', fornecedor: 'Ecorafia', peso: 900, lote, codigo: 'X1', sku: 'GBD.PRE.ECORAF | 900 | L' + lote, sessao_id });
async function bag(sRec) {
  const r = await imprimir('recebimento', sRec);
  const id = r.body && r.body.id;
  if (id) await req('POST', `/etiquetas/${id}/bipar`);
  return id;
}
const consumir = (id, s) => req('POST', `/etiquetas/${id}/consumir`, { sessao_id: s });
const contar = (sql, ...p) => lerDb(sql, ...p).n;

(async () => {
  try {
    console.log('\n═══════════════════════════════════════════════════');
    console.log(' SESSÃO FECHADA NÃO RECEBE ITEM');
    console.log('═══════════════════════════════════════════════════\n');
    await subirServidor();
    const sRec = await sessao('recebimento', { fornecedor: 'Ecorafia' });
    const b1 = await bag(sRec), b2 = await bag(sRec), b3 = await bag(sRec);
    ok(b1 && b2 && b3, 'três bags recebidos e bipados', { b1, b2, b3 });

    console.log('\n[1] Retirada FINALIZADA: o bipe que chega depois não entra nela');
    const sA = await sessao('retirada');
    const c1 = await consumir(b1, sA);
    ok(c1.status === 200, 'o 1º bag sai na retirada aberta', c1.body);
    const fin = await req('POST', `/sessoes/${sA}/finalizar`);
    ok(fin.status === 200, 'retirada finalizada', fin.body);
    const c2 = await consumir(b2, sA);
    ok(c2.status === 409 && c2.body && c2.body.sessao_fechada === true && c2.body.sessao_id === sA,
       'bipe na sessão finalizada → 409 sessao_fechada', c2);
    ok(contar(`SELECT COUNT(*) n FROM etiquetas WHERE tipo='retirada' AND ref_id = ?`, b2) === 0,
       'nenhuma S gravada para o bag recusado', null);
    ok(lerDb('SELECT status FROM etiquetas WHERE id = ?', b2).status === 'bipada',
       'o bag recusado continua no estoque (bipada), livre para sair', null);
    const sB = await sessao('retirada');
    const c2b = await consumir(b2, sB);
    ok(c2b.status === 200 && c2b.body.etiqueta_virtual.sessao_id === sB, 'e sai na sessão nova (o que a tela faz ao receber o 409)', c2b.body);

    console.log('\n[2] "Já foi retirada" conta em qual sessão (a tela ressincroniza a lista)');
    const jr = await consumir(b2, sB);
    ok(jr.status === 409 && jr.body.ja_consumida && jr.body.consumo && jr.body.consumo.sessao_id === sB,
       'bipe repetido devolve a sessão do consumo', jr.body);

    console.log('\n[3] Retirada CANCELADA: o bipe que chega depois não prende o bag');
    const sC = await sessao('retirada');
    await consumir(b3, sC);
    const can = await req('POST', `/sessoes/${sC}/cancelar`);
    ok(can.status === 200, 'retirada cancelada (o bag volta)', can.body);
    const b4 = await bag(sRec);
    const c4 = await consumir(b4, sC);
    ok(c4.status === 409 && c4.body.sessao_fechada, 'bipe na sessão cancelada → 409 sessao_fechada', c4);
    ok(lerDb('SELECT status FROM etiquetas WHERE id = ?', b4).status === 'bipada',
       'o bag não ficou "consumida" preso numa sessão cancelada', null);

    console.log('\n[4] Saída por sacos em sessão fechada');
    const ad = await req('POST', '/retirada/aditivo', { sessao_id: sA, materialKey: 'DESSEC', fornecedor: 'Karina', qtd_sacos: 2 });
    ok(ad.status === 409 && ad.body.sessao_fechada, '/retirada/aditivo → 409 sessao_fechada', ad);
    ok(contar(`SELECT COUNT(*) n FROM etiquetas WHERE sessao_id = ? AND sub_tipo = 'aditivo-saida'`, sA) === 0,
       'nada gravado na sessão finalizada', null);

    console.log('\n[4b] Estorno (X) de item de retirada já FINALIZADA');
    // O X tocado com um bipe no ar e o Finalizar logo depois estornava, na vez
    // dele, o item que já tinha ido no Pedido de Venda (6ª revisão, achado B).
    const sA1 = c1.body.etiqueta_virtual && c1.body.etiqueta_virtual.id;
    const es = await req('POST', `/etiquetas/${sA1}/estornar`);
    ok(es.status === 409 && es.body.sessao_fechada && es.body.sessao_id === sA,
       'estorno de item da sessão finalizada → 409 sessao_fechada', es);
    ok(lerDb('SELECT status FROM etiquetas WHERE id = ?', sA1).status !== 'cancelada',
       'o item finalizado não foi cancelado', null);
    ok(lerDb('SELECT status FROM etiquetas WHERE id = ?', b1).status === 'consumida',
       'e o bag segue consumido (a baixa está no Bling)', null);

    console.log('\n[5] Recebimento e retorno em sessão fechada');
    const sR2 = await sessao('recebimento', { fornecedor: 'Ecorafia' });
    const r1 = await imprimir('recebimento', sR2);
    await req('POST', `/etiquetas/${r1.body.id}/bipar`);
    await req('POST', `/sessoes/${sR2}/finalizar`);
    const antes = contar('SELECT COUNT(*) n FROM etiquetas WHERE sessao_id = ?', sR2);
    const pr = await imprimir('recebimento', sR2);
    ok(pr.status === 409 && pr.body.sessao_fechada, '/print/etiqueta de recebimento em sessão finalizada → 409', pr);
    ok(contar('SELECT COUNT(*) n FROM etiquetas WHERE sessao_id = ?', sR2) === antes,
       'nenhuma etiqueta nova na sessão finalizada', null);
    const sT = await sessao('retorno');
    await req('POST', `/sessoes/${sT}/cancelar`);
    const pt = await imprimir('retorno', sT);
    ok(pt.status === 409 && pt.body.sessao_fechada, '/print/etiqueta de retorno em sessão cancelada → 409', pt);
    const at = await req('POST', '/retorno/aditivo', { sessao_id: sT, materialKey: 'DESSEC', fornecedor: 'Karina', qtd_sacos: 1 });
    ok(at.status === 409 && at.body.sessao_fechada, '/retorno/aditivo em sessão cancelada → 409', at);

    console.log('\n[6] Bipar etiqueta de MP de sessão cancelada não a ressuscita');
    const sR3 = await sessao('recebimento', { fornecedor: 'Ecorafia' });
    const r3 = await imprimir('recebimento', sR3);
    await req('POST', `/sessoes/${sR3}/cancelar`);
    const bp = await req('POST', `/etiquetas/${r3.body.id}/bipar`);
    ok(bp.status === 409 && bp.body.sessao_fechada, 'bipar → 409 sessao_fechada', bp);
    ok(lerDb('SELECT status FROM etiquetas WHERE id = ?', r3.body.id).status === 'cancelada',
       'a etiqueta segue cancelada', null);

    console.log('\n[7] Sessão aberta segue normal');
    const sD = await sessao('retirada');
    const b5 = await bag(sRec);
    const c5 = await consumir(b5, sD);
    ok(c5.status === 200, 'bipe em retirada aberta sai', null);
    const es5 = await req('POST', `/etiquetas/${c5.body.etiqueta_virtual.id}/estornar`);
    ok(es5.status === 200 && es5.body.original_liberada === b5, 'estorno em retirada aberta funciona', es5.body);
    ok(lerDb('SELECT status FROM etiquetas WHERE id = ?', b5).status === 'bipada', 'e o bag volta ao estoque', null);
    ok((await consumir(b5, sD)).status === 200, 'e pode sair de novo', null);
    const ad2 = await req('POST', '/retirada/aditivo', { sessao_id: sD, materialKey: 'DESSEC', fornecedor: 'Karina', qtd_sacos: 2 });
    ok(ad2.status === 200, 'sacos em retirada aberta saem', ad2.body);

    console.log('\n[8] Fora da MP nada muda; repetir a MESMA impressão devolve a mesma etiqueta');
    // "Outras pesagens" (e a extrusão) seguem aceitando item em sessão fechada:
    // a bobina impressa depois do fim de turno automático ainda vai ao Bling no bipe.
    const sO = await sessao('outras');
    await req('POST', `/sessoes/${sO}/cancelar`);
    const po = await imprimir('outras', sO);
    ok(po.status === 200 && po.body.id, '/print/etiqueta de OUTRAS em sessão fechada segue aceito', po);
    const bo = await req('POST', `/etiquetas/${po.body.id}/bipar`);
    ok(bo.status === 200, 'e o bipe dela também', bo);
    // Idempotência: a resposta perdeu-se, a tela repete com o mesmo token
    // depois que a sessão fechou — volta a etiqueta já feita, não 409 nem outra.
    const sI = await sessao('recebimento', { fornecedor: 'Ecorafia' });
    const corpoI = { clientToken: `sf-${C}-idem`, tipo: 'recebimento', materialKey: 'GBD', materialNomeEt: 'GRÃO BAIXA DENSIDADE',
      cor: 'Preto', fornecedor: 'Ecorafia', peso: 900, lote: '161126', codigo: 'X1', sku: 'GBD.PRE.ECORAF | 900 | L161126', sessao_id: sI };
    const i1 = await req('POST', '/print/etiqueta', corpoI);
    await req('POST', `/etiquetas/${i1.body.id}/bipar`);
    await req('POST', `/sessoes/${sI}/finalizar`);
    const i2 = await req('POST', '/print/etiqueta', corpoI);
    ok(i2.status === 200 && i2.body.id === i1.body.id, 'mesmo clientToken depois de fechar devolve a mesma etiqueta', { i1: i1.body, i2: i2.body });
  } catch (e) {
    falhou++; console.log('  \x1b[31m✗ ERRO\x1b[0m', e.stack || e.message);
  } finally {
    if (servidor) servidor.kill('SIGKILL');
    for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm', TMP_TOK]) { try { fs.unlinkSync(f); } catch (e) {} }
    try { fs.rmSync(TMP_LOGS, { recursive: true, force: true }); } catch (e) {}
    console.log(`\n ${passou} passaram, ${falhou} falharam`);
    process.exit(falhou ? 1 : 0);
  }
})();
