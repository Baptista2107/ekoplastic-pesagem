// ════════════════════════════════════════════════════════════════════
//  CADASTROS BLING — PUXAR PRODUTO NOVO DE MATÉRIA-PRIMA
//  ------------------------------------------------------------------
//  Em Opções > Cadastros Bling o sistema procura no Bling os produtos de
//  matéria-prima que ainda não conhece. Em 28/09/2026 o Frederico
//  cadastrou o AUXILIAR DE FLUXO no Bling, mandou procurar — e a tela
//  não trouxe nada. Foi preciso cadastrar por atualização de código.
//
//  POR QUE NÃO VINHA (reproduzido aqui antes de qualquer conserto)
//   1. A busca só reconhecia material que o sistema JÁ conhecia. Um
//      material novo não casava com nada e era descartado calado — sem
//      nem um "achei um produto que não entendi".
//   2. Produto com variação: o nome do pai ("AUXILIAR DE FLUXO") não
//      traz fornecedor nem cor; quem traz é a variação
//      ("Fornecedor:CRISTAL MASTER"). A busca não abria as variações.
//   3. Mesmo cadastrado, o material novo não sabia se era "por sacos":
//      essa lista era fixa no código.
//
//  O Bling aqui é de mentira: um servidor local que responde como o
//  Bling v3 (listagem paginada + detalhe do produto com variações). O
//  servidor sobe com EKO_BLING_INSEGURO=1 para falar HTTP com ele.
// ════════════════════════════════════════════════════════════════════
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const http = require('node:http');
const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');

const ROOT = path.join(__dirname, '..');
const PORT = 13911, PORT_CB = 18911;
const BASE = `http://localhost:${PORT}`;
const C = Date.now();
const TMP_DB   = path.join(os.tmpdir(), `eko_sb_${C}.db`);
const TMP_LOGS = path.join(os.tmpdir(), `eko_sb_${C}`);
const TMP_TOK  = path.join(os.tmpdir(), `eko_sb_tok_${C}.json`);

let passou = 0, falhou = 0, servidor, fake, portaFake = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function ok(cond, msg, extra) {
  if (cond) { passou++; console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
  else { falhou++; console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
         if (extra !== undefined) console.log('      →', JSON.stringify(extra).slice(0, 500)); }
}
async function req(metodo, rota, corpo) {
  const opc = { method: metodo, headers: {} };
  if (corpo !== undefined) { opc.body = JSON.stringify(corpo); opc.headers['Content-Type'] = 'application/json'; }
  const r = await fetch(BASE + rota, opc);
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, body: j };
}
const cfg = k => {
  const db = new DatabaseSync(TMP_DB);
  try { const r = db.prepare('SELECT valor FROM config WHERE chave = ?').get(k); return r ? JSON.parse(r.valor) : null; }
  finally { db.close(); }
};

