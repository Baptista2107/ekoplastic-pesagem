// ════════════════════════════════════════════════════════════════════
//  BOBINA ALTA DENSIDADE - MILHEIRO em OUTRAS PESAGENS (24/11/2026)
//  ------------------------------------------------------------------
//  Vinicius: o card RESÍDUOS vira OUTRAS PESAGENS e ganha a bobina de alta
//  densidade, comprada pronta da IKATUPLAST (contato Bling 18539284560),
//  sem operador, para a sacola de milheiro. Variações (pai 16739752334):
//    BOB.VER.1,52 16739758321 · BOB.PT.1,52 16739758326  → sacola 38 x 48
//    BOB.VER.1,16 16739758324 · BOB.PT.1,16 16739758328  → sacola 29 x 39
//  O fornecedor NÃO sai na etiqueta; a etiqueta diz para qual sacola serve.
//
//   [1] Etiqueta da bobina: "BOBINA ALTA DENSIDADE", cor/largura, "SACOLA
//       38 X 48 - MILHEIRO" (ou 29 X 39), sem IKATUPLAST.
//   [2] Pedido de COMPRA com fornecedor IKATUPLAST e o id da VARIAÇÃO.
//   [3] Na mesma pesagem não entra apara/resíduo (409) e vice-versa;
//       etiqueta cancelada não conta.
//   [4] Borra continua indo com a EKOPLASTIC.
//   [5] Sessão misturada à mão no banco: o envio para com erro e não manda
//       pedido nenhum (a bobina não vira compra da EKOPLASTIC).
//   [1b] Tubete descontado pelo servidor: 1,52 → 3,3 kg; 1,16 → 2,5 kg; mínimo 20 kg
//        líquidos; peso_bruto não leva desconto duplo; repetição devolve o gravado.
//  [11] tubete e mínimo da tela iguais aos do servidor.
//   [6] Nada de palavra de resíduo na observação (a VPS leria como resíduo).
//   [7] Apara (sem produto no Bling) misturada também para o envio.
//   [8] Etiqueta O excluída não volta a 'bipada' pelo leitor.
//   [9] Texto largo da etiqueta da bobina cabe em 800 dots.
//  [10] celular.css não fica preso a um data-tela que não existe mais.
//
//  Como rodar:   node testes/bobina-alta-densidade.js
// ════════════════════════════════════════════════════════════════════
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const http = require('node:http');
const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');

const ROOT = path.join(__dirname, '..');
const PORT = 13997, PORT_CB = 18997;
const BASE = `http://localhost:${PORT}`;
const C = Date.now();
const DB1  = path.join(os.tmpdir(), `eko_bad_${C}.db`);
const LOGS = path.join(os.tmpdir(), `eko_bad_${C}`);
const TOK  = path.join(os.tmpdir(), `eko_bad_tok_${C}.json`);
const DIR_EPL = path.join(LOGS, 'print-simulado');

const ID_EKO        = 17804838271;
const ID_IKATUPLAST = 18539284560;

let passou = 0, falhou = 0, servidor = null, fake, portaFake = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function ok(cond, msg, extra) {
  if (cond) { passou++; console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
  else { falhou++; console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
         if (extra !== undefined) console.log('      →', JSON.stringify(extra).slice(0, 600)); }
}
async function req(metodo, rota, corpo) {
  const opc = { method: metodo, headers: {} };
  if (corpo !== undefined) { opc.body = JSON.stringify(corpo); opc.headers['Content-Type'] = 'application/json'; }
  const r = await fetch(BASE + rota, opc);
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, body: j };
}
function comBanco(fn) { const db = new DatabaseSync(DB1); try { return fn(db); } finally { db.close(); } }

// EPL da etiqueta impressa (impressão simulada grava cada job em arquivo).
function eplDe(id) {
  if (!fs.existsSync(DIR_EPL)) return '';
  return fs.readdirSync(DIR_EPL).map(f => fs.readFileSync(path.join(DIR_EPL, f), 'latin1'))
    .find(t => t.includes(`B210,760,0,1,3,8,110,N,"${id}"`)) || '';
}

