// ════════════════════════════════════════════════════════════════════
//  ENDEREÇO DO BLING (api.bling.com.br)  — Ekoplastic (01/09/2026)
//
//  O QUE ACONTECEU
//  O Bling passou a recusar chamadas de API feitas em www.bling.com.br:
//
//    HTTP 403 { "error": { "type": "FORBIDDEN",
//      "message": "Acesso não permitido",
//      "description": "A URL 'www.bling.com.br' está bloqueada para
//       requisições de API. Por favor, utilize o endpoint oficial:
//       'api.bling.com.br'." } }
//
//  O sistema usava www para TUDO. Envio de recebimento, retirada e
//  produção pararam de chegar ao Bling.
//
//  O QUE ESTA SUÍTE PROVA
//   A) as chamadas de API saem em api.bling.com.br e o OAuth em www;
//   B) se o Bling recusar o endereço e indicar outro, a chamada é
//      repetida lá sozinha e o endereço novo fica gravado;
//   C) uma recusa por endereço NÃO invalida o refresh_token (senão
//      seria preciso refazer a autorização à toa);
//   D) quando nada funciona, a sessão fica salva e reenviável — não se
//      perde pesagem nenhuma;
//   E) o endereço é configurável, sem depender de atualização de código.
//
//  Como isto roda sem tocar no Bling de verdade: um "Bling de mentira"
//  local, e o servidor sobe com EKO_BLING_INSEGURO=1 (fala HTTP com o
//  Bling). Em produção essa variável não existe e tudo é HTTPS.
//
//  Como rodar:  node testes/bling-endpoint.js
// ════════════════════════════════════════════════════════════════════

const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');

const ROOT     = path.join(__dirname, '..');
const SERVER   = path.join(ROOT, 'server.js');
const PORT     = 13980;
const PORT_CB  = 18980;
const BASE     = `http://localhost:${PORT}`;
const CARIMBO  = Date.now();
const TMP_DB   = path.join(os.tmpdir(), `eko_bling_${CARIMBO}.db`);
const TMP_LOGS = path.join(os.tmpdir(), `eko_bling_logs_${CARIMBO}`);
const TMP_TOK  = path.join(os.tmpdir(), `eko_bling_tokens_${CARIMBO}.json`);

let servidor, fakeWww, fakeApi;
let portaWww = 0, portaApi = 0;
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

// ── O "Bling de mentira" ───────────────────────────────────────────
// Dois servidores: um faz o papel do www (recusa API, aceita OAuth) e o
// outro o papel do api (aceita tudo). O corpo do 403 é o texto REAL que
// o Bling devolveu em 01/09/2026.
const registro = { www: [], api: [] };

function corpoBloqueado(qual) {
  return JSON.stringify({ error: {
    type: 'FORBIDDEN',
    message: 'Acesso não permitido',
    description: `A URL 'www.bling.com.br' está bloqueada para requisições de API. `
               + `Por favor, utilize o endpoint oficial: 'localhost:${portaApi}'.`,
  }});
}

function criarFake(qual) {
  return http.createServer((r, res) => {
    let corpo = '';
    r.on('data', c => corpo += c);
    r.on('end', () => {
      registro[qual].push({ metodo: r.method, url: r.url, corpo });
      const responder = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
      };
      // OAuth: os dois aceitam, para o teste do token poder escolher.
      if (r.url.startsWith('/Api/v3/oauth/token')) {
        if (qual === 'www' && registro.bloquearToken) return responder(403, corpoBloqueado());
        return responder(200, { access_token: 'tok-' + qual + '-' + Date.now(),
                                refresh_token: 'refresh-fake', expires_in: 21600 });
      }
      // Chamadas de API: o "www" recusa, como o Bling de verdade passou a fazer.
      if (qual === 'www') return responder(403, corpoBloqueado());
      if (registro.apiForaDoAr) return responder(403, JSON.stringify({ error: {
        type: 'FORBIDDEN', message: 'Acesso não permitido',
        description: "A URL 'x' está bloqueada para requisições de API. Por favor, utilize o endpoint oficial: 'nada.invalido.com'." } }));
      if (r.url.startsWith('/Api/v3/pedidos/')) return responder(201, { data: { id: 555001 } });
      if (r.url.startsWith('/Api/v3/produtos'))  return responder(200, { data: [] });
      if (r.url.startsWith('/Api/v3/contatos'))  return responder(200, { data: [] });
      return responder(200, { data: {} });
    });
  });
}

