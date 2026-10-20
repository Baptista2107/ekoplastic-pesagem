// ════════════════════════════════════════════════════════════════════
//  EKOPLASTIC — SERVIDOR UNIFICADO DE ETIQUETAS
//  ════════════════════════════════════════════════════════════════════
//  Tudo num único processo. Este arquivo só sobe o sistema; o resto mora em:
//    lib/    banco, logs, balança (porta em EKO_SERIAL_PORT), Bling (OAuth v3),
//            impressão EPL2, catálogos e regras de negócio
//    rotas/  as rotas HTTP, por assunto
//    public/ as telas
//
//  Porta principal:  3000  (HTTPS para o celular: 3443)
//  Porta callback:   8888  (OAuth do Bling)
//
//  Para iniciar:  INICIAR.bat
// ════════════════════════════════════════════════════════════════════

// Sobe os modulos na MESMA ordem do server.js antigo: banco e migracoes,
// enderecamento, materiais (sementes de config), balanca, Bling, impressao...
// Cada um so depende dos anteriores.
require('./lib/config');
require('./lib/log');
require('./lib/db');
require('./lib/enderecamento');
require('./lib/guia');
require('./lib/materiais');
require('./lib/balanca');
require('./lib/bling');
require('./lib/impressao');
require('./lib/separacao');
require('./lib/bobinas');
require('./lib/http');
require('./lib/negocio');
require('./lib/turnos');
require('./lib/atualizacao');

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const url    = require('url');

const {
  DB_FILE, LOG_DIR, PORT, PORT_CALLBACK, PORT_HTTPS, PRINTER_NAMES, PUBLIC_DIR,
} = require('./lib/config');
const { logE, logI, logW } = require('./lib/log');
const { configGet, db, makeTransaction } = require('./lib/db');
const { renovarToken, tk, trocarCodigo } = require('./lib/bling');
const { detectarImpressora, garantirScriptImpressao } = require('./lib/impressao');
const { corrigirSoltosHistorico, empurrarVivoVps, VIVO_CADA_MS } = require('./lib/bobinas');
const { jsonErr, MIME, NAO_TRATADA } = require('./lib/http');
const { checarSessoesParaAutoFim } = require('./lib/turnos');
const impressaoMod = require('./lib/impressao');   // variaveis que mudam de valor: ler sempre por aqui
const atualizacaoMod = require('./lib/atualizacao');   // variaveis que mudam de valor: ler sempre por aqui
// Rotas por assunto, testadas nesta ordem (a primeira que atender responde).
const ROTAS = [
  require('./rotas/sistema'),
  require('./rotas/etiquetas'),
  require('./rotas/sessoes'),
  require('./rotas/catalogo-mp'),
  require('./rotas/produto-acabado'),
  require('./rotas/enderecamento'),
  require('./rotas/separacao'),
  require('./rotas/dashboard'),
  require('./rotas/bobinas'),
  require('./rotas/inventario'),
];

// ════════════════════════════════════════════════════════════════════
//  ROTAS — Servidor principal (porta 3000)
// ════════════════════════════════════════════════════════════════════

const requestHandlerBase = async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // CORS aberto (mesma origem na prática, mas mantém pra flexibilidade)
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  try {
    for (const rota of ROTAS) {
      if (await rota(req, res, parsed, pathname) !== NAO_TRATADA) return;
    }


    // ─── ARQUIVOS ESTÁTICOS ───
    // / → public/index.html
    let filePath = pathname === '/' ? '/index.html' : pathname;
    const finalPath = path.join(PUBLIC_DIR, filePath);
    // Proteção contra path traversal
    if (!finalPath.startsWith(PUBLIC_DIR)) return jsonErr(res, 403, 'Acesso negado');
    fs.readFile(finalPath, (err, data) => {
      const ext = path.extname(finalPath);
      // HTML/JS/CSS NUNCA em cache: evita o navegador servir uma tela antiga
      // depois que o sistema é atualizado (causa de telas "iguais às de antes").
      const semCache = (ext === '.html' || ext === '.js' || ext === '.css');
      if (err) {
        // Fallback: tenta servir index.html (SPA-style)
        fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, d2) => {
          if (e2) { res.writeHead(404); res.end('404 Not Found'); return; }
          res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8', 'Cache-Control': 'no-store, must-revalidate' }); res.end(d2);
        });
        return;
      }
      const headers = { 'Content-Type': MIME[ext] || 'text/plain' };
      if (semCache) headers['Cache-Control'] = 'no-store, must-revalidate';
      res.writeHead(200, headers);
      res.end(data);
    });} catch(e) {
    logE('http', `Erro não tratado em ${req.method} ${pathname}`, { erro: e.message, stack: e.stack });
    if (!res.headersSent) jsonErr(res, 500, 'Erro interno', { detalhe: e.message });
  }
};

