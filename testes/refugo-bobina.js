// ════════════════════════════════════════════════════════════════════
//  REFUGO DE BOBINA  (02/10/2026, pedido do Gustavo)
//  ------------------------------------------------------------------
//  Bobina que entrou na sacoleira, deu 1-2 fardos e não serve para o
//  produto acabado: o operador finaliza no coletor, e no Mini PC
//  (Outras pesagens → REFUGO) bipa a etiqueta ANTIGA e pesa. Ela volta
//  ao estoque como refugo e pode ser montada de novo.
//
//  O que este teste prova, num servidor de teste com banco temporário:
//   1. refugo é recusado com a bobina montada, nunca montada ou já refugo
//   2. o peso desconta o eixo da largura; o peso da etiqueta NÃO muda
//   3. inventário dá a situação 'refugo'; lista do dia e estoque somam
//   4. a bobina de refugo monta de novo (só ela passa com status consumida),
//      começa a montagem com 0 pacotes e soma as montagens no fim
//   5. desfazer a montagem nova devolve ao estoque como refugo
//   6. cancelar refugo: antes de reaproveitar sim, depois não
//   7. bobina comum finalizada continua sem poder ter 2ª baixa
//   8. /dashboard/bobina-refugos devolve as linhas para a VPS
// ════════════════════════════════════════════════════════════════════
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const os   = require('node:os');

