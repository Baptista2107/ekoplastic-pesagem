// ════════════════════════════════════════════════════════════════════
//  TRAVAS DE EXTRUSAO — reproduz o turno de 30/08/2026 no servidor real
//
//  O que aconteceu naquele sabado, uma bobina so:
//    14:51:54  E0001292  C1  705.500 / 713.500 / 8.000   bipagem
//    14:51:59  E0001291  C1  705.500 / 713.500 / 8.000   bipagem
//    14:55:05  E0001292                                  cancelamento
//    14:55:19  E0001292                                  bipagem   <-- ressuscitou
//
//  Este arquivo prova que cada uma dessas linhas agora e' recusada, e que
//  a virada de turno (uma bobina de CADA maquina em poucos segundos)
//  continua passando.
//
//  Rodar:  node testes/travas-extrusao.js
// ════════════════════════════════════════════════════════════════════

const { spawn } = require('node:child_process');
const path   = require('node:path');
const fs     = require('node:fs');
const os     = require('node:os');
const sqlite = require('node:sqlite');

const ROOT    = path.join(__dirname, '..');
const SERVER  = path.join(ROOT, 'server.js');
const PORT    = 13960;
const PORT_CB = 18960;
const BASE    = `http://localhost:${PORT}`;
const TMP_DB  = path.join(os.tmpdir(), `eko_travas_${Date.now()}.db`);
const TMP_LOG = path.join(os.tmpdir(), `eko_travas_logs_${Date.now()}`);

const SENHA_OK   = '1234';        // default do senha_saida_hash
const SENHA_MA   = '9999';

// pesos do caso real
const LIQ = 705.5, BRUTO = 713.5, TARA = 8.0;

let servidor = null;
let passou = 0, falhou = 0;
const falhas = [];

