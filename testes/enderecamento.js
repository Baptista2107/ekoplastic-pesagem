// ════════════════════════════════════════════════════════════════════
//  ENDEREÇAMENTO DO GALPÃO — Ekoplastic (04/09/2026)
//
//  Amarra uma GAIOLA de produto acabado a um ENDEREÇO de prateleira.
//  As duas regras do modelo — um endereço tem um morador, e uma gaiola
//  mora num lugar só — são índices ÚNICOS no banco, não verificação de
//  código. Esta suíte prova as duas pela porta da frente e pela porta
//  dos fundos (duas leituras ao mesmo tempo).
//
//  Prova também:
//   · as 138 posições nascem certas, com as 2 bloqueadas;
//   · endereço bloqueado não recebe palete;
//   · liberar devolve o endereço e PRESERVA o histórico;
//   · a etiqueta da gaiola ganhou o tipo sem quebrar o inventário,
//     que exige 6 campos e agora recebe 7.
//
//  Como rodar:  node testes/enderecamento.js
// ════════════════════════════════════════════════════════════════════

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');

const ROOT     = path.join(__dirname, '..');
const SERVER   = path.join(ROOT, 'server.js');
const PORT     = 13995;
const PORT_CB  = 18995;
const BASE     = `http://localhost:${PORT}`;
const CARIMBO  = Date.now();
const TMP_DB   = path.join(os.tmpdir(), `eko_end_${CARIMBO}.db`);
const TMP_LOGS = path.join(os.tmpdir(), `eko_end_logs_${CARIMBO}`);
const DIR_EPL  = path.join(TMP_LOGS, 'print-simulado');

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

const mapa = async () => (await req('GET', '/enderecamento/mapa')).json;

// Cria uma gaiola de verdade (com etiqueta impressa) e devolve o id.
async function novaGaiola(fardos = 24, tipo = null) {
  const r = await req('POST', '/produto-acabado/etiqueta-gaiola', {
    corKey: 'BC', formato: '50x60', fardos, ...(tipo ? { tipo_gaiola: tipo } : {}),
  });
  if (!r.json || !r.json.ok) throw new Error('não criou gaiola: ' + JSON.stringify(r.json));
  return r.json;
}

function eplsGaiola() {
  if (!fs.existsSync(DIR_EPL)) return [];
  return fs.readdirSync(DIR_EPL).map(f => fs.readFileSync(path.join(DIR_EPL, f), 'latin1'))
           .filter(t => /EKOPA\|/.test(t));
}

// ════════════════════════════════════════════════════════════════════
//  [1] O GALPÃO NASCE DESENHADO
// ════════════════════════════════════════════════════════════════════
async function testeLayout() {
  console.log('\n[1] As 138 posições do galpão nascem no banco');
  const d = await mapa();
  ok(d && d.ok, 'GET /enderecamento/mapa responde');
  eq(d.posicoes.length, 138, 'são 138 posições no total');
  eq(d.resumo.bloqueadas, 2, 'duas bloqueadas (hidrante e espaço da informação)');
  eq(d.resumo.uteis, 136, '136 úteis');
  eq(d.resumo.ocupadas, 0, 'nenhuma ocupada no começo');
  eq(d.resumo.livres, 136, 'e 136 livres');

  const r1 = d.posicoes.filter(p => p.rua === 1), r2 = d.posicoes.filter(p => p.rua === 2);
  eq(r1.length, 60, 'rua 01 com 20 vãos × 3 níveis');
  eq(r2.length, 78, 'rua 02 com 26 vãos × 3 níveis');

  const hidrante = d.posicoes.find(p => p.codigo === '01-01-005');
  ok(hidrante && hidrante.bloqueada && /HIDRANTE/i.test(hidrante.motivo || ''), 'o hidrante está em 01-01-005 e bloqueado', JSON.stringify(hidrante));
  const info = d.posicoes.find(p => p.codigo === '01-01-006');
  ok(info && info.bloqueada, 'o espaço da informação está em 01-01-006 e bloqueado');

  // O nível 01 é o mais alto de propósito: é o das gaiolas grandes.
  const n1 = d.posicoes.filter(p => p.nivel === 1);
  ok(n1.every(p => p.tipo_gaiola === 'GRANDE'), 'todo o nível 01 é vão de gaiola GRANDE');
  ok(d.posicoes.filter(p => p.nivel !== 1).every(p => p.tipo_gaiola === 'PEQUENA'),
     'níveis 02 e 03 são vãos de gaiola PEQUENA');
  eq(n1.filter(p => !p.bloqueada).length, 44, 'sobram 44 vãos grandes utilizáveis');

  const cods = new Set(d.posicoes.map(p => p.codigo));
  eq(cods.size, 138, 'nenhum código repetido');
  ok(cods.has('01-01-001') && cods.has('02-03-026'), 'primeiro e último códigos no formato certo');
}

