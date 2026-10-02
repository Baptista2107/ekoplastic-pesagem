// ════════════════════════════════════════════════════════════════════
//  TROCA DE FORMATO COM A BOBINA MONTADA  (02/10/2026, pedido do Gustavo)
//  ------------------------------------------------------------------
//  Muda o formato da sacola no meio da bobina. O operador toca "Trocar
//  formato" e informa os fardos do formato QUE ESTAVA rodando; o novo o
//  sistema pega sozinho quando o comprimento do CLP muda (505 → 450 mm).
//
//  O que este teste prova, com banco temporário e um CLP de mentira:
//   1. a bobina 1,60 na P2 com o CLP em 505 mm está cortando 40x50
//   2. trocar formato grava a parte 'setup' (40x50) e deixa "aguardando"
//   3. a 2ª troca seguida é recusada enquanto aguarda
//   4. com o CLP ainda em 505, continua aguardando
//   5. CLP em 450 numa leitura só NÃO define; na 2ª leitura define 30x45
//   6. os soltos do 40x50 não passam para o 30x45 (soltos_inicio = 0)
//   7. encerrar: total = soma; cada formato com os seus pacotes, e o resumo
//      do turno mostra os dois formatos
//   8. a parte 'setup' vai para a VPS em /dashboard/bobina-parciais
// ════════════════════════════════════════════════════════════════════
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const http = require('node:http');
const path = require('node:path');
const os   = require('node:os');