const ROOT = path.join(__dirname, '..');
const PORT = 13935, PORT_CB = 18935, PORT_HTTPS = 14935;
const BASE = `http://localhost:${PORT}`;
const C = Date.now();
const TMP_DB   = path.join(os.tmpdir(), `eko_rf_${C}.db`);
const TMP_LOGS = path.join(os.tmpdir(), `eko_rf_${C}`);
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
  console.log('\n=== REFUGO DE BOBINA ===\n');
  if (!await subir()) { console.log('Servidor de teste não subiu.'); process.exit(1); }
  try {
    comBanco(db => { criarBobina(db, 'E9910001', 9910001, 400); criarBobina(db, 'E9910002', 9910002, 380);
                     criarBobina(db, 'E9910003', 9910003, 390); });
    let r = await req('POST', '/bobinas/turno-corte/iniciar', { senha: SENHA, turno: 'A', maquinas: ['P1', 'P2'], operador: 'SUP' });
    ok(r.status === 200, 'turno A aberto na P1 e P2', r.body);

    // 1. recusas
    r = await req('POST', '/bobinas/refugo', { id: 'E9910001', peso_bruto: 300 });
    ok(r.status === 409, 'bobina nunca montada não vira refugo', r.body);
    r = await req('POST', '/bobinas/baixa', { id: 'E9910001', destino: 'P1', operador: 'CARINE' });
    ok(r.status === 200, 'E9910001 montada na P1', r.body);
    r = await req('POST', '/bobinas/refugo', { id: 'E9910001', peso_bruto: 300 });
    ok(r.status === 409 && r.body.na_sacoleira === 'P1', 'montada na sacoleira: pede para finalizar no coletor', r.body);
    r = await req('POST', '/bobinas/finalizar', { sacoleira: 'P1', fardos: 2, operador: 'CARINE' });
    ok(r.status === 200 && r.body.pacotes_total === 10, 'finalizada no coletor com 2 fardos', r.body);
    r = await req('POST', '/bobinas/refugo', { id: 'E9910001', peso_bruto: 5 });
    ok(r.status === 400, 'peso menor que o eixo (8 kg na 1,60) é recusado', r.body);
    r = await req('POST', '/bobinas/refugo', { id: 'E9910001', peso_bruto: 450 });
    ok(r.status === 400, 'refugo maior que a bobina inteira é recusado', r.body);

    // 2. registra: 9910001 só dígitos também vale
    r = await req('POST', '/bobinas/refugo', { id: '9910001', peso_bruto: 338.4 });
    ok(r.status === 200 && r.body.refugo.peso === 330.4 && r.body.refugo.tara === 8 && r.body.refugo.etiqueta_id === 'E9910001',
       'refugo 338,4 − eixo 8 = 330,4 kg', r.body);
    const rid = r.body.refugo && r.body.refugo.id;
    let e = comBanco(db => db.prepare('SELECT peso, status, fardos, encerrada_em FROM etiquetas WHERE id = ?').get('E9910001'));
    ok(e.peso === 400 && e.status === 'consumida' && e.fardos === 2 && e.encerrada_em, 'peso da etiqueta segue 400 (extrusão intacta)', e);
    r = await req('POST', '/bobinas/refugo', { id: 'E9910001', peso_bruto: 300 });
    ok(r.status === 409 && r.body.ja_refugo, 'refugo repetido é recusado', r.body);

    // 2b. vai à VPS pelo exportador que já existe (alterados_desde)
    r = await req('GET', '/dashboard/movimentos?alterados_desde=2000-01-01&tipos=extrusao');
    let lin = r.body.linhas.find(x => x.id === 'E9910001');
    ok(lin && lin.refugo_kg === 330.4 && lin.refugo_em && lin.peso === 400, 'movimentos leva refugo_kg 330,4 (peso 400 intacto)', lin);

    // 3. consultas, inventário
    r = await req('GET', '/bobinas/E9910001');
    ok(r.body.bobina.refugo && r.body.bobina.refugo.peso === 330.4 && r.body.bobina.tara_eixo === 8, 'GET /bobinas/:id traz o refugo', r.body);
    r = await req('GET', '/bobinas/refugos');
    ok(r.body.refugos.length === 1 && Math.abs(r.body.kg - 330.4) < 1e-6, 'lista de hoje: 1 refugo, 330,4 kg', r.body);
    r = await req('GET', '/bobinas/refugos?estoque=1');
    ok(r.body.refugos.length === 1, 'estoque de refugo: 1', r.body);
    await req('POST', '/bobinas/inventario/abrir', { operador: 'INV' });
    r = await req('POST', '/bobinas/inventario/ler', { id: 'E9910001' });
    ok(r.body.situacao === 'refugo', 'inventário: situação refugo', r.body);
    r = await req('POST', '/bobinas/inventario/concluir', { senha: SENHA });

    // 4. monta de novo na P2
    r = await req('POST', '/bobinas/baixa', { id: 'E9910001', destino: 'P2', operador: 'GISLENE' });
    ok(r.status === 200 && r.body.reaproveitada === true, 'refugo monta de novo na P2', r.body);
    r = await req('GET', '/bobinas/abertas');
    let p2 = r.body.sacoleiras.find(s => s.sacoleira === 'P2');
    ok(p2.bobina && p2.bobina.id === 'E9910001' && p2.bobina.pacotes_parciais === 0, 'nova montagem começa com 0 pacotes', p2.bobina);
    r = await req('GET', '/bobinas/refugos?estoque=1');
    ok(r.body.refugos.length === 0, 'saiu do estoque de refugo', r.body);
    r = await req('POST', `/bobinas/refugo/${rid}/cancelar`);
    ok(r.status === 409, 'cancelar refugo já reaproveitado é recusado', r.body);

    // 5. desfazer → volta a refugo, com a montagem anterior intacta
    r = await req('POST', '/bobinas/desfazer', { id: 'E9910001' });
    ok(r.status === 200 && r.body.refugo, 'desfazer a montagem nova', r.body);
    e = comBanco(db => db.prepare('SELECT destino, encerrada_em, encerrada_motivo, fardos, pacotes FROM etiquetas WHERE id = ?').get('E9910001'));
    ok(e.destino === 'P1' && e.encerrada_em && e.encerrada_motivo === 'finalizada' && e.pacotes === 10, 'voltou como estava (P1, finalizada, 10 pc)', e);
    r = await req('GET', '/bobinas/refugos?estoque=1');
    ok(r.body.refugos.length === 1, 'de volta ao estoque de refugo', r.body);

    // montagem nova de verdade: fim de turno 1 fardo + finalizar 1 → 10 + 5 + 5 = 20
    r = await req('POST', '/bobinas/baixa', { id: 'E9910001', destino: 'P2', operador: 'GISLENE' });
    ok(r.status === 200 && r.body.reaproveitada, 'monta de novo na P2', r.body);
    r = await req('POST', '/bobinas/turno-corte/encerrar', { senha: SENHA, maquinas: ['P2'], parciais: { P2: { fardos: 1 } } });
    ok(r.status === 200, 'fim de turno com 1 fardo', r.body);
    await req('POST', '/bobinas/turno-corte/iniciar', { senha: SENHA, turno: 'C', maquinas: ['P2'] });
    r = await req('GET', '/bobinas/abertas');
    p2 = r.body.sacoleiras.find(s => s.sacoleira === 'P2');
    ok(p2.bobina && p2.bobina.pacotes_parciais === 5, 'a montagem nova mostra só o 1 fardo dela', p2.bobina);
    r = await req('POST', '/bobinas/finalizar', { sacoleira: 'P2', fardos: 1, operador: 'GISLENE' });
    ok(r.status === 200 && r.body.pacotes_total === 20, 'total da bobina = 2 + 1 + 1 fardos (20 pc)', r.body);
    e = comBanco(db => db.prepare('SELECT fardos, pacotes, peso FROM etiquetas WHERE id = ?').get('E9910001'));
    ok(e.fardos === 4 && e.pacotes === 20 && e.peso === 400, 'etiqueta: 4 fardos, peso 400', e);
    r = await req('POST', '/bobinas/refugo', { id: 'E9910001', peso_bruto: 200 });
    ok(r.status === 200 && r.body.refugo.peso === 192, 'pode virar refugo de novo depois da 2ª montagem', r.body);

    // 6. cancelar antes de reaproveitar
    r = await req('POST', '/bobinas/baixa', { id: 'E9910002', destino: 'P1', operador: 'CARINE' });
    r = await req('POST', '/bobinas/finalizar', { sacoleira: 'P1', fardos: 1 });
    r = await req('POST', '/bobinas/refugo', { id: 'E9910002', peso_bruto: 300 });
    ok(r.status === 200, 'E9910002 refugo', r.body);
    r = await req('POST', `/bobinas/refugo/${r.body.refugo.id}/cancelar`);
    ok(r.status === 200, 'cancelar refugo antes de reaproveitar', r.body);
    r = await req('GET', '/bobinas/E9910002');
    ok(!r.body.bobina.refugo, 'cancelado: não é mais refugo', r.body.bobina);
    r = await req('GET', '/dashboard/movimentos?alterados_desde=2000-01-01&tipos=extrusao');
    lin = r.body.linhas.find(x => x.id === 'E9910002');
    ok(lin && lin.refugo_kg === null, 'movimentos: refugo cancelado sai (refugo_kg nulo)', lin);
    r = await req('GET', '/dashboard/movimentos?de=2000-01-01&tipos=extrusao');
    lin = r.body.linhas.find(x => x.id === 'E9910003');
    ok(lin && lin.refugo_kg === null && r.body.total === 3, 'bobina sem refugo: refugo_kg nulo; filtro por data segue igual', lin);

    // 7. bobina comum finalizada: 2ª baixa recusada como antes
    r = await req('POST', '/bobinas/baixa', { id: 'E9910002', destino: 'P2', operador: 'CARINE' });
    ok(r.status === 409 && r.body.ja_baixada, 'bobina comum finalizada: "JÁ teve baixa" como antes', r.body);
    r = await req('POST', '/bobinas/baixa', { id: 'E9910003', destino: 'P1', operador: 'CARINE' });
    ok(r.status === 200 && !r.body.reaproveitada, 'bobina nova monta normal', r.body);
    r = await req('POST', '/bobinas/desfazer', { id: 'E9910003' });
    ok(r.status === 200 && !r.body.refugo, 'desfazer bobina comum segue igual', r.body);

    // 8. VPS
    r = await req('GET', '/dashboard/bobina-refugos?desde=2000-01-01');
    ok(r.status === 200 && r.body.refugos.length === 3, '/dashboard/bobina-refugos devolve as 3 linhas', r.body);
  } catch (e) {
    ok(false, 'exceção no teste: ' + e.message);
  } finally {
    await derrubar();
  }
  console.log(`\n${passou} ok, ${falhou} falha(s)\n`);
  process.exit(falhou ? 1 : 0);
})();
