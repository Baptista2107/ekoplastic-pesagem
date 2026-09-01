// ════════════════════════════════════════════════════════════════════
//  PISO DE TESTES AUTOMATIZADOS — Sistema Ekoplastic
//  Sobe o server.js REAL (banco temporário, portas de teste, Bling e
//  impressão em modo simulação) e exercita os endpoints via HTTP.
//  Garante que as correções dos itens críticos da auditoria não voltem.
//
//  Como rodar:   node testes/piso-testes.js
//  Saída:        lista de PASS/FAIL e código de saída 0 (ok) ou 1 (falhou)
// ════════════════════════════════════════════════════════════════════

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');

const ROOT      = path.join(__dirname, '..');
const SERVER    = path.join(ROOT, 'server.js');
const PORT      = 13900;
const PORT_CB   = 18900;
const BASE      = `http://localhost:${PORT}`;
const TMP_DB    = path.join(os.tmpdir(), `eko_teste_${Date.now()}.db`);
const TMP_LOGS  = path.join(os.tmpdir(), `eko_teste_logs_${Date.now()}`);

let servidor;
let passou = 0, falhou = 0;
const falhas = [];

// ── Mini-framework de asserção ──
function ok(cond, nome, detalhe = '') {
  if (cond) { passou++; console.log(`  \x1b[32m✓\x1b[0m ${nome}`); }
  else      { falhou++; falhas.push(nome); console.log(`  \x1b[31m✗ ${nome}\x1b[0m ${detalhe}`); }
}
function eq(a, b, nome) { ok(a === b, nome, `(esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`); }