const ROOT = path.join(__dirname, '..');
const PORT = 13930, PORT_CB = 18930, PORT_HTTPS = 14930, PORT_CLP = 13931;
const BASE = `http://localhost:${PORT}`;
const C = Date.now();
const TMP_DB   = path.join(os.tmpdir(), `eko_tf_${C}.db`);
const TMP_LOGS = path.join(os.tmpdir(), `eko_tf_${C}`);
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
let clpMm = 505, clpSeq = 0;
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
  console.log('\n=== TROCA DE FORMATO COM A BOBINA MONTADA ===\n');
  if (!await subir()) { console.log('Servidor de teste não subiu.'); process.exit(1); }
  try {
    comBanco(db => {
      criarBobina(db, 'E9910001', 9910001, 500);
      db.prepare(`INSERT INTO config(chave, valor) VALUES('vps_sacoleiras_url', ?)
                  ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`).run(`http://localhost:${PORT_CLP}/api`);
    });
    let r = await req('POST', '/bobinas/turno-corte/iniciar', { senha: SENHA, turno: 'A', maquinas: ['P2'], operador: 'SUP' });
    ok(r.status === 200, 'turno A iniciado na P2', r.body);
    r = await req('POST', '/bobinas/baixa', { id: 'E9910001', destino: 'P2', operador: 'GISLENE' });
    ok(r.status === 200, 'bobina 1,60 E9910001 montada na P2', r.body);

    // 1. cortando 40x50 pelo comprimento
    let s = await p2();
    ok(s.bobina.formato.sugerido === '40x50', 'CLP em 505 mm → a P2 está cortando 40x50', s.bobina.formato);

    // 2. troca: 8 fechados + 2 soltos no 40x50
    r = await req('POST', '/bobinas/trocar-formato', { sacoleira: 'P2', fardos: 8, soltos: 2, formato: '40x50',
                                                      formato_origem: 'sugerido', operador: 'GISLENE' });
    ok(r.status === 200 && r.body.pacotes === 42 && r.body.formato_antes === '40x50',
       'troca registrada: 40x50 rendeu 8 fardos + 2 pc (42 pacotes)', r.body);
    s = await p2();
    ok(s.bobina.formato.aguardando_setup && !s.bobina.formato.sugerido, 'a bobina fica "aguardando" o comprimento mudar', s.bobina.formato);
    ok(s.bobina.desde_troca === true && s.bobina.pacotes_parciais === 42, 'a tela sabe que conta "desde a troca" (42 pc já informados)', s.bobina);

    // 3. segunda troca recusada enquanto aguarda
    r = await req('POST', '/bobinas/trocar-formato', { sacoleira: 'P2', fardos: 1, soltos: 0, formato: '40x50' });
    ok(r.status === 409, 'outra troca enquanto aguarda é recusada', r.body);

    // 4. CLP ainda em 505 (leitura nova): continua aguardando
    novaLeitura(505); await sleep(20);
    s = await p2();
    ok(s.bobina.formato.aguardando_setup, 'CLP ainda em 505 mm: continua aguardando', s.bobina.formato);

    // 5. uma leitura em 450 não basta; a segunda define 30x45
    novaLeitura(450); await sleep(20);
    s = await p2();
    ok(s.bobina.formato.aguardando_setup, '1ª leitura em 450 mm: ainda aguardando (pode ser o meio do ajuste)', s.bobina.formato);
    novaLeitura(450); await sleep(20);
    s = await p2();
    ok(!s.bobina.formato.aguardando_setup && s.bobina.formato.sugerido === '30x45',
       '2ª leitura em 450 mm: formato novo 30x45 definido', s.bobina.formato);
    const st = comBanco(db => db.prepare('SELECT formato_antes, formato_novo, comprimento_antes_mm FROM bobina_setups').get());
    ok(st.formato_antes === '40x50' && st.formato_novo === '30x45' && st.comprimento_antes_mm === 505,
       'bobina_setups guarda 40x50 (505 mm) → 30x45', st);

    // 6. soltos não se misturam
    ok(s.bobina.soltos_inicio === 0, 'o 30x45 começa com 0 pacote solto (os 2 eram do 40x50)', s.bobina);

    // CLP some (leitura velha): o formato da troca continua valendo, não o "último cortado" (40x50)
    clpTempo = horaLocal(-7200); await sleep(20);
    s = await p2();
    ok(s.bobina.formato.sugerido === '30x45', 'sem leitura do CLP, vale o formato da troca (30x45), não o antigo', s.bobina.formato);
    novaLeitura(450);

    // 7. encerrar com 5 fechados + 1 solto no 30x45 → 26 pc; total 68
    r = await req('POST', '/bobinas/finalizar', { sacoleira: 'P2', fardos: 5, soltos: 1, formato: '30x45',
                                                 formato_origem: 'sugerido', operador: 'GISLENE' });
    ok(r.status === 200 && r.body.pacotes === 26 && r.body.pacotes_total === 68,
       'encerrar: 30x45 rendeu 26 pc; total da bobina 42 + 26 = 68 pc', r.body);
    const partes = comBanco(db => db.prepare(
      `SELECT formato, pacotes, momento FROM bobina_parciais WHERE etiqueta_id = 'E9910001' ORDER BY id`).all());
    ok(JSON.stringify(partes.map(p => [p.formato, p.pacotes, p.momento])) ===
       JSON.stringify([['40x50', 42, 'setup'], ['30x45', 26, 'final']]),
       'partes: 40x50 42 pc (setup) e 30x45 26 pc (final)', partes);
    const e = comBanco(db => db.prepare('SELECT pacotes, fardos FROM etiquetas WHERE id = ?').get('E9910001'));
    ok(e.pacotes === 68, 'etiquetas.pacotes = 68', e);
    r = await req('GET', '/bobinas/do-turno');
    const b = r.body.sacoleiras.find(x => x.sacoleira === 'P2').bobinas.find(x => x.id === 'E9910001');
    ok(b && JSON.stringify(b.formatos_turno) === JSON.stringify([{ formato: '40x50', pacotes: 42 }, { formato: '30x45', pacotes: 26 }]),
       'resumo do turno mostra os dois formatos com os pacotes de cada', b && b.formatos_turno);

    // 8. a VPS recebe a parte 'setup'
    r = await fetch(BASE + '/dashboard/bobina-parciais?desde=2000-01-01');
    const txt = await r.text();
    ok(txt.includes('"setup"') && txt.includes('40x50'), '/dashboard/bobina-parciais leva a parte setup (40x50) para a VPS', txt.slice(0, 300));
  } catch (e) {
    falhou++; console.log('  ERRO', e);
  } finally {
    await derrubar();
    console.log(`\n${passou} passou · ${falhou} falhou\n`);
    process.exit(falhou ? 1 : 0);
  }
})();