// ── O BLING DE MENTIRA ───────────────────────────────────────────────
// A listagem traz os produtos-PAI. As variações só aparecem no detalhe
// do pai (GET /produtos/{id}) — é o caso que a busca não cobria.
const LISTAGEM = [
  // material que o sistema NÃO conhece: pai + variação por fornecedor
  { id: 950000, nome: 'ADITIVO ANTIBLOCK', codigo: 'ANTIBL', formato: 'V' },
  // material conhecido, produto simples, já mapeado no sistema
  { id: 16586065182, nome: 'RESINA POLINYLON CRISTAL YCARO', codigo: 'POLI.CRIS.YCARO', formato: 'S' },
  // produto acabado (pai com variações) — não é matéria-prima
  { id: 16571279198, nome: 'SACOLA SEMI-VIRGEM BRANCA (25KG)', codigo: 'BC', formato: 'V' },
  // bobina — não é matéria-prima
  { id: 16653916155, nome: 'BOBINA AMARELA LEVE 1,60', codigo: 'BOB.AM.LEV.1,60', formato: 'S' },
  // resíduo — não é matéria-prima
  { id: 16572867363, nome: 'BORRA', codigo: 'RES.BORRA', formato: 'S' },
  // o caso real de 28/09/2026: material que o sistema JÁ tem, com variação
  { id: 16711697470, nome: 'AUXILIAR DE FLUXO', codigo: 'AUXFLUX', formato: 'V' },
];
const DETALHE = {
  950000: { id: 950000, nome: 'ADITIVO ANTIBLOCK', codigo: 'ANTIBL', formato: 'V',
            variacoes: [ { id: 950001, nome: 'ADITIVO ANTIBLOCK Fornecedor:CRISTAL MASTER', codigo: 'ANTIBL.CRISTAL',
                           variacao: { nome: 'Fornecedor:CRISTAL MASTER' } } ] },
  16711697470: { id: 16711697470, nome: 'AUXILIAR DE FLUXO', codigo: 'AUXFLUX', formato: 'V',
                 variacoes: [ { id: 16711697477, nome: 'AUXILIAR DE FLUXO Fornecedor:CRISTAL MASTER', codigo: 'AUXFLUX.CRISTAL',
                                variacao: { nome: 'Fornecedor:CRISTAL MASTER' } } ] },
  16571279198: { id: 16571279198, nome: 'SACOLA SEMI-VIRGEM BRANCA (25KG)', codigo: 'BC', formato: 'V',
                 variacoes: [ { id: 1, nome: 'x', codigo: 'BC.5060.5K', variacao: { nome: 'Tamanho:50x60' } } ] },
};
const chamadas = [];
function subirFake() {
  return new Promise(resolve => {
    fake = http.createServer((r, res) => {
      let corpo = '';
      r.on('data', c => corpo += c);
      r.on('end', () => {
        chamadas.push(r.url);
        const responder = (st, obj) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
        const u = new URL(r.url, 'http://x');
        if (u.pathname.startsWith('/Api/v3/oauth/token'))
          return responder(200, { access_token: 'tok', refresh_token: 'refresh-fake', expires_in: 21600 });
        const mDet = u.pathname.match(/^\/Api\/v3\/produtos\/(\d+)$/);
        if (mDet) {
          const d = DETALHE[mDet[1]];
          return d ? responder(200, { data: d }) : responder(404, { error: { message: 'não encontrado' } });
        }
        if (u.pathname === '/Api/v3/produtos') {
          const pag = parseInt(u.searchParams.get('pagina') || '1', 10);
          return responder(200, { data: pag === 1 ? LISTAGEM : [] });
        }
        if (u.pathname.startsWith('/Api/v3/contatos')) return responder(200, { data: [{ id: 17812997897, nome: 'CRISTAL MASTER' }] });
        return responder(200, { data: {} });
      });
    });
    fake.listen(0, '127.0.0.1', () => { portaFake = fake.address().port; resolve(); });
  });
}

