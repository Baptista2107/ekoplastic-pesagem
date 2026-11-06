// ════════════════════════════════════════════════════════════════════
//  RESUMO DO DIA COM RESPONSÁVEL — Ekoplastic (06/11/2026)
//  Gustavo: "o resumo do dia no mini pc coloca os responsáveis de quem
//  fez o que". Sobe o server.js REAL e prova, ponta a ponta:
//
//   A) Cada linha do Resumo do dia (retirada / resíduos) traz QUEM fez,
//      e a linha de cada bag sai com o nome de quem a retirou (não de outro).
//   B) No fim do papel, bloco POR RESPONSAVEL: operações, itens e kg por
//      pessoa; quem não se identificou soma em "sem identificacao".
//   C) Toda linha de item cabe em 46 caracteres (font 2 na etiqueta 100x150).
//   D) A prévia (GET /resumo-dia) devolve os mesmos totais por pessoa.
//   E) POST /sessoes/:id/operador: só preenche sessão ABERTA e SEM nome;
//      repetido (sequência e ao mesmo tempo) não troca quem ficou gravado.
//   F) O resumo da operação (relatório atual) mostra "Resp: NOME".
//   G) As telas de Retirada e Resíduos pedem o PIN (tela 'mp') e mandam
//      o operador ao abrir a sessão (conferência estática do HTML).
//
//  Como rodar:   node testes/resumo-dia-responsavel.js
// ════════════════════════════════════════════════════════════════════

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');

const ROOT     = path.join(__dirname, '..');
const SERVER   = path.join(ROOT, 'server.js');
const PORT     = 13945;
const PORT_CB  = 18945;
const BASE     = `http://localhost:${PORT}`;
const CARIMBO  = Date.now();
const TMP_DB   = path.join(os.tmpdir(), `eko_resp_${CARIMBO}.db`);
const TMP_LOGS = path.join(os.tmpdir(), `eko_resp_logs_${CARIMBO}`);
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
           EKO_DB_FILE: TMP_DB, EKO_LOG_DIR: TMP_LOGS,
           TZ: 'America/Sao_Paulo',
           EKO_PRINT_SIMULAR: '1' },   // NUNCA imprimir de verdade
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

// Último papel impresso cujo título casa com o regex.
function ultimoPapel(regex) {
  if (!fs.existsSync(DIR_EPL)) return null;
  const fs_ = fs.readdirSync(DIR_EPL).sort()
    .map(f => fs.readFileSync(path.join(DIR_EPL, f), 'latin1'))
    .filter(t => regex.test(t));
  return fs_.length ? fs_[fs_.length - 1] : null;
}
// Texto das linhas de ITEM (font 2 em x=50) e dos cabeçalhos de grupo.
const linhasItem  = epl => [...epl.matchAll(/^A50,\d+,0,2,1,1,N,"(.*)"$/gm)].map(m => m[1]);
const linhasGrupo = epl => [...epl.matchAll(/^A30,\d+,0,3,1,1,N,"(.*)"$/gm)].map(m => m[1]);

const hojeISO = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

async function bigBags(qtd, fornecedor) {
  const s = await req('POST', '/sessoes', { tipo: 'recebimento', operador: 'Recebedor', fornecedor });
  const sid = s.json.sessao_id;
  const ids = [];
  for (let i = 0; i < qtd; i++) {
    const r = await req('POST', '/etiquetas', {
      clientToken: `bb-${fornecedor}-${i}-${CARIMBO}`, tipo: 'recebimento',
      materialKey: 'GBD', materialNomeEt: 'BAIXA DENSIDADE', cor: 'Canela',
      fornecedor, peso: 1000 + i, lote: 'L1', codigo: 'CAN1',
      sku: 'GBD.CAN.X | 1000 | LL1', sessao_id: sid,
    });
    ids.push(r.json.id);
    await req('POST', `/etiquetas/${r.json.id}/bipar`);
  }
  await req('POST', `/sessoes/${sid}/finalizar`);
  return ids;
}

async function retirada(operador, origIds) {
  const corpo = { tipo: 'retirada' };
  if (operador !== undefined) corpo.operador = operador;
  const s = await req('POST', '/sessoes', corpo);
  const sid = s.json.sessao_id;
  for (const oid of origIds) await req('POST', `/etiquetas/${oid}/consumir`, { sessao_id: sid });
  await req('POST', `/sessoes/${sid}/finalizar`);
  return sid;
}

