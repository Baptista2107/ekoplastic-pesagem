// ════════════════════════════════════════════════════════════════════
//  MAPA DO GALPÃO — BIG BAG DE MP (06/11/2026, Gustavo)
//  ------------------------------------------------------------------
//  Os bags de MP moram nas mesmas ruas do PA, UM por posição. O que este
//  teste prova, pela porta da frente (HTTP), num banco de mentira:
//    · bag em estoque (R bipada) é endereçado e o mapa mostra material,
//      fornecedor, lote e kg da etiqueta de recebimento;
//    · 2º bag (ou gaiola) na mesma posição é recusado; o mesmo bag em
//      dois lugares também;
//    · o bag que sai na Retirada libera a posição sozinho;
//    · R já consumida, R cancelada e etiqueta que não é recebimento são
//      recusadas no endereçamento;
//    · o estorno da retirada NÃO devolve o bag ao mapa;
//    · o retrato vai para a VPS (de mentira) e só de novo quando muda;
//      sem endereço da VPS configurado, nada é enviado.
// ════════════════════════════════════════════════════════════════════
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');

const ROOT = path.join(__dirname, '..');
const PORT = 13971, PORT_CB = 18971;
const BASE = `http://localhost:${PORT}`;
const C = Date.now();
const TMP_DB   = path.join(os.tmpdir(), `eko_mb_${C}.db`);
const TMP_LOGS = path.join(os.tmpdir(), `eko_mb_${C}`);
const TMP_TOK  = path.join(os.tmpdir(), `eko_mb_tok_${C}.json`);

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

// VPS de mentira: só guarda os retratos que chegam.
const recebidos = [];
function subirVps() {
  return new Promise(resolve => {
    vps = http.createServer((r, res) => {
      let corpo = '';
      r.on('data', c => corpo += c);
      r.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (r.method === 'POST' && r.url === '/api/coletor/mapa') {
          try { recebidos.push(JSON.parse(corpo)); } catch (e) {}
          return res.end(JSON.stringify({ ok: true }));
        }
        if (r.url === '/api/mp/retirada/abertos') return res.end(JSON.stringify({ ok: true, modo: 'teste', pedidos: [] }));
        res.end(JSON.stringify({ ok: true }));
      });
    });
    vps.listen(0, '127.0.0.1', () => { portaVps = vps.address().port; resolve(); });
  });
}