// Envelope do handler: só conta operação de escrita em voo. Não muda
// rota nenhuma — chama o handler original e devolve o que ele devolver.
const requestHandler = async (req, res) => {
  const metodo  = (req.method || 'GET').toUpperCase();
  const escreve = metodo === 'POST' || metodo === 'PUT' || metodo === 'PATCH' || metodo === 'DELETE';
  let conta = false;
  try {
    conta = escreve && url.parse(req.url, true).pathname !== '/sistema/atualizar';
  } catch(e) { conta = escreve; }
  if (conta) atualizacaoMod.OPS_EM_VOO++;
  try {
    return await requestHandlerBase(req, res);
  } finally {
    if (conta) { atualizacaoMod.OPS_EM_VOO--; atualizacaoMod.ULTIMA_OP_MS = Date.now(); }
  }
};

const server = http.createServer(requestHandler);

// ════════════════════════════════════════════════════════════════════
//  HTTPS NA REDE (porta 3443) — para acesso pelo CELULAR
//  A câmera dos navegadores só funciona em HTTPS. Servimos o MESMO
//  sistema por HTTPS com um certificado auto-assinado gerado localmente
//  (node-forge, JS puro). O HTTP em 127.0.0.1 continua igual pro Mini PC.
// ════════════════════════════════════════════════════════════════════
function ipsLocaisV4() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const nome of Object.keys(nets || {})) {
    for (const net of nets[nome] || []) {
      if (net && net.family === 'IPv4' && !net.internal && net.address) ips.push(net.address);
    }
  }
  return ips;
}

function garantirCertificado() {
  const dir = path.join(__dirname, 'cert');
  const certPath = path.join(dir, 'cert.pem');
  const keyPath  = path.join(dir, 'key.pem');
  const hostsPath = path.join(dir, 'hosts.txt');
  const ips = ipsLocaisV4();
  const assinatura = ['localhost', '127.0.0.1'].concat(ips).join(',');
  // Reaproveita o certificado só se ele cobrir exatamente os IPs de rede atuais.
  // Se o IP do Mini PC mudar, gera um novo automaticamente (o celular precisa
  // acessar por um IP que esteja no certificado).
  try {
    if (fs.existsSync(certPath) && fs.existsSync(keyPath) && fs.existsSync(hostsPath)) {
      if (fs.readFileSync(hostsPath, 'utf8').trim() === assinatura) {
        return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
      }
      logI('https', 'IP da rede mudou desde o ultimo certificado — gerando um novo');
    }
  } catch(e) {}
  let forge;
  try { forge = require('node-forge'); }
  catch(e) { logW('https', 'node-forge nao encontrado — HTTPS desativado. Rode "npm install" na pasta do sistema.'); return null; }
  try {
    const pki = forge.pki;
    const keys = pki.rsa.generateKeyPair(2048);
    const cert = pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = String(Date.now());
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);
    const attrs = [{ name: 'commonName', value: 'Ekoplastic' }, { name: 'organizationName', value: 'Ekoplastic' }];
    cert.setSubject(attrs); cert.setIssuer(attrs);
    // SAN: localhost + 127.0.0.1 + todos os IPs de rede da maquina, para o
    // celular conseguir acessar por https://<ip>:3443 sem erro de "nome invalido".
    const altNames = [ { type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' } ];
    for (const ip of ips) altNames.push({ type: 7, ip });
    cert.setExtensions([
      { name: 'basicConstraints', cA: true },
      { name: 'subjectAltName', altNames },
    ]);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    const pemCert = pki.certificateToPem(cert);
    const pemKey  = pki.privateKeyToPem(keys.privateKey);
    try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(certPath, pemCert); fs.writeFileSync(keyPath, pemKey); fs.writeFileSync(hostsPath, assinatura); } catch(e) {}
    logI('https', `Certificado gerado (validade 10 anos) cobrindo: ${assinatura}`);
    return { cert: pemCert, key: pemKey };
  } catch(e) {
    logW('https', 'Falha ao gerar certificado — HTTPS desativado', { erro: e && e.message });
    return null;
  }
}

let serverHttps = null;
(function subirHttps(){
  const cred = garantirCertificado();
  if (!cred) return;
  serverHttps = https.createServer({ key: cred.key, cert: cred.cert }, requestHandler);
  serverHttps.on('error', e => {
    if (e.code === 'EADDRINUSE') logW('https', `Porta ${PORT_HTTPS} em uso — HTTPS nao subiu`);
    else logW('https', `Erro no HTTPS: ${e.message}`);
  });
})();

// ════════════════════════════════════════════════════════════════════
//  SERVIDOR CALLBACK OAuth (porta 8888)
// ════════════════════════════════════════════════════════════════════

