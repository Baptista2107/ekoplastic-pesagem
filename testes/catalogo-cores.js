// ════════════════════════════════════════════════════════════════════
//  CATÁLOGO DE CORES DE MATÉRIA-PRIMA — Ekoplastic (01/09/2026)
//
//  O BURACO QUE ISTO FECHA
//  Um fornecedor novo cadastrado no Bling entrava no sistema pela
//  sincronização; uma COR nova, não. Eram três lacunas somadas:
//    1. /sync/mp/confirmar gravava fornecedor, produto e código — nunca
//       a cor (mp_materiais ficava intocado);
//    2. a tela de Recebimento nem lia as cores do catálogo: usava uma
//       lista fixa dentro do HTML;
//    3. o reconhecimento do produto do Bling só enxergava cores já
//       cadastradas, então uma cor inédita virava "sem cor".
//  Resultado real: o AMARELO do Grão Baixa Densidade nunca apareceu.
//
//  Esta suíte prova que os três caminhos foram fechados e que a SKU —
//  que é o que casa o produto no Bling — continua saindo certa.
//
//  Como rodar:  node testes/catalogo-cores.js
// ════════════════════════════════════════════════════════════════════

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');

const ROOT     = path.join(__dirname, '..');
const SERVER   = path.join(ROOT, 'server.js');
const PORT     = 13970;
const PORT_CB  = 18970;
const BASE     = `http://localhost:${PORT}`;
const CARIMBO  = Date.now();
const TMP_DB   = path.join(os.tmpdir(), `eko_cores_${CARIMBO}.db`);
const TMP_LOGS = path.join(os.tmpdir(), `eko_cores_logs_${CARIMBO}`);

let servidor;
let passou = 0, falhou = 0;
const falhas = [];