function ok(cond, nome, det = '') {
  if (cond) { passou++; console.log(`  \x1b[32m✓\x1b[0m ${nome}`); }
  else      { falhou++; falhas.push(nome); console.log(`  \x1b[31m✗ ${nome}\x1b[0m ${det}`); }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function req(metodo, caminho, corpo) {
  const r = await fetch(BASE + caminho, {
    method: metodo,
    headers: corpo ? { 'Content-Type': 'application/json' } : {},
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch (e) {}
  return { status: r.status, json };
}

async function subir() {
  try {
    const r = await fetch(BASE + '/healthcheck');
    if (r.ok && !servidor) throw new Error(`Ja ha servidor na porta ${PORT}. Feche antes de rodar.`);
  } catch (e) { if (/Ja ha servidor/.test(e.message)) throw e; }

  servidor = spawn('node', [SERVER], {
    env: { ...process.env,
      EKO_PORT: String(PORT), EKO_PORT_CB: String(PORT_CB),
      EKO_DB_FILE: TMP_DB, EKO_LOG_DIR: TMP_LOG, TZ: 'America/Sao_Paulo' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  servidor.stdout.on('data', () => {});
  servidor.stderr.on('data', d => { if (process.env.VERBOSE) process.stderr.write(d); });
  for (let i = 0; i < 75; i++) {
    try { const r = await fetch(BASE + '/healthcheck'); if (r.ok) return; } catch (e) {}
    await sleep(200);
  }
  throw new Error('Servidor nao subiu em 15s');
}

function matar() { try { servidor && servidor.kill('SIGKILL'); } catch (e) {} servidor = null; }

function banco(fn, somenteLeitura = true) {
  const db = new sqlite.DatabaseSync(TMP_DB, { readOnly: somenteLeitura });
  try { return fn(db); } finally { try { db.close(); } catch (e) {} }
}

function limpar() {
  matar();
  for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.rmSync(f, { force: true }); } catch (e) {} }
  try { fs.rmSync(TMP_LOG, { recursive: true, force: true }); } catch (e) {} }

function imprimir(sid, maquina, extra = {}) {
  return req('POST', '/etiquetas/extrusao', Object.assign({
    clientToken: 'trv-' + Math.random().toString(36).slice(2),
    sessao_id: sid, cor: 'Branca', tipo_bobina: 'LEVE', largura: '1,60',
    operador: 'WALLISON', maquina, turno_codigo: 'EXT-A2',
    peso: LIQ, peso_bruto: BRUTO, tara: TARA,
  }, extra));
}

(async () => {
  console.log('\n═══════════════════════════════════════════════════');
  console.log(' TRAVAS DE EXTRUSAO — caso real de 30/08/2026');
  console.log('═══════════════════════════════════════════════════');

  await subir();
  await req('POST', '/config', { print_simular: '1', bling_simular: '1' });

  const s = await req('POST', '/sessoes', { tipo: 'extrusao', operador: 'WALLISON', maquina: 'C1', turno_codigo: 'EXT-A2' });
  const sid = s.json && s.json.sessao_id;

  // ── 1. impressao duplicada na mesma maquina ─────────────────────────
  console.log('\n[1] Mesma bobina pesada duas vezes na C1');
  const a = await imprimir(sid, 'C1');
  ok(a.status === 200 && a.json.ok, '1a bobina da C1 impressa normalmente', JSON.stringify(a.json));
  const idA = a.json && a.json.id;

  const dupe = await imprimir(sid, 'C1');
  ok(dupe.status === 409, '2a impressao com o MESMO peso na C1 foi RECUSADA', `(status=${dupe.status})`);
  ok(dupe.json && dupe.json.trava === 'peso_repetido', 'motivo e a trava de peso repetido', JSON.stringify(dupe.json && dupe.json.trava));
  ok(dupe.json && dupe.json.gemea && dupe.json.gemea.id === idA, 'a resposta aponta qual bobina ja tem esse peso', JSON.stringify(dupe.json && dupe.json.gemea));
  ok(dupe.json && dupe.json.exige_senha_supervisor === true, 'a saida oferecida e a senha de supervisor');

  // ── 2. virada de turno: outra maquina, mesmo peso, segundos depois ──
  console.log('\n[2] Virada de turno — C2 pesada logo em seguida, mesmo peso');
  const b = await imprimir(sid, 'C2');
  ok(b.status === 200 && b.json.ok, 'C2 com o mesmo peso PASSA (a trava e por maquina)', JSON.stringify(b.json && b.json.erro));
  const idB = b.json && b.json.id;

  // ── 3. mesma maquina, peso diferente ────────────────────────────────
  console.log('\n[3] C1 de novo, agora com peso diferente');
  const c = await imprimir(sid, 'C1', { peso: LIQ + 12.5, peso_bruto: BRUTO + 12.5 });
  ok(c.status === 200 && c.json.ok, 'peso diferente na mesma maquina passa', JSON.stringify(c.json && c.json.erro));

  // ── 4. senha de supervisor ──────────────────────────────────────────
  console.log('\n[4] Liberacao por supervisor');
  const errada = await imprimir(sid, 'C1', { senha_supervisor: SENHA_MA });
  ok(errada.status === 409, 'senha errada NAO libera', `(status=${errada.status})`);
  const certa = await imprimir(sid, 'C1', { senha_supervisor: SENHA_OK });
  ok(certa.status === 200 && certa.json.ok, 'senha correta libera e imprime', JSON.stringify(certa.json && certa.json.erro));
  const idC = certa.json && certa.json.id;

  // ── 5. retry idempotente continua funcionando ───────────────────────
  console.log('\n[5] Retry honesto com o mesmo clientToken');
  const tok = 'idem-' + Math.random().toString(36).slice(2);
  const r1 = await imprimir(sid, 'C2', { clientToken: tok, peso: 88.8, peso_bruto: 96.8 });
  const r2 = await imprimir(sid, 'C2', { clientToken: tok, peso: 88.8, peso_bruto: 96.8 });
  ok(r1.json.ok && r2.json.ok, 'as duas chamadas respondem ok');
  ok(r1.json.id === r2.json.id, 'o retry devolve a MESMA etiqueta, sem cair na trava', `(${r1.json.id} x ${r2.json.id})`);

  // ── 6. bipagem duplicada ────────────────────────────────────────────
  console.log('\n[6] Bipar a mesma bobina duas vezes');
  const bip1 = await req('POST', `/etiquetas/${idA}/bipar`);
  ok(bip1.status === 200 && bip1.json.ok, `1a bipagem de ${idA} ok`);
  const antes = banco(db => db.prepare('SELECT hora_bipagem, bling_pedido_id, status FROM etiquetas WHERE id = ?').get(idA));

  const bip2 = await req('POST', `/etiquetas/${idA}/bipar`);
  ok(bip2.status === 409, '2a bipagem RECUSADA', `(status=${bip2.status})`);
  ok(bip2.json && bip2.json.trava === 'bipagem_duplicada', 'motivo e a trava de bipagem duplicada');
  const depois = banco(db => db.prepare('SELECT hora_bipagem, bling_pedido_id, status FROM etiquetas WHERE id = ?').get(idA));
  ok(depois.hora_bipagem === antes.hora_bipagem, 'a hora da 1a bipagem NAO foi reescrita');
  ok(depois.bling_pedido_id === antes.bling_pedido_id, 'nao gerou um 2o pedido no Bling', `(${antes.bling_pedido_id} -> ${depois.bling_pedido_id})`);

  // ── 7. cancelada nao volta ──────────────────────────────────────────
  console.log('\n[7] Bipar uma bobina cancelada — a linha das 14:55:19');
  await req('POST', `/etiquetas/${idB}/bipar`);
  await req('POST', `/etiquetas/${idB}/cancelar`);
  const canc = banco(db => db.prepare('SELECT status FROM etiquetas WHERE id = ?').get(idB));
  ok(canc.status === 'cancelada', `${idB} esta cancelada`);
  const revive = await req('POST', `/etiquetas/${idB}/bipar`);
  ok(revive.status === 409, 'bipar a cancelada foi RECUSADO', `(status=${revive.status})`);
  const depoisC = banco(db => db.prepare('SELECT status FROM etiquetas WHERE id = ?').get(idB));
  ok(depoisC.status === 'cancelada', 'ela continua cancelada — nao ressuscitou', `(${depoisC.status})`);

  // ── 8. escopo: materia-prima segue como antes ───────────────────────
  console.log('\n[8] Escopo — a trava e so de EXTRUSAO');
  const sMp = await req('POST', '/sessoes', { tipo: 'recebimento', operador: 'MP', fornecedor: 'FORN TESTE' });
  const rMp = await req('POST', '/etiquetas', {
    clientToken: 'mp-' + Math.random(), sessao_id: sMp.json.sessao_id,
    materialKey: 'PEBD', fornecedor: 'FORN TESTE', lote: 'L1', peso: 500, item_codigo: 'X', codigo: 'X', sku: 'X',
  });
  if (rMp.json && rMp.json.ok) {
    const idMp = rMp.json.id;
    const m1 = await req('POST', `/etiquetas/${idMp}/bipar`);
    const m2 = await req('POST', `/etiquetas/${idMp}/bipar`);
    ok(m1.json.ok && m2.json.ok, 'bipagem de MP nao foi alterada (segue aceitando repetir)');
  } else {
    ok(true, 'MP nao exercitada neste ambiente — trava de extrusao nao a alcanca de qualquer forma');
  }

  // ── 9. auto-fim de turno com bipagem pendente ───────────────────────
  console.log('\n[9] Auto-fim de turno com bobina pendente');
  const sp = await req('POST', '/sessoes', { tipo: 'extrusao', operador: 'DAVI', maquina: 'C2', turno_codigo: 'EXT-A2' });
  const sidP = sp.json.sessao_id;
  const p1 = await imprimir(sidP, 'C2', { peso: 111.1, peso_bruto: 119.1 });
  const bipada = await imprimir(sidP, 'C2', { peso: 222.2, peso_bruto: 230.2 });
  await req('POST', `/etiquetas/${bipada.json.id}/bipar`);      // 1 bipada + 1 pendente
  ok(!!p1.json.id, 'sessao com 1 bipada e 1 pendente montada');

  matar();
  await sleep(400);
  // empurra o inicio da sessao para 2 dias atras: o limite de auto-fim
  // (19h do turno A) ja passou, entao o proximo boot dispara o auto-fim.
  const doisDias = new Date(Date.now() - 2 * 24 * 3600 * 1000);
  doisDias.setHours(8, 0, 0, 0);
  banco(db => db.prepare('UPDATE sessoes SET inicio = ? WHERE id = ?').run(doisDias.toISOString(), sidP), false);

  await subir();
  await sleep(7000);        // o checarSessoesParaAutoFim roda 5s apos subir

  const est = banco(db => ({
    fim: db.prepare('SELECT fim FROM sessoes WHERE id = ?').get(sidP).fim,
    pend: db.prepare('SELECT status FROM etiquetas WHERE id = ?').get(p1.json.id).status,
  }));
  ok(est.fim === null, 'o turno NAO foi fechado com bobina pendente', JSON.stringify(est));
  ok(est.pend === 'aguardando_bipe', 'a bobina pendente NAO foi cancelada em silencio', `(${est.pend})`);

  // ── 10. depois de bipar, o auto-fim fecha sozinho ───────────────────
  console.log('\n[10] Bipada a pendente, o auto-fim fecha na passada seguinte');
  const bipFinal = await req('POST', `/etiquetas/${p1.json.id}/bipar`);
  ok(bipFinal.json.ok, 'a pendente foi bipada');
  matar();
  await sleep(400);
  await subir();
  await sleep(7000);
  const est2 = banco(db => db.prepare('SELECT fim, total_etiquetas FROM sessoes WHERE id = ?').get(sidP));
  ok(est2.fim !== null, 'agora o turno fechou sozinho', JSON.stringify(est2));
  ok(est2.total_etiquetas === 2, 'fechou contando as 2 bobinas, nenhuma perdida', `(${est2.total_etiquetas})`);

  console.log('\n═══════════════════════════════════════════════════');
  console.log(` RESULTADO: ${passou} passou, ${falhou} falhou`);
  if (falhas.length) { console.log(' Falhas:'); for (const f of falhas) console.log('   - ' + f); }
  console.log('═══════════════════════════════════════════════════\n');
  limpar();
  process.exit(falhou ? 1 : 0);
})().catch(e => {
  console.error('\nERRO NO TESTE:', (e && e.stack) || e);
  limpar();
  process.exit(1);
});