async function residuos(operador, pesos) {
  const corpo = { tipo: 'outras' };
  if (operador !== undefined) corpo.operador = operador;
  const s = await req('POST', '/sessoes', corpo);
  const sid = s.json.sessao_id;
  for (const [i, p] of pesos.entries()) {
    const r = await req('POST', '/etiquetas/outras', { clientToken: `res-${sid}-${i}`, sessao_id: sid, item_codigo: 'RES.BORRA', peso: p });
    await req('POST', `/etiquetas/${r.json.id}/bipar`);
  }
  await req('POST', `/sessoes/${sid}/finalizar`);
  return sid;
}

// ════════════════════════════════════════════════════════════════════
async function testeRetirada() {
  console.log('\n[A-D] Resumo do dia da RETIRADA com responsável');
  const bagsA = await bigBags(2, 'Cedro');
  const bagsH = await bigBags(1, 'Cristal Master');   // fornecedor maior que a coluna
  const bagsS = await bigBags(1, 'Karina');
  await retirada('ADNILSON RIBEIRO', bagsA);
  await retirada('Henrique', bagsH);
  await retirada(undefined, bagsS);           // operação sem identificação (histórico)

  // D) prévia
  const pv = await req('GET', `/resumo-dia?tipo=retirada&data=${hojeISO()}`);
  ok(pv.json && pv.json.ok, 'prévia do resumo do dia responde');
  const rs = (pv.json && pv.json.responsaveis) || [];
  eq(rs.length, 3, 'prévia: 3 grupos de responsável (2 nomes + sem identificação)');
  const adn = rs.find(r => r.nome === 'ADNILSON RIBEIRO') || {};
  eq(adn.operacoes, 1, 'prévia: ADNILSON fez 1 operação');
  eq(adn.itens, 2, 'prévia: ADNILSON retirou 2 bags');
  eq(adn.kg, 2001, 'prévia: ADNILSON retirou 2.001 kg');
  const hen = rs.find(r => r.nome === 'Henrique') || {};
  eq(hen.itens, 1, 'prévia: Henrique retirou 1 bag');
  eq(rs[rs.length - 1] && rs[rs.length - 1].nome, null, 'prévia: sem identificação vem por último, com nome null');
  eq(rs[rs.length - 1] && rs[rs.length - 1].itens, 1, 'prévia: sem identificação soma 1 bag');

  // A-C) papel
  const imp = await req('POST', '/resumo-dia', { tipo: 'retirada', data: hojeISO() });
  ok(imp.json && imp.json.ok, 'resumo do dia da retirada imprime');
  const epl = ultimoPapel(/RESUMO DO DIA - RETIRADA/);
  ok(!!epl, 'saiu o papel do resumo do dia da retirada');
  if (!epl) return;
  const itens = linhasItem(epl);
  for (const id of bagsA) {
    const ln = itens.find(l => l.includes(id)) || '';
    ok(/ADNILSON\s*$/.test(ln), `linha do bag ${id} diz ADNILSON`, `(linha: "${ln}")`);
  }
  const lnH = itens.find(l => l.includes(bagsH[0])) || '';
  ok(/Henrique\s*$/.test(lnH), `linha do bag ${bagsH[0]} diz Henrique`, `(linha: "${lnH}")`);
  ok(lnH.includes('Cristal Ma ' + bagsH[0]), 'fornecedor comprido é cortado com espaço antes do código (não cola)', `(linha: "${lnH}")`);
  const lnS = itens.find(l => l.includes(bagsS[0])) || '';
  ok(/ -\s*$/.test(lnS), `linha do bag ${bagsS[0]} (sem identificação) termina em "-"`, `(linha: "${lnS}")`);
  ok(/Cedro/.test(itens.find(l => l.includes(bagsA[0])) || ''), 'a linha da retirada continua com o fornecedor');

  const grandes = itens.filter(l => l.length > 46);
  eq(grandes.length, 0, 'nenhuma linha de item passa de 46 caracteres');
  ok(epl.indexOf('TOTAL GERAL') < epl.indexOf('POR RESPONSAVEL'), 'bloco POR RESPONSAVEL vem depois do TOTAL GERAL');
  ok(linhasGrupo(epl).includes('POR RESPONSAVEL'), 'bloco POR RESPONSAVEL tem cabeçalho próprio');
  const lnAdn = itens.find(l => l.startsWith('ADNILSON RIBEIRO')) || '';
  // fmtKg da etiqueta não põe ponto de milhar: 2.001 kg sai "2001,0 kg".
  ok(/^ADNILSON RIBEIRO\s+1 op\s+2 it\s+2001,0 kg$/.test(lnAdn),
     'bloco: ADNILSON RIBEIRO · 1 op · 2 it · 2001,0 kg', `(linha: "${lnAdn}")`);
  const lnSem = itens.find(l => l.startsWith('sem identificacao')) || '';
  ok(/1 op\s+1 it/.test(lnSem), 'bloco: sem identificacao · 1 op · 1 it', `(linha: "${lnSem}")`);
  ok(itens.indexOf(lnSem) > itens.indexOf(lnAdn), 'bloco: sem identificação é a última linha');
}

