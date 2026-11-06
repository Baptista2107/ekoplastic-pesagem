// ════════════════════════════════════════════════════════════════════
//  ENVIO AO VIVO DO BAG DE MP (06/11/2026, Gustavo: pedido de retirada)
//  ------------------------------------------------------------------
//  O envio ao vivo à VPS (5 s) pega etiqueta por alterado_em. Antes só a
//  bobina carimbava; o bag de MP chegava pela cópia SFTP (até ~30 min).
//  Prova, num banco de mentira, que o GATILHO do banco carimba:
//    · etiqueta de MP nova (R, S, T) nasce com alterado_em;
//    · bag consumido (status muda) ganha carimbo NOVO;
//    · a consulta do envio ao vivo (alterados_desde) passa a trazer o bag;
//    · etiqueta de extrusão (bobina) NÃO é tocada pelo gatilho.
// ════════════════════════════════════════════════════════════════════
const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');

const C = Date.now();
const TMP_DB = path.join(os.tmpdir(), `eko_vivomp_${C}.db`);
process.env.EKO_DB_FILE = TMP_DB;
process.env.EKO_LOG_DIR = path.join(os.tmpdir(), `eko_vivomp_${C}`);

let passou = 0, falhou = 0;
function ok(cond, msg, extra) {
  if (cond) { passou++; console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
  else { falhou++; console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
         if (extra !== undefined) console.log('      →', JSON.stringify(extra).slice(0, 500)); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('\n▶ envio ao vivo do bag de MP (gatilho alterado_em)');
  const { db } = require(path.join(__dirname, '..', 'lib', 'db'));
  const ins = db.prepare(`INSERT INTO etiquetas (id, seq, tipo, material_key, fornecedor, lote, peso, codigo, sku, status, hora_impressao)
                          VALUES (?, ?, ?, 'GBD', 'Piquiri', '211026', ?, 'COL1', 'GBD.COL', 'bipada', ?)`);
  const t0 = new Date().toISOString();
  ins.run('R9000001', 9000001, 'recebimento', 1200, t0);
  ins.run('E9000001', 9000002, 'extrusao', 400, t0);
  const r1 = db.prepare(`SELECT alterado_em FROM etiquetas WHERE id='R9000001'`).get();
  const e1 = db.prepare(`SELECT alterado_em FROM etiquetas WHERE id='E9000001'`).get();
  ok(r1 && r1.alterado_em && r1.alterado_em >= t0.slice(0, 19), 'bag de entrada nasce carimbado', r1);
  ok(r1 && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(r1.alterado_em || ''), 'carimbo no mesmo formato do toISOString', r1);
  ok(e1 && e1.alterado_em == null, 'bobina (extrusão) não é tocada pelo gatilho', e1);

  await sleep(15);
  const marco = new Date().toISOString();
  await sleep(15);
  db.prepare(`UPDATE etiquetas SET status='consumida' WHERE id='R9000001'`).run();
  ins.run('S9000001', 9000003, 'retirada', 1200, new Date().toISOString());
  const r2 = db.prepare(`SELECT alterado_em FROM etiquetas WHERE id='R9000001'`).get();
  ok(r2.alterado_em > marco, 'bag consumido ganha carimbo novo', { marco, r2 });
  const vivos = db.prepare(`SELECT id FROM etiquetas WHERE alterado_em >= ? ORDER BY id`).all(marco).map(x => x.id);
  ok(vivos.includes('R9000001') && vivos.includes('S9000001'), 'o envio ao vivo (alterados_desde) leva a entrada consumida e a saída', vivos);
  ok(!vivos.includes('E9000001'), 'bobina parada não entra no envio por causa do gatilho', vivos);

  db.prepare(`UPDATE etiquetas SET impressora='X' WHERE id='S9000001'`).run();
  const s3 = db.prepare(`SELECT alterado_em FROM etiquetas WHERE id='S9000001'`).get();
  ok(!!s3.alterado_em, 'mudança de coluna fora da lista não apaga o carimbo', s3);

  try { db.close(); } catch (e) {}
  for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.unlinkSync(f); } catch (e) {} }
  console.log(`\n  ${passou} ok · ${falhou} falha(s)`);
  process.exit(falhou ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
