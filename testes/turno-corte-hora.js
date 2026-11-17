// ════════════════════════════════════════════════════════════════════
//  TURNO DO CORTE QUE PASSOU DA HORA  (17/11/2026, Gustavo)
//  ------------------------------------------------------------------
//  Em 17/11 o Turno C ficou aberto até 08:20, e as bobinas do A entraram
//  nele. Agora o coletor avisa (card piscando + aviso na bipagem) quando o
//  turno aberto passa da hora de fim (A 18h, EXTRA 22h, C 6h) com 15 min de
//  folga. Não fecha nada sozinho.
//
//  O que este teste prova:
//   1. a regra pura (lib/turno-corte-hora.js): fim de cada turno, virada da
//      meia-noite, folga de 15 min, turno fechado / desconhecido / início
//      ilegível sem aviso, e os encerramentos REAIS medidos de 05 a 17/11
//      sem aviso
//   2. no servidor real: GET /bobinas/turno-corte manda `atrasado` no turno C
//      aberto desde ontem às 22h e null no turno recém-aberto
//   3. a tela usa o `atrasado` (card e bipagem) — conferência do HTML
//
//  Como rodar:   node testes/turno-corte-hora.js
// ════════════════════════════════════════════════════════════════════
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

process.env.TZ = 'America/Sao_Paulo';   // antes do 1º Date: a regra é em hora local
const H = require('../lib/turno-corte-hora');