async function testeResiduos() {
  console.log('\n[A-C] Resumo do dia dos RESÍDUOS com responsável');
  await residuos('Bruno Augusto', [40, 41]);
  await residuos('Bruno Augusto', [10]);
  await residuos(undefined, [500]);          // mais kg que o Bruno: mesmo assim vai por último
  const imp = await req('POST', '/resumo-dia', { tipo: 'outras', data: hojeISO() });
  ok(imp.json && imp.json.ok, 'resumo do dia dos resíduos imprime');
  const epl = ultimoPapel(/RESUMO DO DIA - RESIDUOS/);
  ok(!!epl, 'saiu o papel do resumo do dia dos resíduos');
  if (!epl) return;
  const itens = linhasItem(epl);
  const deBruno = itens.filter(l => /^\d\d:\d\d /.test(l) && /Bruno\s*$/.test(l));
  eq(deBruno.length, 3, '3 linhas de pesagem com "Bruno"');
  const semNome = itens.filter(l => /^\d\d:\d\d /.test(l) && / -\s*$/.test(l));
  eq(semNome.length, 1, '1 linha de pesagem sem identificação ("-")');
  eq(itens.filter(l => l.length > 46).length, 0, 'nenhuma linha de item passa de 46 caracteres');
  const lnB = itens.find(l => l.startsWith('Bruno Augusto')) || '';
  ok(/2 op\s+3 it\s+91(,\d+)? kg$/.test(lnB), 'bloco: Bruno Augusto · 2 op · 3 it · 91 kg', `(linha: "${lnB}")`);
  const lnSemR = itens.find(l => l.startsWith('sem identificacao')) || '';
  ok(/1 op\s+1 it\s+500,0 kg$/.test(lnSemR), 'bloco: sem identificacao · 1 op · 1 it · 500,0 kg', `(linha: "${lnSemR}")`);
  eq(itens[itens.length - 1], lnSemR, 'bloco: sem identificação é a última linha mesmo pesando mais');
}

async function testeRotaOperador() {
  console.log('\n[E] POST /sessoes/:id/operador — completa sessão aberta sem nome');
  const s = await req('POST', '/sessoes', { tipo: 'retirada' });
  const sid = s.json.sessao_id;
  const r1 = await req('POST', `/sessoes/${sid}/operador`, { operador: 'Henrique' });
  ok(r1.json && r1.json.ok && r1.json.alterado === true, 'sessão aberta sem nome recebe o responsável');
  const r2 = await req('POST', `/sessoes/${sid}/operador`, { operador: 'Outro' });
  ok(r2.json && r2.json.ok && r2.json.alterado === false, 'repetir com outro nome não troca (alterado=false)');
  eq(r2.json && r2.json.operador, 'Henrique', 'quem ficou gravado continua sendo Henrique');
  const g = await req('GET', `/sessoes/${sid}`);
  eq(g.json.sessao.operador, 'Henrique', 'no banco: Henrique');
  await req('POST', `/sessoes/${sid}/cancelar`);

  // Ao mesmo tempo (duas abas): só um vence, e o que ficou é o que respondeu alterado.
  const s2 = await req('POST', '/sessoes', { tipo: 'outras' });
  const sid2 = s2.json.sessao_id;
  const [a, b] = await Promise.all([
    req('POST', `/sessoes/${sid2}/operador`, { operador: 'Aba Um' }),
    req('POST', `/sessoes/${sid2}/operador`, { operador: 'Aba Dois' }),
  ]);
  const vencedores = [a, b].filter(x => x.json && x.json.alterado);
  eq(vencedores.length, 1, 'duas chamadas ao mesmo tempo: exatamente uma grava');
  const g2 = await req('GET', `/sessoes/${sid2}`);
  eq(g2.json.sessao.operador, vencedores[0] && (vencedores[0] === a ? 'Aba Um' : 'Aba Dois'), 'o nome gravado é o de quem venceu');
  await req('POST', `/sessoes/${sid2}/cancelar`);

  // Sessão já FINALIZADA não ganha nome depois (histórico não se reescreve).
  const s3 = await req('POST', '/sessoes', { tipo: 'outras' });
  const sid3 = s3.json.sessao_id;
  const e3 = await req('POST', '/etiquetas/outras', { clientToken: `fin-${sid3}`, sessao_id: sid3, item_codigo: 'RES.BORRA', peso: 1 });
  await req('POST', `/etiquetas/${e3.json.id}/bipar`);
  await req('POST', `/sessoes/${sid3}/finalizar`);
  const r3 = await req('POST', `/sessoes/${sid3}/operador`, { operador: 'Tardio' });
  ok(r3.json && r3.json.alterado === false, 'sessão finalizada não recebe responsável depois');
  const g3 = await req('GET', `/sessoes/${sid3}`);
  eq(g3.json.sessao.operador, null, 'no banco a finalizada continua sem nome');

  eq((await req('POST', `/sessoes/${sid}/operador`, { operador: '   ' })).status, 400, 'nome vazio → 400');
  eq((await req('POST', `/sessoes/${sid}/operador`, { operador: 'x'.repeat(61) })).status, 400, 'nome com mais de 60 letras → 400');
  eq((await req('POST', `/sessoes/999999/operador`, { operador: 'Fulano' })).status, 404, 'sessão inexistente → 404');
}