function subirFakes() {
  return new Promise(resolve => {
    fakeWww = criarFake('www');
    fakeApi = criarFake('api');
    fakeWww.listen(0, '127.0.0.1', () => {
      portaWww = fakeWww.address().port;
      fakeApi.listen(0, '127.0.0.1', () => { portaApi = fakeApi.address().port; resolve(); });
    });
  });
}

async function subirServidor() {
  fs.writeFileSync(TMP_TOK, JSON.stringify({
    accessToken: 'tok-inicial', refreshToken: 'refresh-fake',
    expiresAt: Date.now() + 3600e3,
  }));
  servidor = spawn('node', [SERVER], {
    env: { ...process.env, EKO_PORT: String(PORT), EKO_PORT_CB: String(PORT_CB),
           EKO_DB_FILE: TMP_DB, EKO_LOG_DIR: TMP_LOGS, EKO_TOKEN_FILE: TMP_TOK,
           TZ: 'America/Sao_Paulo', EKO_PRINT_SIMULAR: '1',
           EKO_BLING_INSEGURO: '1',              // fala HTTP com o Bling de mentira
           BLING_CLIENT_ID: 'id-teste', BLING_CLIENT_SECRET: 'segredo-teste' },
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
  try { fakeWww && fakeWww.close(); } catch(e) {}
  try { fakeApi && fakeApi.close(); } catch(e) {}
  for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm', TMP_TOK]) { try { fs.rmSync(f, { force: true }); } catch(e) {} }
  try { fs.rmSync(TMP_LOGS, { recursive: true, force: true }); } catch(e) {}
}

// Uma sessão de recebimento pronta para enviar.
async function sessaoRecebimento(fornecedor = 'Cedro') {
  const s = await req('POST', '/sessoes', { tipo: 'recebimento', operador: 'Teste', fornecedor });
  const r = await req('POST', '/etiquetas', {
    clientToken: 'bl-' + Math.random(), tipo: 'recebimento',
    materialKey: 'GBD', materialNomeEt: 'BAIXA DENSIDADE', cor: 'Canela',
    fornecedor, peso: 950, lote: 'L1', codigo: 'CAN1',
    sku: 'GBD.CAN.CED | 950 | LL1', sessao_id: s.json.sessao_id,
  });
  await req('POST', `/etiquetas/${r.json.id}/bipar`);
  return s.json.sessao_id;
}

// ════════════════════════════════════════════════════════════════════
//  [1] OS ENDEREÇOS DE FÁBRICA
// ════════════════════════════════════════════════════════════════════
async function testePadroes() {
  console.log('\n[1] Endereços de fábrica: API no api., OAuth no www.');
  const h = (await req('GET', '/healthcheck')).json;
  eq(h.bling.host_api,   'api.bling.com.br', 'chamadas de API vão para api.bling.com.br');
  eq(h.bling.host_oauth, 'www.bling.com.br', 'OAuth continua em www.bling.com.br');
  const b = (await req('GET', '/bling/status')).json;
  eq(b.host_api,   'api.bling.com.br', '/bling/status mostra o endereço da API');
  eq(b.host_oauth, 'www.bling.com.br', '/bling/status mostra o endereço do OAuth');
}

// ════════════════════════════════════════════════════════════════════
//  [2] O ENVIO CHEGA — e chega no endereço certo
// ════════════════════════════════════════════════════════════════════
async function testeEnvioChega() {
  console.log('\n[2] Com o endereço certo, o pedido chega ao Bling');
  await req('POST', '/config', {
    bling_simular: '0',
    bling_host_api:   'localhost:' + portaApi,
    bling_host_oauth: 'localhost:' + portaWww,
    mapa_fornecedor_bling: JSON.stringify({ Cedro: '17830214554' }),
    mapa_produto_bling: JSON.stringify({ 'GBD:Canela:Cedro': '16571351111' }),
    id_ekoplastic_bling: '999',
  });
  registro.api.length = 0; registro.www.length = 0;

  const sid = await sessaoRecebimento('Cedro');
  const fim = await req('POST', `/sessoes/${sid}/finalizar`);
  ok(fim.json.ok, 'sessão finalizada');
  ok(fim.json.bling && fim.json.bling.ok, 'envio ao Bling deu certo', JSON.stringify(fim.json.bling));
  eq(String(fim.json.bling.bling_id), '555001', 'voltou o número do pedido criado');

  const pedidos = registro.api.filter(x => x.url.startsWith('/Api/v3/pedidos/'));
  eq(pedidos.length, 1, 'o pedido saiu UMA vez, no endereço de API');
  eq(registro.www.filter(x => x.url.startsWith('/Api/v3/pedidos/')).length, 0,
     'e NENHUMA chamada de pedido foi para o endereço bloqueado');
  const corpo = JSON.parse(pedidos[0].corpo || '{}');
  ok(corpo.itens && corpo.itens.length === 1, 'o pedido levou o item pesado', JSON.stringify(corpo.itens));
}

// ════════════════════════════════════════════════════════════════════
//  [3] O SISTEMA SE VIRA SOZINHO SE O ENDEREÇO MUDAR
//      É exatamente o cenário de 01/09/2026, ao contrário: aponta para
//      o endereço bloqueado e vê se ele encontra o caminho.
// ════════════════════════════════════════════════════════════════════
async function testeRedirecionamento() {
  console.log('\n[3] Endereço recusado: repete no indicado e grava o novo');
  await req('POST', '/config', { bling_host_api: 'localhost:' + portaWww });   // endereço "errado"
  registro.api.length = 0; registro.www.length = 0;

  const sid = await sessaoRecebimento('Cedro');
  const fim = await req('POST', `/sessoes/${sid}/finalizar`);
  ok(fim.json.bling && fim.json.bling.ok, 'o envio deu certo mesmo apontando para o endereço bloqueado',
     JSON.stringify(fim.json.bling));
  ok(registro.www.some(x => x.url.startsWith('/Api/v3/pedidos/')), 'tentou primeiro no endereço configurado');
  ok(registro.api.some(x => x.url.startsWith('/Api/v3/pedidos/')), 'e repetiu no endereço que o Bling indicou');

  const h = (await req('GET', '/healthcheck')).json;
  eq(h.bling.host_api, 'localhost:' + portaApi, 'o endereço novo ficou gravado para as próximas');

  const c = (await req('GET', '/config')).json.config;
  eq(c.bling_host_api, 'localhost:' + portaApi, 'e persistido na configuração');
}

// ════════════════════════════════════════════════════════════════════
//  [4] RECUSA DE ENDEREÇO NÃO É TOKEN EXPIRADO
// ════════════════════════════════════════════════════════════════════
async function testeTokenNaoInvalida() {
  console.log('\n[4] Recusa por endereço não queima o refresh_token');
  registro.bloquearToken = true;
  // Deixa o servidor apontado para o endereço que vai recusar o token e
  // com o access_token vencido. Depois do restart, a primeira chamada
  // precisa renovar — e é aí que a recusa acontece.
  await req('POST', '/config', {
    bling_simular: '0',
    bling_host_api:   'localhost:' + portaApi,
    bling_host_oauth: 'localhost:' + portaWww,
  });
  try { servidor.kill('SIGKILL'); } catch(e) {}
  await sleep(600);
  // O subirServidor reescreve o arquivo de token; aqui ele precisa nascer
  // VENCIDO, então a escrita vem depois e o servidor sobe em seguida.
  await subirServidor();
  fs.writeFileSync(TMP_TOK, JSON.stringify({
    accessToken: 'tok-vencido', refreshToken: 'refresh-fake', expiresAt: Date.now() - 1000 }));
  try { servidor.kill('SIGKILL'); } catch(e) {}
  await sleep(400);
  const anterior = subirServidor;
  servidor = spawn(process.execPath, [SERVER], {
    env: { ...process.env, EKO_PORT: String(PORT), EKO_PORT_CB: String(PORT_CB),
           EKO_DB_FILE: TMP_DB, EKO_LOG_DIR: TMP_LOGS, EKO_TOKEN_FILE: TMP_TOK,
           TZ: 'America/Sao_Paulo', EKO_PRINT_SIMULAR: '1', EKO_BLING_INSEGURO: '1',
           BLING_CLIENT_ID: 'id-teste', BLING_CLIENT_SECRET: 'segredo-teste' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  servidor.stdout.on('data', () => {});
  servidor.stderr.on('data', d => { if (process.env.VERBOSE) process.stderr.write(d); });
  for (let i = 0; i < 75; i++) {
    try { const r = await fetch(BASE + '/healthcheck'); if (r.ok) break; } catch(e) {}
    await sleep(200);
  }

  const sid = await sessaoRecebimento('Cedro');
  const fim = await req('POST', `/sessoes/${sid}/finalizar`);
  ok(fim.json.bling && fim.json.bling.ok,
     'renovou o token no endereço indicado e o pedido foi enviado', JSON.stringify(fim.json.bling));
  const st = (await req('GET', '/bling/status')).json;
  eq(st.tokenInvalido, false, 'o refresh_token NÃO foi marcado como inválido');
  eq(st.host_oauth, 'localhost:' + portaApi, 'e o endereço de OAuth foi corrigido sozinho');
  registro.bloquearToken = false;
}

// ════════════════════════════════════════════════════════════════════
//  [5] QUANDO NADA FUNCIONA, A PESAGEM NÃO SE PERDE
// ════════════════════════════════════════════════════════════════════
async function testeFalhaPreservaSessao() {
  console.log('\n[5] Com o Bling fora do ar, a sessão fica salva e reenviável');
  await req('POST', '/config', { bling_host_api: 'localhost:' + portaApi, bling_host_oauth: 'localhost:' + portaApi });
  registro.apiForaDoAr = true;

  const sid = await sessaoRecebimento('Cedro');
  const fim = await req('POST', `/sessoes/${sid}/finalizar`);
  ok(fim.json.ok, 'a sessão finaliza mesmo com o Bling recusando');
  ok(fim.json.bling && !fim.json.bling.ok, 'o envio é reportado como falho', JSON.stringify(fim.json.bling));
  ok(/recusou o endereço/i.test(fim.json.bling.erro || ''),
     'com uma mensagem que explica o problema, não um HTTP 403 cru', fim.json.bling.erro);

  const s = (await req('GET', `/sessoes/${sid}`)).json.sessao;
  eq(s.bling_status, 'erro', 'a sessão fica marcada como erro');
  eq(s.total_etiquetas, 1, 'com a pesagem contada — nada foi perdido');

  const pend = (await req('GET', '/sessoes/pendentes-bling')).json;
  ok((pend.sessoes || []).some(x => x.id === sid), 'e aparece na lista de pendentes para reenvio');

  // Bling volta → reenviar resolve
  registro.apiForaDoAr = false;
  const re = await req('POST', `/sessoes/${sid}/reenviar-bling`);
  ok(re.json.bling && re.json.bling.ok, 'com o Bling de volta, o reenvio funciona', JSON.stringify(re.json.bling));
  const s2 = (await req('GET', `/sessoes/${sid}`)).json.sessao;
  eq(s2.bling_status, 'enviado', 'e a sessão passa a enviada');
}

// ════════════════════════════════════════════════════════════════════
//  [6] O ENDEREÇO É CONFIGURÁVEL
// ════════════════════════════════════════════════════════════════════
async function testeConfiguravel() {
  console.log('\n[6] Dá para trocar o endereço sem atualizar o sistema');
  await req('POST', '/config', { bling_host_api: 'api2.bling.com.br', bling_host_oauth: 'contas.bling.com.br' });
  const h = (await req('GET', '/healthcheck')).json;
  eq(h.bling.host_api,   'api2.bling.com.br',   'endereço de API trocado pela configuração');
  eq(h.bling.host_oauth, 'contas.bling.com.br', 'endereço de OAuth trocado pela configuração');
  await req('POST', '/config', { bling_host_api: 'localhost:' + portaApi, bling_host_oauth: 'localhost:' + portaApi });
  await req('POST', '/config', { bling_simular: '1' });   // devolve o servidor de teste ao estado seguro
}

// ════════════════════════════════════════════════════════════════════
(async () => {
  console.log('═══════════════════════════════════════════════════');
  console.log(' ENDEREÇO DO BLING — Ekoplastic');
  console.log('═══════════════════════════════════════════════════');
  try {
    await subirFakes();
    console.log(`Bling de mentira: "www" em ${portaWww}, "api" em ${portaApi}`);
    console.log('Subindo servidor de teste...');
    await subirServidor();
    console.log(`Servidor no ar em ${BASE} (banco temporário)`);

    await testePadroes();
    await testeEnvioChega();
    await testeRedirecionamento();
    await testeTokenNaoInvalida();
    await testeFalhaPreservaSessao();
    await testeConfiguravel();

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
