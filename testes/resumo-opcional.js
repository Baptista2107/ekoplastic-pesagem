// ════════════════════════════════════════════════════════════════════
//  RESUMO OPCIONAL / RESUMO DO DIA  — Ekoplastic (01/09/2026)
//  Sobe o server.js REAL e prova, ponta a ponta:
//
//   A) EXTRUSÃO, RECEBIMENTO e PRODUTO ACABADO continuam imprimindo o
//      resumo ao finalizar — e o papel sai IGUALZINHO ao de antes.
//   B) RETIRADA, RETORNO e RESÍDUOS não imprimem mais nada ao finalizar
//      (nem uma etiqueta a menos de dado é perdida: só não sai papel).
//   C) O "Resumo do dia" soma TODAS as operações do dia daquele tipo,
//      inclusive as de sessões diferentes, e respeita a virada do dia.
//   D) A regra é configurável (resumo_auto_tipos) — dá pra voltar atrás
//      sem atualizar código.
//
//  Como rodar:   node testes/resumo-opcional.js
//  Saída:        PASS/FAIL e código de saída 0 (ok) ou 1 (falhou)
// ════════════════════════════════════════════════════════════════════

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');
const { DatabaseSync } = require('node:sqlite');

const ROOT     = path.join(__dirname, '..');
const SERVER   = path.join(ROOT, 'server.js');
const PORT     = 13940;
const PORT_CB  = 18940;
const BASE     = `http://localhost:${PORT}`;
const CARIMBO  = Date.now();
const TMP_DB   = path.join(os.tmpdir(), `eko_resumo_${CARIMBO}.db`);
const TMP_LOGS = path.join(os.tmpdir(), `eko_resumo_logs_${CARIMBO}`);
const DIR_EPL  = path.join(TMP_LOGS, 'print-simulado');

let servidor;
let passou = 0, falhou = 0;
const falhas = [];

function ok(cond, nome, detalhe = '') {
  if (cond) { passou++; console.log(`  \x1b[32m✓\x1b[0m ${nome}`); }
  else      { falhou++; falhas.push(nome); console.log(`  \x1b[31m✗ ${nome}\x1b[0m ${detalhe}`); }
}
function eq(a, b, nome) { ok(a === b, nome, `(esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`); }
function perto(a, b, nome) { ok(Math.abs(Number(a) - Number(b)) < 0.01, nome, `(esperado ${b}, veio ${a})`); }
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
           // Fuso de Goiânia: a virada do dia tem que ser a local, não a UTC.
           TZ: 'America/Sao_Paulo',
           // NUNCA imprimir de verdade. A deteccao de impressora e' assincrona:
           // sem esta trava, o teste comeca simulando e, quando a Zebra e'
           // detectada, passa a cuspir papel de verdade no meio da suite.
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

// ── Espia o que foi "impresso": conta os jobs EPL cujo título casa ──
function resumosImpressos(regex) {
  if (!fs.existsSync(DIR_EPL)) return [];
  return fs.readdirSync(DIR_EPL)
    .map(f => fs.readFileSync(path.join(DIR_EPL, f), 'latin1'))
    .filter(t => /A30,24,0,4,1,1,N,"RESUMO/.test(t) && regex.test(t));
}

// O "hoje" tem de ser o do SERVIDOR, não o desta máquina.
// O servidor de teste sobe com TZ=America/Sao_Paulo; se a máquina que
// roda o teste estiver em UTC, das 21h à meia-noite no Brasil os dois
// discordam do dia e o resumo do dia vem vazio — uma falha que não é
// do produto e que só aparece à noite, justamente quando se costuma
// publicar. Perguntar o dia no fuso do servidor acaba com isso.
const TZ_ESTACAO = 'America/Sao_Paulo';
const diaISO = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: TZ_ESTACAO });
const hojeISO = () => diaISO();

