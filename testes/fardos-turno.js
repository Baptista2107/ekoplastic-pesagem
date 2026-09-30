// ════════════════════════════════════════════════════════════════════
//  FARDOS POR TURNO NA SACOLEIRA  (30/09/2026, pedido do Frederico)
//  ------------------------------------------------------------------
//  Encerrar o turno não é acabar a bobina. No fim do turno o supervisor
//  diz quanto a bobina montada deu NAQUELE turno; ela continua montada;
//  o turno seguinte, ao trocar ou finalizar, informa só a parte dele.
//  O total da bobina é a soma das partes.
//
//  O que este teste prova, num servidor de teste com banco temporário:
//   1. encerrar turno com bobina montada SEM fardos é recusado (409) e
//      nada muda — o turno continua aberto
//   2. com os fardos, o turno fecha e a bobina continua montada
//   3. a troca de turno (iniciar por cima) também pede os fardos
//   4. finalizar grava total = soma das partes, cada parte no seu turno
//   5. a troca de bobina soma igual; desfazer é bloqueado com parte > 0
//   6. /dashboard/bobina-parciais devolve as partes para a VPS
// ════════════════════════════════════════════════════════════════════
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const os   = require('node:os');

const ROOT = path.join(__dirname, '..');
const PORT = 13920, PORT_CB = 18920, PORT_HTTPS = 14920;
const BASE = `http://localhost:${PORT}`;
const C = Date.now();
const TMP_DB   = path.join(os.tmpdir(), `eko_ft_${C}.db`);
const TMP_LOGS = path.join(os.tmpdir(), `eko_ft_${C}`);
const SENHA = '1234';   // padrão da trava de saída num banco novo

