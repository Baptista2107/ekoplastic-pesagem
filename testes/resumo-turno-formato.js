// ════════════════════════════════════════════════════════════════════
//  RESUMO DO TURNO E FORMATO DECIDIDO  (01/10/2026, pedido do Gustavo)
//  ------------------------------------------------------------------
//  1. sem leitura da sacoleira, o formato sai da bobina (largura que só roda
//     um formato na máquina) ou do último formato cortado nela — e não inventa
//     quando não tem base
//  2. /bobinas/do-turno?fechado=1 devolve o turno que acabou de fechar, no
//     encerrar e na troca, com os fardos e o formato de cada bobina
// ════════════════════════════════════════════════════════════════════
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const os   = require('node:os');

const ROOT = path.join(__dirname, '..');
const PORT = 13921, PORT_CB = 18921, PORT_HTTPS = 14921;
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
function criarBobina(db, id, seq, peso, largura) {
  db.prepare(`INSERT INTO etiquetas (id, seq, tipo, material_key, fornecedor, lote, peso, codigo, sku, status,
                                     hora_impressao, cor, largura, tipo_bobina, maquina, operador)
              VALUES (?, ?, 'extrusao', 'BOBINA', '-', '-', ?, ?, 'BOB-TESTE', 'bipada', ?, 'BRANCO', ?, 'LISA', 'E1', 'TESTE')`)
    .run(id, seq, peso, id, new Date().toISOString(), largura || '1,60');
}

