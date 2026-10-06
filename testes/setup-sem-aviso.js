// ════════════════════════════════════════════════════════════════════
//  SETUP QUE MUDOU SEM AVISO  (06/10/2026, pedido do Gustavo)
//  ------------------------------------------------------------------
//  Caso real: P2, E0001823 — o comprimento foi de 451 para 500 mm às 09:47
//  com a máquina parada e a bobina foi encerrada às 09:52 como 40x50, mas
//  tinha cortado tudo a 451 (30x45). Agora:
//   1. CLP em 451: a bobina corta 30x45 (e o coletor guarda esse "vigente")
//   2. 1 leitura em 500 não alerta nem troca o formato sugerido
//   3. 2ª leitura em 500: setup_detectado 30x45 → 40x50, e o sugerido segue
//      30x45 (o que rodou) — um encerramento agora grava o certo
//   4. "Informar 30x45" (trocar-formato) registra a parte do 30x45 com o
//      comprimento de ANTES (451) e limpa o alerta; o 40x50 é definido
//   5. resumo do turno: corrigir SÓ o formato de uma parte (sem fardos) →
//      formato_origem 'corrigido', fardos intactos; formato de outra máquina
//      é recusado
//   6. bobina nova na máquina começa sem alerta
// ════════════════════════════════════════════════════════════════════
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const http = require('node:http');
const path = require('node:path');
const os   = require('node:os');

const ROOT = path.join(__dirname, '..');
const PORT = 13940, PORT_CB = 18940, PORT_HTTPS = 14940, PORT_CLP = 13941;
const BASE = `http://localhost:${PORT}`;
const C = Date.now();
const TMP_DB   = path.join(os.tmpdir(), `eko_ssa_${C}.db`);
const TMP_LOGS = path.join(os.tmpdir(), `eko_ssa_${C}`);
const SENHA = '1234';