// ── Helpers de cenário ──
async function bigBagsRecebidos(qtd, fornecedor = 'Cedro') {
  const s = await req('POST', '/sessoes', { tipo: 'recebimento', operador: 'Teste', fornecedor });
  const sid = s.json.sessao_id;
  const ids = [];
  for (let i = 0; i < qtd; i++) {
    const r = await req('POST', '/etiquetas', {
      clientToken: `bb-${CARIMBO}-${Math.random()}`, tipo: 'recebimento',
      materialKey: 'GBD', materialNomeEt: 'BAIXA DENSIDADE', cor: 'Canela',
      fornecedor, peso: 500 + i, lote: 'L1', codigo: 'CAN1',
      sku: 'GBD.CAN.CED | 500 | LL1', sessao_id: sid,
    });
    ids.push(r.json.id);
    await req('POST', `/etiquetas/${r.json.id}/bipar`);
  }
  await req('POST', `/sessoes/${sid}/finalizar`);
  return ids;
}

async function retiradaDe(origIds) {
  const s = await req('POST', '/sessoes', { tipo: 'retirada', operador: 'Teste' });
  const sid = s.json.sessao_id;
  for (const oid of origIds) await req('POST', `/etiquetas/${oid}/consumir`, { sessao_id: sid });
  const fim = await req('POST', `/sessoes/${sid}/finalizar`);
  return { sid, fim };
}

// ════════════════════════════════════════════════════════════════════
//  [1] O QUE CONTINUA IMPRIMINDO
// ════════════════════════════════════════════════════════════════════
async function testeFechamentosSeguemImprimindo() {
  console.log('\n[1] Extrusão, Recebimento e Produto Acabado continuam imprimindo');

  const h = await req('GET', '/healthcheck');

  // TRAVA DE SEGURANÇA — tem que vir antes de tudo.
  // A detecção de impressora é assíncrona: sem EKO_PRINT_SIMULAR=1 o teste
  // começaria simulando e, assim que a Zebra fosse detectada, passaria a
  // imprimir DE VERDADE no meio da suíte — gastando etiqueta e fazendo as
  // conferências de papel falharem sem motivo aparente. Foi o que aconteceu
  // no PC de desenvolvimento em 01/09/2026.
  ok(h.json.impressao_simulada_forcada === true,
     'impressão travada em SIMULAÇÃO pelo ambiente (não gasta etiqueta)',
     `(impressao_simulada=${h.json.impressao_simulada}, forcada=${h.json.impressao_simulada_forcada})`);
  if (h.json.impressao_simulada_forcada !== true) {
    throw new Error('ABORTADO: o servidor de teste nao esta com a impressao travada em simulacao. '
      + 'Rode com EKO_PRINT_SIMULAR=1 (ou atualize o server.js) antes de seguir.');
  }

  const auto = (h.json.resumo && h.json.resumo.automatico) || [];
  ok(auto.includes('extrusao') && auto.includes('recebimento') && auto.includes('produto-acabado'),
     'healthcheck declara os 3 tipos de fechamento como automáticos', `(veio ${JSON.stringify(auto)})`);
  const sob = (h.json.resumo && h.json.resumo.sob_demanda) || [];
  ok(sob.includes('retirada') && sob.includes('retorno') && sob.includes('outras'),
     'healthcheck declara retirada/retorno/resíduos como sob demanda', `(veio ${JSON.stringify(sob)})`);

  // Extrusão
  const se = await req('POST', '/sessoes', { tipo: 'extrusao', operador: 'Teste', maquina: 'C1', turno_codigo: 'EXT-A1' });
  const sidE = se.json.sessao_id;
  for (let i = 0; i < 2; i++) {
    const r = await req('POST', '/etiquetas/extrusao', {
      clientToken: 'rx-' + i, sessao_id: sidE, cor: 'Preta', tipo_bobina: 'LEVE', largura: '1,60',
      operador: 'Teste', maquina: 'C1', turno_codigo: 'EXT-A1', peso: 200 + i, peso_bruto: 208 + i, tara: 8,
    });
    await req('POST', `/etiquetas/${r.json.id}/bipar`);
  }
  const fimE = await req('POST', `/sessoes/${sidE}/finalizar`);
  ok(fimE.json.ok && fimE.json.resumo && fimE.json.resumo.ok === true,
     'EXTRUSÃO imprime o resumo ao finalizar', JSON.stringify(fimE.json.resumo));
  eq(resumosImpressos(/RESUMO EXTRUSAO/).length, 1, 'saiu exatamente 1 papel de resumo da extrusão');

  // Recebimento
  await bigBagsRecebidos(2, 'Cedro');
  eq(resumosImpressos(/RESUMO RECEBIMENTO/).length, 1, 'RECEBIMENTO imprime o resumo ao finalizar');

  // Produto Acabado
  const sp = await req('POST', '/sessoes', { tipo: 'produto-acabado', operador: 'Teste', maquina: 'P1', turno_codigo: 'PA-A1' });
  const sidP = sp.json.sessao_id;
  // PA nasce já 'bipada' (não há bipagem física dos fardos)
  const rp = await req('POST', '/produto-acabado/item', {
    sessao_id: sidP, corKey: 'BC', formato: '50x60', fardos: 4, maquina: 'P1',
  });
  ok(rp.json && rp.json.ok, 'item de produto acabado registrado', JSON.stringify(rp.json && rp.json.erro));
  const fimP = await req('POST', `/sessoes/${sidP}/finalizar`);
  ok(fimP.json.ok && fimP.json.resumo && fimP.json.resumo.ok === true,
     'PRODUTO ACABADO imprime o resumo ao finalizar', JSON.stringify(fimP.json && fimP.json.resumo));
}

