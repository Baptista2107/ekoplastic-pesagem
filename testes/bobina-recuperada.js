// ════════════════════════════════════════════════════════════════════
//  BOBINA RECUPERADA  (21/10/2026, pedido do Vinicius)
//  ------------------------------------------------------------------
//  Bobina achada SEM etiqueta, de origem desconhecida: Outras pesagens →
//  BOBINA SEM ETIQUETA gera um número E novo (sub_tipo 'recuperada'), sem
//  operador, máquina, turno nem sessão — só para voltar ao estoque e poder
//  ir à sacoleira. Não é produção.
//
//  O que este teste prova, num servidor de teste com banco temporário:
//   1. sem senha de supervisor (ou com a errada) não cria nada
//   2. cor/espessura/largura fora do cadastro e peso absurdo são recusados
//   3. com a senha: etiqueta E, sub_tipo recuperada, 'bipada', sem
//      operador/máquina/turno/sessão, fornecedor RECUPERADA
//   4. repetir com o mesmo clientToken não gera 2ª etiqueta
//   5. a etiqueta impressa leva a tarja RECUPERADA e "SEM ORIGEM"
//   6. a recuperada monta numa sacoleira como qualquer bobina
// ════════════════════════════════════════════════════════════════════
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const os   = require('node:os');

const ROOT = path.join(__dirname, '..');
const PORT = 13945, PORT_CB = 18945, PORT_HTTPS = 14945;
const BASE = `http://localhost:${PORT}`;
const C = Date.now();
const TMP_DB   = path.join(os.tmpdir(), `eko_rec_${C}.db`);
const TMP_LOGS = path.join(os.tmpdir(), `eko_rec_${C}`);
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
const contar = () => comBanco(db => db.prepare(`SELECT COUNT(*) n FROM etiquetas WHERE sub_tipo = 'recuperada'`).get().n);

