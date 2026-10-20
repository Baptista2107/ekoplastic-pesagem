// ════════════════════════════════════════════════════════════════════
//  PRÓXIMA BOBINA E TROCA NA MESMA BOBINA  (20/10/2026, pedido do Gustavo)
//  ------------------------------------------------------------------
//  A produção se informa num lugar só, o ✓ Bobina finalizou, que também
//  pergunta o formato da PRÓXIMA bobina. A máquina fica com o aviso
//  "BIPE A PRÓXIMA BOBINA" até o bipe. O "Trocar formato" é só para a
//  mesma bobina e já pede o formato novo.
//
//  O que este teste prova, com banco temporário e um CLP de mentira:
//   1. finalizou 30x40 escolhendo 30x45 para a próxima: máquina vazia com
//      aguardando_bipe e formato_proximo 30x45
//   2. leitura do CLP de depois do finalizou, operando: cortando_sem_bobina
//   3. bipou: o aviso sai e a bobina nova começa em 30x45 (escolhido), com o
//      CLP ainda em 401 mm — e continua assim nas leituras seguintes
//   4. CLP vai para 451 (30x45): confirma, sem alerta de setup
//   5. desfazer a bobina nova devolve o aviso de bipe
//   6. "automático": finalizou mantendo 30x45, bipou e SÓ DEPOIS a máquina
//      foi para 401 → vale o da máquina (30x40), sem pedir fardos
//   7. troca na MESMA bobina com formato_novo: parte 'setup' do antigo e a
//      troca já definida no novo; CLP ainda no antigo não desfaz a escolha
//   8. formato da próxima que não é da máquina é recusado
// ════════════════════════════════════════════════════════════════════
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const http = require('node:http');
const path = require('node:path');
const os   = require('node:os');