async function subirServidor() {
  fs.writeFileSync(TMP_TOK, JSON.stringify({ accessToken: 'tok', refreshToken: 'refresh-fake', expiresAt: Date.now() + 3600e3 }));
  servidor = spawn('node', [path.join(ROOT, 'server.js')], {
    env: { ...process.env, EKO_PORT: String(PORT), EKO_PORT_CB: String(PORT_CB),
           EKO_DB_FILE: TMP_DB, EKO_LOG_DIR: TMP_LOGS, EKO_TOKEN_FILE: TMP_TOK,
           TZ: 'America/Sao_Paulo', EKO_PRINT_SIMULAR: '1', EKO_BLING_INSEGURO: '1',
           BLING_CLIENT_ID: 'id-teste', BLING_CLIENT_SECRET: 'segredo-teste' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  servidor.stdout.on('data', () => {});
  for (let i = 0; i < 75; i++) {
    try { const r = await fetch(BASE + '/healthcheck'); if (r.ok) return; } catch (e) {}
    await sleep(200);
  }
  throw new Error('servidor não subiu');
}

(async () => {
  try {
    console.log('\n═══════════════════════════════════════════════════');
    console.log(' CADASTROS BLING — PRODUTO NOVO DE MATÉRIA-PRIMA');
    console.log('═══════════════════════════════════════════════════\n');
    await subirFake();
    await subirServidor();
    await req('POST', '/config', { bling_simular: '0', bling_host_api: 'localhost:' + portaFake,
                                   bling_host_oauth: 'localhost:' + portaFake });

    // ── [1] A BUSCA ENCONTRA O QUE EXISTE NO BLING ─────────────────
    console.log('[1] A busca não descarta calada um material que ela ainda não conhece');
    const p1 = await req('GET', '/sync/mp/procurar');
    ok(p1.status === 200 && p1.body.ok, 'a busca responde', p1.body && p1.body.erro);
    const desconhecidos = (p1.body && p1.body.nao_reconhecidos) || [];
    const antib = desconhecidos.find(n => n.bling_id === '950001' || n.bling_id === '950000');
    ok(!!antib, 'o ANTIBLOCK aparece como "não reconhecido" — antes sumia sem aviso', desconhecidos);
    ok(antib && antib.sugestao_material === 'ANTIBL',
       `com a chave sugerida pela SKU: ${antib && antib.sugestao_material}`, antib);
    ok(!desconhecidos.some(n => /SACOLA|BOBINA|BORRA/.test(n.nome)),
       'produto acabado, bobina e resíduo NÃO entram como matéria-prima desconhecida',
       desconhecidos.map(n => n.nome));
    ok(!desconhecidos.some(n => /AUXILIAR/.test(n.nome) || (n.pai && /AUXILIAR/.test(n.pai.nome))),
       'o AUXILIAR DE FLUXO (material que o sistema já tem) é reconhecido', desconhecidos);
    ok(!(p1.body.novos || []).some(n => n.bling_id === '16711697477'),
       'e não aparece como novo: a variação dele já está cadastrada', (p1.body.novos || []).map(n => n.nome));

    // ── [2] AS VARIAÇÕES SÃO ABERTAS ───────────────────────────────
    console.log('\n[2] A busca abre as variações do produto-pai');
    ok(chamadas.some(u => /\/Api\/v3\/produtos\/950000/.test(u)),
       'o detalhe do pai foi consultado — é lá que está o fornecedor');
    ok(!chamadas.some(u => /\/Api\/v3\/produtos\/16571279198/.test(u)),
       'e o pai do produto acabado NÃO — não se gasta chamada com o que não é MP');
    ok(antib && antib.bling_id === '950001' && antib.codigo === 'ANTIBL.CRISTAL',
       'o que aparece é a VARIAÇÃO (id e SKU dela), não o pai', antib);

    // ── [3] CRIAR O MATERIAL NOVO PELA TELA ────────────────────────
    console.log('\n[3] Criar o material novo pela tela, sem atualização de código');
    const inval = await req('POST', '/sync/mp/material', { matKey: 'a b', popular: 'X', unidade: 'sacos' });
    ok(inval.status === 400, 'chave com espaço é recusada', inval.body);
    const dup = await req('POST', '/sync/mp/material', { matKey: 'POLI', popular: 'Outro', unidade: 'bigbag' });
    ok(dup.status === 409, 'chave de material que já existe é recusada — não sobrescreve cadastro', dup.body);
    const novo = await req('POST', '/sync/mp/material',
      { matKey: 'ANTIBL', popular: 'Aditivo Antiblock', unidade: 'sacos', apelidos: ['ANTIBLOCK'] });
    ok(novo.status === 200 && novo.body.ok, 'o material é criado', novo.body);
    const cat = await req('GET', '/catalogo-mp');
    const m = (cat.body.materiais || {}).ANTIBL || {};
    ok(m.popular === 'Aditivo Antiblock' && m.porSacos === true && m.kgPorSaco === 25,
       'no catálogo, como material por sacos de 25 kg', m);

    // ── [4] AGORA ELE É RECONHECIDO ────────────────────────────────
    console.log('\n[4] Na busca seguinte o produto já vem pronto para cadastrar');
    const p2 = await req('GET', '/sync/mp/procurar');
    const item = (p2.body.novos || []).find(n => n.bling_id === '950001');
    ok(!!item, 'o produto aparece entre os NOVOS', (p2.body.novos || []).map(n => n.nome));
    ok(item && item.material === 'ANTIBL' && item.fornecedor === 'Cristal Master' && item.completo,
       `interpretado: ${item && item.material} · ${item && item.fornecedor}`, item);
    ok(item && item.cor === null,
       'sem cor inventada: o "CRISTAL" de "Cristal Master" é fornecedor, não cor', item && item.cor);
    ok(!(p2.body.nao_reconhecidos || []).some(n => n.bling_id === '950001'),
       'e saiu da lista de não reconhecidos');

    // ── [5] CONFIRMAR: VIRA MATERIAL DE VERDADE ────────────────────
    console.log('\n[5] Confirmar cadastra id, SKU da variação e código gravimétrico');
    const conf = await req('POST', '/sync/mp/confirmar', { itens: [{
      bling_id: item.bling_id, codigo: item.codigo, formato: item.formato,
      material: 'ANTIBL', cor: null, fornecedor: 'Cristal Master',
      codigo_gravimetrico: 'AB1', contato_id: '17812997897' }] });
    ok(conf.status === 200 && conf.body.cadastrados === 1, 'cadastrado', conf.body);
    ok((cfg('mapa_produto_bling') || {})['ANTIBL::Cristal Master'] === '950001',
       'o id da variação foi gravado');
    ok((cfg('mapa_sku_variacao_mp') || {})['ANTIBL::Cristal Master'] === 'ANTIBL.CRISTAL',
       'e a SKU da variação — é ela que resolve a variação certa no envio');
    const cat2 = await req('GET', '/catalogo-mp');
    ok((cat2.body.codigos || []).some(c => c.matKey === 'ANTIBL' && c.codigo === 'AB1'), 'com o código AB1');

    // ── [6] "POR SACOS" VALE EM TODO LUGAR ─────────────────────────
    console.log('\n[6] O material por sacos se comporta como os outros aditivos');
    const inv = await req('GET', '/inventario/produtos');
    const pi = (inv.body.produtos || []).find(p => p.material === 'ANTIBL');
    ok(pi && pi.manual === true && pi.kgPorSaco === 25, 'o inventário conta em sacos de 25 kg', pi);
    const s = await req('POST', '/sessoes', { tipo: 'retirada', operador: 'Teste' });
    const ad = await req('POST', '/retirada/aditivo',
      { sessao_id: s.body.sessao_id, materialKey: 'ANTIBL', fornecedor: 'Cristal Master', qtd_sacos: 3 });
    ok(ad.status === 200 && ad.body.etiqueta && ad.body.etiqueta.peso === 75,
       'a retirada por sacos aceita: 3 × 25 = 75 kg', ad.body);
    ok(ad.body.etiqueta && ad.body.etiqueta.material_nome === 'Aditivo Antiblock',
       'com o nome cadastrado na tela');

  } catch (e) {
    falhou++;
    console.error('\n\x1b[31mERRO NO TESTE:\x1b[0m', e.stack || e.message);
  } finally {
    console.log('\n═══════════════════════════════════════════════════');
    console.log(` RESULTADO: ${passou} passou, ${falhou} falhou`);
    console.log('═══════════════════════════════════════════════════\n');
    try { servidor && servidor.kill('SIGKILL'); } catch (e) {}
    try { fake && fake.close(); } catch (e) {}
    for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm', TMP_TOK]) { try { fs.rmSync(f, { force: true }); } catch (e) {} }
    try { fs.rmSync(TMP_LOGS, { recursive: true, force: true }); } catch (e) {}
    setTimeout(() => process.exit(falhou ? 1 : 0), 200);
  }
})();
