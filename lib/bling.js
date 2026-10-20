// ════════════════════════════════════════════════════════════════════
//  BLING — hosts, credenciais, OAuth 2.0 e chamadas à API v3
// ════════════════════════════════════════════════════════════════════

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');

const { PORT_CALLBACK, RAIZ, TOKEN_FILE } = require('./config');
const { logE, logI, logW } = require('./log');
const { configGet, configSet } = require('./db');

// ══════════════════════════════════════════════════════════════════
//  HOSTS DO BLING           (corrigido em 01/09/2026)
// ------------------------------------------------------------------
//  O Bling passou a RECUSAR chamadas de API feitas em
//  www.bling.com.br, devolvendo 403:
//
//    "A URL 'www.bling.com.br' está bloqueada para requisições de API.
//     Por favor, utilize o endpoint oficial: 'api.bling.com.br'."
//
//  Até então o sistema usava www para tudo. Agora são dois hosts:
//   - API (produtos, pedidos, contatos, estoque) → api.bling.com.br
//   - OAuth (a tela de autorização e a troca/renovação do token)
//     → www.bling.com.br, que é o que a documentação do Bling ainda
//     mostra. Se um dia isso mudar também, o sistema se vira sozinho:
//     quando o Bling responde apontando outro endereço, a chamada é
//     repetida lá e o novo host fica gravado.
//
//  Os dois podem ser trocados sem atualização de código, pelas chaves
//  de configuração bling_host_api e bling_host_oauth.
// ══════════════════════════════════════════════════════════════════
const BLING_HOST_API_PADRAO   = 'api.bling.com.br';
const BLING_HOST_OAUTH_PADRAO = 'www.bling.com.br';

function blingHostApi() {
  try { return configGet('bling_host_api', BLING_HOST_API_PADRAO) || BLING_HOST_API_PADRAO; }
  catch (e) { return BLING_HOST_API_PADRAO; }
}
function blingHostOauth() {
  try { return configGet('bling_host_oauth', BLING_HOST_OAUTH_PADRAO) || BLING_HOST_OAUTH_PADRAO; }
  catch (e) { return BLING_HOST_OAUTH_PADRAO; }
}

// Só para o piso de testes: fala HTTP em vez de HTTPS com o Bling, para
// que os testes possam levantar um "Bling de mentira" local sem
// certificado. Em produção a variável não existe e tudo segue em HTTPS.
const BLING_INSEGURO = process.env.EKO_BLING_INSEGURO === '1';

// Endereço que aceitamos seguir quando o Bling nos manda para outro
// lugar. Fora dos testes, SÓ um subdomínio de bling.com.br — seguir um
// endereço qualquer que venha num corpo de resposta seria entregar as
// chamadas (com o token dentro) para quem respondeu.
function hostBlingValido(h) {
  if (/^[A-Za-z0-9.\-]+\.bling\.com\.br$/.test(h)) return true;
  if (BLING_INSEGURO && /^localhost(:\d+)?$/.test(h)) return true;   // Bling de mentira dos testes
  return false;
}

// A resposta é uma recusa POR CAUSA DO ENDEREÇO? Serve para explicar o
// erro em português para o operador, mesmo quando não dá para consertar
// sozinho — sem isso ele veria um "HTTP 403 {json}" na tela.
function blingRecusouEndereco(res) {
  return !!(res && res.status === 403 && /bloquead/i.test(String(res.body || '')));
}

