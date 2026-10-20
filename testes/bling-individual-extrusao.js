// ════════════════════════════════════════════════════════════════════
//  ENVIO INDIVIDUAL DA EXTRUSÃO AO BLING  (20/10/2026)
//  ------------------------------------------------------------------
//  Com bling_extrusao_modo = 'individual', bipar uma bobina dispara o
//  pedido no Bling na hora. O caminho real chamava garantirAcessToken(),
//  que não existe: a bipagem respondia "garantirAcessToken is not
//  defined" e o pedido nunca saía. Produção usa 'lote', por isso nunca
//  apareceu.
//  Aqui roda SEM token (arquivo temporário vazio): getToken() recusa antes
//  de qualquer chamada de rede, então o teste nunca encosta no Bling.
//   1. a bipagem responde com o erro de autenticação, não ReferenceError
//   2. a etiqueta fica bipada e sem bling_pedido_id (reenvio possível)
// ════════════════════════════════════════════════════════════════════
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path'), os = require('node:os');
const ROOT = path.join(__dirname, '..');
const PORT = 13923, BASE = `http://localhost:${PORT}`, C = Date.now();
const TMP_DB = path.join(os.tmpdir(), `eko_bi_${C}.db`);
let passou = 0, falhou = 0, servidor;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function ok(c, msg, extra) { if (c) { passou++; console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
  else { falhou++; console.log(`  \x1b[31m✗\x1b[0m ${msg}`); if (extra !== undefined) console.log('      →', JSON.stringify(extra).slice(0, 400)); } }
async function req(m, rota, corpo) {
  const r = await fetch(BASE + rota, { method: m, headers: { 'Content-Type': 'application/json' }, body: corpo ? JSON.stringify(corpo) : undefined });
  let j = null; try { j = await r.json(); } catch (e) {} return { status: r.status, body: j };
}
(async () => {
  console.log('\n=== ENVIO INDIVIDUAL DA EXTRUSÃO AO BLING ===\n');
  servidor = spawn('node', [path.join(ROOT, 'server.js')], { env: { ...process.env, EKO_PORT: String(PORT), EKO_PORT_CB: '18923',
    EKO_PORT_HTTPS: '14923', EKO_DB_FILE: TMP_DB, EKO_LOG_DIR: TMP_DB + '_logs', EKO_TOKEN_FILE: TMP_DB + '_tokens.json',
    TZ: 'America/Sao_Paulo', EKO_PRINT_SIMULAR: '1' }, stdio: 'ignore' });
  for (let i = 0; i < 75; i++) { try { if ((await fetch(BASE + '/healthcheck')).ok) break; } catch (e) {} await sleep(200); }
  try {
    await req('POST', '/config', { print_simular: '1', bling_simular: '0', bling_extrusao_modo: 'individual' });
    const s = await req('POST', '/sessoes', { tipo: 'extrusao', operador: 'WALLISON', maquina: 'C1', turno_codigo: 'EXT-A2' });
    let r = await req('POST', '/etiquetas/extrusao', { clientToken: 'bi-' + C, sessao_id: s.body && s.body.sessao_id,
      cor: 'Branca', tipo_bobina: 'LEVE', largura: '1,60', operador: 'WALLISON', maquina: 'C1', turno_codigo: 'EXT-A2', peso: 500.1 });
    ok(r.status === 200 && r.body.ok, 'bobina impressa', r.body);
    const id = r.body && r.body.id;
    r = await req('POST', `/etiqueta/${id}/bipar`, {});
    const b = r.body && r.body.bling;
    ok(b && b.ok === false && /autenticado/i.test(b.erro || ''), 'sem token: erro de autenticação do Bling', r.body);
    ok(!/not defined/.test(JSON.stringify(r.body)), 'nenhuma função inexistente no caminho', r.body);
    const db = new DatabaseSync(TMP_DB, { readOnly: true });
    const e = db.prepare('SELECT status, bling_pedido_id FROM etiquetas WHERE id = ?').get(id); db.close();
    ok(e && e.status === 'bipada' && e.bling_pedido_id === null, 'etiqueta bipada, sem pedido (pode reenviar)', e);
  } catch (e) { falhou++; console.log('  erro:', e); }
  try { servidor.kill('SIGKILL'); } catch (e) {}
  console.log(`\n${passou} ok, ${falhou} falha(s)\n`);
  process.exit(falhou ? 1 : 0);
})();
