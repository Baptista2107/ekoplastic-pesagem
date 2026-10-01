// ════════════════════════════════════════════════════════════════════
//  EMENDAS NA PESAGEM DA EXTRUSÃO  (01/10/2026, pedido do Gustavo)
//  ------------------------------------------------------------------
//  O operador informa na pesagem quantas emendas a bobina tem; o número não
//  sai na etiqueta, fica em etiquetas.emendas e vai para a VPS no
//  /dashboard/movimentos.
//   1. imprimir com emendas grava o número
//   2. sem o campo (tela antiga) grava NULL e imprime normal
//   3. valor inválido é recusado
//   4. /dashboard/movimentos traz a coluna
// ════════════════════════════════════════════════════════════════════
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path'), os = require('node:os');
const ROOT = path.join(__dirname, '..');
const PORT = 13922, BASE = `http://localhost:${PORT}`, C = Date.now();
const TMP_DB = path.join(os.tmpdir(), `eko_em_${C}.db`);
let passou = 0, falhou = 0, servidor;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function ok(c, msg, extra) { if (c) { passou++; console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
  else { falhou++; console.log(`  \x1b[31m✗\x1b[0m ${msg}`); if (extra !== undefined) console.log('      →', JSON.stringify(extra).slice(0, 400)); } }
async function req(m, rota, corpo) {
  const r = await fetch(BASE + rota, { method: m, headers: { 'Content-Type': 'application/json' }, body: corpo ? JSON.stringify(corpo) : undefined });
  let j = null; try { j = await r.json(); } catch (e) {} return { status: r.status, body: j };
}
const imprimir = (sid, peso, extra = {}) => req('POST', '/etiquetas/extrusao', Object.assign({
  clientToken: 'em-' + Math.random().toString(36).slice(2), sessao_id: sid, cor: 'Branca', tipo_bobina: 'LEVE',
  largura: '1,60', operador: 'WALLISON', maquina: 'C1', turno_codigo: 'EXT-A2', peso }, extra));
(async () => {
  console.log('\n=== EMENDAS NA PESAGEM DA EXTRUSÃO ===\n');
  servidor = spawn('node', [path.join(ROOT, 'server.js')], { env: { ...process.env, EKO_PORT: String(PORT), EKO_PORT_CB: '18922',
    EKO_PORT_HTTPS: '14922', EKO_DB_FILE: TMP_DB, EKO_LOG_DIR: TMP_DB + '_logs', TZ: 'America/Sao_Paulo', EKO_PRINT_SIMULAR: '1' }, stdio: 'ignore' });
  for (let i = 0; i < 75; i++) { try { if ((await fetch(BASE + '/healthcheck')).ok) break; } catch (e) {} await sleep(200); }
  try {
    await req('POST', '/config', { print_simular: '1', bling_simular: '1' });
    const s = await req('POST', '/sessoes', { tipo: 'extrusao', operador: 'WALLISON', maquina: 'C1', turno_codigo: 'EXT-A2' });
    const sid = s.body && s.body.sessao_id;
    let r = await imprimir(sid, 500.1, { emendas: 3 });
    ok(r.status === 200 && r.body.ok, 'bobina com 3 emendas impressa', r.body);
    const id1 = r.body && r.body.id;
    const banco = () => new DatabaseSync(TMP_DB, { readOnly: true });
    let db = banco(); const e1 = db.prepare('SELECT emendas FROM etiquetas WHERE id = ?').get(id1); db.close();
    ok(e1 && e1.emendas === 3, 'etiquetas.emendas = 3', e1);
    r = await imprimir(sid, 501.2);
    ok(r.status === 200 && r.body.ok, 'sem o campo (tela antiga) imprime normal', r.body);
    db = banco(); const e2 = db.prepare('SELECT emendas FROM etiquetas WHERE id = ?').get(r.body.id); db.close();
    ok(e2 && e2.emendas === null, 'e grava NULL (não informado), não 0', e2);
    r = await imprimir(sid, 502.3, { emendas: -1 });
    ok(r.status === 400, 'emendas -1 é recusado', r.body);
    r = await imprimir(sid, 503.4, { emendas: 'x' });
    ok(r.status === 400, 'emendas não numérico é recusado', r.body);
    r = await req('GET', '/dashboard/movimentos?tipo=extrusao');
    const l = (r.body.linhas || []).find(x => x.id === id1);
    ok(l && l.emendas === 3, '/dashboard/movimentos leva emendas para a VPS', l);
  } catch (e) { falhou++; console.log('  erro:', e); }
  try { servidor.kill('SIGKILL'); } catch (e) {}
  console.log(`\n${passou} ok, ${falhou} falha(s)\n`);
  process.exit(falhou ? 1 : 0);
})();