async function testeResumoSessao() {
  console.log('\n[F] Resumo da operação mostra o responsável');
  const bags = await bigBags(1, 'Tallpack');
  const s = await req('POST', '/sessoes', { tipo: 'retirada', operador: 'ADNILSON RIBEIRO' });
  const sid = s.json.sessao_id;
  await req('POST', `/etiquetas/${bags[0]}/consumir`, { sessao_id: sid });
  const parc = await req('POST', `/sessoes/${sid}/relatorio-atual`);
  ok(parc.json && parc.json.ok, 'relatório atual da retirada imprime');
  const epl = ultimoPapel(/RESUMO RETIRADA - PARCIAL/) || '';
  // O cabeçalho já cortava o nome em 14 letras (regra de antes, igual ao
  // recebimento): "ADNILSON RIBEI". O nome inteiro sai no Resumo do dia.
  ok(/A30,82,0,3,1,1,N,"Saida de estoque  Resp: ADNILSON RIBEI"/.test(epl), 'cabeçalho do resumo da operação traz "Resp: ADNILSON…"',
     `(cabeçalho: ${(epl.match(/A30,82,[^\n]*/) || [''])[0]})`);
  await req('POST', `/sessoes/${sid}/cancelar`);
}

function testeTelas() {
  console.log('\n[G] Telas de Retirada e Resíduos pedem o PIN e mandam o operador');
  for (const [arq, tipo] of [['mp-retirada.html', 'retirada'], ['outras-pesagens.html', 'outras']]) {
    const h = fs.readFileSync(path.join(ROOT, 'public', arq), 'utf8');
    ok(/<script src="\/acesso-colaborador\.js"><\/script>/.test(h), `${arq}: carrega acesso-colaborador.js`);
    ok(/comAcesso\('mp',\s*\w+\);/.test(h), `${arq}: a tela só inicia depois do PIN (comAcesso('mp', …))`);
    const re = new RegExp(`JSON\\.stringify\\(\\{ tipo: '${tipo}', operador: \\(window\\.EKO_RESPONSAVEL \\|\\| null\\) \\}\\)`);
    ok(re.test(h), `${arq}: abre a sessão com operador = EKO_RESPONSAVEL`);
    ok(/completarResponsavel\(/.test(h.split('async function restaurarSessaoAberta')[1] || ''),
       `${arq}: sessão restaurada sem nome recebe o responsável`);
    // Nada pode rodar a tela antes do PIN: as chamadas de início vivem dentro da função de entrada.
    const fimScript = h.slice(h.lastIndexOf('comAcesso(\'mp\''));
    ok(!/^restaurarSessaoAberta\(\);/m.test(h) && !/^init\(\);/m.test(h), `${arq}: nenhuma inicialização solta fora do portão do PIN`);
    ok(fimScript.length > 0, `${arq}: portão do PIN encontrado`);
  }
}

(async () => {
  try {
    await subirServidor();
    const h = await req('GET', '/healthcheck');
    if (!h.json || h.json.impressao_simulada_forcada !== true) throw new Error('ABORTADO: impressão não está travada em simulação');
    await testeRetirada();
    await testeResiduos();
    await testeRotaOperador();
    await testeResumoSessao();
    testeTelas();
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