// ════════════════════════════════════════════════════════════════════
//  [2] O QUE DEIXOU DE IMPRIMIR — sem perder um grama de dado
// ════════════════════════════════════════════════════════════════════
async function testeAcumulativosNaoImprimem() {
  console.log('\n[2] Retirada, Retorno e Resíduos não imprimem ao finalizar');

  // RETIRADA
  const bbs = await bigBagsRecebidos(2, 'Cedro');
  const { sid, fim } = await retiradaDe(bbs);
  ok(fim.json.ok, 'retirada finaliza normalmente');
  eq(fim.json.resumo && fim.json.resumo.motivo, 'impressao_opcional', 'retirada responde motivo=impressao_opcional');
  eq(resumosImpressos(/RESUMO RETIRADA/).length, 0, 'NENHUM papel de resumo da retirada foi impresso');
  // O dado continua todo lá — só o papel deixou de sair.
  const ses = await req('GET', `/sessoes/${sid}`);
  eq(ses.json.sessao.total_etiquetas, 2, 'a sessão de retirada continua com as 2 etiquetas contadas');
  ok(fim.json.bling && (fim.json.bling.modo === 'simulacao' || /SIM/i.test(fim.json.bling.bling_id || '')),
     'a retirada seguiu para o Bling normalmente (envio imediato intacto)');

  // RETORNO
  const sr = await req('POST', '/sessoes', { tipo: 'retorno', operador: 'Teste', fornecedor: 'Ekoplastic' });
  const sidR = sr.json.sessao_id;
  const rr = await req('POST', '/etiquetas', {
    clientToken: 'rt-1', tipo: 'retorno', materialKey: 'GBD', materialNomeEt: 'BAIXA DENSIDADE',
    cor: 'Canela', fornecedor: 'Ekoplastic', peso: 300, lote: 'L9', codigo: 'CAN1',
    sku: 'GBD.CAN.EKO | 300 | LL9', sessao_id: sidR,
  });
  await req('POST', `/etiquetas/${rr.json.id}/bipar`);
  const fimR = await req('POST', `/sessoes/${sidR}/finalizar`);
  eq(fimR.json.resumo && fimR.json.resumo.motivo, 'impressao_opcional', 'RETORNO não imprime ao finalizar');
  eq(resumosImpressos(/RESUMO RETORNO/).length, 0, 'nenhum papel de resumo do retorno foi impresso');

  // RESÍDUOS (outras pesagens)
  const so = await req('POST', '/sessoes', { tipo: 'outras', operador: 'Teste' });
  const sidO = so.json.sessao_id;
  for (const [i, item] of ['APARA.AMARELA', 'RES.BORRA'].entries()) {
    const r = await req('POST', '/etiquetas/outras', { clientToken: 'ro-' + i, sessao_id: sidO, item_codigo: item, peso: 40 + i });
    await req('POST', `/etiquetas/${r.json.id}/bipar`);
  }
  const fimO = await req('POST', `/sessoes/${sidO}/finalizar`);
  eq(fimO.json.resumo && fimO.json.resumo.motivo, 'impressao_opcional', 'RESÍDUOS não imprimem ao finalizar');
  eq(resumosImpressos(/RESUMO OUTRAS PESAGENS/).length, 0, 'nenhum papel de resumo dos resíduos foi impresso');

  // O "Relatório atual" (parcial, com a sessão aberta) continua existindo:
  // é a válvula de escape de quem quer o papel na hora.
  const so2 = await req('POST', '/sessoes', { tipo: 'outras', operador: 'Teste' });
  const r2 = await req('POST', '/etiquetas/outras', { clientToken: 'ro-p', sessao_id: so2.json.sessao_id, item_codigo: 'RES.BORRA', peso: 12 });
  await req('POST', `/etiquetas/${r2.json.id}/bipar`);
  const parc = await req('POST', `/sessoes/${so2.json.sessao_id}/relatorio-atual`);
  ok(parc.json.ok, 'o "Relatório atual" da sessão aberta continua funcionando');
  eq(resumosImpressos(/RESUMO OUTRAS PESAGENS - PARCIAL/).length, 1, 'e é ele quem imprime, marcado como PARCIAL');
  await req('POST', `/sessoes/${so2.json.sessao_id}/cancelar`);
}

