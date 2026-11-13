// ════════════════════════════════════════════════════════════════════
//  OPERADORES DA EXTRUSÃO NO SERVIDOR  (13/11/2026, Gustavo: "pode,
//  coloca a lista no servidor")
//  ------------------------------------------------------------------
//  Até 13/11 a lista era só do navegador da tela; perfil novo depois da
//  queda de energia = extrusão sem nomes. O que este teste prova, num
//  servidor de teste com banco temporário:
//   1. banco que nunca mexeu na lista devolve os 5 de sempre
//   2. adicionar normaliza (maiúsculo, espaços) e grava
//   3. repetir o mesmo nome (até sem acento) não duplica
//   4. nome inválido (1 letra, HTML, não-texto) → 400 e nada muda
//   5. remover tira; remover quem não está → 404
//   6. a lista sobrevive a reiniciar o servidor (é do banco, não da tela)
//   7. lista esvaziada de propósito continua vazia (não volta o padrão)
//   8. config estragado volta a lista de sempre (não deixa a tela vazia)
//   9. a tela pede a lista ao servidor (não só ao localStorage)
// ════════════════════════════════════════════════════════════════════
const { spawn } = require('node:child_process');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const ROOT = path.join(__dirname, '..');
const PORT = 13960, PORT_CB = 18960, PORT_HTTPS = 14960;
const BASE = `http://localhost:${PORT}`;
const C = Date.now();
const TMP_DB   = path.join(os.tmpdir(), `eko_opx_${C}.db`);
const TMP_LOGS = path.join(os.tmpdir(), `eko_opx_${C}`);
const PADRAO = ['DAVI', 'MARLITO', 'WALLISON', 'ALEXANDRO', 'WILLIAN'];

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
const lista = async () => (await req('GET', '/extrusao/operadores')).body?.operadores;
const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  console.log('\n=== OPERADORES DA EXTRUSÃO NO SERVIDOR ===\n');
  if (!await subir()) { console.log('Servidor de teste não subiu.'); process.exit(1); }
  try {
    // 1
    let r = await req('GET', '/extrusao/operadores');
    ok(r.status === 200 && igual(r.body.operadores, PADRAO), 'banco novo: os 5 de sempre', r.body);

    // 2
    r = await req('POST', '/extrusao/operadores', { nome: '  joão   pedro ' });
    ok(r.status === 200 && r.body.nome === 'JOÃO PEDRO' && igual(r.body.operadores, [...PADRAO, 'JOÃO PEDRO']),
       'adicionar normaliza ("  joão   pedro " → JOÃO PEDRO) e vai para o fim', r.body);

    // 3
    r = await req('POST', '/extrusao/operadores', { nome: 'Joao Pedro' });
    ok(r.status === 200 && r.body.ja_existia === true && r.body.nome === 'JOÃO PEDRO' && (await lista()).length === 6,
       'repetir sem acento não duplica (devolve JOÃO PEDRO)', r.body);

    // 4
    for (const ruim of ['X', '<b>ZE</b>', "D'AVI", 12, null, '   ']) {
      r = await req('POST', '/extrusao/operadores', { nome: ruim });
      ok(r.status === 400, `nome inválido ${JSON.stringify(ruim)} → 400`, r);
    }
    ok((await lista()).length === 6, 'nenhum nome inválido entrou');

    // 5
    r = await req('POST', '/extrusao/operadores/remover', { nome: 'marlito' });
    ok(r.status === 200 && !r.body.operadores.includes('MARLITO') && r.body.operadores.length === 5,
       'remover "marlito" tira MARLITO', r.body);
    r = await req('POST', '/extrusao/operadores/remover', { nome: 'NINGUEM' });
    ok(r.status === 404, 'remover quem não está → 404', r);

    // 6
    const antes = await lista();
    await derrubar();
    if (!await subir()) throw new Error('servidor não voltou');
    ok(igual(await lista(), antes), 'depois de reiniciar o servidor a lista é a mesma (sem MARLITO, com JOÃO PEDRO)', await lista());

    // 7
    for (const n of antes) await req('POST', '/extrusao/operadores/remover', { nome: n });
    ok(igual(await lista(), []), 'lista esvaziada de propósito fica vazia (não volta o padrão)', await lista());

    // 7b: config estragado (não é JSON de lista) não pode deixar a tela sem nomes
    await req('POST', '/config', { operadores_extrusao: 'lixo{' });
    ok(igual(await lista(), PADRAO), 'config estragado → volta a lista de sempre, não lista vazia', await lista());

    // 8
    const html = fs.readFileSync(path.join(ROOT, 'public', 'etiqueta-producao.html'), 'utf8');
    ok(/fetch\(URL_BASE \+ '\/extrusao\/operadores'/.test(html) && /await carregarOperadores\(\)/.test(html),
       'a tela da extrusão busca a lista no servidor ao abrir');
  } catch (e) {
    ok(false, 'exceção no teste: ' + e.message);
  } finally {
    await derrubar();
    try { fs.rmSync(TMP_DB, { force: true }); fs.rmSync(TMP_LOGS, { recursive: true, force: true }); } catch (e) {}
  }
  console.log(`\n${passou} ok, ${falhou} falha(s)\n`);
  process.exit(falhou ? 1 : 0);
})();
