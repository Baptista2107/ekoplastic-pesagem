// ════════════════════════════════════════════════════════════════════
//  SOLTOS SÓ PASSAM PARA BOBINA DA MESMA COR E FORMATO  (09/10/2026, Gustavo)
//  ------------------------------------------------------------------
//  "Não pode aproveitar pacotes de tamanhos diferentes e cores diferentes
//  para a próxima bobina" — "só não pode aproveitar 30x45 no 50x60".
//  Os soltos seguem na produção da bobina que os fez; a seguinte, de outra
//  cor ou formato, não os desconta.
//
//  O que este teste prova, num servidor de teste com banco temporário:
//   1. mesma cor e formato: a seguinte desconta os soltos (como antes)
//   2. outra COR: a seguinte não desconta
//   3. outro FORMATO: a seguinte não desconta
//   4. a tela (/bobinas/abertas) mostra soltos_inicio 0 quando a cor muda
//   5. HISTÓRICO: num banco antigo, a parte que descontou soltos de outra
//      cor recebe de volta (parte + total da etiqueta, editado_em marcado);
//      a da mesma cor fica igual; e roda uma vez só
// ════════════════════════════════════════════════════════════════════
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const os   = require('node:os');

const ROOT = path.join(__dirname, '..');
const PORT = 13931, PORT_CB = 18931, PORT_HTTPS = 14931;
const BASE = `http://localhost:${PORT}`;
const C = Date.now();
const TMP_LOGS = path.join(os.tmpdir(), `eko_scf_${C}`);
const SENHA = '1234';
let TMP_DB = path.join(os.tmpdir(), `eko_scf_${C}.db`);

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
           EKO_DB_FILE: TMP_DB, EKO_LOG_DIR: TMP_LOGS, TZ: 'America/Sao_Paulo', EKO_PRINT_SIMULAR: '1' },
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
function criarBobina(db, id, seq, cor) {
  db.prepare(`INSERT INTO etiquetas (id, seq, tipo, material_key, fornecedor, lote, peso, codigo, sku, status,
                                     hora_impressao, cor, largura, tipo_bobina, maquina, operador)
              VALUES (?, ?, 'extrusao', 'BOBINA', '-', '-', 400, ?, 'BOB-TESTE', 'bipada', ?, ?, '1,60', 'LISA', 'E1', 'TESTE')`)
    .run(id, seq, id, new Date().toISOString(), cor);
}
const pacotesDe = id => comBanco(db => db.prepare('SELECT pacotes FROM etiquetas WHERE id = ?').get(id).pacotes);