// ════════════════════════════════════════════════════════════════════
//  [2] ENDEREÇAR — o caminho feliz
// ════════════════════════════════════════════════════════════════════
let GAIOLA_A, GAIOLA_B;
async function testeOcupar() {
  console.log('\n[2] Guardar uma gaiola num endereço');
  GAIOLA_A = await novaGaiola(24, 'PEQUENA');
  ok(/^G\d{7}$/.test(GAIOLA_A.id), 'gaiola criada com etiqueta impressa', GAIOLA_A.id);

  const r = await req('POST', '/enderecamento/ocupar', {
    posicao: '01-02-003', gaiola_id: GAIOLA_A.id, operador: 'Teste' });
  ok(r.json && r.json.ok, 'endereçamento aceito', JSON.stringify(r.json && r.json.erro));
  eq(r.json.ocupacao.posicao, '01-02-003', 'gravado no endereço certo');
  eq(r.json.ocupacao.gaiola_id, GAIOLA_A.id, 'com a gaiola certa');
  // Os dados do produto vêm do REGISTRO da gaiola, não do que o celular mandou.
  eq(r.json.ocupacao.formato, '50x60', 'o formato veio do registro da gaiola');
  eq(r.json.ocupacao.fardos, 24, 'e a quantidade de fardos também');
  eq(r.json.ocupacao.kg, 600, 'com o peso calculado (24 × 25 kg)');
  ok(!r.json.aviso, 'sem aviso: gaiola pequena em nível de gaiola pequena');

  const d = await mapa();
  eq(d.resumo.ocupadas, 1, 'o mapa passa a mostrar 1 ocupada');
  eq(d.resumo.livres, 135, 'e 135 livres');
  eq(d.resumo.fardos, 24, 'somando os fardos guardados');
  eq(d.resumo.kg, 600, 'e o peso em estoque');
  const p = d.posicoes.find(x => x.codigo === '01-02-003');
  ok(p.ocupada && p.gaiola.id === GAIOLA_A.id, 'a posição aparece ocupada no mapa');
  eq(p.gaiola.dias, 0, 'parada há 0 dias (acabou de entrar)');

  const det = await req('GET', '/enderecamento/posicao/01-02-003');
  ok(det.json.ok && det.json.atual, 'o detalhe da posição mostra o morador');
  const g = await req('GET', '/enderecamento/gaiola/' + GAIOLA_A.id);
  eq(g.json.atual.posicao, '01-02-003', 'e pela gaiola dá para achar o endereço');
}

// ════════════════════════════════════════════════════════════════════
//  [3] AS DUAS REGRAS DO MODELO
// ════════════════════════════════════════════════════════════════════
async function testeRegras() {
  console.log('\n[3] Um endereço, um morador — e uma gaiola num lugar só');
  GAIOLA_B = await novaGaiola(12, 'PEQUENA');

  const ocupado = await req('POST', '/enderecamento/ocupar', { posicao: '01-02-003', gaiola_id: GAIOLA_B.id });
  eq(ocupado.status, 409, 'endereço ocupado recusa outra gaiola');
  ok(/já tem a gaiola/i.test(ocupado.json.erro || ''), 'e diz qual gaiola está lá', ocupado.json.erro);

  const mesma = await req('POST', '/enderecamento/ocupar', { posicao: '01-02-003', gaiola_id: GAIOLA_A.id });
  ok(mesma.json.ok && mesma.json.ja_estava, 'reler a MESMA gaiola no MESMO lugar não é erro — só confirma');

  const doisLugares = await req('POST', '/enderecamento/ocupar', { posicao: '02-02-010', gaiola_id: GAIOLA_A.id });
  eq(doisLugares.status, 409, 'a mesma gaiola não pode estar em dois endereços');
  ok(/já está endereçada em 01-02-003/i.test(doisLugares.json.erro || ''), 'e diz onde ela está', doisLugares.json.erro);

  const bloqueada = await req('POST', '/enderecamento/ocupar', { posicao: '01-01-005', gaiola_id: GAIOLA_B.id });
  eq(bloqueada.status, 409, 'endereço do hidrante recusa palete');
  ok(/HIDRANTE/i.test(bloqueada.json.erro || ''), 'dizendo o motivo do bloqueio', bloqueada.json.erro);

  const inexistente = await req('POST', '/enderecamento/ocupar', { posicao: '09-09-999', gaiola_id: GAIOLA_B.id });
  eq(inexistente.status, 404, 'endereço que não existe é recusado');
  const formatoRuim = await req('POST', '/enderecamento/ocupar', { posicao: 'RUA1', gaiola_id: GAIOLA_B.id });
  eq(formatoRuim.status, 400, 'código fora do padrão RR-NN-PPP é recusado');

  // Etiqueta de big bag no fluxo de gaiola é engano — melhor recusar.
  const naoEhGaiola = await req('POST', '/enderecamento/ocupar', { posicao: '02-02-010', gaiola_id: 'R0000123' });
  eq(naoEhGaiola.status, 400, 'etiqueta de big bag (R…) não entra como gaiola');
  ok(/começa com G/i.test(naoEhGaiola.json.erro || ''), 'e a mensagem explica o que se espera', naoEhGaiola.json.erro);
}