// Lê a resposta do Bling procurando o endereço que ele indicou. Devolve
// só se for um endereço em que confiamos (ver hostBlingValido) — é para
// lá que a chamada, com o token dentro, seria repetida.
function blingHostSugerido(res) {
  if (!blingRecusouEndereco(res)) return null;
  const txt = String(res.body || '');
  const m = txt.match(/endpoint\s*oficial:?\s*['"]?([A-Za-z0-9.\-]+(?::\d+)?)['"]?/i)
         || txt.match(/utilize[^'"]{0,40}['"]([A-Za-z0-9.\-]+(?::\d+)?)['"]/i);
  if (!m) return null;
  if (!hostBlingValido(m[1])) {
    logW('bling', `O Bling indicou o endereço "${m[1]}", que não é do dominio bling.com.br — ignorado por segurança`);
    return null;
  }
  return m[1];
}

// Faz a chamada; se o Bling recusar o endereço e indicar outro, repete
// lá e — se der certo — grava o endereço novo para as próximas.
async function blingRequisicao(host, chaveConfig, montarOpcoes, body, comRetry) {
  const executar = h => (comRetry ? httpsReqComRetry : httpsReq)(montarOpcoes(h), body);
  let res = await executar(host);
  const sugerido = blingHostSugerido(res);
  if (sugerido && sugerido !== host) {
    logW('bling', `O Bling recusou ${host} e indicou ${sugerido} — repetindo a chamada lá`);
    const res2 = await executar(sugerido);
    if (res2.status < 400) {
      try { configSet(chaveConfig, sugerido); } catch (e) {}
      logI('bling', `Endereço do Bling atualizado: ${chaveConfig} = ${sugerido}`);
    }
    return res2;
  }
  return res;
}

const REDIRECT_URI  = `http://localhost:${PORT_CALLBACK}/callback`;

// ── Credenciais OAuth do Bling (M3: fora do código-fonte) ──
// Ordem de prioridade:
//   1) Variáveis de ambiente BLING_CLIENT_ID / BLING_CLIENT_SECRET
//   2) Arquivo local credenciais-bling.json (NÃO versionar / NÃO compartilhar)
// Não há credencial embutida no código: este arquivo é versionado no Git,
// e um client_secret aqui iria junto para o repositório. Em instalação nova,
// coloque credenciais-bling.json na pasta do servidor antes de iniciar.
const CRED_FILE = path.join(RAIZ, 'credenciais-bling.json');

function carregarCredenciaisBling() {
  // 1) Ambiente
  if (process.env.BLING_CLIENT_ID && process.env.BLING_CLIENT_SECRET) {
    return { clientId: process.env.BLING_CLIENT_ID, clientSecret: process.env.BLING_CLIENT_SECRET, origem: 'env' };
  }
  // 2) Arquivo local
  try {
    if (fs.existsSync(CRED_FILE)) {
      const d = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
      if (d.client_id && d.client_secret) {
        return { clientId: d.client_id, clientSecret: d.client_secret, origem: 'arquivo' };
      }
    }
  } catch(e) {
    console.warn('[WARN] credenciais-bling.json ilegível:', e.message);
  }
  // 3) Sem credencial. O bloco de migração legada, que trazia client_id e
  //    client_secret escritos aqui dentro, foi REMOVIDO ao publicar este código
  //    no Git: segredo em arquivo versionado vai junto para o repositório.
  //    Ver seção 9 do docs/historico/HANDOFF_MIGRACAO_PESAGEM.md.
  //
  //    O servidor sobe assim mesmo, de propósito. Pesar, imprimir etiqueta e
  //    bipar bobina não podem depender do Bling nem de rede. As sessões ficam
  //    com bling_status='pendente_config' e sobem quando a credencial existir.
  console.warn('[WARN] ==============================================================');
  console.warn('[WARN] Bling SEM CREDENCIAL.');
  console.warn('[WARN] Pesagem e impressão funcionam normalmente.');
  console.warn('[WARN] O envio ao Bling fica em espera - pendente_config.');
  console.warn('[WARN] Para configurar, crie o arquivo:');
  console.warn(`[WARN]   ${CRED_FILE}`);
  console.warn('[WARN]   {"client_id":"...","client_secret":"..."}');
  console.warn('[WARN] ou defina BLING_CLIENT_ID e BLING_CLIENT_SECRET no ambiente.');
  console.warn('[WARN] ==============================================================');
  return { clientId: '', clientSecret: '', origem: 'ausente' };
}

const _cred = carregarCredenciaisBling();
const CLIENT_ID     = _cred.clientId;
const CLIENT_SECRET = _cred.clientSecret;

// ════════════════════════════════════════════════════════════════════
//  BLING — OAuth 2.0 + Refresh + Proxy
// ════════════════════════════════════════════════════════════════════

let tk = { accessToken: null, refreshToken: null, expiresAt: 0 };
let _tokenInvalido = false;
let _renovandoPromise = null;

function carregarTokens() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const d = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      tk.accessToken  = d.accessToken  || d.access_token  || null;
      tk.refreshToken = d.refreshToken || d.refresh_token || null;
      tk.expiresAt    = d.expiresAt    || 0;
      logI('bling', `Tokens carregados (expiresAt=${new Date(tk.expiresAt).toISOString()})`);
    } else {
      logW('bling', 'bling_tokens.json não encontrado — autentique via /bling/auth/start');
    }
  } catch(e) { logE('bling', 'Falha ao carregar tokens', { erro: e.message }); }
}
function salvarTokens() {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({
      accessToken:  tk.accessToken,
      refreshToken: tk.refreshToken,
      expiresAt:    tk.expiresAt,
      access_token:  tk.accessToken,
      refresh_token: tk.refreshToken,
      updated_at:    new Date().toISOString(),
    }, null, 2));
  } catch(e) { logE('bling', 'Falha ao salvar tokens', { erro: e.message }); }
}
carregarTokens();

function httpsReq(options, body) {
  return new Promise((resolve, reject) => {
    const opts = { ...options };
    // Aceita "host:porta" na configuração de endereço — é o que permite
    // apontar para o Bling de mentira do piso de testes.
    if (typeof opts.hostname === 'string' && opts.hostname.includes(':')) {
      const [h, p] = opts.hostname.split(':');
      opts.hostname = h;
      opts.port = Number(p) || undefined;
    }
    const req = (BLING_INSEGURO ? http : https).request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(new Error('Timeout (20s) na chamada Bling')); });
    if (body) req.write(body);
    req.end();
  });
}

