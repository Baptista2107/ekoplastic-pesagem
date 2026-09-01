// ════════════════════════════════════════════════════════════════════
//  TESTE DA JANELA SEGURA DE ATUALIZACAO REMOTA
//  Sobe o server.js REAL, cria sessao de Extrusao ABERTA (como na
//  fabrica 24h) e prova, ponto a ponto, que:
//    - nada e atualizado enquanto ha bobina esperando bipe
//    - nada e atualizado com sessao aberta SEM nenhuma bipada
//      (essa e' a que o limparSessoesOrfas() fecharia no reinicio)
//    - nada e atualizado logo apos movimento
//    - com a janela aberta, a sessao ATRAVESSA o reinicio inteira,
//      com todas as etiquetas bipadas preservadas
//
//  Rodar:  node testes/janela-atualizacao.js
// ════════════════════════════════════════════════════════════════════

const { spawn } = require('node:child_process');
const path   = require('node:path');
const fs     = require('node:fs');
const os     = require('node:os');
const sqlite = require('node:sqlite');

const ROOT   = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'server.js');
const PORT   = 13950;
const PORT_CB= 18950;
const BASE   = `http://localhost:${PORT}`;
const TMP_DB = path.join(os.tmpdir(), `eko_janela_${Date.now()}.db`);
const TMP_LOG= path.join(os.tmpdir(), `eko_janela_logs_${Date.now()}`);
const FLAG   = path.join(ROOT, 'eko-atualizar.flag');

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
  try { json = await r.json(); } catch(e) {}
  return { status: r.status, json };
}