// ════════════════════════════════════════════════════════════════════
//  [3] RESUMO DO DIA — soma sessões diferentes
// ════════════════════════════════════════════════════════════════════
async function testeResumoDoDiaSoma() {
  console.log('\n[3] Resumo do dia soma TODAS as retiradas do dia');
  const hoje = hojeISO();

  // Estado antes (o teste [2] já fez 1 retirada de 2 big bags)
  const antes = await req('GET', `/resumo-dia?tipo=retirada&data=${hoje}`);
  ok(antes.json.ok, 'prévia do dia responde ok');
  const itensAntes = antes.json.itens, kgAntes = antes.json.total_kg, sessAntes = antes.json.sessoes;

  // Mais DUAS retiradas, em sessões separadas
  const a = await bigBagsRecebidos(2, 'Braskem');
  await retiradaDe(a);
  const b = await bigBagsRecebidos(3, 'Cromex');
  await retiradaDe(b);

  const dep = await req('GET', `/resumo-dia?tipo=retirada&data=${hoje}`);
  eq(dep.json.itens, itensAntes + 5, 'a prévia soma as 5 novas retiradas');
  eq(dep.json.sessoes, sessAntes + 2, 'e conta as 2 novas sessões');
  eq(dep.json.abertas, 0, 'nenhuma sessão aberta pendurada no resumo');
  ok(dep.json.total_kg > kgAntes, 'o total em kg cresceu', `(${kgAntes} → ${dep.json.total_kg})`);
  ok(Array.isArray(dep.json.grupos) && dep.json.grupos.length >= 1, 'a prévia devolve os grupos por material');
  const somaGrupos = dep.json.grupos.reduce((s, g) => s + g.kg, 0);
  perto(somaGrupos, dep.json.total_kg, 'a soma dos grupos bate com o total geral');

  // Agora imprime
  const imp = await req('POST', '/resumo-dia', { tipo: 'retirada', data: hoje });
  ok(imp.json.ok, 'POST /resumo-dia imprime');
  eq(imp.json.resumo.itens, dep.json.itens, 'o papel leva a mesma contagem da prévia');
  const papeis = resumosImpressos(/RESUMO DO DIA - RETIRADA/);
  eq(papeis.length, 1, 'saiu exatamente 1 job de impressão do resumo do dia');
  const papel = papeis[0];
  ok(/TOTAL GERAL: \d+ itens/.test(papel), 'o papel traz o TOTAL GERAL');
  ok(papel.includes(`${dep.json.itens} itens`), 'o TOTAL GERAL mostra o nº de itens do dia inteiro');
  ok(/Dia \d{2}\/\d{2}\/\d{4}/.test(papel), 'o cabeçalho traz o dia');
  ok(/operacoes/.test(papel), 'o cabeçalho traz quantas operações entraram');
  ok(/^N\nq800\nQ1200,24/.test(papel), 'usa o MESMO formato de etiqueta 100x150 do resumo de sempre');
}