function ok(cond, nome, detalhe = '') {
  if (cond) { passou++; console.log(`  \x1b[32m✓\x1b[0m ${nome}`); }
  else      { falhou++; falhas.push(nome); console.log(`  \x1b[31m✗ ${nome}\x1b[0m ${detalhe}`); }
}
function eq(a, b, nome) { ok(a === b, nome, `(esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function req(metodo, caminho, corpo) {
  const r = await fetch(BASE + caminho, {
    method: metodo,
    headers: corpo ? { 'Content-Type': 'application/json' } : {},
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  let json = null; try { json = await r.json(); } catch(e) {}
  return { status: r.status, json };
}

async function subirServidor() {
  servidor = spawn('node', [SERVER], {
    env: { ...process.env, EKO_PORT: String(PORT), EKO_PORT_CB: String(PORT_CB),
           EKO_DB_FILE: TMP_DB, EKO_LOG_DIR: TMP_LOGS, TZ: 'America/Sao_Paulo',
           EKO_PRINT_SIMULAR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  servidor.stdout.on('data', () => {});
  servidor.stderr.on('data', d => { if (process.env.VERBOSE) process.stderr.write(d); });
  for (let i = 0; i < 75; i++) {
    try { const r = await fetch(BASE + '/healthcheck'); if (r.ok) return; } catch(e) {}
    await sleep(200);
  }
  throw new Error('Servidor não subiu em 15s');
}

function encerrar() {
  try { servidor && servidor.kill('SIGKILL'); } catch(e) {}
  for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.rmSync(f, { force: true }); } catch(e) {} }
  try { fs.rmSync(TMP_LOGS, { recursive: true, force: true }); } catch(e) {}
}

const catalogo = async () => (await req('GET', '/catalogo-mp')).json;
const coresDe  = async mk => { const c = await catalogo(); return ((c.materiais || {})[mk] || {}).cores || []; };
const labelsDe = async mk => { const c = await catalogo(); return ((c.materiais || {})[mk] || {}).corLabel || {}; };

// ════════════════════════════════════════════════════════════════════
//  [1] O PONTO DE PARTIDA
// ════════════════════════════════════════════════════════════════════
async function testeEstadoInicial() {
  console.log('\n[1] O catálogo publica cores E abreviações da SKU');
  const c = await catalogo();
  ok(c && c.ok, 'GET /catalogo-mp responde');
  const gbd = (c.materiais || {}).GBD || {};
  ok(Array.isArray(gbd.cores) && gbd.cores.includes('Canela'), 'GBD traz as cores de sempre', JSON.stringify(gbd.cores));
  ok(!gbd.cores.includes('Amarelo'), 'GBD ainda NÃO tem Amarelo (é o caso a resolver)');

  // As abreviações moravam só no HTML. Se elas mudarem, a SKU muda, e a
  // SKU é o que casa o produto no Bling — por isso cada uma é conferida.
  const l = gbd.corLabel || {};
  eq(l['Colorido'], 'COL', 'GBD · Colorido continua COL');
  eq(l['Canela'],   'CAN', 'GBD · Canela continua CAN');
  eq(l['Preto'],    'PTO', 'GBD · Preto continua PTO (no grão é PTO, não PRE)');
  eq(l['Leitoso'],  'LEI', 'GBD · Leitoso continua LEI');
  const lp = ((c.materiais || {}).PIG || {}).corLabel || {};
  eq(lp['Preto'],   'PRE', 'PIG · Preto continua PRE (diferente do grão, de propósito)');
  eq(lp['Amarelo'], 'AMA', 'PIG · Amarelo continua AMA');
  const lpo = ((c.materiais || {}).POLI || {}).corLabel || {};
  eq(lpo['Cristal'], 'CRIS', 'POLI · Cristal continua CRIS (4 letras, não 3)');
}

// ════════════════════════════════════════════════════════════════════
//  [2] CADASTRO MANUAL — o caso do AMARELO
// ════════════════════════════════════════════════════════════════════
async function testeCadastroManual() {
  console.log('\n[2] Cadastrar cor na mão (o AMARELO do grão)');
  const r = await req('POST', '/catalogo-mp/cor', { matKey: 'GBD', cor: 'Amarelo' });
  ok(r.json && r.json.ok, 'cadastro aceito', JSON.stringify(r.json && r.json.erro));
  eq(r.json.label, 'AMA', 'sugere AMA como abreviação da SKU');
  const cores = await coresDe('GBD');
  ok(cores.includes('Amarelo'), 'Amarelo entrou na lista do GBD', JSON.stringify(cores));
  eq((await labelsDe('GBD'))['Amarelo'], 'AMA', 'a abreviação ficou gravada');

  // As outras não podem ter se mexido
  ok(cores.includes('Canela') && cores.includes('Preto') && cores.includes('Colorido') && cores.includes('Leitoso'),
     'as cores antigas continuam todas lá', JSON.stringify(cores));
  eq((await labelsDe('GBD'))['Preto'], 'PTO', 'e a abreviação delas não mudou');

  const dup = await req('POST', '/catalogo-mp/cor', { matKey: 'GBD', cor: 'Amarelo' });
  eq(dup.status, 409, 'cadastrar a mesma cor de novo é recusado');

  const semMat = await req('POST', '/catalogo-mp/cor', { matKey: 'XPTO', cor: 'Azul' });
  eq(semMat.status, 400, 'material desconhecido é recusado');

  const semNome = await req('POST', '/catalogo-mp/cor', { matKey: 'GBD', cor: '  ' });
  eq(semNome.status, 400, 'cor sem nome é recusada');

  // Abreviação personalizada (o padrão de 3 letras nem sempre serve)
  const cst = await req('POST', '/catalogo-mp/cor', { matKey: 'POLI', cor: 'Fumê', label: 'FUME' });
  ok(cst.json.ok && cst.json.label === 'FUME', 'aceita abreviação escolhida à mão', JSON.stringify(cst.json));
}

// ════════════════════════════════════════════════════════════════════
//  [3] A SKU SAI COM A ABREVIAÇÃO NOVA
//      É o teste que importa para o Bling: a etiqueta impressa carrega
//      a SKU, e é ela que casa o produto lá.
// ════════════════════════════════════════════════════════════════════
async function testeSkuDaCorNova() {
  console.log('\n[3] A etiqueta da cor nova sai com a SKU certa');
  const s = await req('POST', '/sessoes', { tipo: 'recebimento', operador: 'Teste', fornecedor: 'Cedro' });
  const r = await req('POST', '/etiquetas', {
    clientToken: 'cor-' + CARIMBO, tipo: 'recebimento',
    materialKey: 'GBD', materialNomeEt: 'BAIXA DENSIDADE', cor: 'Amarelo',
    fornecedor: 'Cedro', peso: 900, lote: 'L1', codigo: 'AMA1',
    sku: 'GBD.AMA.CED | 900 | LL1', sessao_id: s.json.sessao_id,
  });
  ok(r.json && r.json.ok, 'etiqueta de GBD Amarelo é impressa', JSON.stringify(r.json && r.json.erro));
  const et = (await req('GET', `/etiquetas/${r.json.id}`)).json.etiqueta;
  eq(et.cor, 'Amarelo', 'a etiqueta guarda a cor Amarelo');
  eq(et.sku, 'GBD.AMA.CED | 900 | LL1', 'a SKU gravada é a que a tela montou');

  await req('POST', `/etiquetas/${r.json.id}/bipar`);
  const fim = await req('POST', `/sessoes/${s.json.sessao_id}/finalizar`);
  ok(fim.json.ok, 'a sessão com a cor nova finaliza normalmente');
  ok(fim.json.resumo && fim.json.resumo.ok === true, 'e o resumo do recebimento sai como sempre');
}

// ════════════════════════════════════════════════════════════════════
//  [4] RENOMEAR ARRASTA OS VÍNCULOS
//      Renomear só na lista deixaria a etiqueta com um nome e o
//      lançamento do Bling com outro — pedido de compra sem produto.
// ════════════════════════════════════════════════════════════════════
async function testeRenomear() {
  console.log('\n[4] Renomear leva junto código gravimétrico e vínculo com o Bling');
  // Amarra a cor: um código gravimétrico e um produto do Bling.
  const cod = await req('POST', '/catalogo-mp/codigo', { matKey: 'GBD', cor: 'Amarelo', forn: 'Cedro', codigo: 'AMA9' });
  ok(cod.json && cod.json.ok, 'código gravimétrico cadastrado para GBD/Amarelo/Cedro', JSON.stringify(cod.json && cod.json.erro));
  await req('POST', '/sync/mp/confirmar', { itens: [
    { bling_id: '99999', codigo: 'GBD.AMA.CED', formato: 'V', material: 'GBD', cor: 'Amarelo', fornecedor: 'Cedro' },
  ]});
  const cfgAntes = (await req('GET', '/config')).json.config;
  const mapaAntes = JSON.parse(cfgAntes.mapa_produto_bling || '{}');
  ok(!!mapaAntes['GBD:Amarelo:Cedro'], 'o produto do Bling ficou na chave GBD:Amarelo:Cedro');

  const ren = await req('POST', '/catalogo-mp/cor', { matKey: 'GBD', cor: 'Amarelo Ouro', renomear_de: 'Amarelo', label: 'AMO' });
  ok(ren.json && ren.json.ok && ren.json.renomeado, 'renomeação aceita', JSON.stringify(ren.json && ren.json.erro));

  const cores = await coresDe('GBD');
  ok(cores.includes('Amarelo Ouro') && !cores.includes('Amarelo'), 'a lista mostra o nome novo e some com o antigo', JSON.stringify(cores));
  eq((await labelsDe('GBD'))['Amarelo Ouro'], 'AMO', 'a abreviação acompanhou');
  ok((await labelsDe('GBD'))['Amarelo'] === undefined, 'e a abreviação antiga foi embora');

  const cfg = (await req('GET', '/config')).json.config;
  const mapa = JSON.parse(cfg.mapa_produto_bling || '{}');
  ok(!!mapa['GBD:Amarelo Ouro:Cedro'], 'o produto do Bling migrou para a chave nova');
  ok(!mapa['GBD:Amarelo:Cedro'], 'e a chave antiga não ficou para trás');
  eq(ren.json.migrado.produtos_bling, 1, 'a resposta informa 1 produto migrado');

  const codigos = JSON.parse(cfg.mp_codigos_gravimetricos || '[]');
  const achou = codigos.find(c => c.matKey === 'GBD' && c.cor === 'Amarelo Ouro' && c.forn === 'Cedro');
  ok(achou && achou.codigo === 'AMA9', 'o código gravimétrico acompanhou o nome novo', JSON.stringify(achou));
  ok(!codigos.some(c => c.matKey === 'GBD' && c.cor === 'Amarelo'), 'e não sobrou código no nome antigo');

  const inexistente = await req('POST', '/catalogo-mp/cor', { matKey: 'GBD', cor: 'X', renomear_de: 'Nao Existe' });
  eq(inexistente.status, 404, 'renomear cor que não existe é recusado');
  const colide = await req('POST', '/catalogo-mp/cor', { matKey: 'GBD', cor: 'Canela', renomear_de: 'Amarelo Ouro' });
  eq(colide.status, 409, 'renomear para um nome que já existe é recusado');

  // Volta ao nome simples para os testes seguintes
  await req('POST', '/catalogo-mp/cor', { matKey: 'GBD', cor: 'Amarelo', renomear_de: 'Amarelo Ouro', label: 'AMA' });
}

// ════════════════════════════════════════════════════════════════════
//  [5] REMOVER NÃO APAGA COR EM USO SEM AVISAR
// ════════════════════════════════════════════════════════════════════
async function testeRemover() {
  console.log('\n[5] Remover avisa quando a cor ainda está amarrada');
  const presa = await req('POST', '/catalogo-mp/cor/remover', { matKey: 'GBD', cor: 'Amarelo' });
  eq(presa.status, 409, 'recusa remover cor com código e produto amarrados');
  ok(presa.json && presa.json.em_uso === true, 'e diz que está em uso');
  ok(Array.isArray(presa.json.produtos_bling) && presa.json.produtos_bling.length >= 1,
     'listando o que está preso', JSON.stringify(presa.json.produtos_bling));
  ok((await coresDe('GBD')).includes('Amarelo'), 'a cor continua lá depois da recusa');

  const forcado = await req('POST', '/catalogo-mp/cor/remover', { matKey: 'GBD', cor: 'Amarelo', forcar: true });
  ok(forcado.json && forcado.json.ok, 'com confirmação explícita, remove');
  ok(!(await coresDe('GBD')).includes('Amarelo'), 'e a cor sai da lista');

  const semUso = await req('POST', '/catalogo-mp/cor/remover', { matKey: 'POLI', cor: 'Fumê' });
  ok(semUso.json && semUso.json.ok, 'cor sem vínculo nenhum sai direto');

  const naoExiste = await req('POST', '/catalogo-mp/cor/remover', { matKey: 'GBD', cor: 'Turquesa' });
  eq(naoExiste.status, 404, 'remover cor inexistente é recusado');

  // Recoloca o Amarelo — é o estado que o usuário quer no fim
  await req('POST', '/catalogo-mp/cor', { matKey: 'GBD', cor: 'Amarelo', label: 'AMA' });
  ok((await coresDe('GBD')).includes('Amarelo'), 'Amarelo recadastrado para os testes seguintes');
}

// ════════════════════════════════════════════════════════════════════
//  [6] A SINCRONIZAÇÃO CADASTRA A COR JUNTO COM O PRODUTO
// ════════════════════════════════════════════════════════════════════
async function testeSyncConfirmarCadastraCor() {
  console.log('\n[6] /sync/mp/confirmar passa a gravar a cor no material');
  ok(!(await coresDe('POLI')).includes('Azul'), 'POLI ainda não tem Azul');
  const r = await req('POST', '/sync/mp/confirmar', { itens: [
    { bling_id: '77777', codigo: 'POLI.AZU.ECOLOG', formato: 'V',
      material: 'POLI', cor: 'Azul', fornecedor: 'Ecolog', cor_label: 'AZU' },
  ]});
  ok(r.json && r.json.ok, 'confirmação aceita');
  eq(r.json.cadastrados, 1, 'cadastrou o produto');
  ok(Array.isArray(r.json.cores_cadastradas) && r.json.cores_cadastradas.length === 1,
     'e informa a cor nova que criou', JSON.stringify(r.json.cores_cadastradas));
  ok((await coresDe('POLI')).includes('Azul'), 'Azul entrou nas cores do POLI');
  eq((await labelsDe('POLI'))['Azul'], 'AZU', 'com a abreviação enviada');

  // Fornecedor continua entrando como sempre (não regredimos nada)
  const cat = await catalogo();
  ok((cat.fornecedores.POLI || []).includes('Ecolog'), 'o fornecedor segue sendo cadastrado como antes');

  // Item repetido não duplica a cor
  await req('POST', '/sync/mp/confirmar', { itens: [
    { bling_id: '77777', codigo: 'POLI.AZU.ECOLOG', formato: 'V', material: 'POLI', cor: 'Azul', fornecedor: 'Ecolog' },
  ]});
  eq((await coresDe('POLI')).filter(c => c === 'Azul').length, 1, 'confirmar de novo não duplica a cor');
}

// ════════════════════════════════════════════════════════════════════
//  [7] O QUE A TELA DE RECEBIMENTO ENXERGA
//      A tela monta a lista de cores a partir de /catalogo-mp. Aqui a
//      conferência é do dado que ela recebe.
// ════════════════════════════════════════════════════════════════════
async function testeContratoDaTela() {
  console.log('\n[7] O que a tela de Recebimento recebe do catálogo');
  const c = await catalogo();
  const gbd = c.materiais.GBD;
  ok(gbd.cores.includes('Amarelo'), 'GBD chega na tela COM Amarelo — o pedido original', JSON.stringify(gbd.cores));
  ok(gbd.corLabel && gbd.corLabel['Amarelo'] === 'AMA', 'e com a abreviação para montar a SKU');
  ok(Array.isArray(c.materiais.CARBO.cores) && c.materiais.CARBO.cores.length === 0,
     'material sem cor continua sem cor (Carbonato)');
  for (const k of ['GBD','POLI','CARBO','PIG','DESSEC']) {
    ok(c.materiais[k] && typeof c.materiais[k].corLabel === 'object',
       `${k} publica o mapa de abreviações (mesmo vazio)`);
  }
}

// ════════════════════════════════════════════════════════════════════
//  [8] BANCO QUE JÁ EXISTE — o caso do Mini PC
//      Lá o mp_materiais foi gravado ANTES de existir corLabel. Se o
//      patch de subida não semear as abreviações, a tela monta a SKU
//      pelas 3 primeiras letras e "Preto" do grão viraria PRE em vez de
//      PTO — produto errado no Bling, silenciosamente.
// ════════════════════════════════════════════════════════════════════
async function testeBancoAntigo() {
  console.log('\n[8] Banco antigo (sem corLabel) ganha as abreviações ao subir');

  // Regrava o catálogo no formato ANTIGO, sem corLabel nenhum.
  const antigo = {
    GBD:    { popular: 'Grão Baixa Densidade', cores: ['Colorido','Canela','Preto','Leitoso'] },
    POLI:   { popular: 'Polinylon',            cores: ['Colorido','Canela','Cristal','Leitoso'] },
    CARBO:  { popular: 'Carbonato',            cores: [] },
    PIG:    { popular: 'Pigmento',             cores: ['Amarelo','Branco','Preto','Verde'] },
    DESSEC: { popular: 'Dessecante',           cores: [] },
  };
  await req('POST', '/config', { mp_materiais: JSON.stringify(antigo) });
  ok(Object.keys((await labelsDe('GBD'))).length === 0, 'catálogo voltou ao formato antigo (sem abreviações)');

  // Reinicia o servidor no MESMO banco — é o que acontece no Mini PC
  // quando a atualização sobe.
  try { servidor.kill('SIGKILL'); } catch(e) {}
  await sleep(600);
  await subirServidor();

  const l = await labelsDe('GBD');
  eq(l['Preto'],   'PTO', 'depois de subir, GBD/Preto voltou a ser PTO (e não PRE)');
  eq(l['Canela'],  'CAN', 'GBD/Canela = CAN');
  eq(l['Leitoso'], 'LEI', 'GBD/Leitoso = LEI');
  eq((await labelsDe('PIG'))['Preto'], 'PRE', 'PIG/Preto = PRE, cada material com o seu');
  eq((await labelsDe('POLI'))['Cristal'], 'CRIS', 'POLI/Cristal = CRIS');

  // E as cores que o usuário tinha cadastrado não podem ter sumido no patch
  const cores = await coresDe('GBD');
  ok(cores.length === 4 && cores.includes('Colorido'), 'o patch não mexeu nas cores em si', JSON.stringify(cores));
}

// ════════════════════════════════════════════════════════════════════
(async () => {
  console.log('═══════════════════════════════════════════════════');
  console.log(' CATÁLOGO DE CORES DE MP — Ekoplastic');
  console.log('═══════════════════════════════════════════════════');
  try {
    console.log('Subindo servidor de teste...');
    await subirServidor();
    console.log(`Servidor no ar em ${BASE} (banco temporário)`);

    await testeEstadoInicial();
    await testeCadastroManual();
    await testeSkuDaCorNova();
    await testeRenomear();
    await testeRemover();
    await testeSyncConfirmarCadastraCor();
    await testeContratoDaTela();
    await testeBancoAntigo();

    console.log('\n═══════════════════════════════════════════════════');
    console.log(` RESULTADO: ${passou} passaram, ${falhou} falharam`);
    if (falhou) { console.log(' FALHAS:'); falhas.forEach(f => console.log('   - ' + f)); }
    console.log('═══════════════════════════════════════════════════');
  } catch (e) {
    console.error('\nERRO FATAL:', e.message);
    falhou++;
  } finally {
    encerrar();
    setTimeout(() => process.exit(falhou ? 1 : 0), 200);
  }
})();