// M2: executa uma chamada HTTPS com retry/backoff em erros transitórios.
// Repete em: erro de rede/timeout, HTTP 429 (rate limit) e 5xx.
// NÃO repete em 4xx (exceto 429) — esses são erros de payload/permissão.
// Backoff exponencial: ~0.8s, 1.6s, 3.2s.
async function httpsReqComRetry(options, body, maxTentativas = 3) {
  let ultimoErro;
  for (let tentativa = 1; tentativa <= maxTentativas; tentativa++) {
    try {
      const res = await httpsReq(options, body);
      const transitorio = res.status === 429 || (res.status >= 500 && res.status < 600);
      if (!transitorio || tentativa === maxTentativas) return res;
      logW('bling', `Resposta ${res.status} (transitória) — tentativa ${tentativa}/${maxTentativas}, repetindo...`);
    } catch(e) {
      ultimoErro = e;
      if (tentativa === maxTentativas) throw e;
      logW('bling', `Erro de rede "${e.message}" — tentativa ${tentativa}/${maxTentativas}, repetindo...`);
    }
    await new Promise(r => setTimeout(r, 800 * Math.pow(2, tentativa - 1)));
  }
  if (ultimoErro) throw ultimoErro;
}

async function renovarToken() {
  // M1: se já há uma renovação em curso, aguarda ELA terminar em vez de
  // retornar (antes, retornava sem renovar e o chamador seguia com token velho).
  if (_renovandoPromise) return _renovandoPromise;
  if (_tokenInvalido) throw new Error('refresh_token expirado — autentique em /bling/auth/start');
  if (!tk.refreshToken) throw new Error('Sem refresh_token — autentique em /bling/auth/start');

  _renovandoPromise = (async () => {
    logI('bling', 'Renovando access_token...');
    const body = `grant_type=refresh_token&refresh_token=${encodeURIComponent(tk.refreshToken)}`;
    const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const res = await blingRequisicao(blingHostOauth(), 'bling_host_oauth', h => ({
      hostname: h, path: '/Api/v3/oauth/token', method: 'POST',
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }), body);
    let data = {}; try { data = JSON.parse(res.body); } catch (e) {}
    if (!data.access_token) {
      // 403 por endereço bloqueado NÃO é refresh_token expirado. Marcar o
      // token como inválido aqui obrigaria a refazer o OAuth à toa.
      const desc = (data.error && (data.error.description || data.error.message)) || data.error_description;
      if (blingHostSugerido(res)) {
        throw new Error(`O Bling recusou o endereço ${blingHostOauth()} para o token. ${desc || ''}`.trim());
      }
      _tokenInvalido = true;
      throw new Error(desc || `HTTP ${res.status} — refresh_token expirado`);
    }
    tk.accessToken  = data.access_token;
    if (data.refresh_token) tk.refreshToken = data.refresh_token;
    tk.expiresAt = Date.now() + ((data.expires_in || 21600) - 60) * 1000;
    _tokenInvalido = false;
    salvarTokens();
    logI('bling', `Token renovado — próxima em ${Math.round((data.expires_in||21600)/3600)}h`);
  })();

  try {
    await _renovandoPromise;
  } finally {
    _renovandoPromise = null;
  }
}

async function trocarCodigo(code) {
  const body = `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
  const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const res = await blingRequisicao(blingHostOauth(), 'bling_host_oauth', h => ({
    hostname: h, path: '/Api/v3/oauth/token', method: 'POST',
    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }), body);
  let data = {}; try { data = JSON.parse(res.body); } catch (e) {}
  if (!data.access_token) {
    const desc = (data.error && (data.error.description || data.error.message)) || data.error_description;
    throw new Error(desc || `Falha ao obter token (HTTP ${res.status})`);
  }
  tk.accessToken  = data.access_token;
  tk.refreshToken = data.refresh_token;
  tk.expiresAt    = Date.now() + ((data.expires_in || 21600) - 60) * 1000;
  _tokenInvalido = false;
  salvarTokens();
  logI('bling', 'OAuth concluído — tokens salvos');
}

async function getToken() {
  if (!tk.accessToken && !tk.refreshToken) throw new Error('Não autenticado — /bling/auth/start');
  if (!tk.accessToken || Date.now() >= tk.expiresAt) await renovarToken();
  return tk.accessToken;
}

async function proxyChamada(token, method, blingPath, search, body) {
  return await blingRequisicao(blingHostApi(), 'bling_host_api', h => ({
    hostname: h, path: blingPath + (search || ''), method,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/json', ...(body ? {'Content-Length': Buffer.byteLength(body)} : {}) },
  }), body, true);
}

module.exports = { blingHostApi, blingHostOauth, blingHostSugerido, blingRecusouEndereco, CLIENT_ID,
  getToken, proxyChamada, renovarToken, tk, trocarCodigo, };
Object.defineProperty(module.exports, '_tokenInvalido', { enumerable: true, get: () => _tokenInvalido, set: v => { _tokenInvalido = v; } });