// ════════════════════════════════════════════════════════════════════
//  [4] RETORNO e RESÍDUOS também têm resumo do dia
// ════════════════════════════════════════════════════════════════════
async function testeResumoDiaOutrosTipos() {
  console.log('\n[4] Retorno e Resíduos também acumulam no dia');
  const hoje = hojeISO();

  const rr = await req('POST', '/resumo-dia', { tipo: 'retorno', data: hoje });
  ok(rr.json.ok, 'resumo do dia de RETORNO imprime');
  eq(resumosImpressos(/RESUMO DO DIA - RETORNO/).length, 1, 'saiu 1 papel do retorno');

  const ro = await req('POST', '/resumo-dia', { tipo: 'outras', data: hoje });
  ok(ro.json.ok, 'resumo do dia de RESÍDUOS imprime');
  eq(resumosImpressos(/RESUMO DO DIA - RESIDUOS/).length, 1, 'saiu 1 papel dos resíduos');
  const papel = resumosImpressos(/RESUMO DO DIA - RESIDUOS/)[0];
  ok(/APARA AMARELA/.test(papel) && /BORRA/.test(papel), 'o papel dos resíduos separa apara e borra em grupos');
}

// ════════════════════════════════════════════════════════════════════
//  [5] SESSÃO ABERTA entra no dia — e é sinalizada
// ════════════════════════════════════════════════════════════════════
async function testeSessaoAberta() {
  console.log('\n[5] Sessão ainda aberta entra no resumo do dia, sinalizada');
  const hoje = hojeISO();
  const s = await req('POST', '/sessoes', { tipo: 'outras', operador: 'Aberta' });
  const r = await req('POST', '/etiquetas/outras', { clientToken: 'ab-1', sessao_id: s.json.sessao_id, item_codigo: 'RES.VARREDURA', peso: 7 });
  await req('POST', `/etiquetas/${r.json.id}/bipar`);

  const p = await req('GET', `/resumo-dia?tipo=outras&data=${hoje}`);
  eq(p.json.abertas, 1, 'a prévia avisa que 1 sessão ainda está aberta');
  ok(p.json.itens >= 3, 'e conta o item pesado na sessão aberta', `(itens=${p.json.itens})`);

  // Não bipada não entra (é uma pesagem que ainda não foi confirmada)
  const r2 = await req('POST', '/etiquetas/outras', { clientToken: 'ab-2', sessao_id: s.json.sessao_id, item_codigo: 'RES.BORRA', peso: 99 });
  const p2 = await req('GET', `/resumo-dia?tipo=outras&data=${hoje}`);
  eq(p2.json.itens, p.json.itens, 'pesagem impressa e NÃO bipada fica de fora do resumo do dia');
  await req('POST', `/etiquetas/${r2.json.id}/cancelar`);
  await req('POST', `/sessoes/${s.json.sessao_id}/finalizar`);
}

// ════════════════════════════════════════════════════════════════════
//  [6] VIRADA DO DIA — controle negativo de verdade
//      Recua a hora de uma pesagem para ONTEM (direto no banco) e
//      confere que ela sai do dia de hoje e aparece no de ontem.
// ════════════════════════════════════════════════════════════════════
async function testeViradaDoDia() {
  console.log('\n[6] Virada do dia (fuso local) — pesagem de ontem não entra em hoje');
  const hoje = hojeISO();
  const d = new Date(); d.setDate(d.getDate() - 1);
  const ontem = diaISO(d);

  const antesHoje  = (await req('GET', `/resumo-dia?tipo=outras&data=${hoje}`)).json;
  const antesOntem = (await req('GET', `/resumo-dia?tipo=outras&data=${ontem}`)).json;
  eq(antesOntem.itens, 0, 'ontem começa vazio');

  // Recua UMA pesagem de resíduos para as 23:30 de ontem (hora LOCAL).
  const banco = new DatabaseSync(TMP_DB);
  const alvo = banco.prepare(
    `SELECT id FROM etiquetas WHERE tipo='outras' AND status='bipada' ORDER BY id LIMIT 1`).get();
  ok(!!alvo, 'achei uma pesagem de resíduos para recuar');
  const ontem2330 = new Date(`${ontem}T23:30:00`).toISOString();     // 23:30 LOCAL
  banco.prepare(`UPDATE etiquetas SET hora_impressao = ?, hora_bipagem = ? WHERE id = ?`)
       .run(ontem2330, ontem2330, alvo.id);
  banco.close();

  const depHoje  = (await req('GET', `/resumo-dia?tipo=outras&data=${hoje}`)).json;
  const depOntem = (await req('GET', `/resumo-dia?tipo=outras&data=${ontem}`)).json;
  eq(depHoje.itens, antesHoje.itens - 1, 'a pesagem recuada SAIU do resumo de hoje');
  eq(depOntem.itens, 1, 'e APARECEU no resumo de ontem');
  ok(depOntem.total_kg > 0, 'com o peso junto', `(kg=${depOntem.total_kg})`);

  // Um dia sem movimento nenhum não imprime papel em branco.
  const vazio = await req('POST', '/resumo-dia', { tipo: 'retorno', data: '2020-01-01' });
  eq(vazio.status, 400, 'dia sem movimento recusa a impressão (não gasta etiqueta)');
  eq(vazio.json.motivo, 'sem_itens', 'e diz por quê');
}