// ════════════════════════════════════════════════════════════════════
//  [4] DUAS LEITURAS AO MESMO TEMPO
//      A trava é índice único no banco. Se fosse só verificação em
//      código, duas leituras simultâneas passariam pelas duas.
// ════════════════════════════════════════════════════════════════════
async function testeCorrida() {
  console.log('\n[4] Duas leituras no mesmo instante não duplicam');
  const g1 = await novaGaiola(8), g2 = await novaGaiola(9);
  const [a, b] = await Promise.all([
    req('POST', '/enderecamento/ocupar', { posicao: '02-03-001', gaiola_id: g1.id }),
    req('POST', '/enderecamento/ocupar', { posicao: '02-03-001', gaiola_id: g2.id }),
  ]);
  const okN = [a, b].filter(x => x.json && x.json.ok).length;
  eq(okN, 1, 'só uma das duas leituras ocupou o endereço');
  const det = await req('GET', '/enderecamento/posicao/02-03-001');
  ok(det.json.atual, 'o endereço ficou com exatamente um morador');
  const hist = det.json.historico.filter(h => !h.saida);
  eq(hist.length, 1, 'e uma única ocupação aberta no histórico');

  // A mesma gaiola disparada para dois endereços diferentes
  const g3 = await novaGaiola(7);
  const [c, e] = await Promise.all([
    req('POST', '/enderecamento/ocupar', { posicao: '02-03-002', gaiola_id: g3.id }),
    req('POST', '/enderecamento/ocupar', { posicao: '02-03-003', gaiola_id: g3.id }),
  ]);
  eq([c, e].filter(x => x.json && x.json.ok).length, 1, 'a gaiola só entrou em um dos dois endereços');
}