(async () => {
  console.log('\n=== SOLTOS SÓ PARA A MESMA COR E FORMATO ===\n');
  if (!await subir()) { console.log('Servidor de teste não subiu.'); process.exit(1); }
  try {
    comBanco(db => {
      criarBobina(db, 'E9910001', 9910001, 'BRANCO'); criarBobina(db, 'E9910002', 9910002, 'BRANCO');
      criarBobina(db, 'E9910003', 9910003, 'AZUL');   criarBobina(db, 'E9910004', 9910004, 'AZUL');
    });
    let r = await req('POST', '/bobinas/turno-corte/iniciar', { senha: SENHA, turno: 'A', maquinas: ['P1'], operador: 'SUP' });
    ok(r.status === 200, 'turno A na P1', r.body);

    // 1. BRANCO 50x60 → BRANCO 50x60: aproveita
    await req('POST', '/bobinas/baixa', { id: 'E9910001', destino: 'P1', operador: 'OP' });
    r = await req('POST', '/bobinas/baixa', { id: 'E9910002', destino: 'P1', operador: 'OP',
                                             fardos_anterior: 3, soltos_anterior: 2, formato_anterior: '50x60' });
    ok(r.status === 200 && pacotesDe('E9910001') === 17, '1ª bobina: 3 fardos + 2 soltos = 17 pc', pacotesDe('E9910001'));
    // 2ª fecha o fardo misto e mais 3 = 4 fechados, 1 solto, MESMO formato → 4×5 + 1 − 2 = 19
    r = await req('POST', '/bobinas/baixa', { id: 'E9910003', destino: 'P1', operador: 'OP',
                                             fardos_anterior: 4, soltos_anterior: 1, formato_anterior: '50x60' });
    ok(r.status === 200 && pacotesDe('E9910002') === 19, 'mesma cor e formato: desconta os 2 soltos (20 + 1 − 2 = 19)',
       pacotesDe('E9910002'));

    // 4. tela: a montada agora é AZUL, a anterior BRANCO → soltos_inicio 0
    r = await req('GET', '/bobinas/abertas');
    const p1 = r.body.sacoleiras.find(s => s.sacoleira === 'P1');
    ok(p1.bobina && p1.bobina.id === 'E9910003' && p1.bobina.soltos_inicio === 0,
       'a tela mostra 0 solto no início para a bobina de outra cor', p1.bobina);

    // 2. BRANCO → AZUL: não aproveita → 2 fechados + 4 soltos = 14
    r = await req('POST', '/bobinas/baixa', { id: 'E9910004', destino: 'P1', operador: 'OP',
                                             fardos_anterior: 2, soltos_anterior: 4, formato_anterior: '50x60' });
    ok(r.status === 200 && pacotesDe('E9910003') === 14, 'outra cor: não desconta o solto da branca (2×5 + 4 = 14)',
       pacotesDe('E9910003'));

    // 3. AZUL 50x60 → AZUL 40x50: não aproveita → 3 fechados + 0 = 15
    r = await req('POST', '/bobinas/finalizar', { sacoleira: 'P1', fardos: 3, soltos: 0, formato: '40x50', operador: 'OP' });
    ok(r.status === 200 && pacotesDe('E9910004') === 15, 'outro formato: não desconta os 4 soltos (3×5 = 15)',
       { status: r.status, body: r.body, pacotes: pacotesDe('E9910004') });
  } finally { await derrubar(); }

  // 5. HISTÓRICO num banco "antigo": sobe uma vez para criar o schema, apaga a
  // marca da correção, grava partes como a regra antiga gravava e sobe de novo.
  TMP_DB = path.join(os.tmpdir(), `eko_scf_hist_${C}.db`);
  if (!await subir()) { console.log('Servidor de teste (histórico) não subiu.'); process.exit(1); }
  await derrubar();
  comBanco(db => {
    criarBobina(db, 'E9920001', 9920001, 'BRANCO'); criarBobina(db, 'E9920002', 9920002, 'AZUL');
    criarBobina(db, 'E9920003', 9920003, 'AZUL');
    const fim = new Date().toISOString();
    db.prepare(`UPDATE etiquetas SET encerrada_em = ?, encerrada_motivo = 'troca' WHERE id LIKE 'E99200%'`).run(fim);
    db.prepare(`UPDATE etiquetas SET pacotes = 17, fardos = 3 WHERE id = 'E9920001'`).run();
    db.prepare(`UPDATE etiquetas SET pacotes = 22, fardos = 4 WHERE id = 'E9920002'`).run();   // 4×5+4−2: descontou errado
    db.prepare(`UPDATE etiquetas SET pacotes = 11, fardos = 2 WHERE id = 'E9920003'`).run();   // 3×5+0−4: mesma cor/formato
    const ins = db.prepare(`INSERT INTO bobina_parciais (etiqueta_id, maquina, fardos, pacotes, soltos_fim, formato, momento, registrado_em)
                            VALUES (?, 'P2', ?, ?, ?, '30x45', 'final', ?)`);
    ins.run('E9920001', 3, 17, 2, fim); ins.run('E9920002', 4, 22, 4, fim); ins.run('E9920003', 3, 11, 0, fim);
    db.prepare(`DELETE FROM config WHERE chave = 'soltos_cor_formato_v1'`).run();
  });
  if (!await subir()) { console.log('Servidor de teste (histórico 2) não subiu.'); process.exit(1); }
  try {
    const pa = comBanco(db => db.prepare(`SELECT etiqueta_id, pacotes, editado_em FROM bobina_parciais ORDER BY id`).all());
    const p2 = pa.find(p => p.etiqueta_id === 'E9920002'), p3 = pa.find(p => p.etiqueta_id === 'E9920003');
    ok(p2.pacotes === 24 && p2.editado_em, 'histórico: a azul depois da branca recebe os 2 soltos de volta (22 → 24)', p2);
    ok(pacotesDe('E9920002') === 24, 'e o total da etiqueta também (22 → 24)', pacotesDe('E9920002'));
    ok(p3.pacotes === 11 && !p3.editado_em, 'a azul depois da azul (mesmo formato) fica igual (11)', p3);
  } finally { await derrubar(); }
  // roda uma vez só: subir de novo não soma outra vez
  if (!await subir()) { console.log('Servidor de teste (histórico 3) não subiu.'); process.exit(1); }
  try {
    ok(pacotesDe('E9920002') === 24, 'subir de novo não corrige duas vezes (continua 24)', pacotesDe('E9920002'));
  } finally { await derrubar(); }

  console.log(`\n${passou} ok, ${falhou} falha(s)\n`);
  process.exit(falhou ? 1 : 0);
})();