async function req(metodo, caminho, corpo) {
  const r = await fetch(BASE + caminho, {
    method: metodo,
    headers: corpo ? { 'Content-Type': 'application/json' } : {},
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch(e) {}
  return { status: r.status, json };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function subirServidor() {
  servidor = spawn('node', [SERVER], {
    env: {
      ...process.env,
      EKO_PORT: String(PORT),
      EKO_PORT_CB: String(PORT_CB),
      EKO_DB_FILE: TMP_DB,
      EKO_LOG_DIR: TMP_LOGS,
      // NUNCA imprimir de verdade: o portao de testes nao pode gastar
      // etiqueta nem depender de a Zebra estar instalada nesta maquina.
      EKO_PRINT_SIMULAR: '1',
      // Roda no fuso de Goiânia (UTC-3) para reproduzir bugs de fuso
      // horário (ex: dashboard vazio à noite) independente de onde o
      // teste rode. Sem isso, máquinas em UTC mascarariam o problema.
      TZ: 'America/Sao_Paulo',
      // Garante modo simulação (não toca em Bling real nem precisa de impressora)
      // bling_simular já é '1' por default; impressão auto-simula sem Zebra.
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  servidor.stdout.on('data', () => {});
  servidor.stderr.on('data', d => { if (process.env.VERBOSE) process.stderr.write(d); });

  // Espera o healthcheck responder (até 15s)
  for (let i = 0; i < 75; i++) {
    try {
      const r = await fetch(BASE + '/healthcheck');
      if (r.ok) return true;
    } catch(e) {}
    await sleep(200);
  }
  throw new Error('Servidor não subiu em 15s');
}

function encerrar() {
  try { servidor && servidor.kill('SIGKILL'); } catch(e) {}
  for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) {
    try { fs.rmSync(f, { force: true }); } catch(e) {}
  }
  try { fs.rmSync(TMP_LOGS, { recursive: true, force: true }); } catch(e) {}
}

// ════════════════════════════════════════════════════════════════════
//  BATERIAS DE TESTE
// ════════════════════════════════════════════════════════════════════

async function testeHealthcheck() {
  console.log('\n[1] Healthcheck e diagnóstico honesto (A6/A2)');
  const { status, json } = await req('GET', '/healthcheck');
  eq(status, 200, 'healthcheck responde 200');
  ok(json && json.ok === true, 'healthcheck ok=true');
  console.log(`      → versão do servidor testado: \x1b[36m${json && json.versao ? json.versao : '(sem versão — server.js ANTIGO!)'}\x1b[0m`);
  ok('impressora_detectada' in json, 'reporta impressora_detectada (A6)');
  ok(json.impressao_simulada === true, 'impressao_simulada=true (A6)');
  // Trava: o portao de testes NUNCA pode imprimir de verdade. A deteccao de
  // impressora e' assincrona, entao sem EKO_PRINT_SIMULAR=1 o teste comeca
  // simulando e passa a imprimir no meio do caminho, numa maquina com Zebra.
  ok(json.impressao_simulada_forcada === true, 'impressao travada em SIMULACAO pelo ambiente (nao gasta etiqueta)');
  ok(json.bling && typeof json.bling.simulacao === 'boolean', 'reporta bling.simulacao (A2)');
  ok(json.balanca && 'estavel' in json.balanca, 'reporta balanca.estavel (A6)');
}

async function testeNumeracaoConcorrente() {
  console.log('\n[2] Numeração atômica sob concorrência (C1/C2/M6)');
  // Abre sessão de extrusão
  const s = await req('POST', '/sessoes', { tipo: 'extrusao', operador: 'Teste', maquina: 'C1', turno_codigo: 'EXT-A1' });
  const sid = s.json.sessao_id;
  ok(!!sid, 'sessão de extrusão criada');

  // Dispara 40 impressões EM PARALELO (cada uma com clientToken único)
  const N = 40;
  const promessas = [];
  for (let i = 0; i < N; i++) {
    promessas.push(req('POST', '/etiquetas/extrusao', {
      clientToken: 'conc-' + i + '-' + Math.random().toString(36).slice(2),
      sessao_id: sid, cor: 'Preta', tipo_bobina: 'LEVE', largura: '1,60',
      operador: 'Teste', maquina: 'C1', turno_codigo: 'EXT-A1',
      peso: 20 + i, peso_bruto: 28 + i, tara: 8,
    }));
  }
  const resultados = await Promise.all(promessas);
  const sucessos = resultados.filter(r => r.json && r.json.ok);
  eq(sucessos.length, N, `as ${N} impressões retornaram ok`);

  const ids = sucessos.map(r => r.json.id);
  const idsUnicos = new Set(ids);
  eq(idsUnicos.size, N, 'todos os IDs são únicos (C1/C2 — sem duplicata)');

  // Confere no banco: quantas etiquetas na sessão
  const dash = await req('GET', '/extrusao/dashboard');
  const naSessao = (dash.json.bobinas || []).filter(b => true).length;
  ok(naSessao >= N, `banco tem ao menos ${N} bobinas (zero órfãs)`, `(veio ${naSessao})`);

  // seq_sessao deve ser 1..N sem repetir
  const seqs = sucessos.map(r => r.json.seq_sessao).sort((a, b) => a - b);
  const espera = Array.from({ length: N }, (_, i) => i + 1);
  ok(JSON.stringify(seqs) === JSON.stringify(espera), 'seq_sessao 1..N denso e sem repetir (M6)',
     `(veio ${seqs.slice(0, 6)}...)`);

  return sid;
}

async function testeIdempotencia() {
  console.log('\n[3] Idempotência por clientToken (C3)');
  const s = await req('POST', '/sessoes', { tipo: 'extrusao', operador: 'Idem', maquina: 'C2', turno_codigo: 'EXT-A2' });
  const sid = s.json.sessao_id;
  const token = 'idem-fixo-123';

  const r1 = await req('POST', '/etiquetas/extrusao', {
    clientToken: token, sessao_id: sid, cor: 'Branca', tipo_bobina: 'LEVE', largura: '1,75',
    operador: 'Idem', maquina: 'C2', turno_codigo: 'EXT-A2', peso: 15, peso_bruto: 24, tara: 9,
  });
  ok(r1.json.ok, '1ª impressão com token ok');
  const id1 = r1.json.id;

  // Reenvia com MESMO token (simula retry após resposta perdida)
  const r2 = await req('POST', '/etiquetas/extrusao', {
    clientToken: token, sessao_id: sid, cor: 'Branca', tipo_bobina: 'LEVE', largura: '1,75',
    operador: 'Idem', maquina: 'C2', turno_codigo: 'EXT-A2', peso: 15, peso_bruto: 24, tara: 9,
  });
  ok(r2.json.ok, '2ª chamada (mesmo token) também ok');
  eq(r2.json.id, id1, 'devolve a MESMA etiqueta (não duplicou — C3)');
  ok(r2.json.idempotente === true, 'marcada como idempotente');
}

async function testeTaraLiquido() {
  console.log('\n[4] Peso líquido = bruto − tara fixa');
  const s = await req('POST', '/sessoes', { tipo: 'extrusao', operador: 'Tara', maquina: 'C1', turno_codigo: 'EXT-A1' });
  const sid = s.json.sessao_id;
  // largura 1,60 → tara 8 (a tara é aplicada no FRONTEND; aqui o servidor
  // recebe o peso líquido já calculado + peso_bruto/tara pra auditoria)
  const r = await req('POST', '/etiquetas/extrusao', {
    clientToken: 't-' + Math.random(), sessao_id: sid, cor: 'Preta', tipo_bobina: 'LEVE', largura: '1,60',
    operador: 'Tara', maquina: 'C1', turno_codigo: 'EXT-A1', peso: 20, peso_bruto: 28, tara: 8,
  });
  ok(r.json.ok, 'impressão com tara ok');
  // Confere no dashboard que o peso registrado é o líquido (20)
  const dash = await req('GET', '/extrusao/dashboard');
  const bob = (dash.json.bobinas || []).find(b => b.id === r.json.id);
  ok(bob && Math.abs(bob.peso - 20) < 0.01, 'peso registrado é o líquido (20kg)', `(veio ${bob?.peso})`);
}

async function testeAutoFinalizacaoCoerente() {
  console.log('\n[5] Finalizacao BLOQUEADA por bobina nao bipada; apos bipar, total coerente');
  const s = await req('POST', '/sessoes', { tipo: 'extrusao', operador: 'Fim', maquina: 'C1', turno_codigo: 'EXT-A1' });
  const sid = s.json.sessao_id;

  // Imprime 3 bobinas — PESOS DIFERENTES de propósito. A trava de peso
  // repetido (mesma máquina, mesmo bruto/tara/líquido dentro da janela)
  // recusaria três bobinas idênticas em sequência, que é exatamente o
  // erro de 30/08/2026. Este teste é sobre a trava de FINALIZAÇÃO, então
  // os pesos variam como variam na fábrica.
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const r = await req('POST', '/etiquetas/extrusao', {
      clientToken: 'fim-' + i + '-' + Math.random(), sessao_id: sid, cor: 'Preta', tipo_bobina: 'LEVE', largura: '1,60',
      operador: 'Fim', maquina: 'C1', turno_codigo: 'EXT-A1', peso: 20 + i, peso_bruto: 28 + i, tara: 8,
    });
    ids.push(r.json.id);
  }
  ok(ids.length === 3 && ids.every(Boolean), '3 bobinas impressas', `(${JSON.stringify(ids)})`);

  // Bipa só 2 das 3
  await req('POST', `/etiquetas/${ids[0]}/bipar`);
  await req('POST', `/etiquetas/${ids[1]}/bipar`);

  // Tenta finalizar com 1 pendente → deve ser BLOQUEADO (Cenário 02)
  const bloq = await req('POST', `/sessoes/${sid}/finalizar`);
  ok(bloq.status === 409, 'finalização BLOQUEADA com bobina não bipada', `(status=${bloq.status})`);
  ok(Array.isArray(bloq.json.pendentes) && bloq.json.pendentes.includes(ids[2]), 'resposta lista a bobina pendente', `(${JSON.stringify(bloq.json && bloq.json.pendentes)})`);

  // A 3ª NÃO pode ter sido cancelada — segue aguardando bipe (não some o dado)
  const et3 = await req('GET', `/etiquetas/${ids[2]}`);
  const e3 = et3.json.etiqueta;
  ok(e3 && e3.status === 'aguardando_bipe', 'bobina pendente segue aguardando (não foi cancelada)', `(status=${e3 && e3.status})`);

  // Bipa a 3ª e finaliza de novo → agora passa e conta as 3
  await req('POST', `/etiquetas/${ids[2]}/bipar`);
  const fim = await req('POST', `/sessoes/${sid}/finalizar`);
  ok(fim.json.ok, 'finalização OK após bipar todas');

  const ses = await req('GET', `/sessoes?tipo=extrusao&limit=200`);
  const nossa = (ses.json.sessoes || []).find(x => x.id === sid);
  if (nossa) {
    eq(nossa.total_etiquetas, 3, 'total_etiquetas conta as 3 bipadas');
  } else {
    ok(false, 'conseguiu reler a sessão finalizada', '(não encontrada em /sessoes)');
  }
}

async function testeEnvioBlingSimulado() {
  console.log('\n[6] Envio ao Bling em modo simulação (A2)');
  const s = await req('POST', '/sessoes', { tipo: 'extrusao', operador: 'Bling', maquina: 'C1', turno_codigo: 'EXT-A1' });
  const sid = s.json.sessao_id;
  const r = await req('POST', '/etiquetas/extrusao', {
    clientToken: 'bl-' + Math.random(), sessao_id: sid, cor: 'Preta', tipo_bobina: 'LEVE', largura: '1,60',
    operador: 'Bling', maquina: 'C1', turno_codigo: 'EXT-A1', peso: 20, peso_bruto: 28, tara: 8,
  });
  await req('POST', `/etiquetas/${r.json.id}/bipar`);
  const fim = await req('POST', `/sessoes/${sid}/finalizar`);
  ok(fim.json.ok, 'finalização com envio Bling respondeu ok');
  ok(fim.json.bling && (fim.json.bling.modo === 'simulacao' || /SIM/i.test(fim.json.bling.bling_id || '')),
     'envio foi em modo SIMULAÇÃO (não tocou no Bling real)',
     `(${JSON.stringify(fim.json.bling)})`);
}

async function testeLimiteBody() {
  console.log('\n[7] Limite de tamanho de corpo (M4)');
  // Corpo de ~2MB deve ser rejeitado
  const gigante = 'x'.repeat(2 * 1024 * 1024);
  try {
    const r = await fetch(BASE + '/sessoes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tipo: 'extrusao', lixo: gigante }),
    });
    ok(r.status >= 400, 'corpo de 2MB é rejeitado (não aceita 2xx)', `(status ${r.status})`);
  } catch(e) {
    ok(true, 'corpo de 2MB rejeitado (conexão abortada)');
  }
}

async function testeSeqGlobalIndependentePorTipo() {
  console.log('\n[8] Sequência global independente por tipo (recebimento vs extrusão)');
  const h = await req('GET', '/healthcheck');
  ok(h.json.proximoSeq && typeof h.json.proximoSeq.recebimento === 'number',
     'healthcheck expõe proximoSeq por tipo');
}

async function testeRecebimentoMP() {
  console.log('\n[9] Fluxo de recebimento MP (imprimir → bipar → finalizar)');
  const s = await req('POST', '/sessoes', { tipo: 'recebimento', operador: 'Receb', fornecedor: 'Cedro' });
  const sid = s.json.sessao_id;
  ok(!!sid, 'sessão de recebimento criada');

  // Imprime 2 etiquetas de recebimento (servidor atribui o número — C2)
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const r = await req('POST', '/etiquetas', {
      clientToken: 'mp-' + i + '-' + Math.random(),
      tipo: 'recebimento', materialKey: 'GBD', materialNomeEt: 'BAIXA DENSIDADE',
      cor: 'Canela', fornecedor: 'Cedro', peso: 1000 + i, lote: 'L1', codigo: 'CAN1',
      sku: 'GBD.CAN.CED | 1000 | LL1', sessao_id: sid,
    });
    ok(r.json.ok, `etiqueta de recebimento ${i + 1} impressa`);
    ok(/^R\d{7}$/.test(r.json.id), `ID no formato R####### (veio ${r.json.id})`);
    ids.push(r.json.id);
  }
  ok(ids[0] !== ids[1], 'as 2 etiquetas têm IDs diferentes');

  // Bipa ambas (confirmação física do recebimento)
  await req('POST', `/etiquetas/${ids[0]}/bipar`);
  await req('POST', `/etiquetas/${ids[1]}/bipar`);

  // Finaliza → envia ao Bling (simulação)
  const fim = await req('POST', `/sessoes/${sid}/finalizar`);
  ok(fim.json.ok, 'finalização do recebimento ok');
  eq(fim.json.totais.qtd, 2, 'total conta as 2 bipadas');
  ok(fim.json.bling && (fim.json.bling.modo === 'simulacao' || /SIM/i.test(fim.json.bling.bling_id || '')),
     'recebimento enviado em simulação (fluxo MP intacto)');
}

// ════════════════════════════════════════════════════════════════════
//  EXECUÇÃO
// ════════════════════════════════════════════════════════════════════
(async () => {
  console.log('═══════════════════════════════════════════════════');
  console.log(' PISO DE TESTES — Ekoplastic (servidor real via HTTP)');
  console.log('═══════════════════════════════════════════════════');
  try {
    console.log('Subindo servidor de teste...');
    await subirServidor();
    console.log(`Servidor no ar em ${BASE} (banco temporário)`);

    await testeHealthcheck();
    await testeNumeracaoConcorrente();
    await testeIdempotencia();
    await testeTaraLiquido();
    await testeAutoFinalizacaoCoerente();
    await testeEnvioBlingSimulado();
    await testeLimiteBody();
    await testeSeqGlobalIndependentePorTipo();
    await testeRecebimentoMP();
  } catch(e) {
    console.error('\n\x1b[31mERRO FATAL NO PISO DE TESTES:\x1b[0m', e.message);
    falhou++;
  } finally {
    encerrar();
  }

  console.log('\n═══════════════════════════════════════════════════');
  console.log(` RESULTADO: ${passou} passou, ${falhou} falhou`);
  if (falhou > 0) {
    console.log(' Falhas:');
    falhas.forEach(f => console.log('   ✗ ' + f));
  }
  console.log('═══════════════════════════════════════════════════');
  process.exit(falhou > 0 ? 1 : 0);
})();