const serverCb = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  if (parsed.pathname === '/callback') {
    const { code, error, state } = parsed.query;
    const html = (ok, msg) => `<html><body style="font-family:sans-serif;padding:40px;background:#0d0f14;color:${ok?'#00ff9d':'#ff4466'}">
      <h2>${ok ? '✓ Bling autenticado!' : '❌ Erro'}</h2><p>${msg}</p>
      ${ok ? '<script>setTimeout(()=>window.close(),2000)</script>' : ''}
      </body></html>`;
    if (error || !code) {
      logW('bling', `Callback recebeu erro`, { error, state: state?.substring(0,8) });
      res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});
      return res.end(html(false, error || 'sem código'));
    }
    const stateEsperado = configGet('oauth_state', null);
    if (stateEsperado && state !== stateEsperado) {
      logW('bling', `State inválido no callback :8888`, { esperado: stateEsperado?.substring(0,8), recebido: state?.substring(0,8) });
      res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});
      return res.end(html(false, 'state inválido (sessão expirada ou possível CSRF)'));
    }
    try {
      await trocarCodigo(code);
      res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' });
      res.end(html(true, 'Pode fechar esta aba.'));
      logI('bling', 'OAuth concluído via callback :8888');
    } catch(e) {
      res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' });
      res.end(html(false, e.message));
    }
    return;
  }
  res.writeHead(404); res.end();
});

// ════════════════════════════════════════════════════════════════════
//  STARTUP
// ════════════════════════════════════════════════════════════════════

// Uma vez só: devolve os soltos descontados de bobina de outra cor/formato.
// Falha aqui não pode impedir o coletor de subir.
try { corrigirSoltosHistorico(); } catch (e) { logE('bobinas', `Correção dos soltos no histórico falhou: ${e.message}`); }

serverCb.listen(PORT_CALLBACK, '127.0.0.1', () => {
  logI('http', `Callback OAuth escutando em http://localhost:${PORT_CALLBACK}/callback`);
});
serverCb.on('error', e => {
  if (e.code === 'EADDRINUSE') logW('http', `Porta ${PORT_CALLBACK} em uso — OAuth callback pode não funcionar`);
});

// Limpeza na inicialização: cancela sessões abertas (fim IS NULL) que não têm
// NENHUMA etiqueta ativa (aguardando_bipe/bipada) — sobras de testes ou de
// sessões cujos itens foram todos excluídos. Evita "em andamento" fantasma na
// tela inicial / nas abas. Sessões com itens ativos são preservadas (resumíveis).
function limparSessoesOrfas() {
  try {
    const orfas = db.prepare(`
      SELECT s.id, s.tipo FROM sessoes s
      WHERE s.fim IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM etiquetas e
          WHERE e.sessao_id = s.id AND e.status IN ('aguardando_bipe','bipada')
        )
    `).all();
    if (!orfas.length) return 0;
    const agora = new Date().toISOString();
    const stmt = db.prepare(`UPDATE sessoes SET fim = ?, bling_status = 'cancelada' WHERE id = ?`);
    const tr = makeTransaction(() => { for (const s of orfas) stmt.run(agora, s.id); });
    tr();
    logI('sessao', `Limpeza inicial: ${orfas.length} sessão(ões) órfã(s) sem itens ativos cancelada(s) [${orfas.map(o => '#'+o.id+'/'+o.tipo).join(', ')}]`);
    return orfas.length;
  } catch(e) {
    logW('sessao', 'Falha na limpeza de sessões órfãs', { erro: e.message });
    return 0;
  }
}

// Libera etiquetas "presas": originais com status 'consumida' cujo consumo de
// retirada foi TODO cancelado/estornado voltam para 'bipada' (aptas a bipar de
// novo). Cobre as sobras de retiradas canceladas ANTES desta correção. Roda no
// startup. Não toca em etiquetas com consumo ativo (essas seguem consumidas).
function liberarConsumosOrfaos() {
  try {
    const info = db.prepare(`
      UPDATE etiquetas SET status = 'bipada', hora_bipagem = NULL
      WHERE status = 'consumida'
        AND EXISTS (SELECT 1 FROM etiquetas v  WHERE v.ref_id  = etiquetas.id AND v.tipo  = 'retirada')
        AND NOT EXISTS (SELECT 1 FROM etiquetas v2 WHERE v2.ref_id = etiquetas.id AND v2.tipo = 'retirada' AND v2.status != 'cancelada')
    `).run();
    if (info.changes > 0) logI('retirada', `Liberadas ${info.changes} etiqueta(s) presa(s) por consumo cancelado — aptas a bipar de novo`);
    return info.changes;
  } catch(e) {
    logW('retirada', 'Falha ao liberar consumos órfãos', { erro: e.message });
    return 0;
  }
}