// ════════════════════════════════════════════════════════════════════
//  [5] RETIRAR — e o histórico continua lá
// ════════════════════════════════════════════════════════════════════
async function testeLiberar() {
  console.log('\n[5] Retirar devolve o endereço e guarda a passagem');
  const antes = (await mapa()).resumo.ocupadas;

  const porEndereco = await req('POST', '/enderecamento/liberar', { posicao: '01-02-003', operador: 'Teste', motivo: 'carregamento' });
  ok(porEndereco.json.ok, 'liberar pelo endereço funciona');
  eq(porEndereco.json.gaiola_id, GAIOLA_A.id, 'devolvendo qual gaiola saiu');

  const d = await mapa();
  eq(d.resumo.ocupadas, antes - 1, 'o mapa tem uma ocupada a menos');
  const p = d.posicoes.find(x => x.codigo === '01-02-003');
  ok(!p.ocupada && !p.gaiola, 'e a posição aparece livre');

  const det = await req('GET', '/enderecamento/posicao/01-02-003');
  ok(!det.json.atual, 'não há morador atual');
  const passagem = det.json.historico.find(h => h.gaiola_id === GAIOLA_A.id);
  ok(passagem && passagem.saida, 'mas o histórico guarda que ela esteve ali, com a data de saída');
  eq(passagem.motivo_saida, 'carregamento', 'e o motivo informado');
  eq(passagem.formato, '50x60', 'com o retrato do produto preservado');

  // O endereço volta a aceitar gaiola
  const denovo = await req('POST', '/enderecamento/ocupar', { posicao: '01-02-003', gaiola_id: GAIOLA_B.id });
  ok(denovo.json.ok, 'o endereço liberado recebe outra gaiola');
  const det2 = await req('GET', '/enderecamento/posicao/01-02-003');
  ok(det2.json.historico.length >= 2, 'e o histórico agora tem as duas passagens', String(det2.json.historico.length));

  // Liberar pela gaiola (é o que está mais à mão no chão de fábrica)
  const porGaiola = await req('POST', '/enderecamento/liberar', { gaiola_id: GAIOLA_B.id });
  ok(porGaiola.json.ok, 'liberar pela gaiola também funciona');
  eq(porGaiola.json.posicao, '01-02-003', 'achando o endereço sozinho');

  const vazio = await req('POST', '/enderecamento/liberar', { posicao: '01-02-003' });
  eq(vazio.status, 404, 'liberar endereço já vazio é recusado com clareza');
  ok(vazio.json.ja_vazio === true, 'e sinalizado como já vazio');

  const divergente = await req('POST', '/enderecamento/liberar', { posicao: '02-03-001', gaiola_id: 'G9999999' });
  eq(divergente.status, 409, 'endereço e gaiola que não combinam são recusados');
}

// ════════════════════════════════════════════════════════════════════
//  [6] AVISO DA GAIOLA GRANDE (aviso, não bloqueio)
// ════════════════════════════════════════════════════════════════════
async function testeAvisoGrande() {
  console.log('\n[6] Gaiola grande em nível de cima: avisa, não impede');
  const g = await novaGaiola(30, 'GRANDE');
  const r = await req('POST', '/enderecamento/ocupar', {
    posicao: '02-03-020', gaiola_id: g.id, tipo_gaiola: 'GRANDE' });
  ok(r.json.ok, 'o endereçamento é ACEITO (quem impede de verdade é o vão)');
  ok(/GRANDE/i.test(r.json.aviso || ''), 'mas vem com aviso', r.json.aviso);

  const chao = await novaGaiola(30, 'GRANDE');
  const r2 = await req('POST', '/enderecamento/ocupar', {
    posicao: '02-01-020', gaiola_id: chao.id, tipo_gaiola: 'GRANDE' });
  ok(r2.json.ok && !r2.json.aviso, 'gaiola grande no nível 01 entra sem aviso nenhum');

  const peq = await novaGaiola(6, 'PEQUENA');
  const r3 = await req('POST', '/enderecamento/ocupar', {
    posicao: '02-01-021', gaiola_id: peq.id, tipo_gaiola: 'PEQUENA' });
  ok(r3.json.ok && !r3.json.aviso, 'gaiola pequena no chão também não gera aviso (só desperdiça vão)');
}