(async () => {
  console.log('\n=== BOBINA RECUPERADA ===\n');
  if (!await subir()) { console.log('Servidor de teste não subiu.'); process.exit(1); }
  try {
    const base = { cor: 'Colorida', tipo_bobina: 'LEVE', largura: '1,60', peso: 423.5 };

    // 1. senha
    let r = await req('POST', '/etiquetas/bobina-recuperada', base);
    ok(r.status === 403 && contar() === 0, 'sem senha de supervisor: recusado, nada criado', r.body);
    r = await req('POST', '/etiquetas/bobina-recuperada', { ...base, senha_supervisor: 'errada' });
    ok(r.status === 403 && contar() === 0, 'senha errada: recusado, nada criado', r.body);

    // 2. validação
    r = await req('POST', '/etiquetas/bobina-recuperada', { ...base, cor: 'Roxa', senha_supervisor: SENHA });
    ok(r.status === 400 && contar() === 0, 'cor fora do cadastro: recusado', r.body);
    r = await req('POST', '/etiquetas/bobina-recuperada', { ...base, peso: 5, senha_supervisor: SENHA });
    ok(r.status === 400 && contar() === 0, 'peso de 5 kg: recusado', r.body);
    r = await req('POST', '/etiquetas/bobina-recuperada', { ...base, peso: 9999, senha_supervisor: SENHA });
    ok(r.status === 400 && contar() === 0, 'peso de 9.999 kg: recusado', r.body);

    // 3. cria
    r = await req('POST', '/etiquetas/bobina-recuperada', { ...base, senha_supervisor: SENHA, clientToken: 'rec-t1' });
    ok(r.status === 200 && /^E\d{7}$/.test(r.body && r.body.id || ''), 'com a senha: etiqueta E criada', r.body);
    const id = r.body && r.body.id;
    const e = comBanco(db => db.prepare('SELECT * FROM etiquetas WHERE id = ?').get(id)) || {};
    ok(e.tipo === 'extrusao' && e.sub_tipo === 'recuperada' && e.status === 'bipada' && e.hora_bipagem,
       'extrusão, sub_tipo recuperada, já bipada (no estoque)', e);
    ok(!e.operador && !e.maquina && !e.turno_codigo && !e.sessao_id && e.fornecedor === 'RECUPERADA',
       'sem operador, máquina, turno e sessão — fora da produção', e);
    ok(e.peso === 423.5 && e.cor === 'Colorida' && e.tipo_bobina === 'LEVE' && e.largura === '1,60'
       && e.sku === 'BOB.COL.LEV.1,60', 'peso, cor, espessura, largura e SKU do cadastro', e);

    // 4. idempotência
    r = await req('POST', '/etiquetas/bobina-recuperada', { ...base, senha_supervisor: SENHA, clientToken: 'rec-t1' });
    ok(r.status === 200 && r.body.id === id && contar() === 1, 'mesmo clientToken: não gera 2ª etiqueta', r.body);

    // 5. a etiqueta (EPL) — reimpressão gera o MESMO layout
    // lib/impressao carrega lib/db: sem isto ele abriria o etiquetas.db padrão do clone
    process.env.EKO_DB_FILE = path.join(os.tmpdir(), `eko_rec_epl_${C}.db`);
    process.env.EKO_LOG_DIR = TMP_LOGS;
    const { gerarEPL } = require(path.join(ROOT, 'lib', 'impressao'));
    const epl = gerarEPL({ tipo: 'extrusao', sub_tipo: 'recuperada', seq: e.seq, cor: e.cor,
                           tipo_bobina: e.tipo_bobina, largura: e.largura, peso: e.peso });
    ok(epl.includes('RECUPERADA') && epl.includes('SEM ORIGEM') && epl.includes(id),
       'etiqueta com tarja RECUPERADA, "SEM ORIGEM" e o número');
    r = await req('POST', `/etiquetas/${id}/reimprimir`, {});
    ok(r.status === 200, 'reimprimir a recuperada funciona', r.body);

    // 6. monta na sacoleira
    r = await req('POST', '/bobinas/turno-corte/iniciar', { senha: SENHA, turno: 'A', maquinas: ['P1'], operador: 'SUP' });
    ok(r.status === 200, 'turno A aberto na P1', r.body);
    r = await req('POST', '/bobinas/baixa', { id, destino: 'P1' });
    const m = comBanco(db => db.prepare('SELECT status, destino FROM etiquetas WHERE id = ?').get(id)) || {};
    ok(r.status === 200 && m.status === 'consumida' && m.destino === 'P1', 'a recuperada monta na P1', { r: r.body, m });

    // 7. tela touch: peso da BALANÇA, o servidor tira o eixo pela largura (1,60 = 8 kg)
    r = await req('POST', '/etiquetas/bobina-recuperada', { cor: 'Colorida', tipo_bobina: 'LEVE', largura: '1,60',
                                                            peso_bruto: 431.5, senha_supervisor: SENHA, clientToken: 'rec-t2' });
    const e2 = comBanco(db => db.prepare('SELECT peso, peso_bruto FROM etiquetas WHERE id = ?').get(r.body && r.body.id)) || {};
    ok(r.status === 200 && e2.peso === 423.5, 'peso_bruto 431,5 na 1,60 → 423,5 kg líquido', { r: r.body, e2 });
    r = await req('POST', '/etiquetas/bobina-recuperada', { cor: 'Colorida', tipo_bobina: 'LEVE', largura: '1,60',
                                                            senha_supervisor: SENHA, clientToken: 'rec-t3' });
    ok(r.status === 400, 'sem peso nenhum: recusado', r.body);
  } catch (e) {
    ok(false, 'exceção no teste: ' + e.message);
  } finally {
    await derrubar();
  }
  console.log(`\n${passou} ok, ${falhou} falha(s)\n`);
  process.exit(falhou ? 1 : 0);
})();