// HTTPS na rede (0.0.0.0) para o celular acessar — só se o certificado subiu.
if (serverHttps) {
  serverHttps.listen(PORT_HTTPS, '0.0.0.0', () => {
    logI('https', `HTTPS na rede: porta ${PORT_HTTPS} — acesse https://IP-DO-MINI-PC:${PORT_HTTPS} pelo celular (mesmo Wi-Fi)`);
  });
}

server.listen(PORT, '127.0.0.1', async () => {
  console.log('');
  console.log('  ============================================================');
  console.log('   EKOPLASTIC - SERVIDOR DE ETIQUETAS');
  console.log('  ============================================================');
  console.log(`   HTTP:        http://localhost:${PORT}`);
  console.log(`   HTTPS(rede): ${serverHttps ? 'https://<ip-do-mini-pc>:'+PORT_HTTPS+'  (celular)' : 'desativado (rode npm install)'}`);
  console.log(`   Callback:    http://localhost:${PORT_CALLBACK}/callback`);
  console.log(`   Banco:       ${DB_FILE}`);
  console.log(`   Logs:        ${LOG_DIR}/`);
  console.log('');

  // Garante o script de impressão (gera se faltar) ANTES de detectar
  garantirScriptImpressao();

  // Detecta impressora
  detectarImpressora((match, installed) => {
    if (installed.length > 0) {
      console.log(`   Impressoras instaladas (${installed.length}):`);
      installed.forEach(p => {
        const tag = (p.Name === match) ? '  <<< ATIVA' : '';
        console.log(`     - ${(p.Name||'?').padEnd(34)} ${(p.PortName||'?').padEnd(12)} ${p.PrinterStatus||'?'}${tag}`);
      });
    }
    if (match) { impressaoMod.PRINTER_ATIVA = match; impressaoMod.PRINTER_DETECTADA = true; logI('print', `Impressora ATIVA: ${impressaoMod.PRINTER_ATIVA}`); }
    else logW('print', `Nenhuma das impressoras esperadas detectada (${PRINTER_NAMES.join(', ')})`);
    console.log('');
  });

  // Status do Bling
  if (tk.refreshToken) {
    if (!tk.accessToken || Date.now() >= tk.expiresAt) {
      renovarToken().catch(e => logW('bling', 'Renovação automática falhou', { erro: e.message }));
    } else {
      logI('bling', 'Pronto — access_token válido');
    }
  } else {
    logW('bling', 'Não autenticado — acesse http://localhost:3000/bling/auth/start');
  }

  // Limpa sessões órfãs (abertas, sem itens ativos) deixadas por testes ou por
  // exclusão de todos os itens — some o "em andamento" fantasma na tela/abas.
  limparSessoesOrfas();
  // Libera etiquetas presas (consumida com consumo cancelado) — voltam a bipável.
  liberarConsumosOrfaos();

  // Auto-finalização de turnos de Extrusão por horário (a cada 5min)
  // Roda também 5s depois do server subir (pra pegar sessões abandonadas
  // que estavam pendentes durante restart noturno).
  setTimeout(checarSessoesParaAutoFim, 5000);
  setInterval(checarSessoesParaAutoFim, 5 * 60 * 1000);
  logI('sessao', 'Auto-finalização de turnos de Extrusão ativada (verificação a cada 5min)');

  // Bipagem ao vivo → VPS (14/10/2026): ver empurrarVivoVps.
  setInterval(empurrarVivoVps, VIVO_CADA_MS);
  logI('vivo', `Envio ao vivo das bipagens à VPS ativado (a cada ${VIVO_CADA_MS / 1000}s)`);
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') logE('http', `Porta ${PORT} em uso. Já tem outro servidor rodando?`);
  else logE('http', `Erro no servidor`, { erro: e.message });
  process.exit(1);
});

process.on('SIGINT', () => { logI('app', 'Encerrando...'); db.close(); process.exit(0); });
process.on('SIGTERM', () => { logI('app', 'Encerrando...'); db.close(); process.exit(0); });

// M5: após uma exceção não capturada, o estado do processo pode estar
// corrompido (recomendação oficial do Node é encerrar). Logamos, tentamos
// fechar o banco com segurança, e saímos com código 1 — um supervisor
// (NSSM/serviço do Windows) deve reiniciar automaticamente. Isso é mais
// seguro que seguir rodando num estado indefinido.
let _encerrandoPorErro = false;
function encerrarPorErroFatal(origem, e) {
  if (_encerrandoPorErro) return;
  _encerrandoPorErro = true;
  logE('app', `${origem} — encerrando para reinício limpo`, { erro: e?.message || String(e), stack: e?.stack });
  try { db.close(); } catch(_) {}
  // Pequeno atraso pra garantir que o log foi gravado em disco
  setTimeout(() => process.exit(1), 250);
}
process.on('uncaughtException',  e => encerrarPorErroFatal('uncaughtException', e));
process.on('unhandledRejection', e => encerrarPorErroFatal('unhandledRejection', e));