(async () => {
  console.log('\n=== RESUMO DO TURNO E FORMATO DECIDIDO ===\n');
  if (!await subir()) { console.log('Servidor de teste não subiu.'); process.exit(1); }
  try {
    comBanco(db => {
      // sem CLP: a sugestão tem que sair da bobina ou do histórico
      db.prepare(`INSERT OR REPLACE INTO config (chave, valor) VALUES ('vps_sacoleiras_url', 'http://127.0.0.1:9/nada')`).run();
      criarBobina(db, 'E9910001', 9910001, 500, '1,75');   // P2: 1,75 só roda 35x45
      criarBobina(db, 'E9910002', 9910002, 500, '1,60');   // P1: 1,60 roda 40x50 e 50x60
      criarBobina(db, 'E9910003', 9910003, 500, '1,60');
    });
    // sem turno aberto não monta bobina
    let r = await req('POST', '/bobinas/baixa', { id: 'E9910001', destino: 'P2', operador: 'CARINE' });
    ok(r.status === 409 && r.body.sem_turno, 'bipar sem turno aberto é recusado', r.body);
    ok(comBanco(db => db.prepare('SELECT destino FROM etiquetas WHERE id = ?').get('E9910001')).destino == null,
       'e a bobina continua no estoque');
    r = await req('POST', '/bobinas/turno-corte/iniciar', { senha: SENHA, turno: 'A', maquinas: ['P1', 'P2'], operador: 'SUP' });
    ok(r.status === 200, 'turno A iniciado nas duas', r.body);
    await req('POST', '/bobinas/baixa', { id: 'E9910001', destino: 'P2', operador: 'CARINE' });
    await req('POST', '/bobinas/baixa', { id: 'E9910002', destino: 'P1', operador: 'ANDRE' });
    r = await req('GET', '/bobinas/abertas');
    const p2 = r.body.sacoleiras.find(s => s.sacoleira === 'P2').bobina;
    const p1 = r.body.sacoleiras.find(s => s.sacoleira === 'P1').bobina;
    ok(p2.formato.sugerido === '35x45', 'P2 sem CLP, bobina 1,75: decide 35x45 pela bobina', p2.formato);
    ok(p1.formato.sugerido === null, 'P1 sem CLP, bobina 1,60 e sem histórico: não inventa', p1.formato);

    // troca de bobina na P1 informando 50x60 → vira o "último formato" da P1
    r = await req('POST', '/bobinas/baixa', { id: 'E9910003', destino: 'P1', operador: 'ANDRE',
                                              fardos_anterior: 4, formato_anterior: '50x60', formato_anterior_origem: 'escolhido' });
    ok(r.status === 200, 'troca na P1 com 4 fardos de 50x60', r.body);
    r = await req('GET', '/bobinas/abertas');
    const p1b = r.body.sacoleiras.find(s => s.sacoleira === 'P1').bobina;
    ok(p1b.formato.sugerido === '50x60' && /último formato/.test(p1b.formato.motivo),
       'P1 sem CLP: decide pelo último formato cortado nela', p1b.formato);

    // encerrar o turno e pedir o resumo
    r = await req('POST', '/bobinas/turno-corte/encerrar', { senha: SENHA, maquinas: ['P1', 'P2'],
      parciais: { P1: { fardos: 2, formato: '50x60' }, P2: { fardos: 7, formato: '35x45' } } });
    ok(r.status === 200, 'turno encerrado nas duas', r.body);
    r = await req('GET', '/bobinas/do-turno?fechado=1');
    const s1 = r.body.sacoleiras.find(s => s.sacoleira === 'P1'), s2 = r.body.sacoleiras.find(s => s.sacoleira === 'P2');
    ok(s1.turno && s1.turno.fim && s1.pacotes_turno === 30, 'resumo P1: turno fechado com 6 fardos (4 da troca + 2)', s1);
    ok(s2.pacotes_turno === 35 && s2.bobinas[0].formato_turno === '35x45', 'resumo P2: 7 fardos de 35x45', s2);

    // corrigir no resumo: P2 lançou 7, eram 6
    const b2 = s2.bobinas.find(b => b.id === 'E9910001');
    ok(b2.parte_id && b2.fechados_turno === 7, 'a bobina da P2 traz a parte editável (7 fardos)', b2);
    r = await req('POST', '/bobinas/parcial/editar', { senha: 'x', parte_id: b2.parte_id, fardos: 6 });
    ok(r.status === 401, 'corrigir com senha errada é recusado');
    const antesEd = new Date().toISOString();
    r = await req('POST', '/bobinas/parcial/editar', { senha: SENHA, parte_id: b2.parte_id, fardos: 6, operador: 'SUP' });
    ok(r.status === 200 && r.body.pacotes === 30, 'corrige 7 → 6 fardos (30 pc)', r.body);
    r = await req('GET', '/bobinas/do-turno?fechado=1');
    const s2b = r.body.sacoleiras.find(s => s.sacoleira === 'P2'), b2b = s2b.bobinas[0];
    ok(s2b.pacotes_turno === 30 && b2b.editado && b2b.fardos_antes === 7, 'resumo mostra 6 fardos, corrigido (era 7)', b2b);
    r = await req('GET', '/dashboard/bobina-parciais?desde=' + encodeURIComponent(antesEd));
    ok(r.body.parciais.some(p => p.id === b2.parte_id && p.fardos === 6), 'a parte corrigida volta no exportador (editado_em)', r.body);
    // bobina já encerrada (troca na P1): o total da etiqueta é refeito
    const b1 = s1.bobinas.find(b => b.id === 'E9910002');
    r = await req('POST', '/bobinas/parcial/editar', { senha: SENHA, parte_id: b1.parte_id, fardos: 3 });
    ok(r.status === 200 && r.body.pacotes_total === 15, 'corrige a bobina encerrada: total refeito para 3 fardos', r.body);
    const e1 = comBanco(db => db.prepare('SELECT fardos, pacotes FROM etiquetas WHERE id = ?').get('E9910002'));
    ok(e1.fardos === 3 && e1.pacotes === 15, 'etiquetas.fardos/pacotes da bobina encerrada acompanham', e1);

    // trocar o turno (iniciar por cima) também mostra o turno que fechou
    await req('POST', '/bobinas/turno-corte/iniciar', { senha: SENHA, turno: 'C', maquinas: ['P1', 'P2'] });
    r = await req('POST', '/bobinas/turno-corte/iniciar', { senha: SENHA, turno: 'EXTRA', maquinas: ['P1', 'P2'],
      parciais: { P1: { fardos: 1 }, P2: { fardos: 3 } } });
    ok(r.status === 200 && r.body.encerrados.length === 2, 'troca C → EXTRA nas duas', r.body);
    r = await req('GET', '/bobinas/do-turno?fechado=1');
    ok(r.body.sacoleiras.every(s => s.turno && s.turno.turno === 'C'), 'resumo depois da troca é do turno C que fechou', r.body.sacoleiras.map(s => s.turno));
    r = await req('GET', '/bobinas/do-turno');
    ok(r.body.sacoleiras.every(s => s.turno && s.turno.turno === 'EXTRA' && !s.turno.fim), 'sem ?fechado continua o turno aberto');
  } catch (e) { falhou++; console.log('  erro:', e); }
  await derrubar();
  console.log(`\n${passou} ok, ${falhou} falha(s)\n`);
  process.exit(falhou ? 1 : 0);
})();
