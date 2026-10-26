// ════════════════════════════════════════════════════════════════════
//  30x45 ↔ 33x46 SÓ PELO COLETOR  (26/10/2026, pedido do Vinicius)
//  ------------------------------------------------------------------
//  Caso real: P2, E0002156 em 30x45 a 455 mm; ajuste fino para 456 (tentativa
//  de melhorar a sacola) e o coletor alertou "setup mudou para 33x46". Entre
//  esses dois formatos o CLP não troca um pelo outro — só a escolha no coletor:
//   1. CLP em 455: 30x45 (empate fica com 30x45)
//   2. 456 e 460 em 2 leituras: sem alerta, segue 30x45
//   3. Trocar formato escolhendo 33x46: vale 33x46; CLP voltar a 455 não alerta
//   4. ✓ Bobina finalizou com a próxima em 30x45: bobina nova em 30x45 mesmo
//      com o CLP em 460, e 460 depois não alerta
//   5. troca para fora do par (500 = 40x50) continua alertando
//   6. bobina nova sem escolha: CLP em 460 fica no último cortado (30x45)
// ════════════════════════════════════════════════════════════════════
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const http = require('node:http');
const path = require('node:path');
const os   = require('node:os');

const ROOT = path.join(__dirname, '..');
const PORT = 13955, PORT_CB = 18955, PORT_HTTPS = 14955, PORT_CLP = 13956;
const BASE = `http://localhost:${PORT}`;
const C = Date.now();
const TMP_DB   = path.join(os.tmpdir(), `eko_par_${C}.db`);
const TMP_LOGS = path.join(os.tmpdir(), `eko_par_${C}`);
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
// CLP de mentira (hora LOCAL, sem fuso, como o EKOSERVER manda).
let clpMm = 455, clpSeq = 0;
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
async function duasLeituras(mm) {
  novaLeitura(mm); await sleep(20); await p2();
  novaLeitura(mm); await sleep(20); return p2();
}
const fmt = s => s.bobina && s.bobina.formato;

(async () => {
  console.log('\n=== 30x45 ↔ 33x46 SÓ PELO COLETOR ===\n');
  if (!await subir()) { console.log('Servidor de teste não subiu.'); process.exit(1); }
  try {
    comBanco(db => {
      criarBobina(db, 'E9950001', 9950001, 600);
      criarBobina(db, 'E9950002', 9950002, 600);
      criarBobina(db, 'E9950003', 9950003, 600);
      db.prepare(`INSERT INTO config(chave, valor) VALUES('vps_sacoleiras_url', ?)
                  ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`).run(`http://localhost:${PORT_CLP}/api`);
    });
    let r = await req('POST', '/bobinas/turno-corte/iniciar', { senha: SENHA, turno: 'A', maquinas: ['P2'], operador: 'SUP' });
    ok(r.status === 200, 'turno A iniciado na P2', r.body);
    r = await req('POST', '/bobinas/baixa', { id: 'E9950001', destino: 'P2', operador: 'ROMULO' });
    ok(r.status === 200, 'bobina 1,60 E9950001 montada na P2', r.body);

    // 1.
    let s = await p2();
    ok(fmt(s).sugerido === '30x45' && !fmt(s).setup_detectado, 'CLP em 455 → 30x45, sem alerta', fmt(s));

    // 2.
    s = await duasLeituras(456);
    ok(fmt(s).sugerido === '30x45' && !fmt(s).setup_detectado, '456 em 2 leituras (o caso da E0002156): sem alerta, 30x45', fmt(s));
    s = await duasLeituras(460);
    ok(fmt(s).sugerido === '30x45' && !fmt(s).setup_detectado, '460 em 2 leituras: o CLP sozinho não vira 33x46', fmt(s));

    // 3.
    r = await req('POST', '/bobinas/trocar-formato', { sacoleira: 'P2', fardos: 5, soltos: 0, formato: '30x45',
                                                      formato_origem: 'sugerido', formato_novo: '33x46' });
    ok(r.status === 200 && r.body.formato_novo === '33x46', 'operador escolhe 33x46 no Trocar formato', r.body);
    s = await p2();
    ok(fmt(s).sugerido === '33x46' && !fmt(s).setup_detectado, 'a tela passa a 33x46', fmt(s));
    s = await duasLeituras(455);
    ok(fmt(s).sugerido === '33x46' && !fmt(s).setup_detectado && !fmt(s).aguardando_setup,
       'CLP volta a 455: segue 33x46, sem alerta', fmt(s));

    // 4.
    r = await req('POST', '/bobinas/finalizar', { sacoleira: 'P2', fardos: 8, soltos: 0, formato: '33x46',
                                                  formato_origem: 'sugerido', acabou: true, formato_proximo: '30x45' });
    ok(r.status === 200 && r.body.formato_proximo === '30x45', 'finalizou em 33x46, próxima escolhida 30x45', r.body);
    novaLeitura(460);
    r = await req('POST', '/bobinas/baixa', { id: 'E9950002', destino: 'P2', operador: 'ROMULO' });
    s = await p2();
    ok(r.status === 200 && fmt(s).sugerido === '30x45', 'E9950002 entra em 30x45 com o CLP ainda em 460', fmt(s));
    s = await duasLeituras(460);
    ok(fmt(s).sugerido === '30x45' && !fmt(s).setup_detectado, '460 depois do bipe: segue 30x45', fmt(s));
    s = await duasLeituras(455);
    ok(fmt(s).sugerido === '30x45' && !fmt(s).setup_detectado, '455: segue 30x45', fmt(s));

    // 5.
    s = await duasLeituras(500);
    const sd = fmt(s).setup_detectado;
    ok(sd && sd.de === '30x45' && sd.para === '40x50', 'fora do par (500 = 40x50): o alerta continua', fmt(s));
    r = await req('POST', '/bobinas/trocar-formato', { sacoleira: 'P2', fardos: 3, soltos: 0, formato: '30x45',
                                                      formato_origem: 'sugerido', formato_novo: '40x50' });
    ok(r.status === 200, 'informado: 30x45 rendeu 3 fardos, agora 40x50', r.body);

    // 6.
    r = await req('POST', '/bobinas/finalizar', { sacoleira: 'P2', fardos: 2, soltos: 0, formato: '40x50',
                                                  formato_origem: 'sugerido', acabou: true });
    ok(r.status === 200, 'finalizou sem escolher a próxima', r.body);
    comBanco(db => db.prepare(`UPDATE bobina_parciais SET formato = '30x45' WHERE etiqueta_id = 'E9950002'`).run());
    novaLeitura(460);
    r = await req('POST', '/bobinas/baixa', { id: 'E9950003', destino: 'P2', operador: 'ROMULO' });
    s = await p2();
    ok(r.status === 200 && fmt(s).sugerido === '30x45' && !fmt(s).setup_detectado,
       'bobina nova sem escolha, CLP em 460: fica no último cortado (30x45)', fmt(s));
  } catch (e) {
    falhou++; console.log('  ERRO', e);
  } finally {
    await derrubar();
    console.log(`\n${passou} passou · ${falhou} falhou\n`);
    process.exit(falhou ? 1 : 0);
  }
})();