const ROOT = path.join(__dirname, '..');
const PORT = 13971, PORT_CB = 18971, PORT_HTTPS = 14971;
const BASE = `http://localhost:${PORT}`;
const C = Date.now();
const TMP_DB   = path.join(os.tmpdir(), `eko_tch_${C}.db`);
const TMP_LOGS = path.join(os.tmpdir(), `eko_tch_${C}`);
const SENHA = '1234';
let passou = 0, falhou = 0, servidor;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function ok(cond, msg, extra) {
  if (cond) { passou++; console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
  else { falhou++; console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
         if (extra !== undefined) console.log('      →', JSON.stringify(extra).slice(0, 400)); }
}
// hora local de São Paulo (-03:00) → ISO UTC, como o Mini PC grava
const L = s => new Date(s + '-03:00').toISOString();

function regraPura() {
  console.log('\n— 1. regra pura —');
  const fim = (t, ini) => { const f = H.fimPrevistoTurnoCorte(t, L(ini)); return f && f.toISOString(); };
  ok(fim('A', '2026-11-17T06:00:00') === L('2026-11-17T18:00:00'), 'A aberto às 06:00 acaba às 18:00 do mesmo dia');
  ok(fim('EXTRA', '2026-11-16T18:22:24') === L('2026-11-16T22:00:00'), 'EXTRA aberto às 18:22 acaba às 22:00');
  ok(fim('C', '2026-11-16T22:01:32') === L('2026-11-17T06:00:00'), 'C aberto às 22:01 acaba às 06:00 do DIA SEGUINTE');
  ok(fim('C', '2026-11-06T20:35:14') === L('2026-11-07T06:00:00'), 'C aberto cedo (20:35) também acaba às 06:00 seguinte');
  ok(fim('C', '2026-11-17T00:30:00') === L('2026-11-17T06:00:00'), 'C aberto depois da meia-noite acaba às 06:00 do MESMO dia');
  ok(H.fimPrevistoTurnoCorte('X', L('2026-11-17T06:00:00')) === null, 'turno desconhecido: sem hora de fim');
  ok(H.fimPrevistoTurnoCorte('A', 'lixo') === null && H.fimPrevistoTurnoCorte('A', null) === null,
     'início ilegível ou vazio: sem hora de fim');

  // O caso de 17/11: C aberto 16/11 22:01, ninguém encerrou.
  const c17 = { turno: 'C', inicio: L('2026-11-16T22:01:32'), fim: null };
  ok(H.turnoCorteAtrasado(c17, L('2026-11-17T06:14:00')) === null, 'C às 06:14 (14 min depois): ainda sem aviso (folga 15)');
  const a = H.turnoCorteAtrasado(c17, L('2026-11-17T06:15:00'));
  ok(a && a.minutos === 15 && a.fim_previsto === L('2026-11-17T06:00:00'), 'C às 06:15: AVISA, passou 15 min das 06:00', a);
  const a2 = H.turnoCorteAtrasado(c17, L('2026-11-17T08:20:00'));
  ok(a2 && a2.minutos === 140, 'C às 08:20 (a correção de 17/11): 140 min de atraso', a2);
  ok(H.turnoCorteAtrasado({ ...c17, fim: L('2026-11-17T08:20:00') }, L('2026-11-17T09:00:00')) === null,
     'turno já encerrado: nunca avisa');
  ok(H.turnoCorteAtrasado(null) === null && H.turnoCorteAtrasado({ turno: 'Z', inicio: c17.inicio }, L('2026-11-18T00:00:00')) === null,
     'sem turno ou turno desconhecido: sem aviso');
  ok(H.turnoCorteAtrasado({ turno: 'A', inicio: L('2026-11-17T06:00:00') }, L('2026-11-17T11:00:00')) === null,
     'A no meio do turno: sem aviso');

  // Encerramentos REAIS (turnos_corte da VPS, 05-17/11/2026): nenhum normal teria visto o aviso.
  const reais = [
    ['A', '2026-11-05T06:00:53', '2026-11-05T17:57:40'], ['A', '2026-11-10T05:59:11', '2026-11-10T17:55:25'],
    ['A', '2026-11-16T05:54:07', '2026-11-16T17:54:50'], ['A', '2026-11-13T05:59:58', '2026-11-13T16:01:19'],
    ['EXTRA', '2026-11-09T18:07:23', '2026-11-09T22:01:58'], ['EXTRA', '2026-11-12T18:24:39', '2026-11-12T21:59:33'],
    ['C', '2026-11-04T22:03:41', '2026-11-05T06:00:25'], ['C', '2026-11-06T20:35:14', '2026-11-07T06:04:18'],
    ['C', '2026-11-13T21:59:34', '2026-11-14T05:56:58'],
  ];
  const avisariam = reais.filter(([t, i, f]) => H.turnoCorteAtrasado({ turno: t, inicio: L(i), fim: null }, L(f)));
  ok(avisariam.length === 0, `os ${reais.length} encerramentos normais medidos não veem o aviso`, avisariam);
  ok(H.turnoCorteAtrasado({ turno: 'EXTRA', inicio: L('2026-11-11T18:11:47') }, L('2026-11-11T22:21:49')) !== null,
     'o EXTRA de 11/11 encerrado às 22:21 (o mais atrasado medido) veria o aviso');
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
function comBanco(fn) {
  const db = new DatabaseSync(TMP_DB);
  try { return fn(db); } finally { try { db.close(); } catch (e) {} }
}

async function noServidor() {
  console.log('\n— 2. GET /bobinas/turno-corte no servidor real —');
  if (!await subir()) { ok(false, 'servidor de teste subiu'); return; }
  try {
    let r = await req('POST', '/bobinas/turno-corte/iniciar', { senha: SENHA, turno: 'C', maquinas: ['P1'], operador: 'SUP' });
    ok(r.status === 200, 'turno C iniciado na P1', r.body);
    r = await req('POST', '/bobinas/turno-corte/iniciar', { senha: SENHA, turno: 'A', maquinas: ['P2'], operador: 'SUP' });
    ok(r.status === 200, 'turno A iniciado na P2', r.body);
    // O C da P1 passa a ter começado ONTEM às 22:00 (hora local): já passou das 06:00 de hoje.
    const ontem22 = new Date(); ontem22.setDate(ontem22.getDate() - 1); ontem22.setHours(22, 0, 0, 0);
    comBanco(db => db.prepare(`UPDATE turnos_corte SET inicio = ? WHERE maquina = 'P1' AND fim IS NULL`).run(ontem22.toISOString()));
    r = await req('GET', '/bobinas/turno-corte');
    const p1 = r.body.sacoleiras.find(s => s.sacoleira === 'P1').turno;
    const p2 = r.body.sacoleiras.find(s => s.sacoleira === 'P2').turno;
    const hoje6 = new Date(); hoje6.setHours(6, 0, 0, 0);
    const esperado = Date.now() - hoje6.getTime() >= 15 * 60000;   // depois das 06:15 de hoje
    ok(esperado ? (p1.atrasado && p1.atrasado.fim_previsto === hoje6.toISOString())
                : p1.atrasado === null, `C da P1 aberto desde ontem 22:00: atrasado ${esperado ? 'com fim 06:00 de hoje' : 'ainda null (antes das 06:15)'}`, p1);
    ok(p1.id && p1.turno === 'C' && p1.inicio === ontem22.toISOString(), 'o resto do turno segue igual na resposta', p1);
    // P2: A aberto agora. Só fica atrasado se o teste rodar depois das 18:15.
    const hoje18 = new Date(); hoje18.setHours(18, 15, 0, 0);
    ok(Date.now() >= hoje18.getTime() ? !!p2.atrasado : p2.atrasado === null, 'A da P2 recém-aberto: atrasado só depois das 18:15', p2);
    // Encerrado não aparece mais como turno aberto.
    r = await req('POST', '/bobinas/turno-corte/encerrar', { senha: SENHA, maquinas: ['P1'] });
    ok(r.status === 200, 'encerrar o C da P1 (sem bobina montada)', r.body);
    r = await req('GET', '/bobinas/turno-corte');
    ok(r.body.sacoleiras.find(s => s.sacoleira === 'P1').turno === null, 'depois de encerrar: P1 sem turno, sem aviso');
  } finally {
    try { servidor && servidor.kill('SIGKILL'); } catch (e) {}
    await sleep(700);
    for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.unlinkSync(f); } catch (e) {} }
    try { fs.rmSync(TMP_LOGS, { recursive: true, force: true }); } catch (e) {}
  }
}

function naTela() {
  console.log('\n— 3. a tela usa o atrasado —');
  const html = fs.readFileSync(path.join(ROOT, 'public', 'retirada-bobinas.html'), 'utf8');
  ok(/function avisoTurnoAtrasado\(\)/.test(html) && /s\.turno&&s\.turno\.atrasado/.test(html), 'avisoTurnoAtrasado lê o atrasado do servidor');
  ok(/\(atraso\?' atrasado':''\)/.test(html) && /\.tc\.atrasado\{[^}]*animation:tc-pisca/.test(html), 'card do turno fica vermelho piscando');
  ok(/ENCERRE O TURNO/.test(html), 'card diz ENCERRE O TURNO');
  ok(/avisoTurnoAtrasado\(\)\?'<div class="l-atraso">/.test(html), 'a bipagem mostra o aviso antes de escolher a sacoleira');
}

(async () => {
  console.log('\n=== TURNO DO CORTE QUE PASSOU DA HORA ===');
  regraPura();
  await noServidor();
  naTela();
  console.log(`\n  ${passou} passaram, ${falhou} falharam\n`);
  process.exit(falhou ? 1 : 0);
})();
