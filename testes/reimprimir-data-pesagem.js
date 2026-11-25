// ════════════════════════════════════════════════════════════════════
//  REIMPRESSÃO DE MP LEVA A DATA DA PESAGEM  (25/11/2026)
//  Gustavo pediu para trocar as etiquetas de MP antigas pelas novas (QR +
//  barras), reimprimindo com o MESMO número. A data/hora da etiqueta saía
//  sempre a do momento da impressão: as ~200 sairiam com a data da troca.
//
//   A) etiqueta nova: data/hora de agora
//   B) reimprimir pela rota: data/hora gravada na pesagem (hora_impressao),
//      mesmo número, status inalterado
//
//  Como rodar:   node testes/reimprimir-data-pesagem.js
// ════════════════════════════════════════════════════════════════════
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');

const ROOT    = path.join(__dirname, '..');
const PORT    = 13977, PORT_CB = 18977, PORT_HTTPS = 14977;
const BASE    = `http://localhost:${PORT}`;
const TMP     = fs.mkdtempSync(path.join(os.tmpdir(), 'eko_reimp_'));
const TMP_DB  = path.join(TMP, 'etiquetas.db');
const TMP_LOGS = path.join(TMP, 'logs');
const DIR_EPL = path.join(TMP_LOGS, 'print-simulado');

let servidor, passou = 0, falhou = 0;
function ok(cond, nome, detalhe) {
  if (cond) { passou++; console.log(`  \x1b[32m✓\x1b[0m ${nome}`); }
  else { falhou++; console.log(`  \x1b[31m✗ ${nome}\x1b[0m`, detalhe === undefined ? '' : JSON.stringify(detalhe).slice(0, 400)); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function req(metodo, caminho, corpo) {
  const r = await fetch(BASE + caminho, { method: metodo,
    headers: corpo ? { 'Content-Type': 'application/json' } : {}, body: corpo ? JSON.stringify(corpo) : undefined });
  let json = null; try { json = await r.json(); } catch (e) {}
  return { status: r.status, json };
}
async function subir() {
  servidor = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, EKO_PORT: String(PORT), EKO_PORT_CB: String(PORT_CB), EKO_PORT_HTTPS: String(PORT_HTTPS),
           EKO_DB_FILE: TMP_DB, EKO_LOG_DIR: TMP_LOGS, TZ: 'America/Sao_Paulo', EKO_PRINT_SIMULAR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  servidor.stdout.on('data', () => {});
  servidor.stderr.on('data', d => { if (process.env.VERBOSE) process.stderr.write(d); });
  for (let i = 0; i < 75; i++) {
    try { const r = await fetch(BASE + '/healthcheck'); if (r.ok) return; } catch (e) {}
    await sleep(200);
  }
  throw new Error('Servidor não subiu em 15s');
}
function encerrar() {
  try { servidor && servidor.kill('SIGKILL'); } catch (e) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
}
// Último EPL impresso que traz o texto.
function ultimoEpl(txt) {
  if (!fs.existsSync(DIR_EPL)) return null;
  const t = fs.readdirSync(DIR_EPL).sort().map(f => fs.readFileSync(path.join(DIR_EPL, f), 'latin1')).filter(x => x.includes(txt));
  return t.length ? t[t.length - 1] : null;
}
const dataDe = epl => { const m = epl && epl.match(/"DATA \/ HORA: ([^"]+)"/); return m ? m[1] : null; };

(async () => {
  try {
    await subir();
    const s = await req('POST', '/sessoes', { tipo: 'recebimento', operador: 'Recebedor', fornecedor: 'Piquiri' });
    const r = await req('POST', '/print/etiqueta', {
      clientToken: `reimp-${Date.now()}`, tipo: 'recebimento', materialKey: 'GBD', materialNomeEt: 'BAIXA DENSIDADE',
      cor: 'Canela', fornecedor: 'Piquiri', peso: 777.5, lote: '7788', codigo: 'CAN1', sku: 'GBD.CAN.PIQUIR',
      sessao_id: s.json && s.json.sessao_id });
    const id = r.json && (r.json.id || (r.json.etiqueta && r.json.etiqueta.id));
    ok(/^R\d{7}$/.test(id || ''), 'etiqueta de recebimento impressa', r.json);

    console.log('\nA) etiqueta nova: data de agora');
    const hoje = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const d1 = dataDe(ultimoEpl(`"${id}"`));
    ok(d1 && d1.startsWith(hoje), `data de hoje (${hoje})`, d1);

    console.log('\nB) reimprimir: data da pesagem');
    // A pesagem "foi" em 09/07/2026 11:30 de Brasília (14:30 UTC).
    const db = new DatabaseSync(TMP_DB);
    const st0 = db.prepare('SELECT status FROM etiquetas WHERE id = ?').get(id).status;
    db.prepare('UPDATE etiquetas SET hora_impressao = ? WHERE id = ?').run('2026-07-09T14:30:00.000Z', id);
    db.close();
    const antes = fs.existsSync(DIR_EPL) ? fs.readdirSync(DIR_EPL).length : 0;
    const re = await req('POST', `/etiquetas/${id}/reimprimir`);
    ok(re.status === 200 && re.json && re.json.reimpresso, 'reimpressão aceita', re);
    let epl = null;
    for (let i = 0; i < 25 && !epl; i++) {
      if (fs.readdirSync(DIR_EPL).length > antes) epl = ultimoEpl(`"${id}"`);
      if (!epl) await sleep(200);
    }
    ok(dataDe(epl) === '09/07/2026  11:30', 'reimpressa com a data da pesagem (09/07/2026 11:30)', dataDe(epl));
    ok(epl && epl.includes(`b`) && new RegExp(`^b\\d+,\\d+,Q,m2,s\\d+,"${id}"$`, 'm').test(epl), 'mesmo número no QR');
    ok(epl && new RegExp(`^B\\d+,\\d+,0,1,3,6,80,N,"${id}"$`, 'm').test(epl), 'mesmo número nas barras');
    const db2 = new DatabaseSync(TMP_DB);
    ok(db2.prepare('SELECT status FROM etiquetas WHERE id = ?').get(id).status === st0, 'status não mudou');
    db2.close();
  } catch (e) {
    falhou++; console.log('  \x1b[31m✗ erro\x1b[0m', e.message);
  } finally {
    encerrar();
    console.log(`\n RESULTADO: ${passou} passaram, ${falhou} falharam`);
    process.exit(falhou ? 1 : 0);
  }
})();
