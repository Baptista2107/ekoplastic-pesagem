// ════════════════════════════════════════════════════════════════════
//  INVENTÁRIO → VPS COM O BAG A BAG (24/11/2026, Gustavo: "o relatório
//  não precisa de bag a bag, mas eu preciso dessa informação
//  internamente nos sistemas")
//  ------------------------------------------------------------------
//  O 🏁 Encerrar manda o PDF; o Mini PC repassa à VPS e, desde 24/11,
//  põe junto a contagem inteira (inventario_atual, com cada gaiola/bag
//  lido), porque o Encerrar zera a contagem logo depois. Prova, numa
//  VPS de mentira:
//    · a VPS recebe o PDF intacto + o inventário com as leituras;
//    · com a contagem vazia, o campo não vai (só o PDF);
//    · corpo que não é JSON é recusado aqui, sem chegar à VPS;
//    · a VPS recusando, o Mini PC devolve erro (o coletor não zera).
// ════════════════════════════════════════════════════════════════════
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');

const ROOT = path.join(__dirname, '..');
const PORT = 13991, PORT_CB = 18991;
const BASE = `http://localhost:${PORT}`;
const C = Date.now();
const TMP_DB   = path.join(os.tmpdir(), `eko_ie_${C}.db`);
const TMP_LOGS = path.join(os.tmpdir(), `eko_ie_${C}`);

let passou = 0, falhou = 0, servidor, vps, portaVps = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function ok(cond, msg, extra) {
  if (cond) { passou++; console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
  else { falhou++; console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
         if (extra !== undefined) console.log('      →', JSON.stringify(extra).slice(0, 700)); }
}
async function req(metodo, rota, corpo, cru) {
  const opc = { method: metodo, headers: {} };
  if (corpo !== undefined) { opc.body = cru ? corpo : JSON.stringify(corpo); opc.headers['Content-Type'] = 'application/json'; }
  const r = await fetch(BASE + rota, opc);
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, body: j };
}

// VPS de mentira: guarda o que chega no inventario-pdf e responde como a real.
const recebidos = [];
let vpsRecusa = false;
function subirVps() {
  return new Promise(resolve => {
    vps = http.createServer((r, res) => {
      let corpo = '';
      r.on('data', c => corpo += c);
      r.on('end', () => {
        res.writeHead(vpsRecusa ? 502 : 200, { 'Content-Type': 'application/json' });
        if (r.method === 'POST' && r.url === '/api/coletor/inventario-pdf') {
          let d = null; try { d = JSON.parse(corpo); } catch (e) {}
          recebidos.push(d);
          if (vpsRecusa) return res.end(JSON.stringify({ ok: false, erro: 'não consegui mandar a ninguém no Telegram' }));
          return res.end(JSON.stringify({ ok: true, enviados: ['Bruno Augusto', 'Vinicius'], falhas: [],
                                          guardado: 'x.pdf', detalhe: d && d.inventario ? 'x.json' : null }));
        }
        res.end(JSON.stringify({ ok: true }));
      });
    });
    vps.listen(0, '127.0.0.1', () => { portaVps = vps.address().port; resolve(); });
  });
}