async function subir() {
  // Se alguem ja responde nesta porta, e' sobra de uma rodada anterior:
  // o teste falaria com o servidor errado (banco ja apagado) e daria
  // erro sem sentido. Melhor parar e dizer o que houve.
  try {
    const r = await fetch(BASE + '/healthcheck');
    if (r.ok && !servidor) throw new Error(`Ja ha um servidor na porta ${PORT}. Feche-o antes de rodar o teste.`);
  } catch(e) { if (/Ja ha um servidor/.test(e.message)) throw e; }

  servidor = spawn('node', [SERVER], {
    env: { ...process.env,
      EKO_PORT: String(PORT), EKO_PORT_CB: String(PORT_CB),
      EKO_DB_FILE: TMP_DB, EKO_LOG_DIR: TMP_LOG, TZ: 'America/Sao_Paulo',
      // NUNCA imprimir de verdade (ver comentario em piso-testes.js)
      EKO_PRINT_SIMULAR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  servidor.stdout.on('data', () => {});
  servidor.stderr.on('data', d => { if (process.env.VERBOSE) process.stderr.write(d); });
  for (let i = 0; i < 75; i++) {
    try { const r = await fetch(BASE + '/healthcheck'); if (r.ok) return true; } catch(e) {}
    await sleep(200);
  }
  throw new Error('Servidor nao subiu em 15s');
}

function matar() { try { servidor && servidor.kill('SIGKILL'); } catch(e) {} }

function lerBanco(fn) {
  const db = new sqlite.DatabaseSync(TMP_DB, { readOnly: true });
  try { return fn(db); } finally { try { db.close(); } catch(e) {} }
}

// A limpeza de startup roda DEPOIS do healthcheck ja responder (ela vem
// no fim do callback do listen). Entao esperamos ela acontecer em vez de
// cravar um sleep fixo.
async function esperarBanco(fn, cond, ms = 8000) {
  const ate = Date.now() + ms;
  let v = null;
  for (;;) {
    v = lerBanco(fn);
    if (cond(v) || Date.now() > ate) return v;
    await sleep(200);
  }
}

function limpar() {
  matar();
  for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.rmSync(f, { force: true }); } catch(e) {} }
  try { fs.rmSync(TMP_LOG, { recursive: true, force: true }); } catch(e) {}
  try { fs.rmSync(FLAG, { force: true }); } catch(e) {}
}

async function imprimir(sid, i) {
  const r = await req('POST', '/etiquetas/extrusao', {
    clientToken: 'jan-' + i + '-' + Date.now(),
    sessao_id: sid, cor: 'Preta', tipo_bobina: 'LEVE', largura: '1,60',
    operador: 'WALLISON', maquina: 'C2', turno_codigo: 'EXT-A2',
    peso: 20 + i, peso_bruto: 28 + i, tara: 8,
  });
  return r.json && r.json.id;
}

(async () => {
  try { fs.rmSync(FLAG, { force: true }); } catch(e) {}

  console.log('\n═══════════════════════════════════════════════════');
  console.log(' JANELA SEGURA DE ATUALIZACAO — Ekoplastic');
  console.log('═══════════════════════════════════════════════════');

  await subir();
  await req('POST', '/config', { print_simular: '1', bling_simular: '1' });

  // ── 1. Sessao aberta SEM nenhuma etiqueta ──
  console.log('\n[1] Sessao de Extrusao aberta, ainda sem bobina nenhuma');
  const s = await req('POST', '/sessoes', { tipo: 'extrusao', operador: 'WALLISON', maquina: 'C2', turno_codigo: 'EXT-A2' });
  const sid = s.json && s.json.sessao_id;
  ok(!!sid, 'sessao de extrusao aberta');

  let r = await req('POST', '/sistema/atualizar', { senha: '1234' });
  ok(r.status === 409, 'atualizacao RECUSADA com sessao sem bipada', JSON.stringify(r.json));
  ok(r.json && r.json.janela && r.json.janela.regra === 'sessao_sem_bipada',
     'motivo e a sessao sem etiqueta viva (a que o startup fecharia)',
     JSON.stringify(r.json && r.json.janela && r.json.janela.regra));

  // ── 2. Bobina impressa esperando bipe ──
  console.log('\n[2] Bobina impressa, ainda nao bipada');
  const e1 = await imprimir(sid, 1);
  ok(!!e1, 'bobina 1 impressa');
  r = await req('POST', '/sistema/atualizar', { senha: '1234' });
  ok(r.status === 409, 'atualizacao RECUSADA com bobina esperando bipe');
  ok(r.json && r.json.janela && r.json.janela.regra === 'aguardando_bipe',
     'motivo e a bobina esperando bipe',
     JSON.stringify(r.json && r.json.janela && r.json.janela.regra));

  // ── 3. Senha errada nunca passa ──
  console.log('\n[3] Senha de supervisor');
  r = await req('POST', '/sistema/atualizar', { senha: '9999' });
  ok(r.status === 401, 'senha errada recusada com 401');

  // ── 4. Bipou: agora falta o silencio ──
  console.log('\n[4] Bobinas bipadas, mas a estacao acabou de se mexer');
  await req('POST', `/etiquetas/${e1}/bipar`);
  const e2 = await imprimir(sid, 2);
  await req('POST', `/etiquetas/${e2}/bipar`);
  r = await req('POST', '/sistema/atualizar', { senha: '1234' });
  ok(r.status === 409, 'atualizacao RECUSADA logo apos movimento');
  ok(r.json && r.json.janela && r.json.janela.regra === 'movimento',
     'motivo e o movimento recente',
     JSON.stringify(r.json && r.json.janela && r.json.janela.regra));

  // ── 5. Janela aberta: atualiza COM a sessao aberta ──
  console.log('\n[5] Silencio na estacao — a janela abre');
  // O servidor tem piso de 10s de silencio (Math.max(10, ...)), entao
  // pedir menos que isso nao adianta — esperamos os 10s de verdade.
  await req('POST', '/config', { atualizar_silencio_s: '10' });
  await sleep(11500);

  const saiu = new Promise(res => servidor.once('exit', c => res(c)));
  r = await req('POST', '/sistema/atualizar', { senha: '1234' });
  ok(r.status === 200 && r.json && r.json.ok === true, 'atualizacao ACEITA mesmo com sessao aberta', JSON.stringify(r.json));
  ok(r.json && r.json.sessoes_abertas === 1, 'a resposta diz que ha 1 sessao aberta preservada');
  ok(r.json && Array.isArray(r.json.sessoes_preservadas) && r.json.sessoes_preservadas[0] &&
     r.json.sessoes_preservadas[0].id === sid, 'a sessao preservada e a nossa');

  const cod = await Promise.race([saiu, sleep(6000).then(() => 'travou')]);
  ok(cod === 0, 'servidor encerrou sozinho para o INICIAR.bat aplicar o git', String(cod));
  ok(fs.existsSync(FLAG), 'bandeira eko-atualizar.flag gravada');
  try { fs.rmSync(FLAG, { force: true }); } catch(e) {}

  // ── 6. O reinicio nao pode perder nada ──
  console.log('\n[6] Reinicio: a sessao e as bipadas tem de sobreviver');
  const antes = lerBanco(db => ({
    fim: db.prepare('SELECT fim FROM sessoes WHERE id = ?').get(sid).fim,
    bipadas: db.prepare(`SELECT COUNT(*) AS n FROM etiquetas WHERE sessao_id = ? AND status = 'bipada'`).get(sid).n,
  }));
  ok(antes.fim === null, 'antes do reinicio a sessao esta aberta');
  ok(antes.bipadas === 2, 'antes do reinicio ha 2 bobinas bipadas', String(antes.bipadas));

  await subir();                      // e' o que o INICIAR.bat faz
  const leitura = db => ({
    fim: db.prepare('SELECT fim FROM sessoes WHERE id = ?').get(sid).fim,
    blingStatus: db.prepare('SELECT bling_status FROM sessoes WHERE id = ?').get(sid).bling_status,
    bipadas: db.prepare(`SELECT COUNT(*) AS n FROM etiquetas WHERE sessao_id = ? AND status = 'bipada'`).get(sid).n,
    total: db.prepare('SELECT COUNT(*) AS n FROM etiquetas WHERE sessao_id = ?').get(sid).n,
  });
  // espera a limpeza de startup passar (ela roda depois do healthcheck)
  await esperarBanco(leitura, () => false, 3000);
  const depois = lerBanco(leitura);
  ok(depois.fim === null, 'DEPOIS do reinicio a sessao continua ABERTA', JSON.stringify(depois));
  ok(depois.blingStatus !== 'cancelada', 'a sessao nao foi cancelada pela limpeza de startup', String(depois.blingStatus));
  ok(depois.bipadas === 2, 'as 2 bobinas bipadas continuam bipadas', String(depois.bipadas));
  ok(depois.total === 2, 'nenhuma etiqueta sumiu', String(depois.total));

  // ── 7. Controle negativo: prova que a regra 2 nao e' superstitcao ──
  console.log('\n[7] Controle negativo — sessao sem bipada NAO sobrevive a um reinicio');
  const s2 = await req('POST', '/sessoes', { tipo: 'produto-acabado', turno_codigo: 'A' });
  const sid2 = s2.json && s2.json.sessao_id;
  ok(!!sid2, 'segunda sessao aberta, sem nenhuma etiqueta');
  matar();
  await sleep(500);
  await subir();
  const dep2 = await esperarBanco(
    db => db.prepare('SELECT fim, bling_status FROM sessoes WHERE id = ?').get(sid2),
    v => v && v.fim !== null);
  ok(dep2.fim !== null, 'ela FOI fechada pela limpeza de startup — por isso a trava existe', JSON.stringify(dep2));
  const dep1 = lerBanco(db => db.prepare('SELECT fim FROM sessoes WHERE id = ?').get(sid));
  ok(dep1.fim === null, 'e a de Extrusao, com bipadas, seguiu aberta mesmo assim');

  console.log('\n═══════════════════════════════════════════════════');
  console.log(` RESULTADO: ${passou} passou, ${falhou} falhou`);
  if (falhas.length) { console.log(' Falhas:'); for (const f of falhas) console.log('   - ' + f); }
  console.log('═══════════════════════════════════════════════════\n');
  limpar();
  process.exit(falhou ? 1 : 0);
})().catch(e => {
  console.error('\nERRO NO TESTE:', e && e.stack || e);
  limpar();
  process.exit(1);
});