let passou = 0, falhou = 0, servidor;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function ok(cond, msg, extra) {
  if (cond) { passou++; console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
  else { falhou++; console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
         if (extra !== undefined) console.log('      →', JSON.stringify(extra).slice(0, 400)); }
}
async function req(metodo, rota, corpo) {
  const opc = { method: metodo, headers: {} };
  if (corpo !== undefined) { opc.body = JSON.stringify(corpo); opc.headers['Content-Type'] = 'application/json'; }
  const r = await fetch(BASE + rota, opc);
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, body: j };
}
async function subir() {
  servidor = spawn('node', [path.join(ROOT, 'server.js')], {
    env: { ...process.env, EKO_PORT: String(PORT), EKO_PORT_CB: String(PORT_CB), EKO_PORT_HTTPS: String(PORT_HTTPS),
           EKO_DB_FILE: TMP_DB, EKO_LOG_DIR: TMP_LOGS,
           TZ: 'America/Sao_Paulo', EKO_PRINT_SIMULAR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  servidor.stdout.on('data', () => {});
  servidor.stderr.on('data', () => {});
  for (let i = 0; i < 75; i++) {
    try { const r = await fetch(BASE + '/healthcheck'); if (r.ok) return true; } catch (e) {}
    await sleep(200);
  }
  return false;
}
async function derrubar() {
  try { servidor && servidor.kill('SIGKILL'); } catch (e) {}
  await sleep(700);
}
function comBanco(fn) {
  const db = new DatabaseSync(TMP_DB);
  try { return fn(db); } finally { try { db.close(); } catch (e) {} }
}
// Bobina de extrusão pronta para ir à sacoleira (bipada, em estoque).
function criarBobina(db, id, seq, peso) {
  db.prepare(`INSERT INTO etiquetas (id, seq, tipo, material_key, fornecedor, lote, peso, codigo, sku, status,
                                     hora_impressao, cor, largura, tipo_bobina, maquina, operador)
              VALUES (?, ?, 'extrusao', 'BOBINA', '-', '-', ?, ?, 'BOB-TESTE', 'bipada', ?, 'BRANCO', '1,60', 'LISA', 'E1', 'TESTE')`)
    .run(id, seq, peso, id, new Date().toISOString());
}

(async () => {
  console.log('\n=== FARDOS POR TURNO NA SACOLEIRA ===\n');
  if (!await subir()) { console.log('Servidor de teste não subiu.'); process.exit(1); }
  try {
    comBanco(db => { criarBobina(db, 'E9900001', 9900001, 400); criarBobina(db, 'E9900002', 9900002, 400);
                     criarBobina(db, 'E9900003', 9900003, 400); });

    // Turno A aberto na P1, bobina 1 montada.
    let r = await req('POST', '/bobinas/turno-corte/iniciar', { senha: SENHA, turno: 'A', maquinas: ['P1'], operador: 'SUP' });
    ok(r.status === 200, 'turno A iniciado na P1', r.body);
    r = await req('POST', '/bobinas/baixa', { id: 'E9900001', destino: 'P1', operador: 'CARINE' });
    ok(r.status === 200, 'bobina E9900001 montada na P1', r.body);

    // 1. encerrar sem fardos → 409, nada muda
    r = await req('POST', '/bobinas/turno-corte/encerrar', { senha: SENHA, maquinas: ['P1'] });
    ok(r.status === 409 && r.body && r.body.precisa_fardos && r.body.bobinas[0].id === 'E9900001',
       'encerrar sem fardos é recusado e aponta a bobina', r.body);
    r = await req('GET', '/bobinas/turno-corte');
    ok(r.body.sacoleiras.find(s => s.sacoleira === 'P1').turno, 'o turno A continua aberto após a recusa');

    // senha errada não grava parte
    r = await req('POST', '/bobinas/turno-corte/encerrar', { senha: 'x', maquinas: ['P1'], parciais: { P1: { fardos: 5 } } });
    ok(r.status === 401, 'senha errada é recusada');
    ok(comBanco(db => db.prepare('SELECT COUNT(*) n FROM bobina_parciais').get().n) === 0, 'e não grava parte nenhuma');

    // 2. encerrar com 6 fardos
    r = await req('POST', '/bobinas/turno-corte/encerrar', { senha: SENHA, maquinas: ['P1'], parciais: { P1: { fardos: 6 } } });
    ok(r.status === 200 && r.body.parciais && r.body.parciais[0].fardos === 6, 'encerrar com 6 fardos fecha o turno', r.body);
    r = await req('GET', '/bobinas/abertas');
    let p1 = r.body.sacoleiras.find(s => s.sacoleira === 'P1');
    ok(p1.bobina && p1.bobina.id === 'E9900001', 'a bobina CONTINUA montada na P1 depois do fim do turno', p1);
    ok(p1.bobina && p1.bobina.fardos_parciais === 6, '/bobinas/abertas mostra 6 fardos já informados', p1.bobina);
    ok(comBanco(db => db.prepare('SELECT fardos, encerrada_em FROM etiquetas WHERE id = ?').get('E9900001')).encerrada_em === null,
       'a etiqueta segue aberta (sem encerrada_em)');

    // 3. turno C, depois troca para EXTRA por cima: pede os fardos do C
    r = await req('POST', '/bobinas/turno-corte/iniciar', { senha: SENHA, turno: 'C', maquinas: ['P1'] });
    ok(r.status === 200 && (!r.body.parciais || !r.body.parciais.length), 'iniciar C sem turno aberto não pede fardos', r.body);
    r = await req('POST', '/bobinas/turno-corte/iniciar', { senha: SENHA, turno: 'EXTRA', maquinas: ['P1'] });
    ok(r.status === 409 && r.body.precisa_fardos, 'trocar C → EXTRA com bobina montada pede os fardos do C', r.body);
    r = await req('POST', '/bobinas/turno-corte/iniciar', { senha: SENHA, turno: 'EXTRA', maquinas: ['P1'], parciais: { P1: { fardos: 4 } } });
    ok(r.status === 200, 'troca C → EXTRA com 4 fardos', r.body);

    // 4. finalizar no EXTRA com 3 → total 13
    r = await req('POST', '/bobinas/finalizar', { sacoleira: 'P1', fardos: 3, operador: 'CARINE' });
    ok(r.status === 200 && r.body.fardos_total === 13, 'finalizar com 3 fardos: total da bobina = 6 + 4 + 3 = 13', r.body);
    const e1 = comBanco(db => db.prepare('SELECT fardos, encerrada_motivo FROM etiquetas WHERE id = ?').get('E9900001'));
    ok(e1.fardos === 13 && e1.encerrada_motivo === 'finalizada', 'etiquetas.fardos = 13', e1);
    const partes = comBanco(db => db.prepare(
      `SELECT turno, fardos, momento FROM bobina_parciais WHERE etiqueta_id = 'E9900001' ORDER BY id`).all());
    ok(JSON.stringify(partes.map(p => [p.turno, p.fardos, p.momento])) ===
       JSON.stringify([['A', 6, 'turno'], ['C', 4, 'turno'], ['EXTRA', 3, 'final']]),
       'cada parte ficou no turno certo (A 6, C 4, EXTRA 3 final)', partes);

    // 5. troca de bobina soma igual; desfazer bloqueado com parte > 0
    r = await req('POST', '/bobinas/baixa', { id: 'E9900002', destino: 'P1', operador: 'GISLENE' });
    ok(r.status === 200, 'bobina E9900002 montada na P1', r.body);
    r = await req('POST', '/bobinas/turno-corte/iniciar', { senha: SENHA, turno: 'A', maquinas: ['P1'], parciais: { P1: { fardos: 2 } } });
    ok(r.status === 200, 'troca EXTRA → A com 2 fardos da E9900002', r.body);
    r = await req('POST', '/bobinas/desfazer', { id: 'E9900002' });
    ok(r.status === 409, 'desfazer a E9900002 é bloqueado (já tem fardos de fim de turno)', r.body);
    r = await req('POST', '/bobinas/baixa', { id: 'E9900003', destino: 'P1', operador: 'GISLENE' });
    ok(r.status === 409 && r.body.precisa_fardos && r.body.anterior.fardos_parciais === 2,
       'trocar de bobina pede os fardos e mostra os 2 já informados', r.body);
    r = await req('POST', '/bobinas/baixa', { id: 'E9900003', destino: 'P1', operador: 'GISLENE', fardos_anterior: 5 });
    ok(r.status === 200, 'troca de bobina com 5 fardos neste turno', r.body);
    const e2 = comBanco(db => db.prepare('SELECT fardos, encerrada_motivo FROM etiquetas WHERE id = ?').get('E9900002'));
    ok(e2.fardos === 7 && e2.encerrada_motivo === 'troca', 'E9900002 fechou com 2 + 5 = 7 fardos', e2);

    // Bobina sem fim de turno no meio: comportamento de antes (total = informado).
    r = await req('POST', '/bobinas/finalizar', { sacoleira: 'P1', fardos: 9 });
    ok(r.status === 200 && r.body.fardos_total === 9, 'bobina sem fim de turno no meio: total = o informado (9)', r.body);

    // 6. dashboard
    r = await req('GET', '/dashboard/bobina-parciais?desde=2000-01-01');
    ok(r.status === 200 && r.body.parciais.length === 6, '/dashboard/bobina-parciais devolve as 6 partes (3 + 2 + 1)', r.body);
  } catch (e) {
    ok(false, 'exceção no teste: ' + e.message);
  } finally {
    await derrubar();
  }
  console.log(`\n${passou} ok, ${falhou} falha(s)\n`);
  process.exit(falhou ? 1 : 0);
})();