// ════════════════════════════════════════════════════════════════════
//  [7] A ETIQUETA DA GAIOLA GANHOU O TIPO — sem quebrar o inventário
// ════════════════════════════════════════════════════════════════════
async function testeEtiqueta() {
  console.log('\n[7] O tipo da gaiola foi para o QR sem quebrar a leitura antiga');
  const com = await novaGaiola(20, 'GRANDE');
  eq(com.tipo_gaiola, 'GRANDE', 'a resposta declara o tipo');
  ok(com.conteudo_qr.endsWith('|GRANDE'), 'o QR termina com o tipo', com.conteudo_qr);
  eq(com.conteudo_qr.split('|').length, 7, 'são 7 campos');
  // O inventário exige EKOPA + ao menos 6 campos. 7 continua passando.
  const partes = com.conteudo_qr.split('|');
  eq(partes[0], 'EKOPA', 'o primeiro campo continua EKOPA');
  ok(partes.length >= 6, 'e a regra do inventário (6 campos ou mais) segue valendo');

  const sem = await novaGaiola(20);
  eq(sem.conteudo_qr.split('|').length, 6, 'sem informar o tipo, a etiqueta sai como sempre foi (6 campos)');
  ok(!sem.tipo_gaiola, 'e o tipo fica em branco');

  await sleep(300);
  const epls = eplsGaiola();
  ok(epls.some(t => /EKOPA\|[^"]*\|GRANDE/.test(t)), 'o EPL impresso leva o tipo dentro do QR');
  ok(epls.some(t => /GAIOLA GRANDE/.test(t)), 'e o tipo também sai escrito, para quem lê com o olho');

  const invalido = await req('POST', '/produto-acabado/etiqueta-gaiola', {
    corKey: 'BC', formato: '50x60', fardos: 5, tipo_gaiola: 'ENORME' });
  ok(invalido.json.ok && !invalido.json.tipo_gaiola, 'tipo desconhecido é ignorado em vez de virar lixo na etiqueta');
}

// ════════════════════════════════════════════════════════════════════
//  [8] O RESTO DO SISTEMA SEGUE INTACTO
// ════════════════════════════════════════════════════════════════════
async function testeNaoQuebrou() {
  console.log('\n[8] Nada do que já rodava foi afetado');
  const h = await req('GET', '/healthcheck');
  ok(h.json.ok, 'healthcheck continua respondendo');

  // Produção de PA continua fechando e imprimindo o resumo
  const s = await req('POST', '/sessoes', { tipo: 'produto-acabado', operador: 'T', maquina: 'P1', turno_codigo: 'PA-A1' });
  const it = await req('POST', '/produto-acabado/item', {
    sessao_id: s.json.sessao_id, corKey: 'BC', formato: '50x60', fardos: 4, maquina: 'P1' });
  ok(it.json.ok, 'lançamento de produto acabado segue funcionando');
  const fim = await req('POST', `/sessoes/${s.json.sessao_id}/finalizar`);
  ok(fim.json.ok && fim.json.resumo && fim.json.resumo.ok, 'e o resumo de PA continua saindo ao finalizar');

  // A contagem de gaiola do inventário continua achando a gaiola
  const g = await novaGaiola(10, 'PEQUENA');
  const inv = await req('GET', '/inventario/pa/gaiola/' + g.id);
  ok(inv.json.ok && inv.json.gaiola.fardos === 10, 'o inventário continua encontrando a gaiola pelo id');

  const hist = await req('GET', '/enderecamento/historico?limit=5');
  ok(hist.json.ok && Array.isArray(hist.json.movimentos), 'o histórico de movimentos responde');
  ok(hist.json.movimentos.length <= 5, 'respeitando o limite pedido');
}

// ════════════════════════════════════════════════════════════════════
//  [9] O QUE JÁ ESTAVA ENDEREÇADO SOBREVIVE A UM RESTART
// ════════════════════════════════════════════════════════════════════
async function testeRestart() {
  console.log('\n[9] O endereçamento sobrevive ao restart da atualização');
  const antes = (await mapa()).resumo;
  try { servidor.kill('SIGKILL'); } catch(e) {}
  await sleep(600);
  await subirServidor();
  const dep = (await mapa()).resumo;
  eq(dep.total, 138, 'continuam 138 posições (a semeadura não duplica)');
  eq(dep.ocupadas, antes.ocupadas, 'as ocupações continuam lá');
  eq(dep.kg, antes.kg, 'com o mesmo peso guardado');
  const p = (await mapa()).posicoes.find(x => x.codigo === '02-01-020');
  ok(p && p.ocupada, 'e a posição de exemplo continua ocupada depois do restart');
}

// ════════════════════════════════════════════════════════════════════
(async () => {
  console.log('═══════════════════════════════════════════════════');
  console.log(' ENDEREÇAMENTO DO GALPÃO — Ekoplastic');
  console.log('═══════════════════════════════════════════════════');
  try {
    console.log('Subindo servidor de teste...');
    await subirServidor();
    console.log(`Servidor no ar em ${BASE} (banco temporário)`);

    await testeLayout();
    await testeOcupar();
    await testeRegras();
    await testeCorrida();
    await testeLiberar();
    await testeAvisoGrande();
    await testeEtiqueta();
    await testeNaoQuebrou();
    await testeRestart();

    console.log('\n═══════════════════════════════════════════════════');
    console.log(` RESULTADO: ${passou} passaram, ${falhou} falharam`);
    if (falhou) { console.log(' FALHAS:'); falhas.forEach(f => console.log('   - ' + f)); }
    console.log('═══════════════════════════════════════════════════');
  } catch (e) {
    console.error('\nERRO FATAL:', e.stack || e.message);
    falhou++;
  } finally {
    encerrar();
    setTimeout(() => process.exit(falhou ? 1 : 0), 200);
  }
})();