const ROOT = path.join(__dirname, '..');
const PORT = 13950, PORT_CB = 18950, PORT_HTTPS = 14950, PORT_CLP = 13951;
const BASE = `http://localhost:${PORT}`;
const C = Date.now();
const TMP_DB   = path.join(os.tmpdir(), `eko_pb_${C}.db`);
const TMP_LOGS = path.join(os.tmpdir(), `eko_pb_${C}`);
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
// CLP de mentira (hora LOCAL, sem fuso, como o EKOSERVER manda). Cada
// leitura nova ganha um carimbo novo, `adiante` segundos depois de agora.
let clpMm = 401, clpSeq = 0, clpSacosMin = 700;
function horaLocal(segAMais) {
  const d = new Date(Date.now() - 3 * 3600e3 + segAMais * 1000);
  return d.toISOString().slice(0, 19);
}
let clpTempo = horaLocal(0);
function novaLeitura(mm, adiante) { clpMm = mm; clpSeq++; clpTempo = horaLocal(adiante !== undefined ? adiante : clpSeq); }
async function subir() {
  clpSrv = http.createServer((q, s) => {
    s.setHeader('Content-Type', 'application/json');
    s.end(JSON.stringify({ ok: true, sacoleiras: { P2: { comprimento_mm: clpMm, operando: 1, sacos_min: clpSacosMin, tempo: clpTempo } } }));
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
// Duas leituras novas no mesmo comprimento (o sistema só aceita mudança em 2).
async function duasLeituras(mm) {
  novaLeitura(mm); await sleep(20); await p2();
  novaLeitura(mm); await sleep(20); return p2();
}

(async () => {
  console.log('\n=== PRÓXIMA BOBINA E TROCA NA MESMA BOBINA ===\n');
  if (!await subir()) { console.log('Servidor de teste não subiu.'); process.exit(1); }
  try {
    comBanco(db => {
      for (let i = 1; i <= 5; i++) criarBobina(db, 'E993000' + i, 9930000 + i, 500 + i);
      db.prepare(`INSERT INTO config(chave, valor) VALUES('vps_sacoleiras_url', ?)
                  ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`).run(`http://localhost:${PORT_CLP}/api`);
    });
    let r = await req('POST', '/bobinas/turno-corte/iniciar', { senha: SENHA, turno: 'A', maquinas: ['P2'], operador: 'SUP' });
    ok(r.status === 200, 'turno A iniciado na P2', r.body);
    r = await req('POST', '/bobinas/baixa', { id: 'E9930001', destino: 'P2' });
    ok(r.status === 200, 'E9930001 montada na P2', r.body);
    let s = await p2();
    ok(s.bobina.formato.sugerido === '30x40', 'CLP em 401 mm → cortando 30x40', s.bobina.formato);

    // 8. formato da próxima que não é da P2
    r = await req('POST', '/bobinas/finalizar', { sacoleira: 'P2', fardos: 11, soltos: 0, formato: '30x40',
                                                 acabou: true, formato_proximo: '60x80' });
    ok(r.status === 400, 'próxima em 60x80 (não é da P2) é recusada, nada gravado', r.body);

    // 1. finalizou escolhendo 30x45 para a próxima
    r = await req('POST', '/bobinas/finalizar', { sacoleira: 'P2', fardos: 11, soltos: 0, formato: '30x40',
                                                 formato_origem: 'sugerido', acabou: true, formato_proximo: '30x45' });
    ok(r.status === 200 && r.body.pacotes === 55 && r.body.formato_proximo === '30x45',
       'finalizou: 30x40 com 11 fardos (55 pc), próxima vai cortar 30x45', r.body);
    s = await p2();
    ok(!s.bobina && s.aguardando_bipe === true && s.formato_proximo === '30x45' && s.cortando_sem_bobina === false,
       'máquina vazia: aviso BIPE A PRÓXIMA BOBINA (30x45), sem vermelho', s);

    // 2. a máquina voltou a cortar sem bobina (leitura de 5 min depois)
    novaLeitura(401, 300); await sleep(20);
    s = await p2();
    ok(s.aguardando_bipe && s.cortando_sem_bobina === true, 'leitura de depois do finalizou, operando: CORTANDO SEM BOBINA', s);
    clpSacosMin = 0; novaLeitura(401, 310); await sleep(20);
    s = await p2();
    ok(s.cortando_sem_bobina === false, 'parada (0 sacos/min): sem vermelho', s);
    clpSacosMin = 700; novaLeitura(401);

    // 3. bipou a próxima
    r = await req('POST', '/bobinas/baixa', { id: 'E9930002', destino: 'P2' });
    ok(r.status === 200, 'E9930002 bipada na P2', r.body);
    s = await p2();
    ok(s.bobina && s.bobina.id === 'E9930002' && !s.aguardando_bipe, 'o aviso sai com o bipe', s);
    ok(s.bobina.formato.sugerido === '30x45' && s.bobina.formato.escolhido, 'começa em 30x45 (escolhido), com o CLP ainda em 401', s.bobina.formato);
    s = await duasLeituras(401);
    ok(s.bobina.formato.sugerido === '30x45' && !s.bobina.formato.setup_detectado,
       'mais leituras em 401: a escolha vale até a máquina mudar', s.bobina.formato);

    // 4. máquina ajustada para 451
    novaLeitura(451); await sleep(20);
    s = await p2();
    ok(s.bobina.formato.sugerido === '30x45' && !s.bobina.formato.escolhido && !s.bobina.formato.setup_detectado,
       'CLP em 451: confirma 30x45, sem alerta', s.bobina.formato);

    // 5. desfazer a bobina nova devolve o aviso
    r = await req('POST', '/bobinas/desfazer', { id: 'E9930002' });
    ok(r.status === 200, 'desfeita a E9930002', r.body);
    s = await p2();
    ok(!s.bobina && s.aguardando_bipe && s.formato_proximo === '30x45', 'o aviso de bipe volta (30x45)', s);
    r = await req('POST', '/bobinas/baixa', { id: 'E9930003', destino: 'P2' });
    s = await p2();
    ok(r.status === 200 && s.bobina.id === 'E9930003' && s.bobina.formato.sugerido === '30x45',
       'E9930003 bipada no lugar, em 30x45 (CLP já em 451)', s.bobina && s.bobina.formato);

    // 6. "automático": mantém 30x45, bipa e só depois a máquina vai para 401
    r = await req('POST', '/bobinas/finalizar', { sacoleira: 'P2', fardos: 9, soltos: 0, formato: '30x45',
                                                 formato_origem: 'sugerido', acabou: true, formato_proximo: '30x45' });
    ok(r.status === 200, 'E9930003 finalizou mantendo 30x45 para a próxima', r.body);
    r = await req('POST', '/bobinas/baixa', { id: 'E9930004', destino: 'P2' });
    ok(r.status === 200, 'E9930004 bipada', r.body);
    s = await duasLeituras(401);
    ok(s.bobina.formato.sugerido === '30x40' && !s.bobina.formato.setup_detectado,
       'máquina foi para 401 logo depois do bipe: vale 30x40, sem pedir fardos', s.bobina.formato);
    s = await duasLeituras(451);
    ok(s.bobina.formato.setup_detectado && s.bobina.formato.setup_detectado.de === '30x40',
       'mudança de novo (já é o formato da bobina): aí sim alerta de setup', s.bobina.formato);

    // 7. troca na MESMA bobina com o formato novo escolhido na hora
    r = await req('POST', '/bobinas/trocar-formato', { sacoleira: 'P2', fardos: 4, soltos: 1, formato: '30x40',
                                                      formato_novo: '30x40' });
    ok(r.status === 400, 'formato novo igual ao antigo é recusado', r.body);
    r = await req('POST', '/bobinas/trocar-formato', { sacoleira: 'P2', fardos: 4, soltos: 1, formato: '30x40',
                                                      formato_origem: 'sugerido', formato_novo: '40x50' });
    ok(r.status === 200 && r.body.pacotes === 21 && r.body.formato_novo === '40x50' && r.body.aguardando === false,
       'troca na mesma bobina: 30x40 rendeu 21 pc, agora 40x50', r.body);
    const st = comBanco(db => db.prepare(`SELECT formato_antes, formato_novo, definido_em FROM bobina_setups
                                           WHERE etiqueta_id = 'E9930004'`).get());
    ok(st && st.formato_antes === '30x40' && st.formato_novo === '40x50' && st.definido_em, 'bobina_setups já definida 30x40 → 40x50', st);
    s = await p2();
    ok(s.bobina.formato.sugerido === '40x50' && !s.bobina.formato.aguardando_setup && !s.bobina.formato.setup_detectado,
       'a tela já mostra 40x50 (CLP ainda em 451)', s.bobina.formato);
    ok(s.bobina.desde_troca === true && s.bobina.pacotes_parciais === 21, 'conta "desde a troca" (21 pc já informados)', s.bobina);
    s = await duasLeituras(505);
    ok(s.bobina.formato.sugerido === '40x50' && !s.bobina.formato.escolhido && !s.bobina.formato.setup_detectado,
       'CLP em 505: confirma 40x50', s.bobina.formato);
    r = await req('POST', '/bobinas/finalizar', { sacoleira: 'P2', fardos: 6, soltos: 0, formato: '40x50', acabou: true });
    ok(r.status === 200 && r.body.pacotes_total === 51 && r.body.formato_proximo === null,
       'finalizou sem formato da próxima (tela antiga): total 21 + 30 = 51 pc', r.body);
    s = await p2();
    ok(!s.bobina && !s.aguardando_bipe, 'sem formato da próxima, sem aviso de bipe', s);
  } catch (e) {
    falhou++; console.log('  ERRO', e);
  } finally {
    await derrubar();
    console.log(`\n${passou} passou · ${falhou} falhou\n`);
    process.exit(falhou ? 1 : 0);
  }
})();