async function subirServidor() {
  servidor = spawn('node', [path.join(ROOT, 'server.js')], {
    env: { ...process.env, EKO_PORT: String(PORT), EKO_PORT_CB: String(PORT_CB),
           EKO_DB_FILE: TMP_DB, EKO_LOG_DIR: TMP_LOGS,
           TZ: 'America/Sao_Paulo', EKO_PRINT_SIMULAR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  servidor.stdout.on('data', () => {});
  servidor.stderr.on('data', () => {});
  for (let i = 0; i < 75; i++) {
    try { const r = await fetch(BASE + '/healthcheck'); if (r.ok) return; } catch (e) {}
    await sleep(200);
  }
  throw new Error('servidor não subiu');
}

const PDF_B64 = Buffer.from('%PDF-1.4 inventario de teste').toString('base64');
const pedidoPdf = { pdf_b64: PDF_B64, nome: 'inventario-2026-11-24.pdf', titulo: 'Inventário de MP', resumo: '2 produtos' };

(async () => {
  try {
    console.log('\n═══════════════════════════════════════════════════');
    console.log(' INVENTÁRIO → VPS COM O BAG A BAG');
    console.log('═══════════════════════════════════════════════════\n');
    await subirVps();
    await subirServidor();
    await req('POST', '/config', { vps_sacoleiras_url: `http://127.0.0.1:${portaVps}/api/sacoleiras/agora` });

    console.log('[1] Contagem com 2 produtos: a VPS recebe o PDF e o bag a bag');
    await req('POST', '/inventario/salvar', { material: 'GBD', cor: 'Preto', fornecedor: 'Piquiri',
      materialNome: 'Grão Baixa Densidade', leituras: [{ id: 'R0000865', peso: 1156 }, { id: 'R0000862', peso: 1231 }],
      somaLeitura: 2387, saldoBling: 2387 });
    await req('POST', '/inventario/salvar', { material: 'PNY', cor: 'Leitoso', fornecedor: 'Tallpack',
      materialNome: 'Polinylon', leituras: [{ id: 'R0000900', peso: 18.5 }], somaLeitura: 18.5, saldoBling: 29.5 });
    const r1 = await req('POST', '/inventario/enviar-pdf', pedidoPdf);
    ok(r1.status === 200 && r1.body.ok, 'o Mini PC responde ok ao coletor', r1);
    const d1 = recebidos[recebidos.length - 1] || {};
    ok(d1.pdf_b64 === PDF_B64 && d1.nome === pedidoPdf.nome && d1.titulo === pedidoPdf.titulo,
       'o PDF chega à VPS intacto (mesmo base64, nome e título)', { nome: d1.nome });
    const itens = (d1.inventario && d1.inventario.itens) || [];
    ok(itens.length === 2, 'o inventário vai junto, com os 2 produtos', d1.inventario);
    const gbd = itens.find(i => i.material === 'GBD') || {};
    ok(JSON.stringify(gbd.leituras) === JSON.stringify([{ id: 'R0000865', peso: 1156 }, { id: 'R0000862', peso: 1231 }]),
       'cada bag lido vai com id e peso', gbd.leituras);
    const pny = itens.find(i => i.material === 'PNY') || {};
    ok(pny.divergencia === -11, 'a divergência calculada no Mini PC vai junto (−11 kg)', pny);

    console.log('\n[2] A VPS recusando: o Mini PC devolve erro (o coletor não zera)');
    vpsRecusa = true;
    const r2 = await req('POST', '/inventario/enviar-pdf', pedidoPdf);
    ok(r2.status === 502, 'erro 502 ao coletor', r2);
    vpsRecusa = false;

    console.log('\n[3] Corpo que não é JSON: recusado aqui, nada vai à VPS');
    const antes = recebidos.length;
    const r3 = await req('POST', '/inventario/enviar-pdf', 'isto não é json', true);
    ok(r3.status === 400, 'erro 400', r3);
    ok(recebidos.length === antes, 'a VPS não recebeu nada', recebidos.length - antes);

    console.log('\n[4] Contagem zerada: vai só o PDF, sem o campo inventario');
    await req('POST', '/inventario/limpar');
    const r4 = await req('POST', '/inventario/enviar-pdf', pedidoPdf);
    const d4 = recebidos[recebidos.length - 1] || {};
    ok(r4.status === 200 && d4.pdf_b64 === PDF_B64 && !('inventario' in d4), 'só o PDF, sem inventario', Object.keys(d4));
  } catch (e) {
    falhou++; console.log('  \x1b[31m✗\x1b[0m exceção:', e.stack || e.message);
  } finally {
    try { servidor && servidor.kill(); } catch (e) {}
    try { vps && vps.close(); } catch (e) {}
    await sleep(300);
    for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.unlinkSync(f); } catch (e) {} }
    try { fs.rmSync(TMP_LOGS, { recursive: true, force: true }); } catch (e) {}
    console.log(`\n ${passou} passaram, ${falhou} falharam\n`);
    process.exit(falhou ? 1 : 0);
  }
})();
