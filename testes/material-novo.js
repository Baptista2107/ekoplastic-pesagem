// ════════════════════════════════════════════════════════════════════
//  MATERIAL NOVO CHEGA A UM BANCO QUE JÁ EXISTE
//  ------------------------------------------------------------------
//  O catálogo de MP (fornecedores, códigos gravimétricos e materiais)
//  era gravado no banco SÓ quando a chave não existia. A intenção era
//  boa — não apagar o que foi cadastrado pela tela — mas tinha um
//  efeito que ninguém via: numa estação que já rodou, as três chaves
//  existem, então um material NOVO no código nunca chegava lá. O
//  material estava no server.js, a atualização era instalada, e ele
//  continuava sem aparecer na tela.
//
//  Este teste reproduz exatamente isso: sobe o servidor, ENVELHECE o
//  banco tirando o material novo de todos os mapas (é o banco da
//  estação), sobe de novo e confere que ele voltou — e que o que o
//  usuário tinha cadastrado continua lá, intacto.
//
//  O material do dia é o AUXILIAR DE FLUXO, mas o que está sob teste é
//  a regra: o próximo material vai entrar pelo mesmo caminho.
// ════════════════════════════════════════════════════════════════════
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');

const ROOT = path.join(__dirname, '..');
const PORT = 13910, PORT_CB = 18910;
const BASE = `http://localhost:${PORT}`;
const C = Date.now();
const TMP_DB   = path.join(os.tmpdir(), `eko_mn_${C}.db`);
const TMP_LOGS = path.join(os.tmpdir(), `eko_mn_${C}`);

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
    env: { ...process.env, EKO_PORT: String(PORT), EKO_PORT_CB: String(PORT_CB),
           EKO_DB_FILE: TMP_DB, EKO_LOG_DIR: TMP_LOGS,
           TZ: 'America/Sao_Paulo', EKO_PRINT_SIMULAR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  servidor.stdout.on('data', () => {});
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
// Mexe no banco pela porta dos fundos, como se fosse o banco antigo da
// estação. É o único jeito honesto de reproduzir o problema: o estado
// inicial é um banco que JÁ TEM as chaves, sem o material novo.
function comBanco(fn) {
  const db = new DatabaseSync(TMP_DB);
  try { return fn(db); } finally { try { db.close(); } catch (e) {} }
}
const cfgLer = (db, k) => {
  const r = db.prepare('SELECT valor FROM config WHERE chave = ?').get(k);
  return r ? JSON.parse(r.valor) : null;
};
const cfgGravar = (db, k, v) =>
  db.prepare('INSERT INTO config (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor')
    .run(k, JSON.stringify(v));

const MAT = 'AUXFLUX';
const FORN = 'Cristal Master';
const CHAVE = `${MAT}::${FORN}`;

(async () => {
  try {
    console.log('\n═══════════════════════════════════════════════════');
    console.log(' MATERIAL NOVO EM BANCO EXISTENTE — Ekoplastic');
    console.log('═══════════════════════════════════════════════════\n');

    if (!(await subir())) throw new Error('servidor não subiu');

    // ── [1] NUMA INSTALAÇÃO NOVA, O MATERIAL JÁ NASCE LÁ ────────────
    console.log('[1] Instalação nova traz o material do código');
    const cat0 = await req('GET', '/catalogo-mp');
    ok(cat0.status === 200 && cat0.body.materiais && cat0.body.materiais[MAT],
       'o material está no catálogo', Object.keys((cat0.body && cat0.body.materiais) || {}));
    ok((cat0.body.fornecedores[MAT] || []).includes(FORN),
       `com o fornecedor ${FORN}`, cat0.body.fornecedores[MAT]);
    ok((cat0.body.codigos || []).some(c => c.matKey === MAT && c.codigo === 'A1'),
       'e com o código gravimétrico A1');

    // ── [2] O BANCO DA ESTAÇÃO: JÁ EXISTE, E SEM O MATERIAL ─────────
    // Este é o passo que reproduz o problema real. Tudo o que o usuário
    // cadastrou fica marcado, para se provar depois que nada se perdeu.
    console.log('\n[2] Envelhecendo o banco — tirando o material de todos os mapas');
    await derrubar();
    comBanco(db => {
      const forn = cfgLer(db, 'mp_fornecedores');   delete forn[MAT];
      // marca do usuário: um fornecedor cadastrado pela tela
      forn.CARBO = [...(forn.CARBO || []), 'FORNECEDOR DO USUARIO'];
      cfgGravar(db, 'mp_fornecedores', forn);

      const mats = cfgLer(db, 'mp_materiais');      delete mats[MAT];
      cfgGravar(db, 'mp_materiais', mats);

      const cods = cfgLer(db, 'mp_codigos_gravimetricos').filter(c => c.matKey !== MAT);
      cods.push({ matKey: 'CARBO', cor: null, forn: 'FORNECEDOR DO USUARIO', codigo: 'C9' });
      cfgGravar(db, 'mp_codigos_gravimetricos', cods);

      const prod = cfgLer(db, 'mapa_produto_bling');    delete prod[CHAVE];
      cfgGravar(db, 'mapa_produto_bling', prod);
      const skuv = cfgLer(db, 'mapa_sku_variacao_mp');  delete skuv[CHAVE];
      cfgGravar(db, 'mapa_sku_variacao_mp', skuv);
    });
    const antes = comBanco(db => ({
      temMat:  !!cfgLer(db, 'mp_materiais')[MAT],
      temForn: !!cfgLer(db, 'mp_fornecedores')[MAT],
      temProd: !!cfgLer(db, 'mapa_produto_bling')[CHAVE],
    }));
    ok(!antes.temMat && !antes.temForn && !antes.temProd,
       'o banco ficou igual ao da estação: sem o material em lugar nenhum', antes);

    // ── [3] A ATUALIZAÇÃO CHEGA — E O MATERIAL TAMBÉM ──────────────
    console.log('\n[3] Subindo a versão nova sobre esse banco');
    if (!(await subir())) throw new Error('servidor não voltou');
    const cat = await req('GET', '/catalogo-mp');
    ok(cat.body.materiais && cat.body.materiais[MAT],
       'o material apareceu no catálogo sem ninguém mexer no banco à mão');
    const matNovo = (cat.body.materiais || {})[MAT] || {};
    ok(matNovo.popular === 'Auxiliar de Fluxo', `com o nome certo: ${matNovo.popular}`);
    ok(((cat.body.fornecedores || {})[MAT] || []).includes(FORN), 'com o fornecedor');
    ok((cat.body.codigos || []).some(c => c.matKey === MAT && c.codigo === 'A1'), 'com o código A1');

    // ── [4] E NADA DO QUE O USUÁRIO CADASTROU SE PERDEU ────────────
    // Esta é a metade que importa tanto quanto: mesclar não pode virar
    // sobrescrever. Quem cadastrou um fornecedor pela tela tem de
    // encontrá-lo lá depois da atualização.
    console.log('\n[4] O que estava cadastrado continua cadastrado');
    ok(((cat.body.fornecedores || {}).CARBO || []).includes('FORNECEDOR DO USUARIO'),
       'o fornecedor cadastrado pela tela sobreviveu à atualização', (cat.body.fornecedores || {}).CARBO);
    ok((cat.body.codigos || []).some(c => c.codigo === 'C9'),
       'e o código gravimétrico cadastrado também');
    const duplicados = (cat.body.codigos || [])
      .map(c => `${c.matKey}|${c.cor || ''}|${c.forn || ''}`)
      .filter((v, i, a) => a.indexOf(v) !== i);
    ok(duplicados.length === 0, 'nenhum código foi duplicado na mesclagem', duplicados);

    // ── [5] O PRODUTO DO BLING VOLTOU COM O ID E A SKU ─────────────
    console.log('\n[5] O produto do Bling: id e SKU no lugar');
    const mapas = comBanco(db => ({
      id:  cfgLer(db, 'mapa_produto_bling')[CHAVE],
      sku: cfgLer(db, 'mapa_sku_variacao_mp')[CHAVE],
    }));
    ok(mapas.id === '16711697477', `id do produto: ${mapas.id}`);
    ok(mapas.sku === 'AUXFLUX.CRISTAL', `SKU da variação: ${mapas.sku}`);

    // ── [6] APARECE NO INVENTÁRIO, CONTADO EM SACOS ────────────────
    console.log('\n[6] No inventário, contado em sacos de 25 kg');
    const inv = await req('GET', '/inventario/produtos');
    const item = (inv.body.produtos || []).find(p => p.material === MAT && p.fornecedor === FORN);
    ok(!!item, 'o material aparece na lista do inventário', (inv.body.produtos || []).length);
    ok(item && item.manual === true && item.kgPorSaco === 25,
       'marcado como contagem por sacos de 25 kg — igual aos outros aditivos', item);
    ok(item && (item.cor === null || item.cor === undefined), 'e sem cor', item && item.cor);

    // ── [7] ENTRA POR SACOS E SAI POR SACOS ────────────────────────
    // A retirada por sacos recusava qualquer material fora de PIG e
    // DESSEC. Material que entra e não sai é pior que material que não
    // entra: cria estoque preso no sistema.
    console.log('\n[7] A retirada por sacos aceita o material novo');
    const s = await req('POST', '/sessoes', { tipo: 'retirada', operador: 'Teste' });
    const sid = s.body.sessao_id;
    const ad = await req('POST', '/retirada/aditivo',
      { sessao_id: sid, materialKey: MAT, fornecedor: FORN, qtd_sacos: 4 });
    ok(ad.status === 200, 'a retirada de 4 sacos é aceita', ad.body);
    ok(ad.body && ad.body.etiqueta && ad.body.etiqueta.peso === 100,
       `4 sacos × 25 kg = 100 kg: ${ad.body && ad.body.etiqueta && ad.body.etiqueta.peso}`, ad.body);
    const etq = (ad.body && ad.body.etiqueta) || {};
    ok(etq.material_nome === 'Auxiliar de Fluxo',
       `com o nome do material, não um rótulo chutado: ${etq.material_nome}`);
    ok(etq.cor === null, 'sem cor — cor só é exigida de quem tem cor no catálogo');

    const semCor = await req('POST', '/retirada/aditivo',
      { sessao_id: sid, materialKey: 'PIG', fornecedor: FORN, qtd_sacos: 1 });
    ok(semCor.status === 400 && /cor obrigat/i.test(semCor.body.erro || ''),
       'e o pigmento continua exigindo cor', semCor.body);
    const inventado = await req('POST', '/retirada/aditivo',
      { sessao_id: sid, materialKey: 'NAOEXISTE', fornecedor: FORN, qtd_sacos: 1 });
    ok(inventado.status === 400, 'material que não existe continua recusado', inventado.body);

  } catch (e) {
    falhou++;
    console.error('\n\x1b[31mERRO NO TESTE:\x1b[0m', e.stack || e.message);
  } finally {
    console.log('\n═══════════════════════════════════════════════════');
    console.log(` RESULTADO: ${passou} passou, ${falhou} falhou`);
    console.log('═══════════════════════════════════════════════════\n');
    try { servidor && servidor.kill('SIGKILL'); } catch (e) {}
    for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.rmSync(f, { force: true }); } catch (e) {} }
    try { fs.rmSync(TMP_LOGS, { recursive: true, force: true }); } catch (e) {}
    setTimeout(() => process.exit(falhou ? 1 : 0), 200);
  }
})();