let passou = 0, falhou = 0, servidor, clpSrv;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function ok(cond, msg, extra) {
  if (cond) { passou++; console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
  else { falhou++; console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
         if (extra !== undefined) console.log('      →', JSON.stringify(extra).slice(0, 500)); }
}
async function req(metodo, rota, corpo) {
  const opc = { method: metodo, headers: {} };
  if (corpo !== undefined) { opc.body = JSON.stringify(corpo); opc.headers['Content-Type'] = 'application/json'; }
  const r = await fetch(BASE + rota, opc);
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, body: j };
}
// CLP de mentira: o que /api/sacoleiras/agora da VPS devolveria. Cada leitura
// nova ganha um carimbo novo (hora LOCAL, sem fuso, como o EKOSERVER manda).
let clpMm = 451, clpSeq = 0;
function horaLocal(segAMais) {
  const d = new Date(Date.now() - 3 * 3600e3 + segAMais * 1000);
  return d.toISOString().slice(0, 19);
}
let clpTempo = horaLocal(0);
function novaLeitura(mm) { clpMm = mm; clpSeq++; clpTempo = horaLocal(clpSeq); }
async function subir() {
  clpSrv = http.createServer((q, s) => {
    s.setHeader('Content-Type', 'application/json');
    s.end(JSON.stringify({ ok: true, sacoleiras: { P2: { comprimento_mm: clpMm, operando: true, tempo: clpTempo } } }));
  }).listen(PORT_CLP);
  servidor = spawn('node', [path.join(ROOT, 'server.js')], {
    env: { ...process.env, EKO_PORT: String(PORT), EKO_PORT_CB: String(PORT_CB), EKO_PORT_HTTPS: String(PORT_HTTPS),
           EKO_DB_FILE: TMP_DB, EKO_LOG_DIR: TMP_LOGS, EKO_CLP_CACHE_MS: '1',
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
  try { clpSrv && clpSrv.close(); } catch (e) {}
  await sleep(700);
}
function comBanco(fn) {
  const db = new DatabaseSync(TMP_DB);
  try { return fn(db); } finally { try { db.close(); } catch (e) {} }
}
function criarBobina(db, id, seq, peso) {
  db.prepare(`INSERT INTO etiquetas (id, seq, tipo, material_key, fornecedor, lote, peso, codigo, sku, status,
                                     hora_impressao, cor, largura, tipo_bobina, maquina, operador)
              VALUES (?, ?, 'extrusao', 'BOBINA', '-', '-', ?, ?, 'BOB-TESTE', 'bipada', ?, 'BRANCO', '1,60', 'LISA', 'E1', 'TESTE')`)
    .run(id, seq, peso, id, new Date().toISOString());
}
async function p2() {
  const r = await req('GET', '/bobinas/abertas');
  return r.body.sacoleiras.find(s => s.sacoleira === 'P2');
}

(async () => {
  console.log('\n=== SETUP QUE MUDOU SEM AVISO ===\n');
  if (!await subir()) { console.log('Servidor de teste não subiu.'); process.exit(1); }
  try {
    comBanco(db => {
      criarBobina(db, 'E9920001', 9920001, 565);
      criarBobina(db, 'E9920002', 9920002, 683);
      db.prepare(`INSERT INTO config(chave, valor) VALUES('vps_sacoleiras_url', ?)
                  ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`).run(`http://localhost:${PORT_CLP}/api`);
    });
    let r = await req('POST', '/bobinas/turno-corte/iniciar', { senha: SENHA, turno: 'A', maquinas: ['P2'], operador: 'SUP' });
    ok(r.status === 200, 'turno A iniciado na P2', r.body);
    r = await req('POST', '/bobinas/baixa', { id: 'E9920001', destino: 'P2', operador: 'ROMULO' });
    ok(r.status === 200, 'bobina 1,60 E9920001 montada na P2', r.body);

    // 1.
    let s = await p2();
    ok(s.bobina.formato.sugerido === '30x45' && !s.bobina.formato.setup_detectado,
       'CLP em 451 mm → cortando 30x45, sem alerta', s.bobina.formato);

    // 2.
    novaLeitura(500); await sleep(20);
    s = await p2();
    ok(!s.bobina.formato.setup_detectado && s.bobina.formato.sugerido === '30x45',
       '1ª leitura em 500 mm: sem alerta, segue 30x45', s.bobina.formato);

    // 3.
    novaLeitura(500); await sleep(20);
    s = await p2();
    const sd = s.bobina.formato.setup_detectado;
    ok(sd && sd.de === '30x45' && sd.para === '40x50' && sd.mm_antes === 451 && sd.mm_agora === 500,
       '2ª leitura em 500 mm: ALERTA setup 30x45 → 40x50 (451 → 500 mm)', s.bobina.formato);
    ok(s.bobina.formato.sugerido === '30x45', 'com o alerta, o sugerido segue 30x45 (o que rodou)', s.bobina.formato);
    novaLeitura(500); await sleep(20);
    s = await p2();
    ok(s.bobina.formato.setup_detectado, 'o alerta continua até alguém informar', s.bobina.formato);

    // 4.
    r = await req('POST', '/bobinas/trocar-formato', { sacoleira: 'P2', fardos: 15, soltos: 2, formato: s.bobina.formato.sugerido,
                                                      formato_origem: 'sugerido', operador: 'CARINE' });
    ok(r.status === 200 && r.body.formato_antes === '30x45' && r.body.pacotes === 77,
       '"Informar 30x45": 15 fardos + 2 pc (77 pc) no 30x45', r.body);
    const st = comBanco(db => db.prepare('SELECT formato_antes, comprimento_antes_mm FROM bobina_setups').get());
    ok(st.formato_antes === '30x45' && st.comprimento_antes_mm === 451, 'troca guarda o comprimento de ANTES (451 mm)', st);
    novaLeitura(500); await sleep(20); await p2();
    novaLeitura(500); await sleep(20);
    s = await p2();
    ok(!s.bobina.formato.aguardando_setup && s.bobina.formato.sugerido === '40x50' && !s.bobina.formato.setup_detectado,
       'troca definida em 40x50 e sem alerta', s.bobina.formato);
    novaLeitura(500); await sleep(20);
    s = await p2();
    ok(!s.bobina.formato.setup_detectado, 'leituras seguintes em 500 não alertam de novo', s.bobina.formato);

    // 5.
    const parte = comBanco(db => db.prepare(`SELECT * FROM bobina_parciais WHERE etiqueta_id='E9920001' ORDER BY id LIMIT 1`).get());
    r = await req('POST', '/bobinas/parcial/editar', { parte_id: parte.id, formato: '40x50', operador: 'SUP' });
    ok(r.status === 200 && r.body.formato === '40x50' && r.body.fardos === 15 && r.body.pacotes === 77,
       'corrigir só o formato: 30x45 → 40x50, fardos e pacotes intactos', r.body);
    const p2b = comBanco(db => db.prepare('SELECT formato, formato_origem, editado_em FROM bobina_parciais WHERE id=?').get(parte.id));
    ok(p2b.formato === '40x50' && p2b.formato_origem === 'corrigido' && p2b.editado_em, 'parte: 40x50, origem corrigido, editado_em (vai para a VPS)', p2b);
    r = await req('POST', '/bobinas/parcial/editar', { parte_id: parte.id, formato: '80x100' });
    ok(r.status === 400, 'formato que não é da P2 é recusado', r.body);
    r = await req('POST', '/bobinas/parcial/editar', { parte_id: parte.id, formato: '30x45' });
    ok(r.status === 200 && r.body.formato === '30x45', 'e dá para voltar ao 30x45', r.body);

    // 6.
    r = await req('POST', '/bobinas/baixa', { id: 'E9920002', destino: 'P2', operador: 'CARINE',
                                              fardos_anterior: 3, soltos_anterior: 0, formato_anterior: '40x50',
                                              formato_anterior_origem: 'sugerido' });
    ok(r.status === 200, 'bobina nova E9920002 na P2 (troca)', r.body);
    novaLeitura(500); await sleep(20);
    s = await p2();
    ok(s.bobina.id === 'E9920002' && s.bobina.formato.sugerido === '40x50' && !s.bobina.formato.setup_detectado,
       'bobina nova começa em 40x50, sem alerta', s.bobina);
  } catch (e) {
    falhou++; console.log('  ERRO', e);
  } finally {
    await derrubar();
    console.log(`\n${passou} passou · ${falhou} falhou\n`);
    process.exit(falhou ? 1 : 0);
  }
})();