// Bling de mentira: registra os pedidos para conferir o que foi mandado.
const pedidos = [];
function subirFake() {
  return new Promise(resolve => {
    fake = http.createServer((r, res) => {
      let corpo = '';
      r.on('data', c => corpo += c);
      r.on('end', () => {
        const responder = (st, obj) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
        if (r.url.startsWith('/Api/v3/oauth/token'))
          return responder(200, { access_token: 'tok', refresh_token: 'refresh-fake', expires_in: 21600 });
        if (r.method === 'POST' && r.url.startsWith('/Api/v3/pedidos/')) {
          let b = {}; try { b = JSON.parse(corpo); } catch (e) {}
          pedidos.push({ rota: r.url, corpo: b });
          return responder(201, { data: { id: 900000 + pedidos.length } });
        }
        return responder(200, { data: [] });
      });
    });
    fake.listen(0, '127.0.0.1', () => { portaFake = fake.address().port; resolve(); });
  });
}
async function subir() {
  fs.writeFileSync(TOK, JSON.stringify({ accessToken: 'tok', refreshToken: 'refresh-fake', expiresAt: Date.now() + 3600e3 }));
  servidor = spawn('node', [path.join(ROOT, 'server.js')], {
    env: { ...process.env, EKO_PORT: String(PORT), EKO_PORT_CB: String(PORT_CB),
           EKO_DB_FILE: DB1, EKO_LOG_DIR: LOGS, EKO_TOKEN_FILE: TOK,
           TZ: 'America/Sao_Paulo', EKO_PRINT_SIMULAR: '1', EKO_BLING_INSEGURO: '1',
           BLING_CLIENT_ID: 'id-teste', BLING_CLIENT_SECRET: 'segredo-teste' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  servidor.stdout.on('data', () => {}); servidor.stderr.on('data', () => {});
  for (let i = 0; i < 75; i++) {
    try { const r = await fetch(BASE + '/healthcheck'); if (r.ok) return; } catch (e) {}
    await sleep(200);
  }
  throw new Error('servidor não subiu');
}
async function derrubar() {
  if (!servidor) return;
  const p = servidor; servidor = null;
  await new Promise(r => { p.once('exit', r); p.kill('SIGKILL'); setTimeout(r, 3000); });
}

let tok = 0;
async function pesar(sid, item, peso) {
  return req('POST', '/etiquetas/outras', { clientToken: `bad-${C}-${++tok}`, sessao_id: sid, item_codigo: item, peso });
}
const novaSessao = async () => (await req('POST', '/sessoes', { tipo: 'outras', operador: 'Teste' })).body.sessao_id;
async function fechar(sid) {
  pedidos.length = 0;
  const fim = await req('POST', `/sessoes/${sid}/finalizar`);
  return { fim, pedido: pedidos.find(x => x.rota.startsWith('/Api/v3/pedidos/compras')) };
}
const RX_RESIDUO_VPS = /RES\.|RESIDUO|RESÍDUO|VARREDURA|BORRA/i;   // = _RX_RESIDUO do snapshot_producao.py

(async () => {
  try {
    await subirFake();
    await subir();
    await req('POST', '/config', { bling_simular: '0', bling_host_api: 'localhost:' + portaFake,
                                   bling_host_oauth: 'localhost:' + portaFake, id_ekoplastic_bling: String(ID_EKO) });

    console.log('\n[1] etiqueta da bobina AD');
    const s1 = await novaSessao();
    const b1 = await pesar(s1, 'BOB.VER.1,52', 412.5);
    ok(b1.status === 200 && /^O\d{7}$/.test(b1.body.id || ''), 'bobina verde 1,52 imprime etiqueta O', b1.body);
    const epl1 = eplDe(b1.body.id);
    ok(epl1.includes('"BOBINA ALTA DENSIDADE"'), 'etiqueta diz BOBINA ALTA DENSIDADE', epl1.slice(0, 300));
    ok(epl1.includes('"VERDE 1,52 M"'), 'etiqueta diz VERDE 1,52 M', epl1.slice(0, 400));
    ok(epl1.includes('"SACOLA 38 X 48 - MILHEIRO"'), 'etiqueta diz para qual sacola serve (38 x 48)', epl1);
    ok(epl1.includes('409.2 KG'), 'etiqueta leva o peso SEM o tubete (412,5 − 3,3)', epl1.match(/"[\d.]+ KG"/));
    const g1 = comBanco(db => db.prepare('SELECT peso, peso_bruto, tara FROM etiquetas WHERE id = ?').get(b1.body.id));
    ok(g1.peso === 409.2 && g1.peso_bruto === 412.5 && g1.tara === 3.3, 'banco: peso 409,2 · bruto 412,5 · tara 3,3', g1);
    ok(!/IKATU/i.test(epl1), 'fornecedor NÃO sai na etiqueta');
    await req('POST', `/etiquetas/${b1.body.id}/bipar`);
    const b2 = await pesar(s1, 'BOB.PT.1,16', 300);
    ok(b2.status === 200, 'bobina preta 1,16 na mesma pesagem', b2.body);
    ok(comBanco(db => db.prepare('SELECT peso FROM etiquetas WHERE id = ?').get(b2.body.id).peso) === 297.5, '1,16: tubete de 2,5 kg (300 → 297,5)');
    const tara0 = await pesar(s1, 'BOB.VER.1,52', 3);
    ok(tara0.status === 400 && /tubete/.test(tara0.body.erro || ''), 'peso que não passa do tubete → 400', tara0);
    const quase = await pesar(s1, 'BOB.VER.1,52', 23.2);          // 19,9 líquido
    ok(quase.status === 400, 'abaixo de 20 kg líquidos → 400 (tubete vazio não é bobina)', quase);
    const nan = await req('POST', '/etiquetas/outras', { clientToken: `bad-${C}-nan`, sessao_id: s1, item_codigo: 'BOB.VER.1,52', peso: 'abc' });
    ok(nan.status === 400, 'peso inválido → 400', nan);
    // contrato: com peso_bruto, o `peso` mandado NÃO é tratado como líquido (sem desconto em dobro)
    const dupla = await req('POST', '/etiquetas/outras', { clientToken: `bad-${C}-dupla`, sessao_id: s1, item_codigo: 'BOB.VER.1,52', peso: 96.7, peso_bruto: 100 });
    ok(dupla.status === 200 && dupla.body.peso === 96.7, 'peso_bruto 100 → 96,7 (não 93,4)', dupla.body);
    // repetição pelo clientToken: mesma etiqueta, e a resposta diz o que FICOU gravado
    const rep1 = await req('POST', '/etiquetas/outras', { clientToken: `bad-${C}-dupla`, sessao_id: s1, item_codigo: 'BOB.PT.1,16', peso: 300, peso_bruto: 300 });
    ok(rep1.status === 200 && rep1.body.id === dupla.body.id && rep1.body.peso === 96.7 && rep1.body.sku === 'BOB.VER.1,52',
       'repetir o mesmo clientToken com outro item/peso: devolve a etiqueta de antes (id, peso e sku dela)', rep1.body);
    ok(comBanco(db => db.prepare(`SELECT COUNT(*) n FROM etiquetas WHERE sessao_id = ? AND sku = 'BOB.PT.1,16'`).get(s1).n) === 1,
       'a repetição não criou etiqueta nova');
    await req('POST', `/etiquetas/${dupla.body.id}/cancelar`);
    const fraude = await req('POST', '/etiquetas/outras', { clientToken: `bad-${C}-tara`, sessao_id: s1, item_codigo: 'BOB.PT.1,52', peso: 100, peso_bruto: 100, tara: 0 });
    ok(fraude.status === 200 && comBanco(db => db.prepare('SELECT peso FROM etiquetas WHERE id = ?').get(fraude.body.id).peso) === 96.7,
       'tara mandada pela tela é ignorada: vale o tubete do catálogo', fraude.body);
    await req('POST', `/etiquetas/${fraude.body.id}/cancelar`);
    ok(eplDe(b2.body.id).includes('"SACOLA 29 X 39 - MILHEIRO"'), '1,16 serve para a sacola 29 x 39');
    await req('POST', `/etiquetas/${b2.body.id}/bipar`);
    ok(comBanco(db => db.prepare('SELECT fornecedor FROM etiquetas WHERE id = ?').get(b1.body.id).fornecedor) === 'IKATUPLAST',
       'no banco a etiqueta guarda o fornecedor IKATUPLAST');

    console.log('\n[3] não mistura com resíduo');
    const r1 = await pesar(s1, 'RES.BORRA', 20);
    ok(r1.status === 409 && r1.body && r1.body.motivo === 'fornecedor_diferente', 'borra na pesagem de bobina AD → 409', r1);
    const r2 = await pesar(s1, 'APARA.VERDE', 20);
    ok(r2.status === 409, 'apara na pesagem de bobina AD → 409', r2);

    console.log('\n[2] pedido de compra com a IKATUPLAST');
    const { fim: f1, pedido: p1 } = await fechar(s1);
    ok(f1.status === 200 && f1.body.bling && f1.body.bling.ok, 'pesagem fecha e vai ao Bling', f1.body);
    ok(p1 && p1.corpo.fornecedor && p1.corpo.fornecedor.id === ID_IKATUPLAST, 'fornecedor do pedido = IKATUPLAST', p1);
    const itens = (p1 && p1.corpo.itens) || [];
    ok(itens.length === 2, '2 itens no pedido', itens);
    ok(itens[0] && itens[0].produto.id === 16739758321 && itens[0].quantidade === 409.2, 'item 1 = variação BOB.VER.1,52 com 409,2 kg', itens[0]);
    ok(itens[1] && itens[1].produto.id === 16739758328 && itens[1].quantidade === 297.5, 'item 2 = variação BOB.PT.1,16 com 297,5 kg', itens[1]);
    ok(itens.every(i => i.produto.id !== 16739752334), 'nenhum item vai no id do produto pai');
    const obs = (p1 && p1.corpo.observacoes) || '';
    ok(/BOBINA ALTA DENSIDADE/.test(obs) && /TOTAL: 706,7 KG/.test(obs), 'observação com título e total', obs);
    ok(!RX_RESIDUO_VPS.test(obs), '[6] observação sem palavra que a VPS lê como resíduo', obs);

    console.log('\n[3b/4] pesagem de resíduo recusa bobina; cancelada não conta');
    const s2 = await novaSessao();
    const e1 = await pesar(s2, 'RES.BORRA', 30);
    ok(e1.status === 200, 'borra imprime', e1.body);
    const r3 = await pesar(s2, 'BOB.VER.1,16', 250);
    ok(r3.status === 409 && /FINALIZAR|Finalize/i.test(r3.body.erro || ''), 'bobina na pesagem de resíduo → 409 dizendo o que fazer', r3);
    await req('POST', `/etiquetas/${e1.body.id}/cancelar`);
    const r4 = await pesar(s2, 'BOB.VER.1,16', 250);
    ok(r4.status === 200, 'com a borra cancelada, a bobina entra', r4);
    await req('POST', `/etiquetas/${r4.body.id}/cancelar`);
    const e2 = await pesar(s2, 'RES.BORRA', 30);
    await req('POST', `/etiquetas/${e2.body.id}/bipar`);
    const { pedido: p2 } = await fechar(s2);
    ok(p2 && p2.corpo.fornecedor.id === ID_EKO, 'borra continua com a EKOPLASTIC', p2);

    console.log('\n[5] sessão misturada à mão no banco');
    const s4 = await novaSessao();
    const m1 = await pesar(s4, 'BOB.VER.1,52', 100);
    await req('POST', `/etiquetas/${m1.body.id}/bipar`);
    const m2 = await pesar(s4, 'BOB.PT.1,52', 100);
    await req('POST', `/etiquetas/${m2.body.id}/bipar`);
    comBanco(db => db.prepare(`UPDATE etiquetas SET sku = 'RES.BORRA' WHERE id = ?`).run(m2.body.id));
    const { fim: f4, pedido: p4 } = await fechar(s4);
    ok(f4.body && f4.body.bling && f4.body.bling.ok === false && /mistura/i.test(f4.body.bling.erro || ''), 'envio para com erro de mistura', f4.body);
    ok(!p4, 'nenhum pedido foi ao Bling', p4);
    const st = comBanco(db => db.prepare('SELECT bling_status FROM sessoes WHERE id = ?').get(s4).bling_status);
    ok(st === 'erro', 'sessão fica em erro (aparece em Envios ao Bling para reenviar)', st);

    console.log('\n[7] apara misturada (sem produto no Bling) também para o envio');
    const s5 = await novaSessao();
    const a1 = await pesar(s5, 'BOB.VER.1,16', 100);
    await req('POST', `/etiquetas/${a1.body.id}/bipar`);
    const a2 = await pesar(s5, 'BOB.PT.1,16', 100);
    await req('POST', `/etiquetas/${a2.body.id}/bipar`);
    comBanco(db => db.prepare(`UPDATE etiquetas SET sku = 'APARA.VERDE' WHERE id = ?`).run(a2.body.id));
    const { fim: f5, pedido: p5 } = await fechar(s5);
    ok(f5.body && f5.body.bling && f5.body.bling.ok === false && /mistura/i.test(f5.body.bling.erro || ''),
       'bobina + apara: envio para com erro (apara não entra no pedido da IKATUPLAST)', f5.body);
    ok(!p5, 'nenhum pedido foi ao Bling', p5);

    console.log('\n[8] etiqueta excluída não volta pelo bipe');
    const s6 = await novaSessao();
    const x1 = await pesar(s6, 'APARA.VERDE', 15);
    await req('POST', `/etiquetas/${x1.body.id}/cancelar`);
    const x2 = await pesar(s6, 'BOB.VER.1,52', 200);
    ok(x2.status === 200, 'depois de excluir a apara, a bobina entra', x2.body);
    const rb = await req('POST', `/etiquetas/${x1.body.id}/bipar`);
    ok(rb.status === 409 && rb.body && rb.body.trava === 'outras_cancelada', 'bipar a apara excluída → 409', rb);
    ok(comBanco(db => db.prepare('SELECT status FROM etiquetas WHERE id = ?').get(x1.body.id).status) === 'cancelada',
       'a apara continua cancelada');

    console.log('\n[9] etiqueta da bobina cabe em 800 dots (todo item do catálogo)');
    const { OUTRAS_CATALOGO } = require(path.join(ROOT, 'lib', 'config.js'));
    const { gerarEPL } = require(path.join(ROOT, 'lib', 'impressao.js'));
    for (const [sku, cat] of Object.entries(OUTRAS_CATALOGO).filter(([, c]) => c.categoria === 'BOBINA_AD')) {
      const epl = gerarEPL({ tipo: 'outras', seq: 1, sku, material_nome: cat.nome, peso: 9999.9 });
      const largas = [...epl.matchAll(/^A(\d+),\d+,0,4,2,\d,N,"(.*)"$/gm)];
      ok(largas.length === 2 && largas.every(m => Number(m[1]) + m[2].length * 28 <= 800), `${sku}: texto largo dentro de 800 dots`, largas.map(m => [m[1], m[2]]));
    }

    console.log('\n[11] tubete e mínimo da tela = os do servidor');
    const html = fs.readFileSync(path.join(ROOT, 'public', 'outras-pesagens.html'), 'utf8');
    for (const [sku, cat] of Object.entries(OUTRAS_CATALOGO).filter(([, c]) => c.tubete)) {
      const linha = html.split('\n').find(l => l.trim().startsWith(`'${sku}':`)) || '';
      const m = linha.match(/tubete:\s*([\d.]+)/);
      ok(m && Number(m[1]) === cat.tubete, `${sku}: tubete da tela = ${cat.tubete}`, linha.trim());
    }
    const { OUTRAS_BOBINA_MIN_KG } = require(path.join(ROOT, 'lib', 'config.js'));
    const mMin = html.match(/const BOBINA_MIN_KG = (\d+)/);
    ok(mMin && Number(mMin[1]) === OUTRAS_BOBINA_MIN_KG, 'mínimo da tela = do servidor', mMin && mMin[1]);

    console.log('\n[10] celular.css só usa data-tela que existe numa tela');
    const css = fs.readFileSync(path.join(ROOT, 'public', 'celular.css'), 'utf8');
    const telas = new Set(fs.readdirSync(path.join(ROOT, 'public')).filter(f => f.endsWith('.html'))
      .map(f => (fs.readFileSync(path.join(ROOT, 'public', f), 'utf8').match(/<body[^>]*data-tela="([^"]+)"/) || [])[1]).filter(Boolean));
    const usadas = [...new Set([...css.matchAll(/data-tela="([^"]+)"/g)].map(m => m[1]))];
    ok(usadas.every(t => telas.has(t)), 'toda regra do celular aponta para uma tela de verdade', { usadas, telas: [...telas] });
  } catch (e) {
    falhou++; console.log('  \x1b[31m✗ exceção:\x1b[0m', e.stack || e.message);
  } finally {
    await derrubar();
    if (fake) fake.close();
    for (const f of [DB1, DB1 + '-wal', DB1 + '-shm', TOK]) { try { fs.unlinkSync(f); } catch (e) {} }
    try { fs.rmSync(LOGS, { recursive: true, force: true }); } catch (e) {}
  }
  console.log(`\n${passou} ok, ${falhou} falha(s)`);
  process.exit(falhou ? 1 : 0);
})();
