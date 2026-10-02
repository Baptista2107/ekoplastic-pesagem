// ════════════════════════════════════════════════════════════════════
//  ZERAR O COLETOR  (02/10/2026, Gustavo: "limpar todas as bipagens do
//  coletor" — eram teste, tudo inclusive inventários)
//  Prova: senha errada recusa; sem confirmar é só ensaio (nada muda);
//  confirmado, as bobinas voltam ao estoque, fardos/setups/refugos/turnos/
//  inventários/histórico somem; bobina com pedido no Bling fica; depois
//  disso o coletor funciona normalmente do zero.
// ════════════════════════════════════════════════════════════════════
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const os   = require('node:os');

const ROOT = path.join(__dirname, '..');
const PORT = 13936, PORT_CB = 18936, PORT_HTTPS = 14936;
const BASE = `http://localhost:${PORT}`;
const C = Date.now();
const TMP_DB   = path.join(os.tmpdir(), `eko_zc_${C}.db`);
const TMP_LOGS = path.join(os.tmpdir(), `eko_zc_${C}`);
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
const conta = t => comBanco(db => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n);

(async () => {
  console.log('\n=== ZERAR O COLETOR ===\n');
  if (!await subir()) { console.log('Servidor de teste não subiu.'); process.exit(1); }
  try {
    comBanco(db => { for (let i = 1; i <= 4; i++) criarBobina(db, 'E992000' + i, 9920000 + i, 400); });
    await req('POST', '/bobinas/turno-corte/iniciar', { senha: SENHA, turno: 'A', maquinas: ['P1', 'P2'] });
    await req('POST', '/bobinas/baixa', { id: 'E9920001', destino: 'P1', operador: 'CARINE' });
    await req('POST', '/bobinas/turno-corte/encerrar', { senha: SENHA, maquinas: ['P1', 'P2'], parciais: { P1: { fardos: 2 } } });
    await req('POST', '/bobinas/turno-corte/iniciar', { senha: SENHA, turno: 'C', maquinas: ['P1', 'P2'] });
    await req('POST', '/bobinas/finalizar', { sacoleira: 'P1', fardos: 1 });
    let r = await req('POST', '/bobinas/refugo', { id: 'E9920001', peso_bruto: 300 });
    ok(r.status === 200, 'cenário: E9920001 montada, fardos, finalizada e refugo', r.body);
    await req('POST', '/bobinas/baixa', { id: 'E9920002', destino: 'P2', operador: 'ITALO' });
    comBanco(db => db.prepare(`UPDATE etiquetas SET status='consumida', destino='P1', baixa_em=?, bling_pedido_id=123
                                WHERE id='E9920003'`).run(new Date().toISOString()));
    await req('POST', '/bobinas/inventario/abrir', { operador: 'INV' });
    await req('POST', '/bobinas/inventario/ler', { id: 'E9920004' });
    const antes = { parc: conta('bobina_parciais'), tur: conta('turnos_corte'), inv: conta('inventario_bobinas'), ref: conta('bobina_refugos') };
    ok(antes.parc >= 2 && antes.tur >= 2 && antes.inv === 1 && antes.ref === 1, 'há dados para zerar', antes);

    r = await req('POST', '/bobinas/zerar-coletor', { senha: 'x', confirmar: true });
    ok(r.status === 401, 'senha errada é recusada', r.body);
    r = await req('POST', '/bobinas/zerar-coletor', { senha: SENHA });
    ok(r.status === 200 && r.body.ensaio && r.body.bobinas_voltam_ao_estoque === 2 && r.body.bobinas_com_pedido_no_bling_ficam.length === 1
       && r.body.turnos_do_corte === antes.tur && r.body.inventarios_de_bobinas === 1 && r.body.refugos === 1,
       'ensaio conta tudo (2 voltam, 1 com Bling fica)', r.body);
    ok(conta('turnos_corte') === antes.tur && conta('bobina_parciais') === antes.parc, 'ensaio não mudou nada');

    r = await req('POST', '/bobinas/zerar-coletor', { senha: SENHA, confirmar: true, operador: 'GUSTAVO' });
    ok(r.status === 200 && r.body.zerado, 'zerado', r.body);
    const depois = ['bobina_parciais', 'bobina_setups', 'bobina_refugos', 'turnos_corte', 'inventario_bobinas', 'inventario_bobinas_itens']
      .map(t => [t, conta(t)]);
    ok(depois.every(([, n]) => n === 0), 'fardos, setups, refugos, turnos e inventários apagados', depois);
    ok(comBanco(db => db.prepare(`SELECT COUNT(*) n FROM config WHERE chave LIKE 'baixas_bobinas_%'`).get().n) === 0, 'histórico do dia apagado');
    const st = comBanco(db => db.prepare(`SELECT id, status, destino, fardos, bling_pedido_id FROM etiquetas ORDER BY id`).all());
    ok(st.filter(e => e.id !== 'E9920003').every(e => e.status === 'bipada' && !e.destino && e.fardos === null), 'bobinas de teste em estoque', st);
    ok(st.find(e => e.id === 'E9920003').status === 'consumida', 'bobina com pedido no Bling ficou como estava', st);

    // coletor funciona do zero
    r = await req('GET', '/bobinas/abertas');
    ok(r.body.sacoleiras.every(s => !s.bobina), 'nenhuma bobina montada', r.body);
    r = await req('POST', '/bobinas/baixa', { id: 'E9920001', destino: 'P1', operador: 'CARINE' });
    ok(r.status === 409 && r.body.sem_turno, 'sem turno aberto (turnos apagados), pede o supervisor', r.body);
    await req('POST', '/bobinas/turno-corte/iniciar', { senha: SENHA, turno: 'A', maquinas: ['P1'] });
    r = await req('POST', '/bobinas/baixa', { id: 'E9920001', destino: 'P1', operador: 'CARINE' });
    ok(r.status === 200 && !r.body.reaproveitada, 'E9920001 monta de novo como bobina comum', r.body);
    r = await req('POST', '/bobinas/finalizar', { sacoleira: 'P1', fardos: 3 });
    ok(r.status === 200 && r.body.pacotes_total === 15, 'total começa do zero (3 fardos)', r.body);
  } catch (e) {
    ok(false, 'exceção no teste: ' + e.message);
  } finally {
    await derrubar();
  }
  console.log(`\n${passou} ok, ${falhou} falha(s)\n`);
  process.exit(falhou ? 1 : 0);
})();