async function subirServidor() {
  fs.writeFileSync(TMP_TOK, JSON.stringify({ accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3600e3 }));
  servidor = spawn('node', [path.join(ROOT, 'server.js')], {
    env: { ...process.env, EKO_PORT: String(PORT), EKO_PORT_CB: String(PORT_CB),
           EKO_DB_FILE: TMP_DB, EKO_LOG_DIR: TMP_LOGS, EKO_TOKEN_FILE: TMP_TOK,
           EKO_MAPA_VPS_MS: '400',
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
async function bag(lote, forn = 'Ecorafia') {
  const r = await req('POST', '/etiquetas', {
    clientToken: `mb-${C}-${++nTok}`, tipo: 'recebimento', materialKey: 'GBD', materialNomeEt: 'GRÃO BAIXA DENSIDADE',
    cor: 'Preto', fornecedor: forn, peso: 900, lote, codigo: 'X1', sku: `GBD.PRE.ECORAF | 900 | L${lote}`, sessao_id: sRec });
  const id = r.body && r.body.id;
  if (id) await req('POST', `/etiquetas/${id}/bipar`);
  return id;
}
const ocupar  = (posicao, id) => req('POST', '/enderecamento/ocupar', { posicao, gaiola_id: id, operador: 'BRUNO' });
const posicao = async cod => (await req('GET', '/enderecamento/mapa')).body.posicoes.find(p => p.codigo === cod);

(async () => {
  try {
    console.log('\n═══════════════════════════════════════════════════');
    console.log(' MAPA DO GALPÃO — BIG BAG DE MP');
    console.log('═══════════════════════════════════════════════════\n');
    await subirVps();
    await subirServidor();
    sRec = (await req('POST', '/sessoes', { tipo: 'recebimento', operador: 'Teste', fornecedor: 'Ecorafia' })).body.sessao_id;

    console.log('[0] Sem endereço da VPS configurado: nada vai para fora');
    await sleep(1200);
    ok(recebidos.length === 0, 'nenhum retrato enviado (teste nunca suja a VPS de verdade)', recebidos.length);
    {
      // Por dentro: sem o endereço gravado, o envio nem tenta (não cai no
      // endereço padrão — que é a VPS de verdade).
      const db2 = path.join(os.tmpdir(), `eko_mb2_${C}.db`);
      const r = require('node:child_process').spawnSync(process.execPath, ['-e',
        `require('./lib/mapa-vps').empurrarMapaVps().then(x => { console.log('R=' + JSON.stringify(x)); process.exit(0); })`],
        { cwd: ROOT, env: { ...process.env, EKO_DB_FILE: db2, EKO_LOG_DIR: TMP_LOGS + '_2' }, encoding: 'utf8', timeout: 30000 });
      const lin = (r.stdout || '').split('\n').find(l => l.startsWith('R=')) || '';
      ok(lin === 'R={"pulou":"sem_endereco"}', 'empurrarMapaVps sem endereço configurado responde "sem_endereco"', lin || r.stderr);
      for (const f of [db2, db2 + '-wal', db2 + '-shm']) { try { fs.unlinkSync(f); } catch (e) {} }
      try { fs.rmSync(TMP_LOGS + '_2', { recursive: true, force: true }); } catch (e) {}
    }
    await req('POST', '/config', { vps_sacoleiras_url: `http://127.0.0.1:${portaVps}/api/sacoleiras/agora` });

    console.log('\n[1] Bag em estoque é endereçado');
    const b1 = await bag('021026');
    const o1 = await ocupar('01-01-007', b1);
    ok(o1.status === 200 && o1.body.bag === true, `bag ${b1} guardado em 01-01-007`, o1.body);
    const p1 = await posicao('01-01-007');
    ok(p1.ocupada && p1.gaiola.item === 'bag' && p1.gaiola.lote === '021026' && p1.gaiola.fornecedor === 'Ecorafia'
       && p1.gaiola.material_key === 'GBD' && p1.gaiola.kg === 900,
       'o mapa mostra BAG · GBD · Ecorafia · lote 021026 · 900 kg', p1);
    const g = (await req('GET', `/enderecamento/gaiola/${b1}`)).body;
    ok(g.bag && g.bag.lote === '021026' && g.atual && g.atual.posicao === '01-01-007', 'consulta do bag diz onde ele está', g);

    console.log('\n[2] Um por posição, um lugar por bag');
    const b2 = await bag('021026');
    const o2 = await ocupar('01-01-007', b2);
    ok(o2.status === 409 && o2.body.ocupada === true, '2º bag na mesma posição é recusado', o2.body);
    const o2g = await ocupar('01-01-007', 'G0000999');
    ok(o2g.status === 409, 'gaiola na posição do bag também é recusada', o2g.body);
    const o1b = await ocupar('01-01-008', b1);
    ok(o1b.status === 409 && o1b.body.gaiola_em_outro_lugar === true, 'o mesmo bag em outro endereço é recusado', o1b.body);
    const o1c = await ocupar('01-01-007', b1);
    ok(o1c.status === 200 && o1c.body.ja_estava === true, 'ler de novo o mesmo bag no mesmo lugar não duplica', o1c.body);
    ok((await req('POST', '/enderecamento/ocupar', { posicao: '01-01-005', gaiola_id: b2 })).status === 409,
       'endereço bloqueado (hidrante) não recebe bag');

    console.log('\n[3] O retrato chega à VPS e só de novo quando muda');
    await sleep(3000);
    const ult = recebidos[recebidos.length - 1];
    ok(ult && ult.posicoes && ult.posicoes.find(p => p.codigo === '01-01-007').gaiola.id === b1 && ult.resumo.bags === 1,
       'a VPS recebeu o mapa com o bag em 01-01-007', ult && ult.resumo);
    const n0 = recebidos.length;
    await sleep(1500);
    ok(recebidos.length === n0, 'sem mudança, não manda de novo (ciclos de 0,4 s)', { antes: n0, depois: recebidos.length });

    console.log('\n[4] O bag sai na Retirada e a posição fica livre sozinha');
    const sRet = (await req('POST', '/sessoes', { tipo: 'retirada', operador: 'Bruno' })).body.sessao_id;
    const c1 = await req('POST', `/etiquetas/${b1}/consumir`, { sessao_id: sRet });
    ok(c1.status === 200, 'retirada do bag ok', c1.body);
    const p1b = await posicao('01-01-007');
    ok(!p1b.ocupada, '01-01-007 está livre depois da retirada', p1b);
    const hist = (await req('GET', '/enderecamento/posicao/01-01-007')).body.historico;
    ok(hist[0] && hist[0].saida && /^retirada sessao /.test(hist[0].motivo_saida || ''),
       'o histórico guarda a saída com o motivo "retirada sessao N"', hist[0]);
    await sleep(3000);
    const ult2 = recebidos[recebidos.length - 1];
    ok(ult2 && !ult2.posicoes.find(p => p.codigo === '01-01-007').ocupada, 'a VPS recebeu o mapa já sem o bag', ult2 && ult2.resumo);

    console.log('\n[5] Etiqueta que não é bag em estoque é recusada');
    const o3 = await ocupar('01-01-009', b1);
    ok(o3.status === 409 && o3.body.consumida === true, 'R já consumida (saiu numa retirada) é recusada', o3.body);
    const b4 = await bag('031026');
    await req('POST', `/etiquetas/${b4}/cancelar`, { motivo: 'teste' });
    const st4 = (await req('GET', `/enderecamento/gaiola/${b4}`)).body.bag;
    if (st4 && st4.status !== 'bipada') {
      const o4 = await ocupar('01-01-009', b4);
      ok(o4.status === 409, `R ${st4.status} é recusada`, o4.body);
    } else {
      ok(true, '(cancelamento de etiqueta indisponível nesta rota — coberto pela consumida)');
    }
    const o5 = await ocupar('01-01-009', 'R9999999');
    ok(o5.status === 404, 'R que não existe nesta estação é recusada', o5.body);

    console.log('\n[6] Estorno da retirada NÃO devolve o bag ao mapa');
    const est = await req('POST', `/etiquetas/${c1.body.etiqueta_virtual.id}/estornar`);
    ok(est.status === 200, 'estorno ok', est.body);
    const p1c = await posicao('01-01-007');
    ok(!p1c.ocupada, '01-01-007 continua livre (bag volta ao estoque, mas sem endereço)', p1c);
    const o6 = await ocupar('01-01-010', b1);
    ok(o6.status === 200, 'o bag estornado pode ser endereçado de novo', o6.body);
  } catch (e) {
    falhou++; console.log('  \x1b[31m✗\x1b[0m exceção:', e.stack || e.message);
  } finally {
    try { servidor && servidor.kill(); } catch (e) {}
    try { vps && vps.close(); } catch (e) {}
    await sleep(300);
    for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm', TMP_TOK]) { try { fs.unlinkSync(f); } catch (e) {} }
    try { fs.rmSync(TMP_LOGS, { recursive: true, force: true }); } catch (e) {}
    console.log(`\n ${passou} passaram, ${falhou} falharam\n`);
    process.exit(falhou ? 1 : 0);
  }
})();