// ════════════════════════════════════════════════════════════════════
//  [7] VALIDAÇÃO de entrada
// ════════════════════════════════════════════════════════════════════
async function testeValidacao() {
  console.log('\n[7] Validação de tipo e data');
  const hoje = hojeISO();
  const t1 = await req('POST', '/resumo-dia', { tipo: 'extrusao', data: hoje });
  eq(t1.status, 400, 'resumo do dia recusa EXTRUSÃO (ela já imprime ao fechar o turno)');
  const t2 = await req('POST', '/resumo-dia', { tipo: 'produto-acabado', data: hoje });
  eq(t2.status, 400, 'recusa PRODUTO ACABADO (formato próprio, por máquina)');
  const t3 = await req('POST', '/resumo-dia', { tipo: 'retirada', data: '01/09/2026' });
  eq(t3.status, 400, 'recusa data fora do padrão AAAA-MM-DD');
  const t4 = await req('GET', '/resumo-dia?tipo=retirada');
  ok(t4.json.ok, 'sem data, assume HOJE (é o caso do dia a dia)');
  eq(t4.json.data, hoje, 'e devolve qual dia usou');
}

// ════════════════════════════════════════════════════════════════════
//  [8] DÁ PRA VOLTAR ATRÁS SEM MEXER NO CÓDIGO
// ════════════════════════════════════════════════════════════════════
async function testeConfiguravel() {
  console.log('\n[8] A regra é configurável (resumo_auto_tipos)');
  await req('POST', '/config', { resumo_auto_tipos: 'recebimento,extrusao,produto-acabado,retirada' });
  const bbs = await bigBagsRecebidos(1, 'Volta');
  const { fim } = await retiradaDe(bbs);
  ok(fim.json.resumo && fim.json.resumo.ok === true, 'com "retirada" na lista, ela volta a imprimir ao finalizar');
  eq(resumosImpressos(/RESUMO RETIRADA/).length, 1, 'e o papel sai');

  await req('POST', '/config', { resumo_auto_tipos: 'recebimento,extrusao,produto-acabado' });
  const bbs2 = await bigBagsRecebidos(1, 'Volta2');
  const { fim: fim2 } = await retiradaDe(bbs2);
  eq(fim2.json.resumo && fim2.json.resumo.motivo, 'impressao_opcional', 'tirando da lista, para de imprimir de novo');
  eq(resumosImpressos(/RESUMO RETIRADA/).length, 1, 'e nenhum papel novo saiu');
}

// ════════════════════════════════════════════════════════════════════
(async () => {
  console.log('═══════════════════════════════════════════════════');
  console.log(' RESUMO OPCIONAL / RESUMO DO DIA — Ekoplastic');
  console.log('═══════════════════════════════════════════════════');
  try {
    console.log('Subindo servidor de teste...');
    await subirServidor();
    console.log(`Servidor no ar em ${BASE} (banco temporário)`);

    await testeFechamentosSeguemImprimindo();
    await testeAcumulativosNaoImprimem();
    await testeResumoDoDiaSoma();
    await testeResumoDiaOutrosTipos();
    await testeSessaoAberta();
    await testeViradaDoDia();
    await testeValidacao();
    await testeConfiguravel();

    // Diagnóstico final: mostra se esta máquina tem impressora instalada.
    // Se tiver, é a prova de que a trava de simulação segurou o teste do
    // começo ao fim (senão o papel teria saído de verdade).
    try {
      const hf = await req('GET', '/healthcheck');
      console.log(`\nImpressora nesta máquina: ${hf.json.impressora_detectada ? 'DETECTADA (' + hf.json.impressora + ') — travada em simulação durante todo o teste' : 'nenhuma'}`);
    } catch (e) {}

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
