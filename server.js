// ════════════════════════════════════════════════════════════════════
//  EKOPLASTIC — SERVIDOR UNIFICADO DE ETIQUETAS
//  ════════════════════════════════════════════════════════════════════
//  Tudo num único processo:
//    - OAuth Bling API v3 + auto-refresh
//    - Proxy autenticado /bling/*
//    - Balança WT3000-iR (serial COM3)
//    - Impressão EPL2 raw (PowerShell + Win32 Spooler)
//    - Banco SQLite (etiquetas + sessões + sequenciais + config)
//    - Servidor de arquivos estáticos (public/)
//    - Callback OAuth secundário na porta 8888
//
//  Porta principal:  3000
//  Porta callback:   8888
//
//  Para iniciar:  INICIAR.bat
// ════════════════════════════════════════════════════════════════════

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const url    = require('url');
const crypto = require('node:crypto');
const { spawn } = require('child_process');

// ════════════════════════════════════════════════════════════════════
//  CONFIGURAÇÃO
// ════════════════════════════════════════════════════════════════════

const PORT          = parseInt(process.env.EKO_PORT)     || 3000;
const PORT_CALLBACK = parseInt(process.env.EKO_PORT_CB)  || 8888;
const PORT_HTTPS    = parseInt(process.env.EKO_PORT_HTTPS) || 3443;
const VERSION       = 'v157';   // versão do servidor (aparece no /healthcheck)

// Catálogo de BOBINAS CAPA (aba "Capas" da extrusão). Não passam pelo
// gravimétrico; entram na MESMA sessão de extrusão do turno (sub_tipo='capa')
// e vão ao Bling com ID próprio. Tubete = tara fixa (peso do eixo) por capa.
const CAPAS_CATALOGO = {
  'CAPA.70X90':      { id: '16589753347', nome: 'Bobina Capa 70 x 90',  dim: '70 x 90',  tubete: 3 },
  'CAPA.60X90':      { id: '16589752073', nome: 'Bobina Capa 60 x 90',  dim: '60 x 90',  tubete: 3 },
  'BOB.CAPA.92x0,5': { id: '16619426133', nome: 'Bobina Capa 92 x 0,5', dim: '92 x 0,5', tubete: 2 },
};

// Catálogo de OUTRAS PESAGENS (processo de inventário / resíduos).
// Sessão própria (tipo='outras'), sem operador/máquina. Aparas NÃO têm produto
// no Bling (blingId null) — entram só no resumo; borra e varredura têm ID e
// são enviadas ao Bling (pedido de compra / entrada de estoque). categoria =
// agrupamento do resumo. A chave é o código do item (vira sku/codigo da etiqueta).
const OUTRAS_CATALOGO = {
  'APARA.AMARELA': { nome: 'Apara Amarela', cor: 'Amarela', categoria: 'APARA',   blingId: null },
  'APARA.VERDE':   { nome: 'Apara Verde',   cor: 'Verde',   categoria: 'APARA',   blingId: null },
  'APARA.PRETA':   { nome: 'Apara Preta',   cor: 'Preta',   categoria: 'APARA',   blingId: null },
  'APARA.BRANCA':  { nome: 'Apara Branca',  cor: 'Branca',  categoria: 'APARA',   blingId: null },
  'RES.BORRA':     { nome: 'Borra',         cor: null,      categoria: 'RESIDUO', blingId: '16572867363' },
  'RES.VARREDURA': { nome: 'Varredura',     cor: null,      categoria: 'RESIDUO', blingId: '16572867344' },
  // PÓ usa o MESMO produto da varredura no Bling (mesmo SKU e ID). O que os
  // distingue lá é a observação do pedido, montada no envio.
  'RES.PO':        { nome: 'Pó',            cor: null,      categoria: 'RESIDUO', blingId: '16572867344', skuBling: 'RES.VARREDURA' },
};

const BLING_HOST    = 'www.bling.com.br';
const REDIRECT_URI  = `http://localhost:${PORT_CALLBACK}/callback`;

// ── Credenciais OAuth do Bling (M3: fora do código-fonte) ──
// Ordem de prioridade:
//   1) Variáveis de ambiente BLING_CLIENT_ID / BLING_CLIENT_SECRET
//   2) Arquivo local credenciais-bling.json (NÃO versionar / NÃO compartilhar)
// Não há credencial embutida no código: este arquivo é versionado no Git,
// e um client_secret aqui iria junto para o repositório. Em instalação nova,
// coloque credenciais-bling.json na pasta do servidor antes de iniciar.
const CRED_FILE = path.join(__dirname, 'credenciais-bling.json');

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
  //    Ver seção 9 do HANDOFF_MIGRACAO_PESAGEM.md.
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

const SERIAL_PORT = process.env.EKO_SERIAL_PORT || 'COM1';
const SERIAL_BAUD = parseInt(process.env.EKO_SERIAL_BAUD) || 9600;

const PRINTER_NAMES = [
  '4BARCODE 4B-2074B',
  'ZDesigner GC420t (EPL)',     // Zebra GC420t com driver EPL (espaço entre 't' e '(')
  'ZDesigner GC420t(EPL)',      // variação sem espaço (caso o driver instale assim)
  'ELGIN L42-DT',
];

const TOKEN_FILE  = path.join(__dirname, 'bling_tokens.json');
const PS_SCRIPT   = path.join(__dirname, 'enviar_raw.ps1');
const DB_FILE     = process.env.EKO_DB_FILE || path.join(__dirname, 'etiquetas.db');
const PUBLIC_DIR  = path.join(__dirname, 'public');
const LOG_DIR     = process.env.EKO_LOG_DIR || path.join(__dirname, 'logs');
const BACKUP_DIR  = path.join(__dirname, 'backups');
const LEGACY_JSON = path.join(__dirname, 'etiquetas-db.json');   // import do print-server v2

// ════════════════════════════════════════════════════════════════════
//  LOGGER (arquivo diário em logs/AAAA-MM-DD.log)
// ════════════════════════════════════════════════════════════════════

function ensureDir(d) { try { fs.mkdirSync(d, { recursive: true }); } catch(e) {} }
const MP_LOG_DIR = path.join(LOG_DIR, 'mp');
ensureDir(LOG_DIR); ensureDir(MP_LOG_DIR); ensureDir(BACKUP_DIR); ensureDir(PUBLIC_DIR);

function logFilePath() {
  const d = new Date();
  return path.join(LOG_DIR, `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}.log`);
}

// Caminho do log estruturado de movimentação de MP (1 arquivo por dia, JSONL).
function logMPFilePath() {
  const d = new Date();
  return path.join(MP_LOG_DIR, `movimentacao-${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}.jsonl`);
}

// Data local (YYYY-MM-DD) — usa fuso do sistema, sem conversão pra UTC.
// Necessário pra Bling /pedidos/vendas (data de emissão e parcelas).
function dataLocalISO(base) {
  const d = base ? new Date(base) : new Date();
  const yyyy = d.getFullYear();
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const dd   = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Calcula a faixa UTC [ini, fim) que corresponde a um DIA LOCAL (YYYY-MM-DD).
// Usado pra filtrar registros cujo timestamp é gravado em UTC (toISOString),
// mas que o usuário enxerga pelo "dia local". Robusto e independente do
// suporte a fusos do SQLite (que falha no Windows): o cálculo é feito pelo
// Node (que conhece o fuso do SO) e a comparação no SQLite é string-vs-string
// de ISO8601 UTC, cuja ordem lexicográfica == ordem cronológica.
function rangeUTCdoDiaLocal(dia) {
  const ini = new Date(`${dia}T00:00:00`);          // meia-noite LOCAL do SO
  const fim = new Date(ini.getTime() + 86400000);   // +24h
  return { ini: ini.toISOString(), fim: fim.toISOString() };
}

// Detecta se uma entrada de log é evento de movimentação de matéria-prima.
// Sources sempre MP: print, sessao, retirada-mp.
// Source bling/db é MP somente se a mensagem refere uma sessão (#N).
function isEventoMP(source, msg) {
  if (!source) return false;
  if (source === 'print' || source === 'sessao' || source === 'retirada' || source === 'retorno' || source === 'produto-acabado' || source === 'retirada-mp') return true;
  if ((source === 'bling' || source === 'db') && /sess(?:ã|a)o\s*#?\d+/i.test(msg || '')) return true;
  return false;
}

// Grava UMA linha JSON no log de MP com fsync explícito.
// fsync força o SO a confirmar a escrita no disco antes de retornar — protege
// contra perda em quedas de energia / kill brusco do processo.
function gravarLogMP(obj) {
  const fpath = logMPFilePath();
  let fd = null;
  try {
    fd = fs.openSync(fpath, 'a');
    fs.writeSync(fd, JSON.stringify(obj) + '\n', null, 'utf8');
    fs.fsyncSync(fd);
  } catch(e) {
    // Não joga no log normal pra evitar recursão. Console-only.
    console.error('[LOG_MP] Falha ao gravar:', e && e.message);
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch(e) {} }
  }
}

// ──────────────────────────────────────────────────────────────────
// Log estruturado de EXTRUSÃO (CSV diário em logs/extrusao/).
// Append-only, write-on-print: cada bobina gera 1 linha no momento
// da impressão da etiqueta. Status/bipagem/bling_id NÃO são atualizados
// nesse arquivo — pra ver dados frescos, use o endpoint /extrusao/dashboard
// ou /extrusao/export.csv que consultam direto o SQLite.
//
// Colunas (separador ; pra Excel BR):
//   data, hora, id, turno, operador, maquina, cor, tipo, largura,
//   sku, peso_liq, peso_bruto, tara, sessao_id, seq_sessao
//
// fsync explícito = mesma durabilidade do log MP.
// ──────────────────────────────────────────────────────────────────
function gravarLogExtrusaoCSV(dados) {
  try {
    const dir = path.join(LOG_DIR, 'extrusao');
    ensureDir(dir);
    const dataDia = dataLocalISO();
    const fpath = path.join(dir, `bobinas-${dataDia}.csv`);
    const novoArq = !fs.existsSync(fpath);
    const cabecalho = 'data;hora;id;turno;operador;maquina;cor;tipo;largura;sku;peso_liq;peso_bruto;tara;sessao_id;seq_sessao\n';
    const dt = new Date();
    const hora = dt.toLocaleTimeString('pt-BR', { hour12: false });
    const safe = v => v == null ? '' : String(v).replace(/[;\r\n]/g, ' ');
    const linha = [
      dataDia, hora, dados.id, dados.turno_codigo, dados.operador, dados.maquina,
      dados.cor, dados.tipo_bobina, dados.largura, dados.sku,
      Number(dados.peso).toFixed(3),
      dados.peso_bruto != null ? Number(dados.peso_bruto).toFixed(3) : '',
      dados.tara       != null ? Number(dados.tara).toFixed(3)       : '',
      dados.sessao_id, dados.seq_sessao,
    ].map(safe).join(';');
    const conteudo = (novoArq ? cabecalho : '') + linha + '\n';
    let fd = null;
    try {
      fd = fs.openSync(fpath, 'a');
      fs.writeSync(fd, conteudo, null, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      if (fd !== null) try { fs.closeSync(fd); } catch(e) {}
    }
  } catch(e) {
    console.error('[LOG_EXTRUSAO] Falha ao gravar CSV:', e && e.message);
  }
}

// ──────────────────────────────────────────────────────────────────
// LOG DE PRODUÇÃO POR BIPAGEM (para dashboard em tempo real)
// A cada etiqueta que vira 'bipada', adiciona UMA linha ao CSV do dia,
// em arquivos SEPARADOS por área:
//   logs/producao/extrusao-AAAA-MM-DD.csv
//   logs/producao/materia-prima-AAAA-MM-DD.csv
// A linha leva os dados que vão na etiqueta. Separador ; (Excel BR) e
// fsync explícito (durável, igual aos outros logs). Recebe o registro
// da etiqueta direto do banco (getEtiqueta) — os nomes dos campos são os
// das colunas do SQLite.
// ──────────────────────────────────────────────────────────────────
// Grava uma linha em CSV (cabeçalho só quando o arquivo é novo), com fsync
// explícito pra durabilidade. Reusado por todos os logs de produção.
function appendCsvLine(fpath, cabecalho, linha) {
  const novoArq  = !fs.existsSync(fpath);
  const conteudo = (novoArq ? cabecalho : '') + linha;
  let fd = null;
  try {
    fd = fs.openSync(fpath, 'a');
    fs.writeSync(fd, conteudo, null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch(e) {}
  }
}

// Nome de pasta seguro pro Windows a partir do nome do fornecedor: remove
// caracteres proibidos e colapsa espaços. Vazio → null (não cria pasta).
function sanitizeNomePasta(nome) {
  if (!nome) return null;
  const limpo = String(nome).trim().replace(/[<>:"/\\|?*\x00-\x1F]/g, '').replace(/\s+/g, ' ').trim();
  return limpo || null;
}

// Registro de MOVIMENTAÇÃO DE MATÉRIA-PRIMA em pastas organizadas (por dia):
//   producao/movimentacao-diaria/
//     recebimentos/recebimento-AAAA-MM-DD.csv   (só recebimentos do dia)
//     retiradas/retirada-AAAA-MM-DD.csv          (só retiradas do dia)
//     retornos/retorno-AAAA-MM-DD.csv            (só retornos do dia)
//     fornecedores/<Fornecedor>/<tipo>-AAAA-MM-DD.csv  (mesma linha, por fornecedor)
// A MESMA linha vai nas duas visões (por tipo e por fornecedor). No RETORNO,
// et.fornecedor é o fornecedor ORIGINAL (dono do SKU) — o EKOPLASTIC é só o
// contato do envio ao Bling —, então a pasta do fornecedor reflete o dono real.
function gravarLogMovimentacaoMP(et, ev, dir, dataDia, horaBip, safe, num) {
  const operacao = et.tipo === 'recebimento' ? 'Recebimento'
                 : et.tipo === 'retorno'     ? 'Retorno'
                 : et.tipo === 'retirada'    ? 'Retirada'
                 : (et.tipo || '');
  const cabecalho = 'data;hora_bipagem;id;operacao;material;cor;fornecedor;lote;peso;qtd_sacos;codigo;sku;sessao_id;evento\n';
  const linha = [
    dataDia, horaBip, et.id, operacao, et.material_key,
    et.cor, et.fornecedor, et.lote,
    num(et.peso), et.qtd_sacos, et.codigo, et.sku, et.sessao_id, ev,
  ].map(safe).join(';') + '\n';

  const tipoArq   = et.tipo === 'recebimento' ? 'recebimento'
                  : et.tipo === 'retorno'     ? 'retorno'
                  : et.tipo === 'retirada'    ? 'retirada'
                  : (et.tipo || 'mp');
  const pastaTipo = et.tipo === 'recebimento' ? 'recebimentos'
                  : et.tipo === 'retorno'     ? 'retornos'
                  : et.tipo === 'retirada'    ? 'retiradas'
                  : 'outros';

  const base = path.join(dir, 'movimentacao-diaria');
  // 1) visão por tipo de operação (dividida por dia)
  const dirTipo = path.join(base, pastaTipo);
  ensureDir(dirTipo);
  appendCsvLine(path.join(dirTipo, `${tipoArq}-${dataDia}.csv`), cabecalho, linha);
  // 2) visão por fornecedor (dividida por dia) — usa o fornecedor da etiqueta
  const fornNome = sanitizeNomePasta(et.fornecedor);
  if (fornNome) {
    const dirForn = path.join(base, 'fornecedores', fornNome);
    ensureDir(dirForn);
    appendCsvLine(path.join(dirForn, `${tipoArq}-${dataDia}.csv`), cabecalho, linha);
  }
}

function gravarLogProducaoBipagem(et, evento) {
  if (!et) return;
  try {
    const ev  = evento || 'bipagem';   // 'bipagem' (padrão) ou 'cancelamento' (item excluído pelo X)
    const dir = path.join(LOG_DIR, 'producao');
    ensureDir(dir);
    const dataDia = dataLocalISO();
    const horaBip = new Date().toLocaleTimeString('pt-BR', { hour12: false });
    const safe = v => v == null ? '' : String(v).replace(/[;\r\n]/g, ' ');
    const num  = v => v == null ? '' : Number(v).toFixed(3);

    // MP (recebimento/retirada/retorno) → nova organização em pastas por
    // movimentação diária (por tipo de operação e por fornecedor).
    if (et.tipo === 'recebimento' || et.tipo === 'retirada' || et.tipo === 'retorno') {
      gravarLogMovimentacaoMP(et, ev, dir, dataDia, horaBip, safe, num);
      return;
    }

    let fpath, cabecalho, campos;
    if (et.tipo === 'extrusao') {
      fpath     = path.join(dir, `extrusao-${dataDia}.csv`);
      cabecalho = 'data;hora_bipagem;id;turno;operador;maquina;cor;tipo_bobina;largura;peso_liquido;peso_bruto;tara;sku;sessao_id;evento\n';
      campos = [
        dataDia, horaBip, et.id, et.turno_codigo, et.operador, et.maquina,
        et.cor, et.tipo_bobina, et.largura,
        num(et.peso), num(et.peso_bruto), num(et.tara),
        et.sku, et.sessao_id, ev,
      ];
    } else if (et.tipo === 'produto-acabado') {
      // Produto acabado tem CSV próprio, separado de extrusão e matéria-prima.
      fpath     = path.join(dir, `produto-acabado-${dataDia}.csv`);
      cabecalho = 'data;hora_bipagem;id;turno;maquina;cor;formato;fardos;peso_kg;sku;sessao_id;evento\n';
      campos = [
        dataDia, horaBip, et.id, et.turno_codigo, et.maquina,
        et.cor, et.lote, et.qtd_sacos, num(et.peso),
        et.sku, et.sessao_id, ev,
      ];
    } else {
      const operacao = et.tipo === 'recebimento' ? 'Recebimento'
                     : et.tipo === 'retorno'     ? 'Retorno'
                     : et.tipo === 'retirada'    ? 'Retirada'
                     : (et.tipo || '');
      fpath     = path.join(dir, `materia-prima-${dataDia}.csv`);
      cabecalho = 'data;hora_bipagem;id;operacao;material;cor;fornecedor;lote;peso;qtd_sacos;codigo;sku;sessao_id;evento\n';
      campos = [
        dataDia, horaBip, et.id, operacao, et.material_key,
        et.cor, et.fornecedor, et.lote,
        num(et.peso), et.qtd_sacos, et.codigo, et.sku, et.sessao_id, ev,
      ];
    }
    const linha = campos.map(safe).join(';') + '\n';
    appendCsvLine(fpath, cabecalho, linha);
  } catch (e) {
    console.error('[LOG_PRODUCAO] Falha ao gravar bipagem:', e && e.message);
  }
}

function log(level, source, msg, extra) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] [${source}] ${msg}${extra ? ' | ' + JSON.stringify(extra) : ''}`;
  const consoleLine = `[${ts.substring(11,19)}] ${level.padEnd(5)} ${source.padEnd(8)} ${msg}`;
  console.log(consoleLine);
  try { fs.appendFileSync(logFilePath(), line + '\n', 'utf8'); } catch(e) {}
  // Replica eventos de movimentação de MP no log estruturado (durável)
  if (isEventoMP(source, msg)) {
    gravarLogMP({ ts, level, source, msg, extra: extra || null });
  }
}
const logI = (src, m, x) => log('INFO',  src, m, x);
const logW = (src, m, x) => log('WARN',  src, m, x);
const logE = (src, m, x) => log('ERROR', src, m, x);
const logD = (src, m, x) => log('DEBUG', src, m, x);

// ── Segurança: trava de saída por senha de supervisor ──
// Qual commit esta rodando. Lido direto de .git/HEAD, sem chamar o git:
// serve para conferir DE OUTRA MAQUINA, pelo /healthcheck, qual versao a
// estacao esta executando de fato. Sem isto, "atualizei?" so' se responde
// indo ate' o Mini PC. Devolve null quando a pasta nao veio de um clone.
function commitAtual() {
  try {
    const head = fs.readFileSync(path.join(__dirname, '.git', 'HEAD'), 'utf8').trim();
    const m = head.match(/^ref:\s*(.+)$/);
    if (!m) return head.slice(0, 7);                    // HEAD destacado: o proprio sha
    const ref = fs.readFileSync(path.join(__dirname, '.git', m[1].trim()), 'utf8').trim();
    return ref.slice(0, 7);
  } catch (e) { return null; }
}

function hashSenha(s) {
  // SHA-256 com sal fixo do app (senha numérica de balcão; protege contra
  // leitura casual do hash, não contra ataque técnico determinado).
  return crypto.createHash('sha256').update('eko$' + String(s)).digest('hex');
}
// Grava tentativas/eventos de segurança num log dedicado (desvios), além
// do log geral. Um arquivo por mês, em logs/desvios-YYYY-MM.jsonl.
function logDesvio(evento) {
  const ts = new Date().toISOString();
  const reg = { ts, ...evento };
  const d = new Date();
  const arq = path.join(LOG_DIR, `desvios-${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}.jsonl`);
  try { fs.appendFileSync(arq, JSON.stringify(reg) + '\n', 'utf8'); } catch(e) {}
  logW('seguranca', `${evento.tipo || 'evento'} em ${evento.tela || '?'}`, evento.detalhe ? { detalhe: evento.detalhe } : undefined);
}

// ════════════════════════════════════════════════════════════════════
//  BANCO SQLITE (node:sqlite — built-in do Node 22.5+)
//  Tabelas: etiquetas, sessoes, seqs, config
// ════════════════════════════════════════════════════════════════════

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch(e) {
  console.error('\n[FATAL] node:sqlite não disponível.');
  console.error('Requer Node.js 22.5 ou superior. Sua versão: ' + process.version);
  console.error('Atualize Node em https://nodejs.org/\n');
  process.exit(1);
}

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = FULL');   // M7: máxima durabilidade em queda de energia
db.exec('PRAGMA foreign_keys = ON');

// Wrapper de transaction (este projeto usa node:sqlite built-in, Node 22.5+;
// a API de transação é manual via BEGIN/COMMIT/ROLLBACK, ao contrário do
// db.transaction() do better-sqlite3)
function makeTransaction(fn) {
  return (...args) => {
    db.exec('BEGIN');
    try {
      const r = fn(...args);
      db.exec('COMMIT');
      return r;
    } catch(e) {
      try { db.exec('ROLLBACK'); } catch(e2) {}
      throw e;
    }
  };
}

// ─── Schema (idempotente — só cria o que não existir) ───
function aplicarSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS etiquetas (
      id              TEXT PRIMARY KEY,
      seq             INTEGER NOT NULL,
      seq_sessao      INTEGER,
      tipo            TEXT NOT NULL CHECK(tipo IN ('recebimento','retorno','retirada','extrusao','outras','produto-acabado')),
      sub_tipo        TEXT,
      material_key    TEXT NOT NULL,
      material_nome   TEXT,
      material_label  TEXT,
      cor             TEXT,
      fornecedor      TEXT NOT NULL,
      lote            TEXT NOT NULL,
      peso            REAL NOT NULL CHECK(peso >= 0),
      qtd_sacos       INTEGER,
      codigo          TEXT NOT NULL,
      sku             TEXT NOT NULL,
      status          TEXT NOT NULL CHECK(status IN ('aguardando_bipe','bipada','cancelada','consumida')),
      ref_id          TEXT,
      hora_impressao  TEXT NOT NULL,
      hora_bipagem    TEXT,
      sessao_id       INTEGER,
      impressora      TEXT,
      -- Campos específicos da Extrusão (NULL pros tipos de MP)
      operador        TEXT,
      maquina         TEXT,
      largura         TEXT,
      tipo_bobina     TEXT,
      turno_codigo    TEXT,
      bling_pedido_id INTEGER,
      peso_bruto      REAL,
      tara            REAL,
      FOREIGN KEY (sessao_id) REFERENCES sessoes(id)
    );

    CREATE TABLE IF NOT EXISTS sessoes (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo            TEXT NOT NULL CHECK(tipo IN ('recebimento','retorno','retirada','extrusao','outras','produto-acabado')),
      inicio          TEXT NOT NULL,
      fim             TEXT,
      fornecedor      TEXT,
      total_kg        REAL,
      total_etiquetas INTEGER,
      bling_status    TEXT CHECK(bling_status IN ('pendente_config','pendente','enviado','erro','cancelada','parcial') OR bling_status IS NULL),
      bling_id        TEXT,
      bling_erro      TEXT,
      -- Campos específicos da Extrusão (NULL pros tipos de MP)
      operador        TEXT,
      maquina         TEXT,
      turno_codigo    TEXT
    );

    CREATE TABLE IF NOT EXISTS seqs (
      tipo  TEXT PRIMARY KEY,
      valor INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS config (
      chave TEXT PRIMARY KEY,
      valor TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_etiq_tipo_status ON etiquetas(tipo, status);
    CREATE INDEX IF NOT EXISTS idx_etiq_sessao      ON etiquetas(sessao_id);
    CREATE INDEX IF NOT EXISTS idx_etiq_hora        ON etiquetas(hora_impressao DESC);
    CREATE INDEX IF NOT EXISTS idx_sessoes_status   ON sessoes(bling_status);

    INSERT OR IGNORE INTO seqs(tipo, valor) VALUES ('recebimento', 1), ('retorno', 1), ('retirada', 1), ('extrusao', 1);
  `);
}
aplicarSchema();

// ─── Migração v3: estender CHECK das tabelas pra aceitar tipo='retirada' ───
// SQLite não permite ALTER de CHECK; recria a tabela mantendo os dados.
// Detecta a necessidade tentando inserir uma linha sentinela.
function migrarSchemaParaV3() {
  // Tenta inserir uma sessão sentinela com tipo='retirada' — se aceitar, schema já está v3
  let precisaMigrar = false;
  try {
    db.prepare(`INSERT INTO sessoes (tipo, inicio) VALUES ('retirada', '__migrate_test__')`).run();
    db.prepare(`DELETE FROM sessoes WHERE inicio = '__migrate_test__'`).run();
  } catch(e) {
    if (/CHECK constraint failed/i.test(e.message) || /constraint/i.test(e.message)) {
      precisaMigrar = true;
    } else {
      throw e;
    }
  }
  if (!precisaMigrar) return;

  logI('db', 'Migrando schema para v3 (suporte a tipo=retirada)...');
  // SQLite recomenda desligar FKs durante migrações que recriam tabelas
  // (ALTER TABLE ... RENAME quebraria temporariamente as referências).
  // Ref: https://www.sqlite.org/lang_altertable.html#otheralter
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    const tr = makeTransaction(() => {
      // ── etiquetas: recriar com novo CHECK ──
      db.exec(`
        CREATE TABLE etiquetas_v3 (
          id              TEXT PRIMARY KEY,
          seq             INTEGER NOT NULL,
          tipo            TEXT NOT NULL CHECK(tipo IN ('recebimento','retorno','retirada')),
          sub_tipo        TEXT,
          material_key    TEXT NOT NULL,
          material_nome   TEXT,
          material_label  TEXT,
          cor             TEXT,
          fornecedor      TEXT NOT NULL,
          lote            TEXT NOT NULL,
          peso            REAL NOT NULL CHECK(peso >= 0),
          qtd_sacos       INTEGER,
          codigo          TEXT NOT NULL,
          sku             TEXT NOT NULL,
          status          TEXT NOT NULL CHECK(status IN ('aguardando_bipe','bipada','cancelada','consumida')),
          ref_id          TEXT,
          hora_impressao  TEXT NOT NULL,
          hora_bipagem    TEXT,
          sessao_id       INTEGER,
          impressora      TEXT,
          FOREIGN KEY (sessao_id) REFERENCES sessoes(id)
        );
        INSERT INTO etiquetas_v3 SELECT * FROM etiquetas;
        DROP TABLE etiquetas;
        ALTER TABLE etiquetas_v3 RENAME TO etiquetas;
      `);

      // ── sessoes: recriar com novo CHECK ──
      db.exec(`
        CREATE TABLE sessoes_v3 (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          tipo            TEXT NOT NULL CHECK(tipo IN ('recebimento','retorno','retirada')),
          inicio          TEXT NOT NULL,
          fim             TEXT,
          fornecedor      TEXT,
          total_kg        REAL,
          total_etiquetas INTEGER,
          bling_status    TEXT CHECK(bling_status IN ('pendente_config','pendente','enviado','erro','cancelada') OR bling_status IS NULL),
          bling_id        TEXT,
          bling_erro      TEXT
        );
        INSERT INTO sessoes_v3 SELECT * FROM sessoes;
        DROP TABLE sessoes;
        ALTER TABLE sessoes_v3 RENAME TO sessoes;
      `);

      // ── índices ──
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_etiq_tipo_status ON etiquetas(tipo, status);
        CREATE INDEX IF NOT EXISTS idx_etiq_sessao      ON etiquetas(sessao_id);
        CREATE INDEX IF NOT EXISTS idx_etiq_hora        ON etiquetas(hora_impressao DESC);
        CREATE INDEX IF NOT EXISTS idx_sessoes_status   ON sessoes(bling_status);
      `);

      // ── seq de retirada ──
      db.exec(`INSERT OR IGNORE INTO seqs(tipo, valor) VALUES ('retirada', 1)`);
    });
    tr();
    // Verifica integridade das FKs após migração
    const orfas = db.prepare(`PRAGMA foreign_key_check`).all();
    if (orfas.length > 0) {
      logW('db', `Migração v3: ${orfas.length} referência(s) FK órfã(s) encontradas`, { exemplo: orfas[0] });
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  logI('db', 'Schema migrado para v3 com sucesso');
}
migrarSchemaParaV3();

// ──────────────────────────────────────────────────────────────────
// Migração v4 — coluna seq_sessao (numeração da etiqueta DENTRO da sessão)
// Permite rastreabilidade visual "Big Bag #1, #2, #3" nos logs, etiqueta
// impressa e na descrição dos itens do Bling.
// ──────────────────────────────────────────────────────────────────
function migrarSchemaParaV4() {
  const cols = db.prepare("PRAGMA table_info(etiquetas)").all();
  const tem = cols.some(c => c.name === 'seq_sessao');
  if (tem) return;
  logI('db', 'Migrando schema para v4 (adicionando seq_sessao)...');
  db.exec('ALTER TABLE etiquetas ADD COLUMN seq_sessao INTEGER');
  logI('db', 'Schema migrado para v4 com sucesso');
}
migrarSchemaParaV4();

// ──────────────────────────────────────────────────────────────────
// Migração v5 — Suporte completo à Extrusão de Bobinas
//   1) Estende CHECK de tipo pra incluir 'extrusao' em etiquetas e sessoes
//   2) Estende CHECK de bling_status com 'parcial' (envio individual fracionado)
//   3) Adiciona colunas específicas da Extrusão:
//      etiquetas:  operador, maquina, largura, tipo_bobina, turno_codigo,
//                  bling_pedido_id, peso_bruto, tara
//      sessoes:    operador, maquina, turno_codigo
//   4) Adiciona seq 'extrusao' (prefixo E)
// ──────────────────────────────────────────────────────────────────
function migrarSchemaParaV5() {
  // Detecta se CHECK aceita 'extrusao'
  let checkOk = true;
  try {
    db.prepare(`INSERT INTO sessoes (tipo, inicio) VALUES ('extrusao', '__migrate_v5_test__')`).run();
    db.prepare(`DELETE FROM sessoes WHERE inicio = '__migrate_v5_test__'`).run();
  } catch(e) {
    if (/CHECK constraint failed/i.test(e.message) || /constraint/i.test(e.message)) checkOk = false;
    else throw e;
  }

  const colsE = db.prepare("PRAGMA table_info(etiquetas)").all().map(c => c.name);
  const colsS = db.prepare("PRAGMA table_info(sessoes)").all().map(c => c.name);
  const temOperadorE = colsE.includes('operador');
  const temOperadorS = colsS.includes('operador');

  if (checkOk && temOperadorE && temOperadorS) {
    // Já está em v5 — só garante a seq extrusao
    db.prepare(`INSERT OR IGNORE INTO seqs(tipo, valor) VALUES ('extrusao', 1)`).run();
    return;
  }

  logI('db', 'Migrando schema para v5 (suporte à Extrusão)...');

  if (!checkOk) {
    // Precisa recriar as tabelas pra trocar o CHECK
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      const tr = makeTransaction(() => {
        // ── etiquetas: recriar com novo CHECK + colunas extras ──
        db.exec(`
          CREATE TABLE etiquetas_v5 (
            id              TEXT PRIMARY KEY,
            seq             INTEGER NOT NULL,
            seq_sessao      INTEGER,
            tipo            TEXT NOT NULL CHECK(tipo IN ('recebimento','retorno','retirada','extrusao')),
            sub_tipo        TEXT,
            material_key    TEXT NOT NULL,
            material_nome   TEXT,
            material_label  TEXT,
            cor             TEXT,
            fornecedor      TEXT NOT NULL,
            lote            TEXT NOT NULL,
            peso            REAL NOT NULL CHECK(peso >= 0),
            qtd_sacos       INTEGER,
            codigo          TEXT NOT NULL,
            sku             TEXT NOT NULL,
            status          TEXT NOT NULL CHECK(status IN ('aguardando_bipe','bipada','cancelada','consumida')),
            ref_id          TEXT,
            hora_impressao  TEXT NOT NULL,
            hora_bipagem    TEXT,
            sessao_id       INTEGER,
            impressora      TEXT,
            operador        TEXT,
            maquina         TEXT,
            largura         TEXT,
            tipo_bobina     TEXT,
            turno_codigo    TEXT,
            bling_pedido_id INTEGER,
            peso_bruto      REAL,
            tara            REAL,
            FOREIGN KEY (sessao_id) REFERENCES sessoes(id)
          );
          INSERT INTO etiquetas_v5 (
            id, seq, seq_sessao, tipo, sub_tipo, material_key, material_nome,
            material_label, cor, fornecedor, lote, peso, qtd_sacos, codigo,
            sku, status, ref_id, hora_impressao, hora_bipagem, sessao_id, impressora
          )
          SELECT
            id, seq, seq_sessao, tipo, sub_tipo, material_key, material_nome,
            material_label, cor, fornecedor, lote, peso, qtd_sacos, codigo,
            sku, status, ref_id, hora_impressao, hora_bipagem, sessao_id, impressora
          FROM etiquetas;
          DROP TABLE etiquetas;
          ALTER TABLE etiquetas_v5 RENAME TO etiquetas;
          CREATE INDEX IF NOT EXISTS idx_etiq_tipo_status ON etiquetas(tipo, status);
          CREATE INDEX IF NOT EXISTS idx_etiq_sessao      ON etiquetas(sessao_id);
          CREATE INDEX IF NOT EXISTS idx_etiq_hora        ON etiquetas(hora_impressao DESC);
        `);

        // ── sessoes: recriar com novo CHECK + colunas extras ──
        db.exec(`
          CREATE TABLE sessoes_v5 (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            tipo            TEXT NOT NULL CHECK(tipo IN ('recebimento','retorno','retirada','extrusao')),
            inicio          TEXT NOT NULL,
            fim             TEXT,
            fornecedor      TEXT,
            total_kg        REAL,
            total_etiquetas INTEGER,
            bling_status    TEXT CHECK(bling_status IN ('pendente_config','pendente','enviado','erro','cancelada','parcial') OR bling_status IS NULL),
            bling_id        TEXT,
            bling_erro      TEXT,
            operador        TEXT,
            maquina         TEXT,
            turno_codigo    TEXT
          );
          INSERT INTO sessoes_v5 (
            id, tipo, inicio, fim, fornecedor, total_kg, total_etiquetas,
            bling_status, bling_id, bling_erro
          )
          SELECT
            id, tipo, inicio, fim, fornecedor, total_kg, total_etiquetas,
            bling_status, bling_id, bling_erro
          FROM sessoes;
          DROP TABLE sessoes;
          ALTER TABLE sessoes_v5 RENAME TO sessoes;
          CREATE INDEX IF NOT EXISTS idx_sessoes_status ON sessoes(bling_status);
        `);
      });
      tr();
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  } else {
    // CHECK já estava ok, mas faltam colunas
    if (!temOperadorE) {
      db.exec(`
        ALTER TABLE etiquetas ADD COLUMN operador        TEXT;
        ALTER TABLE etiquetas ADD COLUMN maquina         TEXT;
        ALTER TABLE etiquetas ADD COLUMN largura         TEXT;
        ALTER TABLE etiquetas ADD COLUMN tipo_bobina     TEXT;
        ALTER TABLE etiquetas ADD COLUMN turno_codigo    TEXT;
        ALTER TABLE etiquetas ADD COLUMN bling_pedido_id INTEGER;
        ALTER TABLE etiquetas ADD COLUMN peso_bruto      REAL;
        ALTER TABLE etiquetas ADD COLUMN tara            REAL;
      `);
    }
    if (!temOperadorS) {
      db.exec(`
        ALTER TABLE sessoes ADD COLUMN operador      TEXT;
        ALTER TABLE sessoes ADD COLUMN maquina       TEXT;
        ALTER TABLE sessoes ADD COLUMN turno_codigo  TEXT;
      `);
    }
  }

  db.prepare(`INSERT OR IGNORE INTO seqs(tipo, valor) VALUES ('extrusao', 1)`).run();
  logI('db', 'Schema migrado para v5 com sucesso');
}
migrarSchemaParaV5();

// ──────────────────────────────────────────────────────────────────
// Migração v6 — Suporte ao processo OUTRAS PESAGENS (inventário/resíduos)
//   Estende o CHECK de tipo pra incluir 'outras' em etiquetas e sessoes.
//   Recria as tabelas (única forma de trocar um CHECK no SQLite), copiando
//   TODAS as colunas e dados. Idempotente: só roda se o CHECK ainda não
//   aceitar 'outras'. Adiciona também a seq 'outras' (prefixo O).
// ──────────────────────────────────────────────────────────────────
function migrarSchemaParaV6() {
  // Detecta se CHECK já aceita 'outras'
  let checkOk = true;
  try {
    db.prepare(`INSERT INTO sessoes (tipo, inicio) VALUES ('outras', '__migrate_v6_test__')`).run();
    db.prepare(`DELETE FROM sessoes WHERE inicio = '__migrate_v6_test__'`).run();
  } catch(e) {
    if (/constraint/i.test(e.message)) checkOk = false;
    else throw e;
  }

  if (checkOk) {
    // Já aceita 'outras' — só garante a seq
    db.prepare(`INSERT OR IGNORE INTO seqs(tipo, valor) VALUES ('outras', 1)`).run();
    return;
  }

  logI('db', 'Migrando schema para v6 (suporte a OUTRAS PESAGENS)...');
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    const tr = makeTransaction(() => {
      // ── etiquetas: recriar com CHECK estendido, copiando TUDO ──
      db.exec(`
        CREATE TABLE etiquetas_v6 (
          id              TEXT PRIMARY KEY,
          seq             INTEGER NOT NULL,
          seq_sessao      INTEGER,
          tipo            TEXT NOT NULL CHECK(tipo IN ('recebimento','retorno','retirada','extrusao','outras')),
          sub_tipo        TEXT,
          material_key    TEXT NOT NULL,
          material_nome   TEXT,
          material_label  TEXT,
          cor             TEXT,
          fornecedor      TEXT NOT NULL,
          lote            TEXT NOT NULL,
          peso            REAL NOT NULL CHECK(peso >= 0),
          qtd_sacos       INTEGER,
          codigo          TEXT NOT NULL,
          sku             TEXT NOT NULL,
          status          TEXT NOT NULL CHECK(status IN ('aguardando_bipe','bipada','cancelada','consumida')),
          ref_id          TEXT,
          hora_impressao  TEXT NOT NULL,
          hora_bipagem    TEXT,
          sessao_id       INTEGER,
          impressora      TEXT,
          operador        TEXT,
          maquina         TEXT,
          largura         TEXT,
          tipo_bobina     TEXT,
          turno_codigo    TEXT,
          bling_pedido_id INTEGER,
          peso_bruto      REAL,
          tara            REAL,
          FOREIGN KEY (sessao_id) REFERENCES sessoes(id)
        );
        INSERT INTO etiquetas_v6 (
          id, seq, seq_sessao, tipo, sub_tipo, material_key, material_nome,
          material_label, cor, fornecedor, lote, peso, qtd_sacos, codigo, sku,
          status, ref_id, hora_impressao, hora_bipagem, sessao_id, impressora,
          operador, maquina, largura, tipo_bobina, turno_codigo, bling_pedido_id,
          peso_bruto, tara
        )
        SELECT
          id, seq, seq_sessao, tipo, sub_tipo, material_key, material_nome,
          material_label, cor, fornecedor, lote, peso, qtd_sacos, codigo, sku,
          status, ref_id, hora_impressao, hora_bipagem, sessao_id, impressora,
          operador, maquina, largura, tipo_bobina, turno_codigo, bling_pedido_id,
          peso_bruto, tara
        FROM etiquetas;
        DROP TABLE etiquetas;
        ALTER TABLE etiquetas_v6 RENAME TO etiquetas;
        CREATE INDEX IF NOT EXISTS idx_etiq_tipo_status ON etiquetas(tipo, status);
        CREATE INDEX IF NOT EXISTS idx_etiq_sessao      ON etiquetas(sessao_id);
        CREATE INDEX IF NOT EXISTS idx_etiq_hora        ON etiquetas(hora_impressao DESC);
      `);

      // ── sessoes: recriar com CHECK estendido, copiando TUDO ──
      db.exec(`
        CREATE TABLE sessoes_v6 (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          tipo            TEXT NOT NULL CHECK(tipo IN ('recebimento','retorno','retirada','extrusao','outras')),
          inicio          TEXT NOT NULL,
          fim             TEXT,
          fornecedor      TEXT,
          total_kg        REAL,
          total_etiquetas INTEGER,
          bling_status    TEXT CHECK(bling_status IN ('pendente_config','pendente','enviado','erro','cancelada','parcial') OR bling_status IS NULL),
          bling_id        TEXT,
          bling_erro      TEXT,
          operador        TEXT,
          maquina         TEXT,
          turno_codigo    TEXT
        );
        INSERT INTO sessoes_v6 (
          id, tipo, inicio, fim, fornecedor, total_kg, total_etiquetas,
          bling_status, bling_id, bling_erro, operador, maquina, turno_codigo
        )
        SELECT
          id, tipo, inicio, fim, fornecedor, total_kg, total_etiquetas,
          bling_status, bling_id, bling_erro, operador, maquina, turno_codigo
        FROM sessoes;
        DROP TABLE sessoes;
        ALTER TABLE sessoes_v6 RENAME TO sessoes;
        CREATE INDEX IF NOT EXISTS idx_sessoes_status ON sessoes(bling_status);
      `);
    });
    tr();
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }

  db.prepare(`INSERT OR IGNORE INTO seqs(tipo, valor) VALUES ('outras', 1)`).run();
  logI('db', 'Schema migrado para v6 com sucesso');
}
migrarSchemaParaV6();

// ──────────────────────────────────────────────────────────────────
// Migração v7: adiciona o tipo 'produto-acabado' ao CHECK de etiquetas
// e sessoes (entrada de sacolas/fardos no Bling ao fim do turno). Recria
// as tabelas copiando TODAS as colunas, igual à v6. Idempotente via
// test-insert (se já aceita 'produto-acabado', só garante a seq).
// ──────────────────────────────────────────────────────────────────
function migrarSchemaParaV7() {
  let checkOk = true;
  try {
    db.prepare(`INSERT INTO sessoes (tipo, inicio) VALUES ('produto-acabado', '__migrate_v7_test__')`).run();
    db.prepare(`DELETE FROM sessoes WHERE inicio = '__migrate_v7_test__'`).run();
  } catch(e) {
    if (/constraint/i.test(e.message)) checkOk = false;
    else throw e;
  }

  if (checkOk) {
    db.prepare(`INSERT OR IGNORE INTO seqs(tipo, valor) VALUES ('produto-acabado', 1)`).run();
    return;
  }

  logI('db', 'Migrando schema para v7 (suporte a PRODUTO ACABADO)...');
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    const tr = makeTransaction(() => {
      db.exec(`
        CREATE TABLE etiquetas_v7 (
          id              TEXT PRIMARY KEY,
          seq             INTEGER NOT NULL,
          seq_sessao      INTEGER,
          tipo            TEXT NOT NULL CHECK(tipo IN ('recebimento','retorno','retirada','extrusao','outras','produto-acabado')),
          sub_tipo        TEXT,
          material_key    TEXT NOT NULL,
          material_nome   TEXT,
          material_label  TEXT,
          cor             TEXT,
          fornecedor      TEXT NOT NULL,
          lote            TEXT NOT NULL,
          peso            REAL NOT NULL CHECK(peso >= 0),
          qtd_sacos       INTEGER,
          codigo          TEXT NOT NULL,
          sku             TEXT NOT NULL,
          status          TEXT NOT NULL CHECK(status IN ('aguardando_bipe','bipada','cancelada','consumida')),
          ref_id          TEXT,
          hora_impressao  TEXT NOT NULL,
          hora_bipagem    TEXT,
          sessao_id       INTEGER,
          impressora      TEXT,
          operador        TEXT,
          maquina         TEXT,
          largura         TEXT,
          tipo_bobina     TEXT,
          turno_codigo    TEXT,
          bling_pedido_id INTEGER,
          peso_bruto      REAL,
          tara            REAL,
          FOREIGN KEY (sessao_id) REFERENCES sessoes(id)
        );
        INSERT INTO etiquetas_v7 (
          id, seq, seq_sessao, tipo, sub_tipo, material_key, material_nome,
          material_label, cor, fornecedor, lote, peso, qtd_sacos, codigo, sku,
          status, ref_id, hora_impressao, hora_bipagem, sessao_id, impressora,
          operador, maquina, largura, tipo_bobina, turno_codigo, bling_pedido_id,
          peso_bruto, tara
        )
        SELECT
          id, seq, seq_sessao, tipo, sub_tipo, material_key, material_nome,
          material_label, cor, fornecedor, lote, peso, qtd_sacos, codigo, sku,
          status, ref_id, hora_impressao, hora_bipagem, sessao_id, impressora,
          operador, maquina, largura, tipo_bobina, turno_codigo, bling_pedido_id,
          peso_bruto, tara
        FROM etiquetas;
        DROP TABLE etiquetas;
        ALTER TABLE etiquetas_v7 RENAME TO etiquetas;
        CREATE INDEX IF NOT EXISTS idx_etiq_tipo_status ON etiquetas(tipo, status);
        CREATE INDEX IF NOT EXISTS idx_etiq_sessao      ON etiquetas(sessao_id);
        CREATE INDEX IF NOT EXISTS idx_etiq_hora        ON etiquetas(hora_impressao DESC);
      `);

      db.exec(`
        CREATE TABLE sessoes_v7 (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          tipo            TEXT NOT NULL CHECK(tipo IN ('recebimento','retorno','retirada','extrusao','outras','produto-acabado')),
          inicio          TEXT NOT NULL,
          fim             TEXT,
          fornecedor      TEXT,
          total_kg        REAL,
          total_etiquetas INTEGER,
          bling_status    TEXT CHECK(bling_status IN ('pendente_config','pendente','enviado','erro','cancelada','parcial') OR bling_status IS NULL),
          bling_id        TEXT,
          bling_erro      TEXT,
          operador        TEXT,
          maquina         TEXT,
          turno_codigo    TEXT
        );
        INSERT INTO sessoes_v7 (
          id, tipo, inicio, fim, fornecedor, total_kg, total_etiquetas,
          bling_status, bling_id, bling_erro, operador, maquina, turno_codigo
        )
        SELECT
          id, tipo, inicio, fim, fornecedor, total_kg, total_etiquetas,
          bling_status, bling_id, bling_erro, operador, maquina, turno_codigo
        FROM sessoes;
        DROP TABLE sessoes;
        ALTER TABLE sessoes_v7 RENAME TO sessoes;
        CREATE INDEX IF NOT EXISTS idx_sessoes_status ON sessoes(bling_status);
      `);
    });
    tr();
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }

  db.prepare(`INSERT OR IGNORE INTO seqs(tipo, valor) VALUES ('produto-acabado', 1)`).run();
  logI('db', 'Schema migrado para v7 com sucesso');
}
migrarSchemaParaV7();

// Migração leve: coluna data_lancamento na sessão — data escolhida pelo operador
// (calendário) para o lançamento no Bling. Quando ausente, usa-se a regra padrão.
function migrarAddDataLancamento() {
  const cols = db.prepare("PRAGMA table_info(sessoes)").all();
  if (cols.some(c => c.name === 'data_lancamento')) return;
  logI('db', 'Migrando: adicionando sessoes.data_lancamento...');
  db.exec('ALTER TABLE sessoes ADD COLUMN data_lancamento TEXT');
  logI('db', 'Coluna data_lancamento adicionada.');
}
migrarAddDataLancamento();

// ──────────────────────────────────────────────────────────────────
// PRODUTO ACABADO — mapas fixos (turnos, cores/produtos-pai, formatos).
// Cada FARDO = 25 kg. O operador escolhe turno (cliente) → formato → cor →
// nº de fardos. A entrada vai pro Bling como pedido de COMPRA (entrada de
// estoque), tendo o turno como fornecedor/contato.
//
// ATENÇÃO À VARIAÇÃO: cada COR é um produto com variações por formato. No
// Bling, todas as variações de uma cor compartilham o ID do produto-PAI; o
// que distingue a variação é a SKU (código). Por isso a SKU é a chave do
// item, e no envio REAL a SKU é resolvida para o id real da variação
// (ver resolverIdVariacaoPA / enviarSessaoBling).
// ──────────────────────────────────────────────────────────────────
const PA_KG_FARDO = 25;
const PA_TURNOS = {
  A:     { nome: 'TURNO A - SACOLEIRAS EKOPLASTIC',     bling: 17802279349 },
  C:     { nome: 'TURNO C - SACOLEIRAS EKOPLASTIC',     bling: 17803577652 },
  EXTRA: { nome: 'TURNO EXTRA - SACOLEIRAS EKOPLASTIC', bling: 18180509587 },
};
const PA_CORES = {
  AM:  { nome: 'Amarela',  label: 'SACOLA SEMI-VIRGEM AMARELA (25KG)', bling_pai: 16571281331 },
  BC:  { nome: 'Branca',   label: 'SACOLA SEMI-VIRGEM BRANCA (25KG)',  bling_pai: 16571279198 },
  PT:  { nome: 'Preta',    label: 'SACOLA RECICLADA PRETA (25KG)',     bling_pai: 16571276024 },
  REC: { nome: 'Colorida', label: 'SACOLA RECICLADA COLORIDA (25KG)',  bling_pai: 16571269944 },
};
const PA_FORMATOS = ['30x40','30x45','33x46','35x45','40x50','42x53','50x60','60x80','80x100'];
const PA_MAQUINAS = ['P1','P2'];
// Trava máquina × formato do Produto Acabado: cada máquina só produz os
// formatos da sua lista (40x50 é o único comum às duas). Evita lançamento
// de formato em máquina que não o produz.
// Materiais contados MANUALMENTE no inventário (sacos, não big bags com
// etiqueta): a contagem é nº de sacos × peso do saco.
const MP_CONTAGEM_MANUAL = { PIG: 25, DESSEC: 25, CARBO: 25 };   // kg por saco

const PA_FORMATOS_POR_MAQUINA = {
  P1: ['40x50', '50x60', '60x80', '80x100'],
  P2: ['30x40', '30x45', '33x46', '35x45', '40x50', '42x53'],
};
// SKU = {prefixo cor}.{dígitos do formato sem 'x'}.5K  →  30x40/AM = AM.3040.5K ; 80x100/BC = BC.80100.5K
function paSku(corKey, formato) {
  return `${corKey}.${String(formato).replace(/[^0-9]/g, '')}.5K`;
}
// Data de lançamento no Bling por turno:
//  - Turno A  → data vigente (o turno fecha no próprio dia).
//  - Turno C e EXTRA → D+1 (dia seguinte), pois a produção é contabilizada no
//    dia seguinte ao da operação (turnos noturnos/estendidos).
function dataLancamentoPA(turnoCodigo) {
  if (turnoCodigo === 'C' || turnoCodigo === 'EXTRA') {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return dataLocalISO(d);
  }
  return dataLocalISO();
}

// Próximo seq_sessao pra uma sessão: MAX(seq_sessao)+1 (não recicla canceladas)
function proximoSeqSessao(sessaoId) {
  if (!sessaoId) return null;
  const r = db.prepare(`SELECT COALESCE(MAX(seq_sessao), 0) + 1 AS p
                        FROM etiquetas WHERE sessao_id = ?`).get(sessaoId);
  return r.p;
}

// ─── Migração: importar etiquetas-db.json se SQLite estiver vazio ───
function migrarLegacy() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM etiquetas').get().n;
  if (count > 0) return;
  if (!fs.existsSync(LEGACY_JSON)) {
    // Nenhum legacy — cria seed mínimo pra testes
    return seedInicial();
  }
  try {
    const j = JSON.parse(fs.readFileSync(LEGACY_JSON, 'utf8'));
    if (!j.etiquetas || Object.keys(j.etiquetas).length === 0) return seedInicial();
    const insert = db.prepare(`INSERT OR IGNORE INTO etiquetas
      (id, seq, tipo, material_key, material_nome, cor, fornecedor, lote, peso, codigo, sku, status, hora_impressao, impressora)
      VALUES (@id, @seq, @tipo, @materialKey, @materialNomeEt, @cor, @fornecedor, @lote, @peso, @codigo, @sku, @status, @hora_impressao, @impressora)`);
    const tr = makeTransaction(items => {
      for (const it of items) {
        try { insert.run({ ...it, impressora: it.impressora || null }); } catch(e) { /* skip */ }
      }
    });
    tr(Object.values(j.etiquetas));
    if (j.proximoSeq) {
      const up = db.prepare('UPDATE seqs SET valor = ? WHERE tipo = ?');
      if (j.proximoSeq.recebimento) up.run(j.proximoSeq.recebimento, 'recebimento');
      if (j.proximoSeq.retorno)     up.run(j.proximoSeq.retorno,     'retorno');
    }
    logI('db', `Migração legacy: ${Object.keys(j.etiquetas).length} etiquetas importadas de etiquetas-db.json`);
    // Renomeia o legacy pra evitar re-importar
    try { fs.renameSync(LEGACY_JSON, LEGACY_JSON + '.migrado'); } catch(e) {}
  } catch(e) {
    logW('db', 'Falha ao migrar legacy', { erro: e.message });
  }
}

function seedInicial() {
  // Cria 3 etiquetas de exemplo se banco vazio (pra facilitar teste do Retorno)
  const seed = [
    { id:'R0000001', seq:1, tipo:'recebimento', material_key:'GBD',  cor:'Colorido', fornecedor:'Cedro', peso:945.5, lote:'180526', codigo:'COL1',   sku:'GBD.COL.CEDRO | 945 | L180526', status:'bipada' },
    { id:'R0000002', seq:2, tipo:'recebimento', material_key:'GBD',  cor:'Colorido', fornecedor:'Cedro', peso:891.2, lote:'180526', codigo:'COL1',   sku:'GBD.COL.CEDRO | 891 | L180526', status:'bipada' },
    { id:'R0000003', seq:3, tipo:'recebimento', material_key:'POLI', cor:'Cristal',  fornecedor:'Ycaro', peso:935.0, lote:'190526', codigo:'NCRIS1', sku:'POLI.CRIS.YCARO | 935 | L190526', status:'bipada' },
  ];
  const insert = db.prepare(`INSERT INTO etiquetas
    (id, seq, tipo, material_key, cor, fornecedor, lote, peso, codigo, sku, status, hora_impressao)
    VALUES (@id, @seq, @tipo, @material_key, @cor, @fornecedor, @lote, @peso, @codigo, @sku, @status, @hora_impressao)`);
  const agora = new Date().toISOString();
  const tr = makeTransaction(items => { for (const it of items) insert.run({...it, hora_impressao: agora}); });
  tr(seed);
  db.prepare('UPDATE seqs SET valor = 4 WHERE tipo = ?').run('recebimento');
  logI('db', `Seed inicial criado (3 etiquetas exemplo)`);
}
migrarLegacy();

// ─── Seed de configs Bling: mapa fornecedor + mapa produtos + ID Ekoplastic ───
// Só insere se a chave NÃO existir (não sobrescreve customização do usuário).
// Os mapas refletem o cadastro Bling fornecido em 21/05/2026.
function seedConfigsBling() {
  const mapaFornecedoresPadrao = {
    "Cedro":          "17830214554",
    "Ecorafia":       "18244556280",
    "Cristal Master": "17812997897",
    "COLLOR-X":       "17847796681",
    "Cromex":         "18292263741",
    "INNOVACOLOR":    "18296773374",
    "Ecolog":         "17804795779",
    "FG":             "18033742774",
    "Forcoplast":     "17812971362",
    "Gold Green":     "18264757168",
    "Karina":         "18033750501",
    "Piquiri":        "17822764082",
    "Redeplast":      "17808256474",
    "Tallpack":       "17807369878",
    "Tupaciguara":    "17880604037",
    "Valgroup":       "17927393383",
    "WT dos Santos":  "18159304251",
    "W R":            "18199057846",
    "Ycaro":          "17817641812"
  };
  // Chave composta: "material_key:cor:fornecedor"
  // cor pode ser vazia (CARBO/DESSEC não têm cor)
  const mapaProdutosPadrao = {
    // POLI
    "POLI:Canela:Ecolog":         "16606216410",
    "POLI:Canela:Tallpack":       "16586065283",
    "POLI:Canela:Valgroup":       "16597086241",
    "POLI:Canela:Ycaro":          "16586065261",
    "POLI:Colorido:Ecolog":       "16606216412",
    "POLI:Colorido:Tallpack":     "16586065319",
    "POLI:Colorido:Valgroup":     "16597086243",
    "POLI:Colorido:Ycaro":        "16586065301",
    "POLI:Cristal:Ecolog":        "16606216405",
    "POLI:Cristal:Tallpack":      "16586065201",
    "POLI:Cristal:Valgroup":      "16597086236",
    "POLI:Cristal:Ycaro":         "16586065182",
    "POLI:Leitoso:Ecolog":        "16606216408",
    "POLI:Leitoso:Tallpack":      "16586065240",
    "POLI:Leitoso:Valgroup":      "16597086237",
    "POLI:Leitoso:Ycaro":         "16586065221",
    // GBD
    "GBD:Canela:Cedro":           "16571358002",
    "GBD:Canela:Ecolog":          "16595820510",
    "GBD:Canela:Forcoplast":      "16616506407",
    "GBD:Canela:Piquiri":         "16595228461",
    "GBD:Canela:Redeplast":       "16595228462",
    "GBD:Canela:Tupaciguara":     "16595228460",
    "GBD:Canela:WT dos Santos":   "16654163409",
    "GBD:Colorido:Cedro":         "16595228452",
    "GBD:Colorido:Ecolog":        "16595820507",
    "GBD:Colorido:Forcoplast":    "16616506399",
    "GBD:Colorido:Piquiri":       "16571356220",
    "GBD:Colorido:Redeplast":     "16595228453",
    "GBD:Colorido:Tupaciguara":   "16595228451",
    "GBD:Colorido:WT dos Santos": "16654163401",
    "GBD:Leitoso:Cedro":          "16595228457",
    "GBD:Leitoso:Ecolog":         "16595820509",
    "GBD:Leitoso:Forcoplast":     "16616506404",
    "GBD:Leitoso:Piquiri":        "16595228458",
    "GBD:Leitoso:Redeplast":      "16595228459",
    "GBD:Leitoso:Tupaciguara":    "16571357989",
    "GBD:Preto:Cedro":            "16595228454",
    "GBD:Preto:Ecolog":           "16595820508",
    "GBD:Preto:Forcoplast":       "16616506402",
    "GBD:Preto:Piquiri":          "16595228455",
    "GBD:Preto:Redeplast":        "16595228456",
    "GBD:Preto:Tupaciguara":      "16571357971",
    // Ecorafia — as 4 cores são variações que compartilham o id-pai 16571355856;
    // a SKU distingue a variação (resolvida no envio via mapa_sku_variacao_mp).
    "GBD:Colorido:Ecorafia":      "16571355856",
    "GBD:Preto:Ecorafia":         "16571355856",
    "GBD:Leitoso:Ecorafia":       "16571355856",
    "GBD:Canela:Ecorafia":        "16571355856",
    // Gold Green — as 4 cores também são variações sob o id-pai 16571355856
    // (a SKU distingue a variação, resolvida no envio via mapa_sku_variacao_mp).
    "GBD:Colorido:Gold Green":    "16571355856",
    "GBD:Preto:Gold Green":       "16571355856",
    "GBD:Leitoso:Gold Green":     "16571355856",
    "GBD:Canela:Gold Green":      "16571355856",
    // CARBO (cor null)
    "CARBO::Cristal Master":      "16620491392",
    "CARBO::FG":                  "16620491394",
    "CARBO::Karina":              "16620491398",
    "CARBO::Secmil":              "16620598333",
    "CARBO::W R":                 "16663405098",
    // DESSEC (cor null)
    "DESSEC::COLLOR-X":           "16571944289",
    "DESSEC::Cromex":             "16684154422",
    "DESSEC::INNOVACOLOR":        "16571944289",
    "DESSEC::Cristal Master":     "16620488764",
    "DESSEC::FG":                 "16620488765",
    "DESSEC::Karina":             "16620488768",
    "DESSEC::Secmil":             "16620601030",
    // PIG
    "PIG:Amarelo:Cristal Master": "16571351818",
    "PIG:Amarelo:FG":             "16620454453",
    "PIG:Amarelo:Karina":         "16620454456",
    "PIG:Branco:Cristal Master":  "16571351806",
    "PIG:Branco:FG":              "16620454449",
    "PIG:Branco:Karina":          "16620454451",
    "PIG:Preto:Cristal Master":   "16571351828",
    "PIG:Preto:FG":               "16620454460",
    "PIG:Preto:Karina":           "16620454461",
    "PIG:Verde:Cristal Master":   "16571351840",
    "PIG:Verde:FG":               "16620454464",
    "PIG:Verde:Karina":           "16620454465",
  };
  const ID_EKOPLASTIC_PADRAO = "17804838271";
  // Mapa de SKU de variação (MP): chave "material:cor:fornecedor" → SKU limpo da
  // variação no Bling. Só para produtos cujas cores compartilham o id-pai (a SKU
  // distingue a variação). Hoje: Ecorafia.
  const mapaSkuVariacaoMpPadrao = {
    "GBD:Colorido:Ecorafia": "GBD.COL.ECORAFIA",
    "GBD:Preto:Ecorafia":    "GBD.PTO.ECORAFIA",
    "GBD:Leitoso:Ecorafia":  "GBD.LEI.ECORAFIA",
    "GBD:Canela:Ecorafia":   "GBD.CAN.ECORAFIA",
    "GBD:Colorido:Gold Green": "GBD.COL.GOLDGREEN",
    "GBD:Preto:Gold Green":    "GBD.PTO.GOLDGREEN",
    "GBD:Leitoso:Gold Green":  "GBD.LEI.GOLDGREEN",
    "GBD:Canela:Gold Green":   "GBD.CAN.GOLDGREEN",
    "DESSEC::COLLOR-X":        "DESSEC.COLLOR-X",
    "DESSEC::Cromex":          "DESSEC.CROMEX",
    "DESSEC::INNOVACOLOR":     "DESSEC.INNOVACOLOR",
  };
  let inseridas = 0;
  if (!dbStmts.configGet.get('mapa_fornecedor_bling')) {
    dbStmts.configSet.run('mapa_fornecedor_bling', JSON.stringify(mapaFornecedoresPadrao));
    inseridas++;
  } else {
    // Mescla fornecedores NOVOS do padrão que ainda não estão no banco (não
    // sobrescreve os já gravados) — para fornecedores adicionados em novas
    // versões valerem mesmo em bancos antigos.
    try {
      const atual = JSON.parse(dbStmts.configGet.get('mapa_fornecedor_bling').valor || '{}');
      let novos = 0;
      for (const k in mapaFornecedoresPadrao) { if (!(k in atual)) { atual[k] = mapaFornecedoresPadrao[k]; novos++; } }
      if (novos > 0) { dbStmts.configSet.run('mapa_fornecedor_bling', JSON.stringify(atual)); logI('db', `Mapa de fornecedores Bling: ${novos} fornecedor(es) novo(s) mesclado(s)`); }
    } catch (e) { logW('db', 'Falha ao mesclar mapa de fornecedores Bling', { erro: e && e.message }); }
  }
  if (!dbStmts.configGet.get('mapa_produto_bling')) {
    dbStmts.configSet.run('mapa_produto_bling', JSON.stringify(mapaProdutosPadrao));
    inseridas++;
  } else {
    // Mescla produtos NOVOS do padrão que ainda não estão no banco (não sobrescreve
    // os já gravados). Assim, materiais adicionados em novas versões passam a valer
    // mesmo em bancos antigos, sem precisar recriar o etiquetas.db.
    try {
      const atual = JSON.parse(dbStmts.configGet.get('mapa_produto_bling').valor || '{}');
      let novos = 0;
      for (const k in mapaProdutosPadrao) {
        if (!(k in atual)) { atual[k] = mapaProdutosPadrao[k]; novos++; }
      }
      if (novos > 0) {
        dbStmts.configSet.run('mapa_produto_bling', JSON.stringify(atual));
        logI('db', `Mapa de produtos Bling: ${novos} produto(s) novo(s) mesclado(s) ao banco existente`);
      }
    } catch (e) { logW('db', 'Falha ao mesclar mapa de produtos Bling', { erro: e && e.message }); }
  }
  if (!dbStmts.configGet.get('id_ekoplastic_bling')) {
    dbStmts.configSet.run('id_ekoplastic_bling', ID_EKOPLASTIC_PADRAO);
    inseridas++;
  }
  if (!dbStmts.configGet.get('mapa_sku_variacao_mp')) {
    dbStmts.configSet.run('mapa_sku_variacao_mp', JSON.stringify(mapaSkuVariacaoMpPadrao));
    inseridas++;
  } else {
    try {
      const atual = JSON.parse(dbStmts.configGet.get('mapa_sku_variacao_mp').valor || '{}');
      let novos = 0;
      for (const k in mapaSkuVariacaoMpPadrao) { if (!(k in atual)) { atual[k] = mapaSkuVariacaoMpPadrao[k]; novos++; } }
      if (novos > 0) { dbStmts.configSet.run('mapa_sku_variacao_mp', JSON.stringify(atual)); logI('db', `Mapa de SKU de variação MP: ${novos} novo(s) mesclado(s)`); }
    } catch (e) { logW('db', 'Falha ao mesclar mapa de SKU de variação MP', { erro: e && e.message }); }
  }
  if (!dbStmts.configGet.get('bling_simular')) {
    dbStmts.configSet.run('bling_simular', '1');           // simulação por padrão
    inseridas++;
  }

  // ── CATÁLOGO MP (Etapa 1): fornecedores por material + códigos gravimétricos ──
  // Fonte única no banco. A tela de recebimento lê via GET /catalogo-mp
  // (com fallback embutido no cliente). O cadastro pela tela vem nas etapas seguintes.
  const mpFornecedoresPadrao = {"GBD": ["Cedro", "Ecorafia", "Ecolog", "Forcoplast", "Gold Green", "Piquiri", "Redeplast", "Tupaciguara", "WT dos Santos"], "POLI": ["Ecolog", "Tallpack", "Valgroup", "Ycaro"], "CARBO": ["Cristal Master", "FG", "Karina", "SecMil", "W R"], "PIG": ["Cristal Master", "FG", "Karina"], "DESSEC": ["COLLOR-X", "Cromex", "INNOVACOLOR", "Cristal Master", "FG", "Karina", "SecMil"]};
  const mpCodigosGravPadrao = [{"matKey": "PIG", "cor": "Amarelo", "forn": null, "codigo": "P1"}, {"matKey": "PIG", "cor": "Verde", "forn": null, "codigo": "P2"}, {"matKey": "PIG", "cor": "Preto", "forn": null, "codigo": "P3"}, {"matKey": "PIG", "cor": "Branco", "forn": null, "codigo": "P4"}, {"matKey": "CARBO", "cor": null, "forn": "Cristal Master", "codigo": "C1"}, {"matKey": "CARBO", "cor": null, "forn": "FG", "codigo": "C2"}, {"matKey": "CARBO", "cor": null, "forn": "Karina", "codigo": "C3"}, {"matKey": "CARBO", "cor": null, "forn": "W R", "codigo": "C4"}, {"matKey": "DESSEC", "cor": null, "forn": "Cristal Master", "codigo": "D1"}, {"matKey": "DESSEC", "cor": null, "forn": "COLLOR-X", "codigo": "D3"}, {"matKey": "DESSEC", "cor": null, "forn": "Cromex", "codigo": "D4"}, {"matKey": "DESSEC", "cor": null, "forn": "INNOVACOLOR", "codigo": "D5"}, {"matKey": "GBD", "cor": "Canela", "forn": "Cedro", "codigo": "CAN1"}, {"matKey": "GBD", "cor": "Canela", "forn": "Tupaciguara", "codigo": "CAN2"}, {"matKey": "GBD", "cor": "Canela", "forn": "WT dos Santos", "codigo": "CAN3"}, {"matKey": "GBD", "cor": "Canela", "forn": "Piquiri", "codigo": "CAN4"}, {"matKey": "GBD", "cor": "Colorido", "forn": "Cedro", "codigo": "COL1"}, {"matKey": "GBD", "cor": "Colorido", "forn": "Forcoplast", "codigo": "COL2"}, {"matKey": "GBD", "cor": "Colorido", "forn": "Piquiri", "codigo": "COL3"}, {"matKey": "GBD", "cor": "Colorido", "forn": "Tupaciguara", "codigo": "COL4"}, {"matKey": "GBD", "cor": "Colorido", "forn": "WT dos Santos", "codigo": "COL5"}, {"matKey": "GBD", "cor": "Preto", "forn": "Cedro", "codigo": "PT1"}, {"matKey": "GBD", "cor": "Preto", "forn": "Forcoplast", "codigo": "PT2"}, {"matKey": "GBD", "cor": "Preto", "forn": "Tupaciguara", "codigo": "PT3"}, {"matKey": "GBD", "cor": "Preto", "forn": "Piquiri", "codigo": "PT4"}, {"matKey": "GBD", "cor": "Colorido", "forn": "Ecorafia", "codigo": "COL6"}, {"matKey": "GBD", "cor": "Canela", "forn": "Ecorafia", "codigo": "CAN4"}, {"matKey": "GBD", "cor": "Leitoso", "forn": "Ecorafia", "codigo": "LEI1"}, {"matKey": "GBD", "cor": "Colorido", "forn": "Gold Green", "codigo": "COL7"}, {"matKey": "GBD", "cor": "Preto", "forn": "Gold Green", "codigo": "PT5"}, {"matKey": "GBD", "cor": "Leitoso", "forn": "Gold Green", "codigo": "LEI2"}, {"matKey": "GBD", "cor": "Canela", "forn": "Gold Green", "codigo": "CAN5"}, {"matKey": "POLI", "cor": "Canela", "forn": "Ycaro", "codigo": "NCAN1"}, {"matKey": "POLI", "cor": "Canela", "forn": "Ecolog", "codigo": "NCAN2"}, {"matKey": "POLI", "cor": "Colorido", "forn": "Ecolog", "codigo": "NCOL1"}, {"matKey": "POLI", "cor": "Colorido", "forn": "Ycaro", "codigo": "NCOL2"}, {"matKey": "POLI", "cor": "Colorido", "forn": "Tallpack", "codigo": "NCOL3"}, {"matKey": "POLI", "cor": "Cristal", "forn": "Ycaro", "codigo": "NCRIS1"}, {"matKey": "POLI", "cor": "Leitoso", "forn": "Ecolog", "codigo": "NLEI1"}, {"matKey": "POLI", "cor": "Leitoso", "forn": "Tallpack", "codigo": "NLEI2"}, {"matKey": "POLI", "cor": "Leitoso", "forn": "Valgroup", "codigo": "NLEI3"}, {"matKey": "POLI", "cor": "Leitoso", "forn": "Ycaro", "codigo": "NLEI4"}];
  if (!dbStmts.configGet.get('mp_fornecedores')) {
    dbStmts.configSet.run('mp_fornecedores', JSON.stringify(mpFornecedoresPadrao));
    inseridas++;
  }
  if (!dbStmts.configGet.get('mp_codigos_gravimetricos')) {
    dbStmts.configSet.run('mp_codigos_gravimetricos', JSON.stringify(mpCodigosGravPadrao));
    inseridas++;
  }
  // Estrutura dos materiais (nome popular + cores válidas). Usada pela tela de
  // Manutenção para montar as opções de cadastro do código gravimétrico.
  const mpMateriaisPadrao = {"GBD": {"popular": "Grão Baixa Densidade", "cores": ["Colorido", "Canela", "Preto", "Leitoso"]}, "POLI": {"popular": "Polinylon", "cores": ["Colorido", "Canela", "Cristal", "Leitoso"]}, "CARBO": {"popular": "Carbonato", "cores": []}, "PIG": {"popular": "Pigmento", "cores": ["Amarelo", "Branco", "Preto", "Verde"]}, "DESSEC": {"popular": "Dessecante", "cores": []}};
  if (!dbStmts.configGet.get('mp_materiais')) {
    dbStmts.configSet.run('mp_materiais', JSON.stringify(mpMateriaisPadrao));
    inseridas++;
  }

  // ── EXTRUSÃO: mapa de bobinas (cor|tipo|largura → ID Bling + SKU) ──
  // Cadastro vigente a partir de 24/05/2026 (24 produtos, todas combinações)
  const mapaBobinasPadrao = {
    // AMARELA · LEVE
    "AMARELA|LEVE|1,60":      { id: "16653916155", sku: "BOB.AM.LEV.1,60" },
    "AMARELA|LEVE|1,68":      { id: "16653916156", sku: "BOB.AM.LEV.1,68" },
    "AMARELA|LEVE|1,75":      { id: "16653916157", sku: "BOB.AM.LEV.1,75" },
    // AMARELA · REFORÇADA
    "AMARELA|REFORCADA|1,20": { id: "16653914905", sku: "BOB.AM.REF.1,20" },
    "AMARELA|REFORCADA|1,60": { id: "16653916160", sku: "BOB.AM.REF.1,60" },
    "AMARELA|REFORCADA|80":   { id: "16653916163", sku: "BOB.AM.REF.80"   },
    // BRANCA · LEVE
    "BRANCA|LEVE|1,60":       { id: "16653916147", sku: "BOB.BC.LEV.1,60" },
    "BRANCA|LEVE|1,68":       { id: "16653916148", sku: "BOB.BC.LEV.1,68" },
    "BRANCA|LEVE|1,75":       { id: "16653916149", sku: "BOB.BC.LEV.1,75" },
    // BRANCA · REFORÇADA
    "BRANCA|REFORCADA|1,20":  { id: "16653914903", sku: "BOB.BC.REF.1,20" },
    "BRANCA|REFORCADA|1,60":  { id: "16653916151", sku: "BOB.BC.REF.1,60" },
    "BRANCA|REFORCADA|80":    { id: "16653916154", sku: "BOB.BC.REF.80"   },
    // COLORIDA · LEVE
    "COLORIDA|LEVE|1,60":     { id: "16653916138", sku: "BOB.COL.LEV.1,60" },
    "COLORIDA|LEVE|1,68":     { id: "16653916140", sku: "BOB.COL.LEV.1,68" },
    "COLORIDA|LEVE|1,75":     { id: "16653916141", sku: "BOB.COL.LEV.1,75" },
    // COLORIDA · REFORÇADA
    "COLORIDA|REFORCADA|1,20":{ id: "16653914901", sku: "BOB.COL.REF.1,20" },
    "COLORIDA|REFORCADA|1,60":{ id: "16653916143", sku: "BOB.COL.REF.1,60" },
    "COLORIDA|REFORCADA|80":  { id: "16653916146", sku: "BOB.COL.REF.80"   },
    // PRETA · LEVE
    // NOTA: o ID 16653916165 estava cadastrado no Bling como "BOB.PT.LEV.1,20"
    //       em 24/05/2026. Aguarda correção pelo cliente pra "BOB.PT.LEV.1,60".
    //       Mapeamento aqui já reflete o correto pós-ajuste.
    "PRETA|LEVE|1,60":        { id: "16653916165", sku: "BOB.PT.LEV.1,60" },
    "PRETA|LEVE|1,68":        { id: "16653916166", sku: "BOB.PT.LEV.1,68" },
    "PRETA|LEVE|1,75":        { id: "16653916167", sku: "BOB.PT.LEV.1,75" },
    // PRETA · REFORÇADA
    "PRETA|REFORCADA|1,20":   { id: "16653914907", sku: "BOB.PT.REF.1,20" },
    "PRETA|REFORCADA|1,60":   { id: "16653916169", sku: "BOB.PT.REF.1,60" },
    "PRETA|REFORCADA|80":     { id: "16653916174", sku: "BOB.PT.REF.80"   },
  };

  // ── EXTRUSÃO: turnos → pseudo-fornecedor Bling ──
  // Cada turno é tratado como "fornecedor" no Bling pra rastrear a produção.
  const mapaTurnosPadrao = {
    "EXT-A1": { fornecedorId: "18007239571", label: "Extrusão Turno A-1", periodo: "diurno",  paridade: "par"   },
    "EXT-C1": { fornecedorId: "18007241951", label: "Extrusão Turno C-1", periodo: "noturno", paridade: "par"   },
    "EXT-A2": { fornecedorId: "18007242562", label: "Extrusão Turno A-2", periodo: "diurno",  paridade: "impar" },
    "EXT-C2": { fornecedorId: "18007243073", label: "Extrusão Turno C-2", periodo: "noturno", paridade: "impar" },
  };

  // ── RETIRADA DE BOBINAS: turno → contato (cliente) do pedido de venda ──
  // Cada turno é um "cliente" no Bling; a baixa da bobina sai como venda para ele.
  const mapaTurnosBobinaPadrao = {
    "A":     { contatoId: "17802279349", label: "Turno A" },
    "C":     { contatoId: "17803577652", label: "Turno C" },
    "EXTRA": { contatoId: "18180509587", label: "Turno Extra" },
  };
  if (!dbStmts.configGet.get('mapa_turno_bobina')) {
    dbStmts.configSet.run('mapa_turno_bobina', JSON.stringify(mapaTurnosBobinaPadrao));
    inseridas++;
  }

  if (!dbStmts.configGet.get('mapa_bobina_bling')) {
    dbStmts.configSet.run('mapa_bobina_bling', JSON.stringify(mapaBobinasPadrao));
    inseridas++;
  }
  if (!dbStmts.configGet.get('mapa_turno_extrusao')) {
    dbStmts.configSet.run('mapa_turno_extrusao', JSON.stringify(mapaTurnosPadrao));
    inseridas++;
  }
  // Modo de envio Bling pra extrusão. Default 'lote' (mesmo modelo da MP:
  // finalizar turno envia todas as bobinas como UM pedido de compra).
  // Alternativa 'individual' — cada bipagem dispara um pedido. Útil pra
  // acompanhar em tempo real, mas gera N pedidos por turno.
  if (!dbStmts.configGet.get('bling_extrusao_modo')) {
    dbStmts.configSet.run('bling_extrusao_modo', 'lote');
    inseridas++;
  }

  if (inseridas > 0) logI('db', `Seed de configs Bling: ${inseridas} chave(s) populada(s) (mapas com ${Object.keys(mapaFornecedoresPadrao).length} fornecedores MP, ${Object.keys(mapaProdutosPadrao).length} produtos MP, ${Object.keys(mapaBobinasPadrao).length} bobinas, ${Object.keys(mapaTurnosPadrao).length} turnos)`);
}
seedConfigsBling   // placeholder — chamada real está logo após dbStmts ser declarado

// ─── Backup diário simples ───
function backupDiario() {
  const d = new Date();
  const tag = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  const dest = path.join(BACKUP_DIR, `etiquetas-${tag}.db`);
  if (fs.existsSync(dest)) return;
  try {
    // VACUUM INTO cria backup limpo, sem precisar de wal_checkpoint manual
    // Path precisa estar entre aspas simples no SQL e escapar aspas no nome se houver
    const destSql = dest.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${destSql}'`);
    logI('db', `Backup diário salvo: ${path.basename(dest)}`);
    // Mantém apenas os últimos 7 backups
    const backups = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('etiquetas-') && f.endsWith('.db'))
      .sort();
    while (backups.length > 7) {
      try { fs.unlinkSync(path.join(BACKUP_DIR, backups.shift())); } catch(e) {}
    }
  } catch(e) { logW('db', 'Backup falhou', { erro: e.message }); }
}
backupDiario();
setInterval(backupDiario, 6 * 60 * 60 * 1000); // tenta a cada 6h (só salva 1x/dia)

// ─── Helpers de acesso ao banco ───
const dbStmts = {
  proximoSeq:       db.prepare('SELECT valor FROM seqs WHERE tipo = ?'),
  incSeq:           db.prepare('UPDATE seqs SET valor = MAX(valor, ? + 1) WHERE tipo = ?'),
  getEtiqueta:      db.prepare('SELECT * FROM etiquetas WHERE id = ?'),
  insertEtiqueta:   db.prepare(`INSERT INTO etiquetas
    (id, seq, seq_sessao, tipo, sub_tipo, material_key, material_nome, material_label, cor, fornecedor, lote, peso, qtd_sacos, codigo, sku, status, ref_id, hora_impressao, sessao_id, impressora,
     operador, maquina, largura, tipo_bobina, turno_codigo, peso_bruto, tara)
    VALUES (@id, @seq, @seq_sessao, @tipo, @sub_tipo, @material_key, @material_nome, @material_label, @cor, @fornecedor, @lote, @peso, @qtd_sacos, @codigo, @sku, @status, @ref_id, @hora_impressao, @sessao_id, @impressora,
     @operador, @maquina, @largura, @tipo_bobina, @turno_codigo, @peso_bruto, @tara)`),
  marcarBipada:     db.prepare('UPDATE etiquetas SET status = ?, hora_bipagem = ? WHERE id = ?'),
  marcarCancelada:  db.prepare('UPDATE etiquetas SET status = ? WHERE id = ?'),
  corrigirEtiqueta: db.prepare(`UPDATE etiquetas SET material_key=@material_key, material_nome=@material_nome, material_label=@material_label, cor=@cor, fornecedor=@fornecedor, lote=@lote, codigo=@codigo, sku=@sku WHERE id=@id`),
  listEtiquetas:    db.prepare('SELECT * FROM etiquetas WHERE 1=1'),
  abrirSessao:      db.prepare('INSERT INTO sessoes (tipo, inicio, fornecedor, operador, maquina, turno_codigo, data_lancamento) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  fecharSessao:     db.prepare(`UPDATE sessoes SET fim = ?, total_kg = ?, total_etiquetas = ?, bling_status = ? WHERE id = ?`),
  getSessao:        db.prepare('SELECT * FROM sessoes WHERE id = ?'),
  updSessaoBling:   db.prepare('UPDATE sessoes SET bling_status = ?, bling_id = ?, bling_erro = ? WHERE id = ?'),
  totaisSessao:     db.prepare(`SELECT COUNT(*) AS qtd, COALESCE(SUM(peso), 0) AS total_kg FROM etiquetas WHERE sessao_id = ? AND status = 'bipada'`),
  // No recebimento/retorno, um big bag retirado antes de finalizar fica
  // 'consumida' mas CONTINUA fazendo parte da entrada — os totais da sessão
  // precisam refletir o mesmo conjunto que vai ao Bling.
  totaisSessaoEntrada: db.prepare(`SELECT COUNT(*) AS qtd, COALESCE(SUM(peso), 0) AS total_kg FROM etiquetas WHERE sessao_id = ? AND status IN ('bipada','consumida')`),
  configGet:        db.prepare('SELECT valor FROM config WHERE chave = ?'),
  configSet:        db.prepare('INSERT INTO config(chave, valor) VALUES(?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor'),
};

function getProximoSeq(tipo) { return dbStmts.proximoSeq.get(tipo)?.valor || 1; }
function incrementaSeq(tipo, seqUsado) { dbStmts.incSeq.run(seqUsado, tipo); }
function configGet(k, def) { return dbStmts.configGet.get(k)?.valor ?? def; }
function configSet(k, v)   { dbStmts.configSet.run(k, String(v)); }

// B4: recalcula total_kg/total_etiquetas de uma sessão a partir das
// etiquetas bipadas atuais. Chamado após cancelamentos para manter o
// histórico coerente. Só atualiza se a sessão já tiver totais (foi fechada).
// Totais da sessão pela MESMA regra do envio ao Bling.
function totaisDaSessao(sessao, sessaoId) {
  const ehEntrada = sessao && (sessao.tipo === 'recebimento' || sessao.tipo === 'retorno');
  return ehEntrada ? dbStmts.totaisSessaoEntrada.get(sessaoId) : dbStmts.totaisSessao.get(sessaoId);
}

function recalcularTotaisSessao(sessaoId) {
  try {
    const s = dbStmts.getSessao.get(sessaoId);
    if (!s) return;
    const tot = totaisDaSessao(s, sessaoId);
    db.prepare('UPDATE sessoes SET total_kg = ?, total_etiquetas = ? WHERE id = ?')
      .run(tot.total_kg, tot.qtd, sessaoId);
  } catch(e) { logW('db', `recalcularTotaisSessao #${sessaoId} falhou: ${e.message}`); }
}

// Agora que dbStmts existe, popula configs default do Bling (se ainda não existirem)
seedConfigsBling();
// Normaliza o nome do fornecedor ECORAFIA → Ecorafia (Title Case, padrão dos
// demais) nas CHAVES já gravadas em bancos que instalaram o v95. Idempotente:
// em bancos novos (já "Ecorafia") não faz nada. Os SKUs (valores, ex
// "GBD.COL.ECORAFIA") não mudam — são os códigos cadastrados no Bling.
(function migrarNomeEcorafia() {
  const renom = (chaveConfig) => {
    try {
      const row = dbStmts.configGet.get(chaveConfig);
      if (!row) return;
      const obj = JSON.parse(row.valor || '{}');
      let mudou = false;
      for (const k of Object.keys(obj)) {
        if (!k.includes('ECORAFIA')) continue;      // só chaves, o valor SKU fica intacto
        const nk = k.split('ECORAFIA').join('Ecorafia');
        if (nk === k) continue;
        if (!(nk in obj)) obj[nk] = obj[k];          // preserva o valor (id ou SKU)
        delete obj[k];                                // remove a chave antiga (garrafais)
        mudou = true;
      }
      if (mudou) { dbStmts.configSet.run(chaveConfig, JSON.stringify(obj)); logI('db', `Nome ECORAFIA→Ecorafia normalizado em ${chaveConfig}`); }
    } catch(e) { logW('db', `Falha ao normalizar nome ECORAFIA em ${chaveConfig}`, { erro: e && e.message }); }
  };
  renom('mapa_fornecedor_bling');
  renom('mapa_produto_bling');
  renom('mapa_sku_variacao_mp');
})();

// ──────────────────────────────────────────────────────────────────
// Patches incrementais de mapas (idempotente, roda em todo boot).
//
// Adiciona entradas novas que vão sendo cadastradas ao longo do tempo
// sem mexer em IDs já existentes (preserva edições manuais).
// Cada bloco abaixo é independente e seguro pra rodar várias vezes.
// ──────────────────────────────────────────────────────────────────
function aplicarPatchsMapas() {
  // ── Fornecedores MP ──
  // Lista canônica de fornecedores: nome final → ID Bling.
  const novosForn = {
    'WT dos Santos': '18159304251',
    'W R':           '18199057846',
    'COLLOR-X':      '17847796681',
    'Cromex':        '18292263741',
    'INNOVACOLOR':   '18296773374',
    // Próximos fornecedores cadastrados, adicionar aqui:
  };
  // Aliases obsoletos a remover (renomeações). Ao trocar a capitalização
  // ou nome de um fornecedor, listar o nome antigo aqui pra ser apagado
  // de qualquer banco que já o tenha gravado.
  const aliasesAntigosForn = ['WT DOS SANTOS'];

  try {
    const atual = JSON.parse(configGet('mapa_fornecedor_bling', '{}'));
    let mudou = false;
    for (const [nome, id] of Object.entries(novosForn)) {
      if (!atual[nome]) {
        atual[nome] = id;
        mudou = true;
        logI('db', `Patch: fornecedor MP "${nome}" adicionado ao mapa (id=${id})`);
      }
    }
    for (const alias of aliasesAntigosForn) {
      if (atual[alias]) {
        delete atual[alias];
        mudou = true;
        logI('db', `Patch: fornecedor MP alias antigo "${alias}" removido (renomeado)`);
      }
    }
    if (mudou) configSet('mapa_fornecedor_bling', JSON.stringify(atual));
  } catch(e) {
    logW('db', `Falha aplicando patch de fornecedores: ${e.message}`);
  }

  // ── Produtos MP ──
  // Chaves no formato "material:cor:fornecedor" → ID Bling
  const novosProd = {
    'GBD:Canela:WT dos Santos':   '16654163409',
    'GBD:Colorido:WT dos Santos': '16654163401',
    'DESSEC::COLLOR-X':            '16571944289',
    'DESSEC::Cromex':              '16684154422',
    'DESSEC::INNOVACOLOR':         '16571944289',
  };
  const aliasesAntigosProd = [
    // Se um produto foi cadastrado com nome antigo, listar aqui pra remover
    // Ex: 'GBD:Canela:WT DOS SANTOS'
    'GBD:Canela:WT DOS SANTOS',
    'GBD:Colorido:WT DOS SANTOS',
  ];

  try {
    const atual = JSON.parse(configGet('mapa_produto_bling', '{}'));
    let mudou = false;
    for (const [chave, id] of Object.entries(novosProd)) {
      if (!atual[chave]) {
        atual[chave] = id;
        mudou = true;
        logI('db', `Patch: produto "${chave}" adicionado ao mapa (id=${id})`);
      }
    }
    for (const alias of aliasesAntigosProd) {
      if (atual[alias]) {
        delete atual[alias];
        mudou = true;
        logI('db', `Patch: produto alias antigo "${alias}" removido (renomeado)`);
      }
    }
    if (mudou) configSet('mapa_produto_bling', JSON.stringify(atual));
  } catch(e) {
    logW('db', `Falha aplicando patch de produtos: ${e.message}`);
  }
}
aplicarPatchsMapas();

// ──────────────────────────────────────────────────────────────────
// Patches do catálogo MP (mp_fornecedores e mp_codigos_gravimetricos).
// Diferente dos mapas do Bling, esses configs NÃO têm merge no seed
// (o seed só grava se ainda não existirem). Como no banco de produção
// eles já existem, fornecedores/códigos novos precisam entrar por aqui
// — idempotente, roda em todo boot. Enquanto o cadastro de fornecedor
// pela tela não existe, é aqui que um fornecedor novo é garantido.
// ──────────────────────────────────────────────────────────────────
function aplicarPatchsCatalogoMP() {
  // Fornecedores a garantir na lista de cada material (aparecem na tela).
  const fornPorMaterial = {
    DESSEC: ['COLLOR-X', 'Cromex', 'INNOVACOLOR'],
  };
  // Códigos gravimétricos a garantir (não sobrescrevem se já houver a combinação).
  const codigos = [
    { matKey: 'DESSEC', cor: null, forn: 'COLLOR-X', codigo: 'D3' },
    { matKey: 'DESSEC', cor: null, forn: 'Cromex', codigo: 'D4' },
    { matKey: 'DESSEC', cor: null, forn: 'INNOVACOLOR', codigo: 'D5' },
  ];

  try {
    const forn = JSON.parse(configGet('mp_fornecedores', '{}'));
    let mudou = false;
    for (const [mat, lista] of Object.entries(fornPorMaterial)) {
      if (!Array.isArray(forn[mat])) forn[mat] = [];
      for (const nome of lista) {
        if (!forn[mat].includes(nome)) { forn[mat].push(nome); mudou = true; logI('db', `Patch catálogo: fornecedor "${nome}" adicionado em ${mat}`); }
      }
    }
    if (mudou) configSet('mp_fornecedores', JSON.stringify(forn));
  } catch (e) { logW('db', 'Falha no patch de fornecedores MP', { erro: e && e.message }); }

  // Nome popular dos materiais que devem ser corrigidos no banco existente.
  const nomesPopulares = { GBD: 'Grão Baixa Densidade' };
  try {
    const mats = JSON.parse(configGet('mp_materiais', '{}'));
    let mudouMat = false;
    for (const [k, nome] of Object.entries(nomesPopulares)) {
      if (mats[k] && mats[k].popular !== nome) {
        logI('db', `Patch catálogo: material ${k} renomeado para "${nome}"`);
        mats[k].popular = nome; mudouMat = true;
      }
    }
    if (mudouMat) configSet('mp_materiais', JSON.stringify(mats));
  } catch (e) { logW('db', 'Falha no patch de nomes de material', { erro: e && e.message }); }

  try {
    const lista = JSON.parse(configGet('mp_codigos_gravimetricos', '[]'));
    let mudou = false;
    for (const nc of codigos) {
      const existe = lista.some(c => c.matKey === nc.matKey && (c.cor || null) === (nc.cor || null) && (c.forn || null) === (nc.forn || null));
      if (!existe) { lista.push(nc); mudou = true; logI('db', `Patch catálogo: código ${nc.codigo} para ${nc.matKey}/${nc.cor || '-'}/${nc.forn || 'todos'}`); }
    }
    if (mudou) configSet('mp_codigos_gravimetricos', JSON.stringify(lista));
  } catch (e) { logW('db', 'Falha no patch de códigos MP', { erro: e && e.message }); }
}
aplicarPatchsCatalogoMP();

// ──────────────────────────────────────────────────────────────────
// Catálogo de MP (fornecedores por material, códigos gravimétricos e
// estrutura dos materiais). Fonte única no banco; a tela de Recebimento
// lê via GET /catalogo-mp e a Manutenção cadastra via POST.
// ──────────────────────────────────────────────────────────────────
function lerCatalogoMP() {
  const ler = (chave, vazio) => {
    try { const r = dbStmts.configGet.get(chave); return r ? JSON.parse(r.valor || vazio) : JSON.parse(vazio); }
    catch(e) { logW('db', `Catálogo MP: falha lendo ${chave}`, { erro: e && e.message }); return JSON.parse(vazio); }
  };
  return {
    fornecedores: ler('mp_fornecedores', '{}'),
    codigos:      ler('mp_codigos_gravimetricos', '[]'),
    materiais:    ler('mp_materiais', '{}'),
  };
}

logI('db', `SQLite inicializado em ${DB_FILE}`);

// ════════════════════════════════════════════════════════════════════
//  BALANÇA WT3000-iR (Serial RS-232)
//  Manual: WT3000-iR v20230817_r33 — Seções 7.2, 8 e 8.1
// ════════════════════════════════════════════════════════════════════

let balanca = {
  ultimoPeso:   null,    // peso numérico parseado (kg)
  ultimoRaw:    '',      // linha bruta da última leitura
  pesoEstavel:  false,   // se F-m 14: status estável (S=0)
  portaAberta:  false,
  bytesTotal:   0,
  ultimoByteTs: null,
};
let _balancaReconectando = false;   // B5: guarda contra empilhamento de reconexões

// "Recebendo" = porta aberta E chegaram bytes há pouco (StrEAn manda várias vezes/s).
// IMPORTANTE: numa porta serial nativa, abrir SEMPRE funciona (mesmo sem aparelho
// ligado) — então "porta aberta" NÃO significa balança conectada. O sinal real de
// comunicação é byte chegando. Por isso o status usa isto, e não só portaAberta.
function balancaRecebendo() {
  return balanca.portaAberta && balanca.ultimoByteTs !== null &&
         (Date.now() - balanca.ultimoByteTs) < 4000;
}

function extrairPeso(linha) {
  let m;
  const sinal = s => (s === '-' ? -1 : 1);   // preserva o sinal que aparece no indicador (peso negativo)
  // F-m 14: "0,+300.000,+100.000,+200.000"  (S=estabilidade, B=bruto, T=tara, L=líquido)
  m = linha.match(/^([01]),([+-])\s*(\d+[.,]\d+)/);
  if (m) {
    balanca.pesoEstavel = (m[1] === '0');
    return sinal(m[2]) * parseFloat(m[3].replace(',', '.'));
  }
  // F-m 0/1/2/9: "ST,GS,+  300.000  kg" (6 ou 7 bytes)
  m = linha.match(/^[A-Z]{2},[A-Z]{2},([+-])\s*(\d+[.,]\d+)/);
  if (m) { balanca.pesoEstavel = linha.startsWith('ST,'); return sinal(m[1]) * parseFloat(m[2].replace(',', '.')); }
  // F-m 3/4/5: "+  300.000"  (também "-  005.000" → peso negativo)
  m = linha.match(/^([+-])\s*(\d+[.,]\d+)/);
  if (m) return sinal(m[1]) * parseFloat(m[2].replace(',', '.'));
  return null;
}

function iniciarBalanca() {
  if (_balancaReconectando) return;   // B5: evita empilhar tentativas concorrentes
  _balancaReconectando = true;
  let SerialPort, ReadlineParser;
  try {
    ({ SerialPort }     = require('serialport'));
    ({ ReadlineParser } = require('@serialport/parser-readline'));
  } catch(e) {
    logW('balanca', 'Módulo serialport não disponível — balança desativada');
    _balancaReconectando = false;
    return;
  }
  logI('balanca', `Conectando em ${SERIAL_PORT} @ ${SERIAL_BAUD} baud (8N1)`);
  const porta = new SerialPort({
    path: SERIAL_PORT, baudRate: SERIAL_BAUD,
    dataBits: 8, parity: 'none', stopBits: 1, autoOpen: false,
  });
  let bufRaw = '';
  porta.on('data', chunk => {
    if (balanca.bytesTotal === 0) {
      logI('balanca', `Balança transmitindo em ${SERIAL_PORT} — primeiros ${chunk.length} bytes recebidos (comunicação OK)`);
    }
    balanca.bytesTotal += chunk.length;
    balanca.ultimoByteTs = Date.now();
    bufRaw += chunk.toString('ascii');
    const linhas = bufRaw.split(/\r\n|\r|\n/);
    bufRaw = linhas.pop();
    for (const linha of linhas) {
      if (!linha.trim()) continue;
      balanca.ultimoRaw = linha;
      const peso = extrairPeso(linha.trim());
      if (peso !== null && !isNaN(peso) && peso >= 0 && peso < 99999) {
        balanca.ultimoPeso = peso;
      }
    }
  });
  porta.open(err => {
    _balancaReconectando = false;   // B5: tentativa concluída (com ou sem sucesso)
    if (err) {
      balanca.portaAberta = false;
      logW('balanca', `Falha ao abrir ${SERIAL_PORT}`, { erro: err.message });
      setTimeout(iniciarBalanca, 10000);
      return;
    }
    balanca.portaAberta = true;
    // pyserial levanta DTR e RTS ao abrir; fazemos o mesmo, caso a balança
    // dependa dessas linhas pra transmitir. Não usamos controle de fluxo.
    porta.set({ dtr: true, rts: true }, e => {
      if (e) logW('balanca', 'Não foi possível ajustar DTR/RTS (seguindo mesmo assim)', { erro: e.message });
    });
    logI('balanca', `Porta ${SERIAL_PORT} aberta — aguardando dados da balança. (Porta serial nativa abre mesmo sem aparelho; só há comunicação de fato quando os bytes começarem a chegar — confira cabo/pinagem e rS1-04 = StrEAn)`);
  });
  porta.on('error', err => { balanca.portaAberta = false; logW('balanca', `Erro na porta`, { erro: err.message }); });
  porta.on('close', () => { balanca.portaAberta = false; _balancaReconectando = false; logW('balanca', 'Porta fechada — reconectando em 10s'); setTimeout(iniciarBalanca, 10000); });
}
iniciarBalanca();

// ════════════════════════════════════════════════════════════════════
//  BLING — OAuth 2.0 + Refresh + Proxy
// ════════════════════════════════════════════════════════════════════

let tk = { accessToken: null, refreshToken: null, expiresAt: 0 };
let _tokenInvalido = false;
let _renovandoPromise = null;   // M1: promise da renovação em curso (pra outros aguardarem)

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
    const req = https.request(options, res => {
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
    const res = await httpsReq({
      hostname: BLING_HOST, path: '/Api/v3/oauth/token', method: 'POST',
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, body);
    const data = JSON.parse(res.body);
    if (!data.access_token) {
      _tokenInvalido = true;
      throw new Error(data.error_description || `HTTP ${res.status} — refresh_token expirado`);
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
  const res = await httpsReq({
    hostname: BLING_HOST, path: '/Api/v3/oauth/token', method: 'POST',
    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, body);
  const data = JSON.parse(res.body);
  if (!data.access_token) throw new Error(data.error_description || 'Falha ao obter token');
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
  return await httpsReqComRetry({
    hostname: BLING_HOST, path: blingPath + (search || ''), method,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/json', ...(body ? {'Content-Length': Buffer.byteLength(body)} : {}) },
  }, body);
}

// ════════════════════════════════════════════════════════════════════
//  IMPRESSORA EPL2 (PowerShell + Win32 Spooler)
// ════════════════════════════════════════════════════════════════════

let PRINTER_ATIVA = PRINTER_NAMES[0];
let PRINTER_DETECTADA = false;     // true só quando detectarImpressora confirma uma instalada

// Garante que o script de impressão (enviar_raw.ps1) exista. Se faltar
// (ex: não foi copiado pra esta máquina), gera automaticamente com o
// método RAW via spooler do Windows (winspool) — o mesmo comprovado em
// campo. Assim o sistema fica auto-contido e a impressão não depende de
// um arquivo externo ter sido copiado.
const ENVIAR_RAW_PS1 = String.raw`param(
  [Parameter(Mandatory=$true)][string]$EplFile,
  [Parameter(Mandatory=$true)][string]$PrinterName
)
$ErrorActionPreference = "Stop"
$code = @"
using System;
using System.Runtime.InteropServices;
public class RawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)]
  public class DOCINFOA { [MarshalAs(UnmanagedType.LPStr)] public string pDocName; [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile; [MarshalAs(UnmanagedType.LPStr)] public string pDataType; }
  [DllImport("winspool.Drv", EntryPoint="OpenPrinterA", SetLastError=true, CharSet=CharSet.Ansi)] public static extern bool OpenPrinter(string src, out IntPtr h, IntPtr pd);
  [DllImport("winspool.Drv", EntryPoint="ClosePrinter", SetLastError=true)] public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.Drv", EntryPoint="StartDocPrinterA", SetLastError=true, CharSet=CharSet.Ansi)] public static extern bool StartDocPrinter(IntPtr h, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);
  [DllImport("winspool.Drv", EntryPoint="EndDocPrinter", SetLastError=true)] public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.Drv", EntryPoint="StartPagePrinter", SetLastError=true)] public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.Drv", EntryPoint="EndPagePrinter", SetLastError=true)] public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.Drv", EntryPoint="WritePrinter", SetLastError=true)] public static extern bool WritePrinter(IntPtr h, byte[] buf, int count, out int written);
  public static string Send(string printer, byte[] bytes) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) throw new Exception("OpenPrinter falhou (err " + Marshal.GetLastWin32Error() + ") para: " + printer);
    var di = new DOCINFOA(); di.pDocName = "Etiqueta EPL"; di.pDataType = "RAW";
    if (!StartDocPrinter(h, 1, di)) { ClosePrinter(h); throw new Exception("StartDocPrinter falhou (err " + Marshal.GetLastWin32Error() + ")"); }
    StartPagePrinter(h);
    int written;
    bool ok = WritePrinter(h, bytes, bytes.Length, out written);
    EndPagePrinter(h); EndDocPrinter(h); ClosePrinter(h);
    if (!ok) throw new Exception("WritePrinter falhou (err " + Marshal.GetLastWin32Error() + ")");
    return "OK " + written + " bytes";
  }
}
"@
Add-Type -TypeDefinition $code -Language CSharp
$bytes = [System.IO.File]::ReadAllBytes($EplFile)
$r = [RawPrinter]::Send($PrinterName, $bytes)
Write-Output $r
`;

function garantirScriptImpressao() {
  try {
    let precisaEscrever = true;
    if (fs.existsSync(PS_SCRIPT)) {
      const atual = fs.readFileSync(PS_SCRIPT, 'utf8');
      if (atual === ENVIAR_RAW_PS1) {
        precisaEscrever = false;   // já é o método comprovado
      } else {
        // Versão diferente/antiga — faz backup antes de substituir pelo
        // método raw via spooler (winspool), comprovado em campo.
        try { fs.copyFileSync(PS_SCRIPT, PS_SCRIPT + '.bak'); } catch (e) {}
        logI('print', 'enviar_raw.ps1 antigo encontrado — backup em enviar_raw.ps1.bak e atualizado para o método raw comprovado');
      }
    } else {
      logI('print', 'enviar_raw.ps1 não existia — gerado automaticamente');
    }
    if (precisaEscrever) fs.writeFileSync(PS_SCRIPT, ENVIAR_RAW_PS1, 'utf8');
  } catch (e) {
    logW('print', `Não foi possível gerar enviar_raw.ps1: ${e.message}`);
  }
}

function detectarImpressora(cb) {
  const psCmd = 'Get-Printer | Select-Object Name,PortName,DriverName,PrinterStatus,JobCount | ConvertTo-Json -Compress';
  const ps = spawn('powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-Command', psCmd], { windowsHide: true });
  let stdout = '';
  ps.stdout.on('data', d => stdout += d.toString());
  let done = false;
  const finish = (m, inst) => { if (done) return; done = true; cb(m, inst); };
  ps.on('close', code => {
    if (code !== 0) return finish(null, []);
    let installed = [];
    try {
      const parsed = JSON.parse(stdout.trim() || '[]');
      installed = Array.isArray(parsed) ? parsed : [parsed];
    } catch(e) {
      installed = stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(n => ({Name:n}));
    }
    let match = null;
    for (const want of PRINTER_NAMES) {
      const wLow = want.toLowerCase();
      const found = installed.find(p => {
        const nLow = (p.Name||'').toLowerCase();
        return nLow === wLow || nLow.includes(wLow) || wLow.includes(nLow);
      });
      if (found) { match = found.Name; break; }
    }
    finish(match, installed);
  });
  ps.on('error', () => finish(null, []));
}

function gerarEPL(dados) {
  // Encaminhamento pra função de bobina quando for extrusão
  if (dados.tipo === 'extrusao') return gerarEPLBobina(dados);
  if (dados.tipo === 'outras')   return gerarEPLOutras(dados);

  const tipo = dados.tipo || 'recebimento';
  const labelTopo = tipo === 'retorno' ? 'RETORNO:' : 'MATERIAL:';
  const materialLabel = dados.cor
    ? `${dados.cor.toUpperCase()} - ${(dados.materialNomeEt || dados.material_nome || '').toUpperCase()}`
    : (dados.materialNomeEt || dados.material_nome || '').toUpperCase();
  const pesoStr = `${Number(dados.peso).toFixed(1)} KG`;     // sem a palavra "PESO"
  const id      = (tipo === 'retorno' ? 'T' : 'R') + String(dados.seq).padStart(7, '0');
  const dataHora = `${new Date().toLocaleDateString('pt-BR')}  ${new Date().toLocaleTimeString('pt-BR').substring(0,5)}`;
  const pesoX   = Math.max(40, Math.floor((800 - pesoStr.length * 32) / 2));
  const codigoX = Math.max(40, Math.floor((800 - dados.codigo.length * 28) / 2));
  const skuX    = Math.max(40, Math.floor((800 - dados.sku.length * 12) / 2));

  // Selo "PESAGEM #N" no canto superior direito. Y=36 (não mais Y=3) pra
  // não cortar no topo (margem não imprimível da etiqueta).
  const seloPesagem = dados.seq_sessao
    ? `A520,44,0,4,1,2,N,"PESAGEM #${String(dados.seq_sessao).padStart(2,'0')}"\n`
    : '';

  // Layout descido (margem superior ~36 dots) pra eliminar o corte do topo.
  // Mantém material/fornecedor/lote/peso/código/barras/sku e acrescenta a
  // data e hora da pesagem no rodapé.
  // Etiqueta 100x150mm (800x1200 dots). Mesmas informações de antes, agora
  // distribuídas na altura maior e com letras mais altas (multiplicador
  // vertical 3 em vez de 2) — mais legível de longe, sem estourar a largura.
  return `N
q800
Q1200,24

${seloPesagem}LO30,88,740,3

A40,116,0,4,1,3,N,"${labelTopo} ${materialLabel}"

A40,232,0,4,1,3,N,"FORNECEDOR: ${dados.fornecedor.toUpperCase()}"

A40,348,0,4,1,3,N,"LOTE ${dados.lote}"

LO30,466,740,3

A${pesoX},500,0,5,1,3,N,"${pesoStr}"

LO30,672,740,3

A40,700,0,4,1,2,N,"CODIGO PARA EXTRUSAO"
A${codigoX},760,0,4,2,3,N,"${dados.codigo}"

LO30,888,740,3

B180,915,0,1,4,9,110,N,"${id}"

A40,1046,0,4,1,2,N,"ETIQUETA ${id}"
A${skuX},1106,0,3,1,1,N,"${dados.sku}"
A40,1146,0,3,1,1,N,"DATA / HORA: ${dataHora}"

P1
`;
}

// ──────────────────────────────────────────────────────────────────
// Layout EPL da ETIQUETA DE GAIOLA (Produto Acabado) — só para CONTAGEM.
// QR Code grande ocupando quase toda a etiqueta + a informação escrita.
// O QR carrega: EKOPA|<id>|<formato>|<corKey>|<fardos>|<kg>
// O <id> é único por gaiola, para o inventário bloquear leitura repetida.
// Nada disso vai ao Bling: o lançamento de produção continua como está.
// ──────────────────────────────────────────────────────────────────
function gerarEPLGaiolaPA(dados) {
  const cor = PA_CORES[dados.corKey] || { nome: dados.corKey };
  const fardos = Number(dados.fardos) || 0;
  const kg = fardos * PA_KG_FARDO;
  const conteudo = `EKOPA|${dados.id}|${dados.formato}|${dados.corKey}|${fardos}|${kg}`;

  const LARG = 800, ALT = 1200;   // etiqueta 100x150mm (dots)

  // Larguras reais das fontes EPL (dots por caractere, antes do multiplicador).
  const LARG_FONTE = { 1: 8, 2: 10, 3: 12, 4: 14, 5: 32 };
  const centralizar = (txt, fonte, mult) => {
    const larg = txt.length * (LARG_FONTE[fonte] || 14) * mult;
    return Math.max(8, Math.round((LARG - larg) / 2));
  };

  // Quantos "quadradinhos" o QR terá (depende do tamanho do conteúdo).
  const modulos = conteudo.length <= 42 ? 29 : 33;

  const Y_TEXTO_FIM = 132;    // onde termina o texto do topo
  const Y_RODAPE    = 1150;   // linha final
  const MARGEM_X    = 24;

  // O QR fica o MAIOR possível e centralizado nos dois eixos.
  const escalaCfg = parseInt(configGet('pa_qr_escala', '0')) || 0;
  const escalaMax = Math.floor(Math.min(LARG - MARGEM_X * 2, Y_RODAPE - Y_TEXTO_FIM - 30) / modulos);
  const escala = Math.max(4, Math.min(escalaCfg > 0 ? escalaCfg : escalaMax, escalaMax));

  const ladoQR = modulos * escala;
  const xQR = Math.round((LARG - ladoQR) / 2);
  const yQR = Math.round(Y_TEXTO_FIM + ((Y_RODAPE - 20 - Y_TEXTO_FIM) - ladoQR) / 2);

  const linha1 = `${dados.formato.replace('x', ' X ')} ${cor.nome.toUpperCase()}`;
  const linha2 = `${fardos} FARDOS`;
  const rodape = `${dados.id}  -  CONTAGEM DE GAIOLA`;

  return `N
q${LARG}
Q${ALT},24

A${centralizar(linha1, 4, 2)},24,0,4,2,2,N,"${linha1}"
A${centralizar(linha2, 4, 1)},84,0,4,1,2,N,"${linha2}"

b${xQR},${yQR},Q,m2,s${escala},"${conteudo}"

A${centralizar(rodape, 3, 1)},${Y_RODAPE},0,3,1,1,N,"${rodape}"

P1
`;
}

// ──────────────────────────────────────────────────────────────────
// Layout EPL específico de bobina (extrusão)
// Campos: cor, tipo_bobina (LEVE/REFORÇADA), largura, operador, máquina,
//         turno, peso, SKU, código de barras (E0000001)
// ──────────────────────────────────────────────────────────────────
function gerarEPLBobina(dados) {
  const id          = 'E' + String(dados.seq).padStart(7, '0');
  const cor         = (dados.cor || '').toUpperCase();
  const tipoBobina  = (dados.tipo_bobina || '').toUpperCase();
  const largura     = dados.largura || '';
  const operador    = (dados.operador || '—').toUpperCase().substring(0, 30);
  const maquina     = (dados.maquina || '—').toUpperCase();
  const peso        = Number(dados.peso).toFixed(1);

  const pesoStr  = `${peso} KG`;                       // sem a palavra "PESO"
  const tipoStr  = dados.sub_tipo === 'capa'
    ? `CAPA ${largura}`                                // capa: sem cor, ex "CAPA 70 x 90"
    : `${cor} ' ${tipoBobina} ' ${largura}`;
  const dataHora = `${new Date().toLocaleDateString('pt-BR')}  ${new Date().toLocaleTimeString('pt-BR').substring(0,5)}`;

  // Centralização (métricas das fontes EPL nativas, dots/char):
  // font 4 hmul1 ≈ 14 ; font 5 hmul2 ≈ 64
  const tipoX = Math.max(20, Math.floor((800 - tipoStr.length * 14) / 2));
  const pesoX = Math.max(20, Math.floor((800 - pesoStr.length * 64) / 2));

  // Layout 100x100mm (800x800 dots). Margem superior de 40 dots evita o
  // corte do topo. Cada bloco: rótulo pequeno (font 3) + valor (font 4),
  // separados por linha. Peso em destaque (font 5). Código de barras no
  // rodapé (necessário para a bipagem na finalização).
  // Etiqueta 100x150mm (800x1200 dots). A PARTE DE CIMA é idêntica à de antes
  // (mesmas informações, mesmas posições, ocupando os primeiros 100mm) — nada
  // muda para quem já usa. O espaço novo embaixo traz os campos onde as
  // sacoleiras anotam à mão o peso que a bobina rendeu em cada turno.
  return `N
q800
Q1200,24

A40,40,0,3,1,1,N,"TIPO DA BOBINA"
A${tipoX},74,0,4,1,2,N,"${tipoStr}"
LO30,148,740,2

A40,166,0,3,1,1,N,"OPERADOR"
A40,200,0,4,1,2,N,"${operador}"
LO30,270,740,2

A40,288,0,3,1,1,N,"MAQUINA"
A40,322,0,4,1,2,N,"${maquina}"
LO30,392,740,2

A40,410,0,3,1,1,N,"DATA / HORA DA PESAGEM"
A40,444,0,4,1,2,N,"${dataHora}"
LO30,514,740,2

A${pesoX},534,0,5,2,2,N,"${pesoStr}"
LO30,652,740,2

B210,668,0,1,3,8,70,N,"${id}"

LO30,772,740,3

A40,792,0,3,1,1,N,"PESO EM SACOLA - ANOTAR"

A40,838,0,4,2,2,N,"TURNO A"
A400,846,0,4,1,2,N,"PESO:"
LO400,942,370,3

LO30,972,740,2

A40,1000,0,4,2,2,N,"TURNO C"
A400,1008,0,4,1,2,N,"PESO:"
LO400,1104,370,3

P1
`;
}

// ──────────────────────────────────────────────────────────────────
// Layout EPL específico de OUTRAS PESAGENS (aparas/borra/varredura).
// Sem operador/máquina; mostra o item, data/hora, peso e código de barras
// (O#######) pra bipagem. SKU no rodapé. Não imprime "código para extrusão".
// ──────────────────────────────────────────────────────────────────
function gerarEPLOutras(dados) {
  const id       = 'O' + String(dados.seq).padStart(7, '0');
  const itemStr  = _eplSafe((dados.materialNomeEt || dados.material_nome || dados.sku || '').toUpperCase(), 28);
  const skuStr   = _eplSafe(dados.sku || '', 40);
  const pesoStr  = `${Number(dados.peso).toFixed(1)} KG`;
  const dataHora = `${new Date().toLocaleDateString('pt-BR')}  ${new Date().toLocaleTimeString('pt-BR').substring(0,5)}`;

  const selo = dados.seq_sessao
    ? `A500,48,0,4,1,2,N,"PESAGEM #${String(dados.seq_sessao).padStart(2,'0')}"\n`
    : '';

  // Métricas das fontes EPL nativas (dots/char): font4 hmul1≈14, font5 hmul2≈64, font3 hmul1≈12
  const itemX = Math.max(20, Math.floor((800 - itemStr.length * 14) / 2));
  const pesoX = Math.max(20, Math.floor((800 - pesoStr.length * 64) / 2));
  const skuX  = Math.max(20, Math.floor((800 - skuStr.length  * 12) / 2));

  // Etiqueta 100x150mm (800x1200 dots) — mesmas informações, distribuídas
  // na altura maior e com letras mais altas.
  return `N
q800
Q1200,24

A40,44,0,3,1,1,N,"RESIDUOS"
${selo}LO30,110,740,3

A40,138,0,3,1,1,N,"ITEM"
A${itemX},182,0,4,1,3,N,"${itemStr}"
LO30,306,740,3

A40,334,0,3,1,1,N,"DATA / HORA DA PESAGEM"
A40,378,0,4,1,3,N,"${dataHora}"
LO30,500,740,3

A${pesoX},536,0,5,2,3,N,"${pesoStr}"
LO30,730,740,3

B210,760,0,1,3,8,110,N,"${id}"

A${skuX},1000,0,3,1,2,N,"${skuStr}"
A40,1060,0,3,1,1,N,"ETIQUETA ${id}"

P1
`;
}


// ──────────────────────────────────────────────────────────────────
// RESUMO DE FINALIZAÇÃO (impresso na térmica 100x100 ao finalizar)
//  - Recebimento (MP): nº do big bag, material, cor, peso + total geral.
//  - Extrusão:        máquina, largura, tipo, cor, peso + total geral.
// Gera UM job EPL com 1+ etiquetas 100x100 — se houver muitos itens, pagina
// automaticamente (cada "página" é uma etiqueta 100x100 dentro do mesmo job).
// Fonte pequena de propósito (cabe ~24 itens por etiqueta).
// ──────────────────────────────────────────────────────────────────
function _eplSafe(v, max) {
  let s = (v == null ? '' : String(v))
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // remove acentos (codepage da impressora)
    .replace(/["\r\n]/g, ' ')
    .replace(/[^\x20-\x7E]/g, ' ');
  if (max && s.length > max) s = s.substring(0, max);
  return s;
}
const _pad  = (v, n) => (_eplSafe(v) + ' '.repeat(n)).substring(0, n);   // alinha à esquerda
const _padR = (v, n) => (' '.repeat(n) + _eplSafe(v)).slice(-n);          // alinha à direita

// Agrupa etiquetas de RECEBIMENTO por tipo de material (material + cor).
// Retorna [{label, kg, count, itens}] ordenado pelo rótulo. O rótulo é "cru"
// (com acentos): quem imprime aplica _eplSafe; quem manda pro Bling usa direto.
function _grupoMP(itens) {
  const mapa = new Map();
  for (const it of itens) {
    const chave = `${it.material_key || ''}|${it.cor || ''}`;
    if (!mapa.has(chave)) {
      const base = it.material_nome || it.material_key || '?';
      mapa.set(chave, { label: (base + (it.cor ? ' ' + it.cor : '')).trim(), kg: 0, count: 0, itens: [] });
    }
    const g = mapa.get(chave);
    g.kg += Number(it.peso || 0); g.count++; g.itens.push(it);
  }
  return [...mapa.values()].sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
}

// Agrupa etiquetas de EXTRUSÃO por máquina, sempre com C1 e C2 primeiro.
function _grupoMaq(itens) {
  const mapa = new Map();
  for (const it of itens) {
    const m = (it.maquina || '—').toUpperCase();
    if (!mapa.has(m)) mapa.set(m, { label: m, kg: 0, count: 0, itens: [] });
    const g = mapa.get(m);
    g.kg += Number(it.peso || 0); g.count++; g.itens.push(it);
  }
  const ordem = ['C1', 'C2'];
  return [...mapa.values()].sort((a, b) => {
    const ia = ordem.indexOf(a.label), ib = ordem.indexOf(b.label);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.label.localeCompare(b.label);
  });
}

// Agrupa CAPAS (sub_tipo='capa') por tipo de capa (SKU). Rótulo = nome da capa.
function _grupoCapa(itens) {
  const mapa = new Map();
  for (const it of itens) {
    const chave = it.sku || it.material_nome || '?';
    if (!mapa.has(chave)) mapa.set(chave, { label: (it.material_nome || it.sku || 'CAPA'), kg: 0, count: 0, itens: [] });
    const g = mapa.get(chave);
    g.kg += Number(it.peso || 0); g.count++; g.itens.push(it);
  }
  return [...mapa.values()].sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
}

// Agrupa etiquetas de OUTRAS PESAGENS por item (Apara Amarela/Verde/Preta/
// Branca, Borra, Varredura). Rótulo = nome do item. Aparas vêm antes dos
// resíduos (ordem por categoria; dentro da categoria, alfabético).
function _grupoOutras(itens) {
  const mapa = new Map();
  for (const it of itens) {
    const chave = it.material_nome || it.sku || '?';
    if (!mapa.has(chave)) {
      const cat = (OUTRAS_CATALOGO[it.sku] && OUTRAS_CATALOGO[it.sku].categoria) || 'ZZZ';
      mapa.set(chave, { label: (it.material_nome || it.sku || 'ITEM'), categoria: cat, kg: 0, count: 0, itens: [] });
    }
    const g = mapa.get(chave);
    g.kg += Number(it.peso || 0); g.count++; g.itens.push(it);
  }
  const ordemCat = { APARA: 0, RESIDUO: 1, ZZZ: 9 };
  return [...mapa.values()].sort((a, b) => {
    const ca = ordemCat[a.categoria] ?? 9, cb = ordemCat[b.categoria] ?? 9;
    return ca - cb || a.label.localeCompare(b.label, 'pt-BR');
  });
}

// Agrupa etiquetas de PRODUTO ACABADO por COR (material_key). Rótulo = nome da
// cor. Cada item = um formato (lote) com fardos. Ordem alfabética por cor.
function _grupoProdutoAcabado(itens) {
  const mapa = new Map();
  for (const it of itens) {
    const chave = it.material_key || it.material_nome || '?';
    if (!mapa.has(chave)) mapa.set(chave, { label: (it.material_nome || it.material_key || 'COR'), kg: 0, count: 0, itens: [] });
    const g = mapa.get(chave);
    g.kg += Number(it.peso || 0); g.count++; g.itens.push(it);
  }
  return [...mapa.values()].sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
}

// ── Resumo de PRODUTO ACABADO no formato da mensagem do WhatsApp (v93) ──
// Agrupa por MÁQUINA (P1, P2); dentro de cada máquina, consolida por
// FORMATO + COR somando fardos e kg; imprime o subtotal por máquina e o
// total do turno. Espelha a mensagem que os operadores mandam no grupo,
// para a conferência ficar lado a lado. Ex.:
//   P1
//   40 x 50 Colorida: 24 fardos = 600 kg
//   Total P1 = 1.100 kg
//   ...
//   Total do Turno = 1.400 kg
function montarResumoProdutoAcabadoEPL(s, itens, dataHora, parcial) {
  const fmtKgPA = kg => {
    const n = Number(kg || 0);
    const t = Number.isInteger(n)
      ? n.toLocaleString('pt-BR')
      : n.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    return t + ' kg';
  };
  const fmtFormato = f => String(f || '').replace('x', ' x ');   // 40x50 -> 40 x 50

  // Consolida: máquina -> combos (formato|cor -> {formato, cor, fardos, kg}).
  const maquinas = new Map();
  for (const it of itens) {
    const maq = (it.maquina || '?').toUpperCase();
    if (!maquinas.has(maq)) maquinas.set(maq, { kg: 0, combos: new Map() });
    const M = maquinas.get(maq);
    const formato = it.lote || '?';
    const cor     = it.material_nome || it.material_key || '?';
    const chave   = formato + '|' + cor;
    if (!M.combos.has(chave)) M.combos.set(chave, { formato, cor, fardos: 0, kg: 0 });
    const C = M.combos.get(chave);
    C.fardos += Number(it.qtd_sacos || 0);
    C.kg     += Number(it.peso || 0);
    M.kg     += Number(it.peso || 0);
  }
  const maqsOrdenadas = [...maquinas.entries()].sort((a, b) => a[0].localeCompare(b[0], 'pt-BR'));
  const totalTurno    = itens.reduce((a, b) => a + Number(b.peso || 0), 0);

  // Paginação por cursor Y (mesma lógica do resumo genérico).
  const ALT = { maq: 46, combo: 34, totalmaq: 42, espaco: 16, totalturno: 78 };
  const Y_TOPO = 160, Y_FIM = 1170;   // etiqueta 100x150mm (1200 dots)
  const paginas = [];
  let cur = [], y = Y_TOPO;
  const fecharPagina = () => { if (cur.length) paginas.push(cur); cur = []; y = Y_TOPO; };
  const push = (k, txt) => { cur.push({ k, y, txt }); y += ALT[k]; };

  for (const [maq, M] of maqsOrdenadas) {
    if (y + ALT.maq + ALT.combo > Y_FIM) fecharPagina();   // não separa a máquina do 1º combo
    push('maq', maq);
    const combos = [...M.combos.values()];   // ordem de adição (1ª aparição) — igual à digitação do operador
    for (const c of combos) {
      if (y + ALT.combo > Y_FIM) { fecharPagina(); push('maq', maq + ' (CONT.)'); }
      push('combo', `${fmtFormato(c.formato)} ${c.cor}: ${c.fardos} fardos = ${fmtKgPA(c.kg)}`);
    }
    if (y + ALT.totalmaq > Y_FIM) fecharPagina();
    push('totalmaq', `Total ${maq} = ${fmtKgPA(M.kg)}`);
    push('espaco', '');
  }
  if (y + ALT.totalturno > Y_FIM) fecharPagina();
  push('totalturno', `Total do Turno = ${fmtKgPA(totalTurno)}`);
  fecharPagina();

  const titulo   = 'RESUMO PRODUTO ACABADO' + (parcial ? ' - PARCIAL' : '');
  const sub1     = s.operador
                   ? `Turno: ${_eplSafe(s.turno_codigo || '-')}  Resp: ${_eplSafe(s.operador, 14)}`
                   : `Turno: ${_eplSafe(s.turno_codigo || '-')}  ·  Entrada de estoque`;
  const nPaginas = paginas.length;
  let epl = '';
  paginas.forEach((linhas, pi) => {
    let bloco = 'N\nq800\nQ1200,24\n';
    bloco += `A30,24,0,4,1,1,N,"${_eplSafe(titulo)}"\n`;
    bloco += `A30,82,0,3,1,1,N,"${sub1}"\n`;
    bloco += `A30,120,0,2,1,1,N,"${dataHora}   Pag ${pi + 1}/${nPaginas}"\n`;
    bloco += 'LO20,150,760,3\n';
    for (const ln of linhas) {
      if (ln.k === 'maq') {
        bloco += `LO20,${ln.y + 2},760,1\n`;
        bloco += `A30,${ln.y + 12},0,4,1,1,N,"${_eplSafe(ln.txt, 42)}"\n`;
      } else if (ln.k === 'combo') {
        bloco += `A50,${ln.y},0,3,1,1,N,"${_eplSafe(ln.txt, 46)}"\n`;
      } else if (ln.k === 'totalmaq') {
        bloco += `A50,${ln.y},0,3,1,1,N,"${_eplSafe(ln.txt, 46)}"\n`;
      } else if (ln.k === 'espaco') {
        /* linha em branco entre máquinas */
      } else {   // total do turno
        bloco += `LO20,${ln.y},760,3\n`;
        bloco += `A30,${ln.y + 14},0,4,1,1,N,"${_eplSafe(ln.txt)}"\n`;
      }
    }
    bloco += 'P1\n';
    epl += bloco;
  });
  return { epl, nPaginas };
}

function imprimirResumoSessao(s, opts) {
  try {
    const parcial = !!(opts && opts.parcial);
    if (!s || (s.tipo !== 'recebimento' && s.tipo !== 'retorno' && s.tipo !== 'extrusao' && s.tipo !== 'outras' && s.tipo !== 'retirada' && s.tipo !== 'produto-acabado')) return { ok: false, motivo: 'tipo_nao_aplicavel' };
    const itens = db.prepare(
      // Mesma regra do envio ao Bling: no recebimento/retorno, big bag já
      // retirado ('consumida') continua fazendo parte da ENTRADA — some do
      // resumo seria esconder do conferente algo que foi lançado.
      `SELECT * FROM etiquetas WHERE sessao_id = ? AND status IN ${
        (s.tipo === 'recebimento' || s.tipo === 'retorno') ? `('bipada','consumida')` : `('bipada')`
      } ORDER BY id`
    ).all(s.id);
    if (!itens.length) return { ok: false, motivo: 'sem_itens_bipados' };   // nada bipado → nada a imprimir

    const dataHora = `${new Date().toLocaleDateString('pt-BR')} ${new Date().toLocaleTimeString('pt-BR').substring(0,5)}`;
    const totalKg  = itens.reduce((a, b) => a + (b.peso || 0), 0);

    const fmtKg = kg => Number(kg || 0).toFixed(1).replace('.', ',') + ' kg';
    // Hora da bipagem (HH:MM, horário local) — em branco se a etiqueta não foi bipada.
    const horaBip = it => it.hora_bipagem
      ? new Date(it.hora_bipagem).toLocaleTimeString('pt-BR', { hour12: false }).slice(0, 5)
      : '--:--';

    // PRODUTO ACABADO usa um resumo próprio (agrupado por MÁQUINA, consolidando
    // por formato+cor) para espelhar a mensagem do WhatsApp — tratado à parte.
    if (s.tipo === 'produto-acabado') {
      const { epl, nPaginas } = montarResumoProdutoAcabadoEPL(s, itens, dataHora, parcial);
      imprimir(epl, null, (ok, out, err, printer) => {
        if (ok) logI('resumo', `Resumo PA da sessão #${s.id} impresso — ${itens.length} itens, ${nPaginas} pág.`, { printer });
        else    logW('resumo', `Falha ao imprimir resumo PA da sessão #${s.id}`, { erro: err });
      });
      return { ok: true, itens: itens.length, paginas: nPaginas };
    }

    // Agrupa os itens e define como cada item é renderizado:
    //   recebimento → por tipo de material (material + cor)
    //   extrusao    → por máquina (C1 / C2)
    // Com o agrupamento, a coluna do material/máquina sai de cada linha (vai
    // pro cabeçalho do grupo), sobrando espaço pra fonte maior.
    let titulo, sub1, grupos, itemLinha;
    if (s.tipo === 'recebimento' || s.tipo === 'retorno') {
      titulo    = s.tipo === 'retorno' ? 'RESUMO RETORNO' : 'RESUMO RECEBIMENTO';
      sub1      = s.operador
                  ? `Forn: ${_eplSafe(s.fornecedor || '-', 16)}  Resp: ${_eplSafe(s.operador, 12)}`
                  : `Fornecedor: ${_eplSafe(s.fornecedor || '-')}`;
      grupos    = _grupoMP(itens);
      itemLinha = (it, n) => _pad(horaBip(it), 6) + _pad('#' + n, 4) + _pad(it.id, 10) + _padR(fmtKg(it.peso), 12);
    } else if (s.tipo === 'outras') {
      titulo    = 'RESUMO OUTRAS PESAGENS';
      sub1      = s.operador ? `Inventario/Residuos  Resp: ${_eplSafe(s.operador, 14)}` : `Inventario / Residuos`;
      // Um grupo por item (Apara Amarela/Verde/Preta/Branca, Borra, Varredura).
      // TOTAL GERAL soma tudo. (Borra/Varredura vão ao Bling; aparas só aqui.)
      grupos    = _grupoOutras(itens);
      itemLinha = (it, n) => _pad(horaBip(it), 6) + _pad('#' + n, 4) + _pad(it.id, 10) + _padR(fmtKg(it.peso), 12);
    } else if (s.tipo === 'retirada') {
      titulo    = 'RESUMO RETIRADA';
      sub1      = s.operador ? `Saida de estoque  Resp: ${_eplSafe(s.operador, 14)}` : `Saida de estoque · Pedido de Venda`;
      // Agrupa por material + cor (grãos consumidos e aditivos contados).
      // TOTAL GERAL soma tudo. Vai ao Bling como pedido de VENDA.
      // Cada linha: hora da bipagem · fornecedor · nº da pesagem do big bag
      // (ref_id = etiqueta original de recebimento) · peso.
      grupos    = _grupoMP(itens);
      itemLinha = (it, n) => {
        // A etiqueta de retirada nasce no /consumir com hora_impressao = momento
        // da retirada; usa hora_bipagem se existir, senão hora_impressao.
        const h = it.hora_bipagem || it.hora_impressao;
        const hhmm = h ? new Date(h).toLocaleTimeString('pt-BR', { hour12: false }).slice(0, 5) : '--:--';
        return _pad(hhmm, 6) + _pad(it.fornecedor || '-', 15) + _pad(it.ref_id || it.id, 10) + _padR(fmtKg(it.peso), 12);
      };
    } else {
      titulo    = 'RESUMO EXTRUSAO';
      sub1      = `Turno: ${_eplSafe(s.turno_codigo || '-')}  Op: ${_eplSafe(s.operador || '-', 14)}`;
      // Bobinas regulares agrupadas por máquina (C1/C2); capas (sub_tipo='capa')
      // em grupos próprios por tipo de capa. TOTAL GERAL soma tudo.
      const bobinasReg = itens.filter(it => it.sub_tipo !== 'capa');
      const capas      = itens.filter(it => it.sub_tipo === 'capa');
      grupos    = _grupoMaq(bobinasReg).concat(_grupoCapa(capas));
      itemLinha = (it, n) => it.sub_tipo === 'capa'
        ? _pad(horaBip(it), 6) + _pad('#' + n, 4) + _pad('Maq ' + (it.maquina || '-'), 9) + _padR(fmtKg(it.peso), 12)
        : _pad(horaBip(it), 6) + _pad('#' + n, 4) + _pad('L' + (it.largura || '-'), 6) + _pad(it.tipo_bobina, 7) + _pad(it.cor, 8) + _padR(fmtKg(it.peso), 11);
    }

    // ── Monta as "linhas de impressão" agrupadas, paginando por cursor Y.
    //    Cada etiqueta 100x100 reserva o topo p/ título/sub/data; o corpo
    //    recebe os grupos (cabeçalho + itens + subtotal) e, no fim, o total
    //    geral. Fontes: título/total = font4, grupo/subtotal = font3, itens =
    //    font2 (maiores que a versão antiga). Quebra em 2+ etiquetas quando
    //    não couber; grupo que vira de página repete o cabeçalho com (CONT.).
    const ALT    = { grupo: 40, item: 30, subtotal: 40, total: 60 };
    const Y_TOPO = 160;
    const Y_FIM  = 1170;   // etiqueta 100x150mm (1200 dots)
    const paginas = [];
    let cur = [], y = Y_TOPO, nGlobal = 0;
    const fecharPagina = () => { if (cur.length) paginas.push(cur); cur = []; y = Y_TOPO; };
    const push = (k, txt) => { cur.push({ k, y, txt }); y += ALT[k]; };

    for (const g of grupos) {
      const rotulo = _eplSafe(g.label.toUpperCase(), 42);
      if (y + ALT.grupo + ALT.item > Y_FIM) fecharPagina();   // não separa cabeçalho do 1º item
      push('grupo', rotulo);
      for (const it of g.itens) {
        if (y + ALT.item > Y_FIM) { fecharPagina(); push('grupo', rotulo + ' (CONT.)'); }
        nGlobal++;
        push('item', itemLinha(it, nGlobal));
      }
      if (y + ALT.subtotal > Y_FIM) fecharPagina();
      push('subtotal', `Subtotal: ${g.count} itens   ${fmtKg(g.kg)}`);
    }
    if (y + ALT.total > Y_FIM) fecharPagina();
    push('total', `TOTAL GERAL: ${itens.length} itens   ${fmtKg(totalKg)}`);
    fecharPagina();

    const nPaginas = paginas.length;
    let epl = '';
    paginas.forEach((linhas, pi) => {
      let bloco = 'N\nq800\nQ1200,24\n';
      bloco += `A30,24,0,4,1,1,N,"${_eplSafe(titulo + (parcial ? ' - PARCIAL' : ''))}"\n`;
      bloco += `A30,82,0,3,1,1,N,"${sub1}"\n`;
      bloco += `A30,120,0,2,1,1,N,"${dataHora}   Pag ${pi + 1}/${nPaginas}"\n`;
      bloco += 'LO20,150,760,3\n';
      for (const ln of linhas) {
        if (ln.k === 'grupo') {
          bloco += `LO20,${ln.y + 2},760,1\n`;
          bloco += `A30,${ln.y + 10},0,3,1,1,N,"${ln.txt}"\n`;
        } else if (ln.k === 'item') {
          bloco += `A50,${ln.y},0,2,1,1,N,"${ln.txt}"\n`;
        } else if (ln.k === 'subtotal') {
          bloco += `A50,${ln.y},0,3,1,1,N,"${ln.txt}"\n`;
        } else {   // total geral
          bloco += `LO20,${ln.y},760,3\n`;
          bloco += `A30,${ln.y + 12},0,4,1,1,N,"${ln.txt}"\n`;
        }
      }
      bloco += 'P1\n';
      epl += bloco;
    });

    imprimir(epl, null, (ok, out, err, printer) => {
      if (ok) logI('resumo', `Resumo da sessão #${s.id} (${s.tipo}) impresso — ${itens.length} itens, ${nPaginas} pág.`, { printer });
      else    logW('resumo', `Falha ao imprimir resumo da sessão #${s.id}`, { erro: err });
    });
    return { ok: true, itens: itens.length, paginas: nPaginas };
  } catch (e) {
    logW('resumo', 'Erro ao gerar resumo da sessão', { erro: e && e.message });
    return { ok: false, motivo: 'erro', erro: e && e.message };
  }
}

function imprimir(eplString, printerOverride, callback) {
  const printer = printerOverride || PRINTER_ATIVA;

  // ── Modo simulação de impressão ──
  // Ativo se config print_simular='1' OU se nenhuma impressora foi detectada
  // (auto-fallback pra que testes/demos rodem sem Zebra física).
  // Em ambos os casos: pula PowerShell e retorna sucesso imediato,
  // gravando o EPL gerado em logs/print-simulado/ pra auditoria.
  const simExplicito = configGet('print_simular', '0') === '1';
  const simAutomatico = !PRINTER_DETECTADA;
  if (simExplicito || simAutomatico) {
    try {
      const dir = path.join(LOG_DIR, 'print-simulado');
      ensureDir(dir);
      const fpath = path.join(dir, `etq_${Date.now()}_${Math.random().toString(36).slice(2,8)}.epl`);
      fs.writeFileSync(fpath, eplString, 'latin1');
      const motivo = simExplicito ? 'config print_simular=1' : 'sem impressora detectada';
      logI('print', `SIMULADA (${motivo}) — EPL salvo em ${path.basename(fpath)}`);
    } catch(e) {
      logW('print', `Falha ao gravar EPL simulado: ${e.message}`);
    }
    // Pequeno delay pra emular tempo de impressão (~50ms)
    return setTimeout(() => callback(true, 'SIMULADO', '', printer || 'SIMULADA'), 50);
  }

  // ── Impressão real (PowerShell + Zebra) ──
  const tempFile = path.join(os.tmpdir(), `mp_etq_${Date.now()}.epl`);
  try { fs.writeFileSync(tempFile, eplString, 'latin1'); }
  catch(e) { return callback(false, '', 'Erro tmpfile: ' + e.message, printer); }
  let done = false;
  const finish = (ok, out, err) => {
    if (done) return; done = true;
    try { fs.unlinkSync(tempFile); } catch(e) {}
    callback(ok, out, err, printer);
  };
  const ps = spawn('powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-File', PS_SCRIPT, '-EplFile', tempFile, '-PrinterName', printer], { windowsHide: true });
  let stdout = '', stderr = '';
  ps.stdout.on('data', d => stdout += d.toString());
  ps.stderr.on('data', d => stderr += d.toString());
  ps.on('close', code => finish(code === 0, stdout, stderr));
  ps.on('error', e => finish(false, stdout, 'Spawn error: ' + e.message));
}

// ════════════════════════════════════════════════════════════════════
//  HELPERS HTTP
// ════════════════════════════════════════════════════════════════════

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
};

function jsonRes(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function jsonOk(res, obj)  { jsonRes(res, 200, { ok: true,  ...obj }); }
function jsonErr(res, status, msg, extra) {
  jsonRes(res, status, { ok: false, erro: msg, ...(extra||{}) });
}
function lerBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    let tamanho = 0;
    const LIMITE = 1024 * 1024;   // 1 MB — M4: protege contra corpo gigante
    req.on('data', c => {
      tamanho += c.length;
      if (tamanho > LIMITE) {
        reject(new Error('Corpo da requisição excede o limite de 1 MB'));
        req.destroy();
        return;
      }
      b += c;
    });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}
async function lerBodyJson(req) {
  const txt = await lerBody(req);
  if (!txt) return {};
  try { return JSON.parse(txt); } catch(e) { throw new Error('JSON inválido no corpo da requisição'); }
}

// Validações de campos obrigatórios
function exigeCampos(obj, campos) {
  for (const c of campos) {
    if (obj[c] === undefined || obj[c] === null || obj[c] === '') {
      throw new Error(`Campo obrigatório ausente: ${c}`);
    }
  }
}

// ════════════════════════════════════════════════════════════════════
//  AÇÕES DE NEGÓCIO
// ════════════════════════════════════════════════════════════════════

// Cache de idempotência (C3): clientToken → resposta já produzida.
// Protege contra duplicação quando a impressão teve sucesso no servidor
// mas a resposta não chegou ao frontend e o operador tenta de novo.
// Entradas expiram após 5 min (a janela real de retry é de segundos).
const _tokensRecentes = new Map();   // clientToken → { resp, ts }
function idempotenciaGet(token) {
  if (!token) return null;
  const e = _tokensRecentes.get(token);
  return e ? e.resp : null;
}
function idempotenciaSet(token, resp) {
  if (!token) return;
  _tokensRecentes.set(token, { resp, ts: Date.now() });
}
setInterval(() => {
  const limite = Date.now() - 5 * 60 * 1000;
  for (const [k, v] of _tokensRecentes) if (v.ts < limite) _tokensRecentes.delete(k);
}, 60 * 1000);

// Reserva número de sequência + número de sessão E insere a etiqueta,
// tudo numa transação SÍNCRONA (atômica no single-thread do Node, pois
// não há await no meio). Resolve C1 (race do seq global), C2 (número
// atribuído server-side) e M6 (race do seq_sessao). Retorna {id, seq,
// seqSessao}. A etiqueta nasce com a impressora ainda nula — preenchida
// após a impressão. Se a impressão falhar, a linha é removida.
function reservarEInserirEtiqueta(dados) {
  const tipo = dados.tipo || 'recebimento';
  const prefixoId = tipo === 'retorno' ? 'T' : tipo === 'extrusao' ? 'E' : tipo === 'outras' ? 'O' : 'R';
  const tr = makeTransaction(() => {
    // Reserva atômica do seq global do tipo
    db.prepare('UPDATE seqs SET valor = valor + 1 WHERE tipo = ?').run(tipo);
    const seq = db.prepare('SELECT valor FROM seqs WHERE tipo = ?').get(tipo).valor - 1;
    const id  = prefixoId + String(seq).padStart(7, '0');
    // Reserva do seq_sessao (MAX+1 dentro da mesma transação síncrona)
    const seqSessao = dados.sessao_id
      ? db.prepare('SELECT COALESCE(MAX(seq_sessao),0)+1 AS p FROM etiquetas WHERE sessao_id = ?').get(dados.sessao_id).p
      : null;
    dbStmts.insertEtiqueta.run({
      id, seq, tipo,
      seq_sessao:      seqSessao,
      sub_tipo:        dados.sub_tipo || null,
      material_key:    dados.materialKey || dados.material_key,
      material_nome:   dados.materialNomeEt || dados.material_nome || null,
      material_label:  dados.material_label || null,
      cor:             dados.cor || null,
      fornecedor:      dados.fornecedor,
      lote:            dados.lote,
      peso:            Number(dados.peso),
      qtd_sacos:       dados.qtd_sacos || dados.qtdSacos || null,
      codigo:          dados.codigo,
      sku:             dados.sku,
      status:          tipo === 'retorno' ? 'bipada' : 'aguardando_bipe',
      ref_id:          dados.ref_id || dados.origId || null,
      hora_impressao:  new Date().toISOString(),
      sessao_id:       dados.sessao_id || null,
      impressora:      null,                      // preenchida após imprimir
      operador:        dados.operador     || null,
      maquina:         dados.maquina      || null,
      largura:         dados.largura      || null,
      tipo_bobina:     dados.tipo_bobina  || null,
      turno_codigo:    dados.turno_codigo || null,
      peso_bruto:      dados.peso_bruto != null ? Number(dados.peso_bruto) : null,
      tara:            dados.tara       != null ? Number(dados.tara)       : null,
    });
    return { id, seq, seqSessao };
  });
  return tr();
}

function imprimirEPersistirEtiqueta(dados, callback) {
  const tipo = dados.tipo || 'recebimento';

  // Idempotência (C3): se já produzimos uma etiqueta com este clientToken,
  // devolve a mesma resposta sem imprimir/persistir de novo.
  const cached = idempotenciaGet(dados.clientToken);
  if (cached) {
    logI('print', `Idempotente: clientToken já processado → devolvendo ${cached.id}`);
    return callback({ ...cached, idempotente: true });
  }

  // Reserva número + insere ANTES de imprimir (C1, C2, M6 — atômico)
  let reserva;
  try {
    reserva = reservarEInserirEtiqueta(dados);
  } catch(e) {
    logE('print', `Reserva/inserção falhou (${tipo})`, { erro: e.message });
    return callback({ ok:false, erro: 'Falha ao reservar número: ' + e.message });
  }
  const { id, seq, seqSessao } = reserva;
  dados.seq = seq;
  dados.seq_sessao = seqSessao;

  const t0 = Date.now();
  const seloLabel = tipo === 'extrusao' ? 'Bobina' : 'Pesagem';
  logI('print', `Imprimindo ${id} (${tipo}, ${seloLabel} #${seqSessao||'-'}) → "${dados.printerName || PRINTER_ATIVA}"`, {
    codigo: dados.codigo, fornecedor: dados.fornecedor, peso: dados.peso, lote: dados.lote
  });
  const epl = gerarEPL(dados);
  imprimir(epl, dados.printerName || null, (ok, out, err, printer) => {
    const dt = Date.now() - t0;
    if (out && out.trim()) out.split('\n').forEach(l => l.trim() && logD('print', 'ps> ' + l.trim()));
    if (!ok) {
      // Impressão falhou → remove a etiqueta reservada (sem buraco no seq_sessao;
      // o seq global "queima" um número, o que é inofensivo).
      try { db.prepare('DELETE FROM etiquetas WHERE id = ?').run(id); } catch(e2) {}
      logE('print', `Falha ${id} em ${dt}ms — etiqueta revertida`, { erro: err || out });
      return callback({ ok:false, erro: err || out, printer });
    }
    // Sucesso → grava a impressora usada
    try { db.prepare('UPDATE etiquetas SET impressora = ? WHERE id = ?').run(printer, id); } catch(e2) {}
    // Log CSV específico de extrusão (write-on-print, durável)
    if (tipo === 'extrusao') {
      gravarLogExtrusaoCSV({
        id, seq_sessao: seqSessao,
        turno_codigo: dados.turno_codigo, operador: dados.operador, maquina: dados.maquina,
        cor: dados.cor, tipo_bobina: dados.tipo_bobina, largura: dados.largura,
        sku: dados.sku, peso: dados.peso, peso_bruto: dados.peso_bruto, tara: dados.tara,
        sessao_id: dados.sessao_id,
      });
    }
    // v52: Retorno nasce já 'bipada' (não passa pelo /bipar) → registra a
    // bipagem no log de produção aqui mesmo, no momento da impressão.
    if (tipo === 'retorno') {
      try { gravarLogProducaoBipagem(dbStmts.getEtiqueta.get(id)); } catch(e) {}
    }
    logI('print', `${id} impresso em ${dt}ms e persistido`);
    const resp = { ok: true, id, seq, seq_sessao: seqSessao, printer, durationMs: dt };
    idempotenciaSet(dados.clientToken, resp);   // guarda pra retry idempotente
    callback(resp);
  });
}

// ──────────────────────────────────────────────────────────────────
// Monta o payload completo da sessão.
// v4: DESAGRUPADO — cada etiqueta vira UMA linha no pedido Bling,
//     mantendo a granularidade pra auditoria item-a-item.
// Aditivos (PIG/DESSEC) já são naturalmente 1 evento de contagem = 1 etiqueta
// virtual, então o desagrupamento não os duplica.
// ──────────────────────────────────────────────────────────────────
function chaveProduto(mat, cor, forn) { return `${mat || ''}:${cor || ''}:${forn || ''}`; }

// ──────────────────────────────────────────────────────────────────
// Payload Bling pra sessão de PRODUTO ACABADO (entrada de sacolas/fardos).
// - Contato/fornecedor: o TURNO (PA_TURNOS[turno_codigo].bling).
// - 1 item por etiqueta 'P'. Produto: id = produto-PAI da cor (PA_CORES),
//   chave_produto/codigo = SKU da variação (cor+formato). quantidade =
//   PESO EM KG (fardos × 25); valor unitário = R$ 1,00.
// - Observação agrupa por cor+formato com fardos e kg, fechando no total.
// A SKU é o que distingue a variação; no envio REAL ela é resolvida pro id
// real da variação (ver resolverIdVariacaoPA em enviarSessaoBling).
// ──────────────────────────────────────────────────────────────────
function montarPayloadBlingProdutoAcabado(sessao, etiquetas) {
  const turno = PA_TURNOS[sessao.turno_codigo] || {};
  const validas = [...etiquetas].sort((a,b) => (a.seq_sessao||999) - (b.seq_sessao||999));

  const itens = validas.map(e => {
    const cor = PA_CORES[e.material_key] || {};
    const maq = (e.maquina || '?').toUpperCase();
    return {
      produto:        { id: cor.bling_pai || null, codigo: e.sku },
      chave_produto:  e.sku,                                   // SKU da variação
      quantidade:     Number(e.peso || 0),                    // QUANTIDADE EM KG (fardos × 25) — o Bling lança em kg
      valor:          1,                                       // R$ 1,00 fixo (preço unitário, padrão Ekoplastic)
      descricao_local: `[${maq}] ${e.material_nome || e.material_key} ${e.lote} · ${e.qtd_sacos} fardo(s) × ${PA_KG_FARDO}kg = ${Number(e.peso).toFixed(0)} kg · SKU ${e.sku} · Etiq ${e.id}`,
      etiquetas_origem: [e.id],
      seq_sessao:      e.seq_sessao || null,
    };
  });

  // Observação lida por dashboard: soma da produção (em kg) por máquina.
  // Formato fixo, uma linha por máquina (0 quando a máquina não produziu).
  const kgPorMaquina = m => validas
    .filter(e => (e.maquina || '').toUpperCase() === m)
    .reduce((a, e) => a + Number(e.peso || 0), 0);
  const observacoes =
    `PRODUÇÃO P1: ${Math.round(kgPorMaquina('P1'))}\n` +
    `PRODUÇÃO P2: ${Math.round(kgPorMaquina('P2'))}`;

  return {
    tipo_movimento: 'produto-acabado',
    contato: { id: turno.bling, nome: turno.nome || sessao.turno_codigo },
    sessao_id: sessao.id,
    data_producao: sessao.data_lancamento || dataLancamentoPA(sessao.turno_codigo),
    observacoes,
    itens,
  };
}

function montarPayloadBling(sessao, etiquetas, mapaForn, mapaSku, idEko) {
  // Ramo dedicado pra extrusão: usa mapas próprios (turno → fornecedor,
  // chave_bobina → produto). Modelo igual MP (lote ao finalizar).
  if (sessao.tipo === 'extrusao') {
    return montarPayloadBlingExtrusao(sessao, etiquetas);
  }
  // Ramo dedicado pra OUTRAS PESAGENS: só borra/varredura (com ID) viram itens
  // do Bling; aparas (sem ID) ficam só na observação/resumo.
  if (sessao.tipo === 'outras') {
    return montarPayloadBlingOutras(sessao, etiquetas, idEko);
  }
  // Ramo dedicado pra PRODUTO ACABADO: contato = turno; itens por SKU de
  // variação (id-pai por cor); quantidade = peso em kg.
  if (sessao.tipo === 'produto-acabado') {
    return montarPayloadBlingProdutoAcabado(sessao, etiquetas);
  }

  // Contato:
  //   recebimento → fornecedor real (mapaForn)
  //   retorno      → EKOPLASTIC (idEko)
  //   retirada     → EKOPLASTIC (idEko) — venda interna pra extrusão
  const contatoNome = sessao.tipo === 'recebimento'
    ? sessao.fornecedor
    : (sessao.tipo === 'retirada' ? 'EKOPLASTIC IND (retirada)' : 'EKOPLASTIC IND (retorno)');
  const contatoId = sessao.tipo === 'recebimento'
    ? mapaForn[sessao.fornecedor]
    : idEko;

  // Ordena por seq_sessao (ordem de pesagem/bipagem real)
  const etiquetasOrdenadas = [...etiquetas].sort((a, b) => {
    return (a.seq_sessao || 999) - (b.seq_sessao || 999);
  });

  // Observação por tipo de sessão.
  //   retirada/retorno → texto curto de origem (inalterado)
  //   recebimento      → discrimina os totais por tipo de material
  //                      (material + cor), igual ao resumo impresso, fechando
  //                      com o total geral. Bling aceita \n nas observações.
  let observacoes;
  if (sessao.tipo === 'retirada') {
    // Rastreio: lista cada big bag retirado (material, cor, fornecedor, lote,
    // peso, etiqueta de retirada e etiqueta de origem no recebimento). Isso
    // garante rastrear 100% qual big bag saiu para produção, mesmo que o Bling
    // exiba a descrição do produto no item do pedido de venda.
    const linhasBB = etiquetasOrdenadas.map(e => {
      const mat = e.material_nome || e.material_key;
      const orig = e.ref_id ? ` (orig ${e.ref_id})` : '';
      return `Palete #${String(e.seq_sessao || '-').padStart(2, '0')}: ${mat}${e.cor ? ' ' + e.cor : ''} - ${e.fornecedor} - Lote ${e.lote} - ${Number(e.peso).toFixed(0)}kg - Etiq ${e.id}${orig}`;
    });
    observacoes = `RETIRADA PARA EXTRUSAO. Sessao #${sessao.id}.\nBig bags retirados:\n` + linhasBB.join('\n');
  } else if (sessao.tipo === 'retorno') {
    observacoes = `RETORNO DE PRODUCAO. Sessao #${sessao.id} - gerado pelo Sistema de Etiquetas.`;
  } else {
    const grupos  = _grupoMP(etiquetas);
    const totalKg = etiquetas.reduce((a, e) => a + Number(e.peso || 0), 0);
    const fmtKgB  = kg => `${Number(kg || 0).toFixed(1).replace('.', ',')} KG`;
    observacoes = grupos.map(g => `${g.label.toUpperCase()}: ${fmtKgB(g.kg)}`).join('\n')
                + `\nTOTAL: ${fmtKgB(totalKg)}`;
  }

  // 1 etiqueta = 1 item. Cada item carrega seu seq_sessao no descritor pra rastreio.
  const mapaSkuVariacaoMp = JSON.parse(configGet('mapa_sku_variacao_mp', '{}'));
  // Índice auxiliar case-insensitive: tolera etiquetas cujo fornecedor foi
  // gravado com case diferente do cadastro (ex "ECORAFIA" recebido antes de o
  // nome virar "Ecorafia"), garantindo que a variação seja resolvida mesmo assim.
  const mapaSkuVarCI = {};
  for (const k in mapaSkuVariacaoMp) mapaSkuVarCI[k.toLowerCase()] = mapaSkuVariacaoMp[k];
  // Índice CI do mapa de produtos também, pra resolver o id-pai de etiquetas
  // cujo fornecedor foi gravado com case diferente (ex "ECORAFIA" recebido
  // antes de o nome virar "Ecorafia") — assim o fallback do id nunca fica nulo.
  const mapaSkuCI = {};
  for (const k in mapaSku) mapaSkuCI[k.toLowerCase()] = mapaSku[k];
  const itens = etiquetasOrdenadas.map(e => {
    const chave = chaveProduto(e.material_key, e.cor, e.fornecedor);
    const material = e.material_nome || e.material_key;
    const isAditivoContado = e.sub_tipo === 'aditivo-saida' || e.sub_tipo === 'aditivo-fechados';
    const sufixoSacos = (e.qtd_sacos && e.qtd_sacos > 0) ? ` · ${e.qtd_sacos} sacos × 25kg` : '';
    const rotuloUnidade = isAditivoContado
      ? `Aditivo #${String(e.seq_sessao||'-').padStart(2,'0')}`
      : (sessao.tipo === 'recebimento'
          ? `Big Bag #${String(e.seq_sessao||'-').padStart(2,'0')}`
          : sessao.tipo === 'retorno'
          ? `Retorno #${String(e.seq_sessao||'-').padStart(2,'0')}`
          : `Palete #${String(e.seq_sessao||'-').padStart(2,'0')}`);
    return {
      produto:        { id: mapaSku[chave] || mapaSkuCI[chave.toLowerCase()] || null, codigo_extrusao: e.codigo },
      chave_produto:  chave,
      sku_variacao:   mapaSkuVariacaoMp[chave] || mapaSkuVarCI[chave.toLowerCase()] || null,   // se preenchido, resolve id da variação no envio
      quantidade:     Number(Number(e.peso).toFixed(3)),
      valor:          1,                                          // R$ 1,00 fixo
      descricao_local: `${rotuloUnidade} · ${material}${e.cor ? ' · ' + e.cor : ''} · Fornecedor: ${e.fornecedor} · Lote: ${e.lote}${sufixoSacos} · Etiq ${e.id}`,
      etiquetas_origem: [e.id],
      seq_sessao:      e.seq_sessao || null,
    };
  });

  return {
    tipo_movimento: sessao.tipo,                 // recebimento | retorno | retirada
    contato: { id: contatoId, nome: contatoNome },
    sessao_id: sessao.id,
    observacoes,
    itens,
  };
}

// ──────────────────────────────────────────────────────────────────
// Payload Bling pra sessão de EXTRUSÃO (modelo lote).
// - Contato: pseudo-fornecedor do turno (mapa_turno_extrusao)
// - 1 item por etiqueta (desagrupado pra rastreio), exclui canceladas
// - Produto via mapa_bobina_bling[cor|tipo|largura]
// ──────────────────────────────────────────────────────────────────
function montarPayloadBlingExtrusao(sessao, etiquetas) {
  const mapaBobinas = JSON.parse(configGet('mapa_bobina_bling', '{}'));
  const mapaTurnos  = JSON.parse(configGet('mapa_turno_extrusao', '{}'));
  const turno = mapaTurnos[sessao.turno_codigo] || {};

  // `etiquetas` já vem filtrado pelo chamador (enviarSessaoBling envia só
  // status='bipada'). Aqui apenas ordenamos por ordem de pesagem.
  const validas = [...etiquetas].sort((a,b) => (a.seq_sessao||999) - (b.seq_sessao||999));

  const itens = validas.map(e => {
    // Capas: produto próprio (CAPAS_CATALOGO por SKU), fora do mapa de bobina.
    if (e.sub_tipo === 'capa') {
      const capa = CAPAS_CATALOGO[e.sku] || {};
      return {
        produto:        { id: capa.id || null, codigo_extrusao: e.sku },
        chave_produto:  e.sku,
        quantidade:     Number(Number(e.peso).toFixed(3)),
        valor:          1,
        descricao_local: `Capa #${String(e.seq_sessao||'-').padStart(2,'0')} · ${e.material_nome || e.sku} · ${Number(e.peso).toFixed(1)} kg · Op ${e.operador||'—'} Maq ${e.maquina||'—'} · Etiq ${e.id}`,
        etiquetas_origem: [e.id],
        seq_sessao:      e.seq_sessao || null,
      };
    }
    const chave = `${(e.cor||'').toUpperCase()}|${(e.tipo_bobina||'').toUpperCase()}|${e.largura}`;
    const bobina = mapaBobinas[chave] || {};
    return {
      produto:        { id: bobina.id || null, codigo_extrusao: bobina.sku || e.sku },
      chave_produto:  chave,
      quantidade:     Number(Number(e.peso).toFixed(3)),
      valor:          1,
      descricao_local: `Bobina #${String(e.seq_sessao||'-').padStart(2,'0')} · ${e.cor} ${e.tipo_bobina} ${e.largura} · ${Number(e.peso).toFixed(1)} kg · Op ${e.operador||'—'} Maq ${e.maquina||'—'} · Etiq ${e.id}`,
      etiquetas_origem: [e.id],
      seq_sessao:      e.seq_sessao || null,
    };
  });

  // Soma por máquina (C1 / C2) pra observação do Bling.
  // Formato EXATO lido pelo dashboard: operador na 1ª linha, C1 na 2ª, C2 na
  // 3ª. Máquina sem produção no turno fica em branco após os dois-pontos
  // (sem escrever "vazio"). Capas NÃO entram nesse total (produto à parte).
  const porMaq = {};
  for (const e of validas) {
    if (e.sub_tipo === 'capa') continue;
    const m = (e.maquina || '').toUpperCase();
    if (m) porMaq[m] = (porMaq[m] || 0) + Number(e.peso || 0);
  }
  const fmtMaqKg = kg => (kg == null ? '' : `${kg.toFixed(1).replace('.', ',')} KG`);
  const observacoes =
    `OPERADOR: ${sessao.operador || ''}\n` +
    `C1: ${fmtMaqKg(porMaq['C1'])}\n` +
    `C2: ${fmtMaqKg(porMaq['C2'])}`;

  // Data de produção = dia de INÍCIO do turno. Os turnos C (noturno) começam
  // às 18h e terminam às 06h do dia seguinte; como a sessão é finalizada de
  // manhã, a data "de hoje" já caiu no dia seguinte ao início. Por isso, para
  // turno C, a data vai pelo INÍCIO da sessão — ex.: C-2 iniciado em 18/06 e
  // finalizado em 19/06 entra no Bling como 18/06. Turnos A (diurno) começam
  // e terminam no mesmo dia, então o início coincide com hoje.
  const ehTurnoC = /^EXT-C/i.test(sessao.turno_codigo || '');
  const dataProducao = ehTurnoC ? dataLocalISO(sessao.inicio) : dataLocalISO();

  return {
    tipo_movimento: 'extrusao',
    contato: { id: turno.fornecedorId, nome: turno.label || sessao.turno_codigo },
    sessao_id: sessao.id,
    data_producao: dataProducao,
    observacoes,
    itens,
  };
}

// ──────────────────────────────────────────────────────────────────
// Payload Bling pra sessão de OUTRAS PESAGENS (inventário / resíduos).
// - Contato: EKOPLASTIC (idEko) — configurável.
// - Itens: SÓ borra/varredura (têm blingId no OUTRAS_CATALOGO). Aparas ficam
//   de fora dos itens (não têm produto no Bling), mas entram na observação.
// - Observação: discrimina TODOS os itens por categoria (igual ao resumo),
//   fechando com o total geral. Bling aceita \n.
// O envio (pedido de COMPRA / entrada de estoque) é feito em enviarSessaoBling.
// ──────────────────────────────────────────────────────────────────
function montarPayloadBlingOutras(sessao, etiquetas, idEko) {
  const ordenadas = [...etiquetas].sort((a, b) => (a.seq_sessao || 999) - (b.seq_sessao || 999));

  // Observação: todos os itens por categoria + total geral.
  const grupos  = _grupoOutras(etiquetas);
  const totalKg = etiquetas.reduce((a, e) => a + Number(e.peso || 0), 0);
  const fmtKgB  = kg => `${Number(kg || 0).toFixed(1).replace('.', ',')} KG`;
  // PÓ e VARREDURA são o MESMO produto no Bling (mesmo SKU e ID). No pedido
  // eles apareceriam idênticos, então a observação é o que permite saber
  // quanto foi de cada um.
  const kgPo = etiquetas.filter(e => e.sku === 'RES.PO')
                        .reduce((a, e) => a + Number(e.peso || 0), 0);
  const observacoes =
    `OUTRAS PESAGENS - Sessao #${sessao.id}\n` +
    grupos.map(g => `${g.label.toUpperCase()}: ${fmtKgB(g.kg)}`).join('\n') +
    `\nTOTAL: ${fmtKgB(totalKg)}` +
    (kgPo > 0
      ? `\n\n*** ${fmtKgB(kgPo)} DESTE PEDIDO E PO ***`
      + `\n(PO usa o mesmo produto da VARREDURA no Bling)`
      : '');

  // Itens: apenas os que têm produto no Bling (borra/varredura).
  const itens = ordenadas
    .filter(e => OUTRAS_CATALOGO[e.sku] && OUTRAS_CATALOGO[e.sku].blingId)
    .map(e => {
      const cat = OUTRAS_CATALOGO[e.sku];
      return {
        produto:        { id: cat.blingId, codigo_extrusao: e.codigo },
        chave_produto:  e.sku,
        quantidade:     Number(Number(e.peso).toFixed(3)),
        valor:          1,                                    // R$ 1,00 fixo (padrão Ekoplastic)
        descricao_local: `${cat.nome} #${String(e.seq_sessao||'-').padStart(2,'0')} · Etiq ${e.id}`,
        etiquetas_origem: [e.id],
        seq_sessao:      e.seq_sessao || null,
      };
    });

  return {
    tipo_movimento: 'outras',
    contato: { id: idEko, nome: 'EKOPLASTIC IND (outras pesagens)' },
    sessao_id: sessao.id,
    observacoes,
    itens,
  };
}

// ──────────────────────────────────────────────────────────────────
// Envia uma sessão fechada pro Bling.
// Modo SIMULAÇÃO (config.bling_simular='1' — default): monta o payload,
//   loga tudo, marca como enviado com bling_id="SIM-<timestamp>".
// Modo REAL: faz POST /Api/v3/pedidos/compras (requer mapa_fornecedor_bling,
//   mapa_produto_bling e/ou id_ekoplastic_bling configurados).
// ──────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────
// PRODUTO ACABADO — resolve a SKU de uma variação pro id REAL dela no Bling.
// Por que: todas as variações de uma cor compartilham o id do produto-PAI;
// o que distingue cada formato é a SKU (código). Para o pedido entrar na
// variação certa, precisamos do id da VARIAÇÃO, não do pai. Buscamos por
// código (GET /produtos?codigo=SKU), cacheamos o resultado em config
// (mapa_variacao_pa_bling) e usamos o id-pai como fallback se a SKU não for
// encontrada. Só é chamado no modo REAL.
// ──────────────────────────────────────────────────────────────────
async function resolverIdVariacaoPA(token, sku, idPaiFallback) {
  let mapa = {};
  try { mapa = JSON.parse(configGet('mapa_variacao_pa_bling', '{}')); } catch(e) {}
  if (mapa[sku]) return mapa[sku];
  try {
    const r = await proxyChamada(token, 'GET', '/Api/v3/produtos?codigo=' + encodeURIComponent(sku), '', '');
    let d = {}; try { d = JSON.parse(r.body); } catch(e) {}
    const id = Array.isArray(d.data) ? (d.data[0] && d.data[0].id) : (d.data && d.data.id);
    if (id) {
      mapa[sku] = Number(id);
      configSet('mapa_variacao_pa_bling', JSON.stringify(mapa));
      logI('bling', `Variação PA resolvida: ${sku} → id ${id}`);
      return Number(id);
    }
    logW('bling', `Variação PA ${sku} não encontrada por código — usando id-pai ${idPaiFallback}`);
  } catch(e) {
    logW('bling', `Falha ao resolver variação PA ${sku} — usando id-pai ${idPaiFallback}`, { erro: e.message });
  }
  return Number(idPaiFallback);
}

async function enviarSessaoBling(sessaoId, opts) {
  const sessao = dbStmts.getSessao.get(sessaoId);
  if (!sessao) throw new Error('Sessão não encontrada');
  const forcar = !!(opts && opts.forcar);
  // Já enviada: normalmente não reenvia (idempotência). Com forcar=true (operador
  // excluiu o pedido no Bling e quer reenviar a versão corrigida), prossegue e
  // gera um NOVO pedido — o bling_id antigo é substituído pelo novo.
  if (!forcar && sessao.bling_status === 'enviado') {
    return { ok: true, ja_enviado: true, bling_id: sessao.bling_id, modo: sessao.bling_id?.startsWith('SIM-') ? 'simulacao' : 'real' };
  }
  if (forcar && sessao.bling_status === 'enviado') {
    logW('bling', `Reenvio FORÇADO da sessão #${sessaoId} (pedido anterior ${sessao.bling_id} deve ter sido excluído no Bling manualmente)`);
  }

  // Quais etiquetas entram no envio.
  // ATENÇÃO ao 'consumida': num RECEBIMENTO (ou retorno), um big bag pode ser
  // retirado para a produção ANTES de a entrada ser finalizada. Nesse caso ele
  // fica 'consumida', mas a ENTRADA dele precisa ir ao Bling do mesmo jeito —
  // senão o Bling registra a saída de um material que nunca entrou. A retirada
  // já é lançada à parte, pela sessão de retirada.
  // Nas sessões de retirada/outras, 'consumida' NÃO entra: lá a etiqueta que
  // vale é a virtual (tipo='retirada'), que já nasce 'bipada'.
  const statusValidos = (sessao.tipo === 'recebimento' || sessao.tipo === 'retorno')
    ? `('bipada','consumida')`
    : `('bipada')`;
  const etiquetas = db.prepare(`SELECT * FROM etiquetas WHERE sessao_id = ? AND status IN ${statusValidos} ORDER BY id`).all(sessaoId);
  if (etiquetas.length === 0) {
    dbStmts.updSessaoBling.run('erro', null, 'Sessão sem etiquetas bipadas', sessaoId);
    return { ok: false, erro: 'Sessão não tem etiquetas bipadas' };
  }

  const mapaFornBling = JSON.parse(configGet('mapa_fornecedor_bling', '{}'));
  const mapaSkuBling  = JSON.parse(configGet('mapa_produto_bling', '{}'));
  const idEkoplastic  = configGet('id_ekoplastic_bling', null);
  const simular       = configGet('bling_simular', '1') === '1';

  // Mantém os totais gravados coerentes com o que está sendo enviado (importante
  // no reenvio: a sessão pode ter sido fechada por uma versão antiga do sistema).
  try {
    const somaEnv = Number(etiquetas.reduce((a, e) => a + (Number(e.peso) || 0), 0).toFixed(3));
    if (sessao.total_etiquetas !== etiquetas.length || Number(sessao.total_kg) !== somaEnv) {
      db.prepare('UPDATE sessoes SET total_kg = ?, total_etiquetas = ? WHERE id = ?').run(somaEnv, etiquetas.length, sessaoId);
      logI('bling', `Totais da sessão #${sessaoId} atualizados: ${etiquetas.length} itens · ${somaEnv} kg (antes ${sessao.total_etiquetas} · ${sessao.total_kg})`);
      sessao.total_etiquetas = etiquetas.length; sessao.total_kg = somaEnv;
    }
  } catch(e) { logW('bling', 'Falha ao atualizar totais da sessão: ' + e.message); }

  const payload = montarPayloadBling(sessao, etiquetas, mapaFornBling, mapaSkuBling, idEkoplastic);

  // Loga payload sempre (útil em qualquer modo)
  logI('bling', `Sessão #${sessaoId} — payload preparado`, {
    tipo:        sessao.tipo,
    fornecedor:  sessao.fornecedor,
    etiquetas:   etiquetas.length,
    grupos:      payload.itens.length,
    total_kg:    Number(etiquetas.reduce((s,e) => s+e.peso, 0).toFixed(3)),
    modo:        simular ? 'simulacao' : 'real',
  });
  // Log detalhado (item a item) em DEBUG pra rastreio fino
  logD('bling', `Sessão #${sessaoId} — payload completo`, payload);

  // OUTRAS PESAGENS sem nenhum item com código Bling (ex.: só aparas) → não há
  // pedido a criar. Não é erro: o resumo já foi impresso. Marca como cancelada
  // (com motivo claro) e segue. Vale pra simulação e real.
  if (sessao.tipo === 'outras' && payload.itens.length === 0) {
    dbStmts.updSessaoBling.run('cancelada', null, 'Sem itens com codigo Bling (apenas aparas) — nada enviado', sessaoId);
    configSet(`payload_sessao_${sessaoId}`, JSON.stringify(payload));
    logI('bling', `Sessão #${sessaoId} (outras) — sem borra/varredura; nada enviado ao Bling`);
    return { ok: true, modo: 'sem_itens_bling', payload };
  }

  // ═══ MODO SIMULAÇÃO ═══
  if (simular) {
    const blingIdSim = `SIM-${Date.now()}`;
    dbStmts.updSessaoBling.run('enviado', blingIdSim, null, sessaoId);
    // Persiste o payload pra revisão posterior (pode ler via /sessoes/:id/payload-bling)
    configSet(`payload_sessao_${sessaoId}`, JSON.stringify(payload));
    logI('bling', `Sessão #${sessaoId} — SIMULADA com sucesso (bling_id=${blingIdSim})`);
    return { ok: true, modo: 'simulacao', bling_id: blingIdSim, payload };
  }

  // ═══ MODO REAL ═══
  // Valida configs necessárias
  const semContato = sessao.tipo === 'recebimento'
    ? !mapaFornBling[sessao.fornecedor]
    : sessao.tipo === 'produto-acabado'
    ? !(payload.contato && payload.contato.id)
    : !idEkoplastic;
  if (semContato) {
    const erro = sessao.tipo === 'recebimento'
      ? `Fornecedor "${sessao.fornecedor}" sem ID Bling. Configure: POST /config {"mapa_fornecedor_bling":{"${sessao.fornecedor}":"ID"}}`
      : sessao.tipo === 'produto-acabado'
      ? `Turno "${sessao.turno_codigo}" sem ID Bling de contato. Verifique PA_TURNOS no servidor.`
      : 'ID Ekoplastic não configurado. POST /config {"id_ekoplastic_bling":"ID"}';
    dbStmts.updSessaoBling.run('pendente_config', null, erro, sessaoId);
    logW('bling', `Sessão #${sessaoId} — pendente_config: ${erro}`);
    return { ok: false, status: 'pendente_config', erro };
  }

  // Envio real ao Bling.
  // - Recebimento/Retorno: POST /Api/v3/pedidos/compras com {fornecedor, itens, observacoes}
  // - Retirada:            POST /Api/v3/pedidos/vendas   com {contato,   itens, observacoes}
  // IDs devem ser number, não string.
  try {
    const token = await getToken();
    let blingPath, blingPayload;
    if (sessao.tipo === 'retirada') {
      // Retirada = venda interna pra extrusão → pedido de VENDA.
      // Itens com sku_variacao (cores que compartilham o id-pai, ex Ecorafia)
      // têm o id da variação resolvido pela SKU (lookup por código, cacheado),
      // com fallback pro id-pai, e enviam também o codigo. Sem isso o Bling
      // recebe só o id-pai e não distingue a variação pra dar baixa no estoque.
      // Os demais itens seguem com o id direto (inalterado).
      blingPath = '/Api/v3/pedidos/vendas';
      const hoje = dataLocalISO();                  // YYYY-MM-DD na hora local
      const itensVenda = [];
      for (const it of payload.itens) {
        let prodId = Number(it.produto.id);
        let codigoVar;
        if (it.sku_variacao) {
          prodId = Number(await resolverIdVariacaoPA(token, it.sku_variacao, it.produto.id));
          codigoVar = it.sku_variacao;
        }
        itensVenda.push({
          produto:    { id: prodId },
          ...(codigoVar ? { codigo: codigoVar } : {}),
          descricao:  it.descricao_local,
          quantidade: it.quantidade,
          valor:      it.valor,
        });
      }
      blingPayload = {
        data: hoje,                                 // data de emissão (obrigatório p/ gerar parcelas)
        contato: { id: Number(payload.contato.id) },
        itens:   itensVenda,
        observacoes: payload.observacoes,
      };
    } else if (sessao.tipo === 'extrusao') {
      // Extrusão também usa pedido de COMPRA (entrada de estoque). Contato é
      // o pseudo-fornecedor do turno. A data de produção vem do payload — é o
      // dia de INÍCIO do turno; turnos C (noturno) fechados de manhã entram no
      // dia anterior ao fechamento (ver montarPayloadBlingExtrusao).
      blingPath = '/Api/v3/pedidos/compras';
      const hoje = payload.data_producao || dataLocalISO();
      blingPayload = {
        fornecedor:   { id: Number(payload.contato.id) },
        data:         hoje,
        dataPrevista: hoje,
        situacao:     { id: 1 },                    // 1 = "Em aberto"
        itens: payload.itens.map(it => ({
          produto:    { id: Number(it.produto.id) },
          descricao:  it.descricao_local,
          quantidade: it.quantidade,
          valor:      it.valor,
        })),
        observacoes: payload.observacoes,
      };
    } else if (sessao.tipo === 'produto-acabado') {
      // Entrada de PRODUTO ACABADO → pedido de COMPRA (entrada de estoque),
      // tendo o TURNO como fornecedor. Cada cor é um produto com variações que
      // compartilham o id-pai; a SKU distingue a variação. Resolvemos a SKU
      // pro id REAL da variação (lookup por código, cacheado) e mandamos esse
      // id no item — com fallback pro id-pai caso a SKU não seja encontrada.
      blingPath = '/Api/v3/pedidos/compras';
      const itensPA = [];
      for (const it of payload.itens) {
        const idVar = await resolverIdVariacaoPA(token, it.chave_produto, it.produto.id);
        itensPA.push({
          produto:    { id: Number(idVar) },
          codigo:     it.chave_produto,               // SKU da variação
          descricao:  it.descricao_local,
          quantidade: it.quantidade,                  // peso em kg (fardos × 25)
          valor:      it.valor,
        });
      }
      const dataPA = payload.data_producao || dataLocalISO();
      blingPayload = {
        fornecedor:   { id: Number(payload.contato.id) },
        data:         dataPA,
        dataPrevista: dataPA,
        itens:        itensPA,
        observacoes:  payload.observacoes,
      };
    } else {
      // recebimento, retorno e OUTRAS PESAGENS (borra/varredura) → pedido de
      // COMPRA (entrada de estoque), igual às matérias-primas.
      // Itens com sku_variacao (cores que compartilham o id-pai, ex Ecorafia)
      // têm o id da variação resolvido pela SKU (lookup por código, cacheado),
      // com fallback pro id-pai. Os demais seguem com o id direto (inalterado).
      blingPath = '/Api/v3/pedidos/compras';
      const itensComp = [];
      for (const it of payload.itens) {
        let prodId = Number(it.produto.id);
        let codigoVar;
        if (it.sku_variacao) {
          prodId = Number(await resolverIdVariacaoPA(token, it.sku_variacao, it.produto.id));
          codigoVar = it.sku_variacao;
        }
        itensComp.push({
          produto:    { id: prodId },
          ...(codigoVar ? { codigo: codigoVar } : {}),
          descricao:  it.descricao_local,
          quantidade: it.quantidade,
          valor:      it.valor,
        });
      }
      blingPayload = {
        fornecedor: { id: Number(payload.contato.id) },
        itens:      itensComp,
        observacoes: payload.observacoes,
      };
    }
    const r = await proxyChamada(token, 'POST', blingPath, '', JSON.stringify(blingPayload));
    const respData = (() => { try { return JSON.parse(r.body); } catch(e) { return {}; }})();
    if (r.status >= 200 && r.status < 300 && respData.data?.id) {
      dbStmts.updSessaoBling.run('enviado', String(respData.data.id), null, sessaoId);
      logI('bling', `Sessão #${sessaoId} — ENVIADA (bling_id=${respData.data.id}) [${blingPath}]`);
      return { ok: true, modo: 'real', bling_id: respData.data.id };
    }
    const erro = `HTTP ${r.status} ${r.body.substring(0,300)}`;
    dbStmts.updSessaoBling.run('erro', null, erro, sessaoId);
    logE('bling', `Sessão #${sessaoId} — falhou no envio`, { status: r.status, body: r.body.substring(0, 500) });
    return { ok: false, erro };
  } catch(e) {
    dbStmts.updSessaoBling.run('erro', null, e.message, sessaoId);
    logE('bling', `Sessão #${sessaoId} — exceção`, { erro: e.message });
    return { ok: false, erro: e.message };
  }
}

// ══════════════════════════════════════════════════════════════════════
//  AUTO-FINALIZAÇÃO de turnos de Extrusão por horário
// ══════════════════════════════════════════════════════════════════════
// Premissas (alinhadas com o cliente — 24/05/2026):
//   • Turno A (EXT-A1, EXT-A2): 06h-18h. Auto-fim ATÉ 19h do mesmo dia.
//   • Turno C (EXT-C1, EXT-C2): 18h-06h. Auto-fim ATÉ 07h do dia seguinte.
//   • Grace = 1h após fim normal do turno.
//
// Comportamentos:
//   • Sessão VAZIA (zero etiquetas válidas) → AUTO-CANCELADA, não envia Bling
//   • Sessão COM ITENS → AUTO-FINALIZADA + envia Bling (mesmo fluxo do MP)
//   • bling_erro marca explícita: "AUTO-FINALIZADA: limite excedido"
//   • Log WARN 30min antes do limite (rastreio de esquecimentos)
//
// Roda a cada 5min via setInterval no bootstrap.
// ══════════════════════════════════════════════════════════════════════

function calcularLimiteAutoFim(turnoCodigo, inicioISO) {
  const inicio = new Date(inicioISO);
  const limite = new Date(inicio);
  if (turnoCodigo === 'EXT-A1' || turnoCodigo === 'EXT-A2') {
    // Turno A — limite às 19h do mesmo dia (ou dia seguinte se iniciou após 18h)
    limite.setHours(19, 0, 0, 0);
    if (inicio.getHours() >= 19) limite.setDate(limite.getDate() + 1);
  } else if (turnoCodigo === 'EXT-C1' || turnoCodigo === 'EXT-C2') {
    // Turno C — limite às 07h do dia seguinte (ou hoje se iniciou de madrugada)
    limite.setHours(7, 0, 0, 0);
    if (inicio.getHours() >= 7) limite.setDate(limite.getDate() + 1);
  } else {
    return null;     // turno desconhecido — não auto-finaliza
  }
  return limite;
}

const _avisos30minDados = new Set();   // memoria pra não logar WARN repetido
const _pendenteAvisado  = new Set();   // desvio de turno preso: registra uma vez por sessão

async function checarSessoesParaAutoFim() {
  let abertas;
  try {
    abertas = db.prepare(
      `SELECT id, tipo, turno_codigo, operador, maquina, inicio
       FROM sessoes
       WHERE fim IS NULL AND tipo = 'extrusao'`
    ).all();
  } catch(e) {
    logE('sessao', 'auto-fim: falha ao listar abertas: ' + e.message);
    return;
  }
  if (!abertas.length) return;

  const agora = new Date();
  for (const s of abertas) {
    const limite = calcularLimiteAutoFim(s.turno_codigo, s.inicio);
    if (!limite) continue;
    const msAteLimite = limite.getTime() - agora.getTime();

    if (msAteLimite <= 0) {
      // Excedeu — auto-finalizar
      try {
        await autoFinalizarSessaoExtrusao(s.id, 'limite_horario_excedido');
      } catch(e) {
        logE('sessao', `auto-fim #${s.id} falhou: ${e.message}`);
      }
    } else if (msAteLimite <= 30 * 60 * 1000 && !_avisos30minDados.has(s.id)) {
      // Aviso 30min antes — só uma vez por sessão
      _avisos30minDados.add(s.id);
      const minutos = Math.ceil(msAteLimite / 60000);
      logW('sessao', `Sessão #${s.id} (${s.turno_codigo}, op=${s.operador||'—'}) será auto-finalizada em ${minutos}min se não houver finalização manual`);
    }
  }
}

async function autoFinalizarSessaoExtrusao(sessaoId, motivo) {
  const sessao = dbStmts.getSessao.get(sessaoId);
  if (!sessao || sessao.fim) return { ok: false, erro: 'Sessão já finalizada' };

  // Etiquetas válidas (não canceladas) e, dentro delas, as bipadas.
  // A trava de bipagem no frontend garante que, no máximo, sobra a última
  // bobina não bipada. Aqui no auto-fim, qualquer pendente restante é
  // CANCELADA (com motivo) pra não ficar órfã — só as bipadas vão ao Bling,
  // mantendo coerência entre total registrado e total enviado.
  const validas    = db.prepare(`SELECT * FROM etiquetas WHERE sessao_id = ? AND status != 'cancelada'`).all(sessaoId);
  const bipadas    = validas.filter(e => e.status === 'bipada');
  const pendentes  = validas.filter(e => e.status === 'aguardando_bipe');

  const agoraISO = new Date().toISOString();

  // ── TRAVA 3: o auto-fim NÃO fecha turno com bipagem pendente ──────────
  // Antes, o auto-fim das 19h (turno A) e das 07h (turno C) CANCELAVA em
  // silêncio toda bobina impressa e não bipada. Uma bobina real podia
  // desaparecer da produção sem ninguém ver — justamente na virada de
  // turno, quando os operadores estão tirando bobina de cada máquina.
  // Agora o turno fica ABERTO e o desvio é registrado. A verificação roda
  // a cada 5 min: assim que alguém bipar (ou excluir) as pendentes, o
  // turno fecha sozinho na passada seguinte.
  if (pendentes.length > 0) {
    const ids = pendentes.map(e => e.id);
    if (!_pendenteAvisado.has(sessaoId)) {
      _pendenteAvisado.add(sessaoId);
      logDesvio({
        tipo: 'turno_nao_fechado_bipagem_pendente',
        tela: 'extrusao',
        detalhe: `Sessão #${sessaoId} (${sessao.turno_codigo || '—'}, op=${sessao.operador || '—'}) — ` +
                 `${ids.length} bobina(s) impressa(s) e NÃO bipada(s): ${ids.join(', ')}`,
      });
    }
    logW('sessao', `Sessão #${sessaoId} NÃO foi fechada no auto-fim: ${ids.length} bobina(s) aguardando bipagem`, { ids });
    return { ok: false, erro: 'bipagem_pendente', pendentes: ids, sessao_id: sessaoId };
  }
  _pendenteAvisado.delete(sessaoId);

  if (bipadas.length === 0) {
    // Nenhuma bipada → cancela a sessão inteira (nada a enviar)
    db.prepare(
      `UPDATE sessoes SET fim = ?, bling_status = 'cancelada', bling_erro = ? WHERE id = ?`
    ).run(agoraISO, `AUTO-CANCELADA: ${motivo} (nenhuma bobina bipada, sessão vazia)`, sessaoId);
    logI('sessao', `Sessão #${sessaoId} (${sessao.turno_codigo}) auto-CANCELADA (${motivo}) — sem bipadas`);
    return { ok: true, modo: 'cancelada_vazia', pendentes_canceladas: pendentes.length };
  }

  // Fecha com totais das BIPADAS (consistente com o que vai ao Bling)
  const totalKg = bipadas.reduce((a,b) => a + (Number(b.peso) || 0), 0);
  db.prepare(
    `UPDATE sessoes SET fim = ?, total_kg = ?, total_etiquetas = ?, bling_status = 'pendente' WHERE id = ?`
  ).run(agoraISO, totalKg, bipadas.length, sessaoId);
  logI('sessao', `Sessão #${sessaoId} (${sessao.turno_codigo}, op=${sessao.operador||'—'}) auto-FINALIZADA por ${motivo} — ${bipadas.length} bobinas bipadas, ${totalKg.toFixed(1)} kg`);

  const r = await enviarSessaoBling(sessaoId);
  // Carimba a observação adicional pra rastreio (mesmo após envio bem-sucedido)
  if (r.ok) {
    try {
      const erroAdicional = `AUTO-FINALIZADA: ${motivo} - enviado bling_id=${r.bling_id || '?'}`;
      db.prepare(`UPDATE sessoes SET bling_erro = COALESCE(bling_erro, ?) WHERE id = ? AND bling_erro IS NULL`)
        .run(erroAdicional, sessaoId);
    } catch(e) {}
  }
  return { ok: r.ok, modo: 'enviada', bling: r, pendentes_canceladas: pendentes.length };
}


// ──────────────────────────────────────────────────────────────────
// Envio INDIVIDUAL ao Bling pra etiqueta de extrusão.
// Usado quando config bling_extrusao_modo='individual' — cada bipagem
// dispara um pedido próprio. No modo 'lote' (default), usa-se
// enviarSessaoBling no fim do turno (modelo MP).
// Grava bling_pedido_id na etiqueta pra rastreio individual.
// ──────────────────────────────────────────────────────────────────
async function enviarBlingIndividualExtrusao(etiquetaId) {
  const et = dbStmts.getEtiqueta.get(etiquetaId);
  if (!et) return { ok: false, erro: 'Etiqueta não encontrada' };
  if (et.tipo !== 'extrusao') return { ok: false, erro: 'Etiqueta não é de extrusão' };
  if (et.bling_pedido_id) return { ok: true, modo: 'jaEnviado', bling_id: et.bling_pedido_id };

  const simular = configGet('bling_simular', '1') === '1';
  if (simular) {
    const idFake = 99000000000 + Math.floor(Math.random() * 999999);
    db.prepare('UPDATE etiquetas SET bling_pedido_id = ? WHERE id = ?').run(idFake, etiquetaId);
    logI('bling', `Etiqueta ${etiquetaId} — SIMULADA (bling_pedido_id=${idFake})`);
    return { ok: true, modo: 'simulacao', bling_id: idFake };
  }

  try {
    const token = await garantirAcessToken();
    const mapaTurnos  = JSON.parse(configGet('mapa_turno_extrusao', '{}'));
    const mapaBobinas = JSON.parse(configGet('mapa_bobina_bling',   '{}'));
    const turno = mapaTurnos[et.turno_codigo];
    if (!turno) return { ok: false, erro: `Turno "${et.turno_codigo}" sem ID de fornecedor configurado` };
    // Bobina é mapeada por cor|tipo|largura
    const chaveBobina = `${(et.cor||'').toUpperCase()}|${(et.tipo_bobina||'').toUpperCase()}|${et.largura}`;
    const bobina = mapaBobinas[chaveBobina];
    if (!bobina) return { ok: false, erro: `Bobina "${chaveBobina}" sem ID Bling configurado` };

    const hoje = dataLocalISO();
    const linhaMaquina = et.maquina ? `\nPRODUÇÃO ${et.maquina}: ${Number(et.peso).toFixed(1).replace('.', ',')} KG` : '';
    const observacoes  = `OPERADOR: ${et.operador || '—'}${linhaMaquina} · Etiqueta ${et.id}`;
    const body = {
      fornecedor:   { id: Number(turno.fornecedorId) },
      data:         hoje,
      dataPrevista: hoje,
      situacao:     { id: 1 },
      observacoes,
      itens: [{
        produto:    { id: Number(bobina.id) },
        descricao:  bobina.sku,
        quantidade: Number(Number(et.peso).toFixed(3)),
        valor:      1,
      }],
    };

    const r = await proxyChamada(token, 'POST', '/Api/v3/pedidos/compras', '', JSON.stringify(body));
    const respData = (() => { try { return JSON.parse(r.body); } catch(e) { return {}; }})();
    if (r.status >= 200 && r.status < 300 && respData.data?.id) {
      const blingId = respData.data.id;
      db.prepare('UPDATE etiquetas SET bling_pedido_id = ? WHERE id = ?').run(blingId, etiquetaId);
      logI('bling', `Etiqueta ${etiquetaId} — Pedido individual enviado (bling_id=${blingId}, turno=${et.turno_codigo}, ${chaveBobina}, ${et.peso} kg)`);
      return { ok: true, modo: 'real', bling_id: blingId };
    }
    const erro = `HTTP ${r.status} ${r.body.substring(0,300)}`;
    logE('bling', `Etiqueta ${etiquetaId} — falha no envio individual`, { status: r.status, body: r.body.substring(0, 500) });
    return { ok: false, erro };
  } catch(e) {
    logE('bling', `Etiqueta ${etiquetaId} — exceção no envio individual`, { erro: e.message });
    return { ok: false, erro: e.message };
  }
}

// ════════════════════════════════════════════════════════════════════
//  OPERAÇÕES EM VOO — usado só pela atualização remota
// ────────────────────────────────────────────────────────────────────
//  Conta quantas requisições de ESCRITA estão sendo atendidas neste
//  instante e quando terminou a última. Isso inclui o envio ao Bling,
//  porque ele acontece dentro do próprio POST /sessoes/:id/finalizar.
//  Nada disso altera o comportamento das rotas: é só um contador.
// ════════════════════════════════════════════════════════════════════
let OPS_EM_VOO   = 0;
let ULTIMA_OP_MS = 0;

// ════════════════════════════════════════════════════════════════════
//  JANELA SEGURA PARA ATUALIZAR   (usada por POST /sistema/atualizar)
// ────────────────────────────────────────────────────────────────────
//  A trava antiga era "nenhuma sessão aberta". Numa fábrica que roda
//  24h a Extrusão nunca fecha sessão, então aquilo era impossível de
//  satisfazer. O que precisa mesmo de proteção é outra coisa:
//
//   1. NADA IMPRESSO SEM BIPAR. Uma etiqueta em 'aguardando_bipe' é
//      uma bobina física esperando o operador. Reiniciar aí atrapalha
//      a operação.
//
//   2. A LIMPEZA DE STARTUP. limparSessoesOrfas(), ao subir, fecha
//      toda sessão aberta que NÃO tenha nenhuma etiqueta em
//      ('aguardando_bipe','bipada'). Por isso só liberamos a
//      atualização quando CADA sessão aberta já tem ao menos uma
//      etiqueta nesse conjunto: aí o NOT EXISTS dela dá falso e a
//      sessão atravessa o reinício inteira, com tudo que foi bipado.
//
//   3. SILÊNCIO. Nada impresso, bipado ou finalizado nos últimos
//      QUIETO_S segundos.
//
//   4. NADA EM VOO. Zero requisições de escrita sendo atendidas.
//
//  Falhando qualquer uma delas, devolve o motivo e NÃO atualiza.
//  Nenhuma etiqueta é apagada, cancelada ou perdida em nenhum caso:
//  esta função só LÊ o banco.
// ════════════════════════════════════════════════════════════════════
function avaliarJanelaAtualizacao(quietoS) {
  const agora = Date.now();

  const abertas = db.prepare(
    `SELECT id, tipo, turno_codigo, operador, maquina, inicio
       FROM sessoes WHERE fim IS NULL ORDER BY inicio`
  ).all();

  // ── 1 e 2: estado de cada sessão aberta ──
  const semBipada = [];
  let aguardando  = 0;
  for (const s of abertas) {
    const c = db.prepare(
      `SELECT
         SUM(CASE WHEN status = 'aguardando_bipe' THEN 1 ELSE 0 END) AS pendentes,
         SUM(CASE WHEN status IN ('aguardando_bipe','bipada') THEN 1 ELSE 0 END) AS vivas
       FROM etiquetas WHERE sessao_id = ?`
    ).get(s.id);
    aguardando += (c && c.pendentes) || 0;
    if (((c && c.vivas) || 0) === 0) semBipada.push(s);
  }

  if (aguardando > 0) {
    return { pode: false, regra: 'aguardando_bipe', abertas,
      motivo: `Há ${aguardando} etiqueta(s) impressa(s) esperando bipe. Bipe ou cancele antes de atualizar.` };
  }
  if (semBipada.length) {
    return { pode: false, regra: 'sessao_sem_bipada', abertas, sessoes_sem_bipada: semBipada,
      motivo: `Há ${semBipada.length} sessão(ões) aberta(s) sem nenhuma etiqueta bipada — o reinício fecharia essa(s) sessão(ões). Espere a primeira bipagem.` };
  }

  // ── 3: silêncio ──
  const u = db.prepare(`SELECT MAX(hora_impressao) AS imp, MAX(hora_bipagem) AS bip FROM etiquetas`).get();
  const f = db.prepare(`SELECT MAX(fim) AS fim FROM sessoes`).get();
  let ultimoMs = ULTIMA_OP_MS;
  for (const t of [u && u.imp, u && u.bip, f && f.fim]) {
    if (!t) continue;
    const ms = Date.parse(t);
    if (!isNaN(ms) && ms > ultimoMs) ultimoMs = ms;
  }
  const paradoS = ultimoMs ? Math.round((agora - ultimoMs) / 1000) : 999999;
  if (paradoS < quietoS) {
    return { pode: false, regra: 'movimento', abertas, parado_s: paradoS, silencio_exigido_s: quietoS,
      motivo: `A estação teve movimento há ${paradoS}s. Preciso de ${quietoS}s de silêncio para atualizar com segurança.` };
  }

  // ── 4: nada em voo ──
  if (OPS_EM_VOO > 0) {
    return { pode: false, regra: 'em_voo', abertas, em_voo: OPS_EM_VOO,
      motivo: `Há ${OPS_EM_VOO} operação(ões) sendo atendida(s) agora mesmo.` };
  }

  return { pode: true, regra: 'ok', abertas, parado_s: paradoS, motivo: 'janela aberta' };
}

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
    // ─── HEALTHCHECK / STATUS ───
    // POST /log/producao  (compat com Extrusão antigo — grava CSV em logs/producao/)
    // Body: { data, hora, operador, turno, maquina, cor, largura, espessura,
    //         pesoBruto, tara, pesoLiq, sku, seq, blingPedido, status }
    // Também é replicado no JSONL durável de MP via logI('print', ...).
    if (pathname === '/log/producao' && req.method === 'POST') {
      let body;
      try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
      try {
        const dir = path.join(LOG_DIR, 'producao');
        ensureDir(dir);
        const fpath = path.join(dir, `${dataLocalISO()}.csv`);
        const novoArq = !fs.existsSync(fpath);
        const cabecalho = 'data;hora;operador;turno;maquina;cor;largura;espessura;pesoBruto;tara;pesoLiq;sku;seq;blingPedido;status\n';
        const linha = [
          body.data, body.hora, body.operador, body.turno, body.maquina,
          body.cor, body.largura, body.espessura,
          body.pesoBruto, body.tara, body.pesoLiq,
          body.sku, body.seq, body.blingPedido, body.status,
        ].map(v => v == null ? '' : String(v).replace(/[;\r\n]/g, ' ')).join(';') + '\n';
        const conteudo = (novoArq ? cabecalho : '') + linha;
        // fsync explícito pra durabilidade (mesma técnica do log MP)
        let fd = null;
        try {
          fd = fs.openSync(fpath, 'a');
          fs.writeSync(fd, conteudo, null, 'utf8');
          fs.fsyncSync(fd);
        } finally {
          if (fd !== null) { try { fs.closeSync(fd); } catch(e) {} }
        }
        // Log MP também (formato estruturado, durável)
        logI('print', `Linha de produção registrada: ${body.sku || '—'} · ${body.pesoLiq || '?'} kg · turno ${body.turno || '—'}`, body);
        return jsonOk(res, { gravado: true, arquivo: path.basename(fpath) });
      } catch(e) {
        return jsonErr(res, 500, 'Falha ao gravar log: ' + e.message);
      }
    }

    // ══════════════════════════════════════════════════════════════
    //  DASHBOARD DE EXTRUSÃO (acompanhamento em tempo real)
    // ══════════════════════════════════════════════════════════════
    //
    // GET /extrusao/dashboard[?dia=YYYY-MM-DD]
    //
    // Retorna agregações do dia (default: hoje). Pensado pra ser
    // consumido por uma UI de dashboard via polling a cada N segundos.
    //
    // Cancelados ficam de fora de TODOS os agregados (mas aparecem na
    // lista bruta `bobinas` com status='cancelada' pra auditoria).
    if (pathname === '/extrusao/dashboard' && req.method === 'GET') {
      const dia = parsed.query.dia || dataLocalISO();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) return jsonErr(res, 400, 'dia deve ser YYYY-MM-DD');

      const { ini: _ini, fim: _fim } = rangeUTCdoDiaLocal(dia);

      const etiquetas = db.prepare(
        `SELECT id, seq_sessao, hora_impressao, hora_bipagem, turno_codigo,
                operador, maquina, cor, tipo_bobina, largura, sku,
                peso, peso_bruto, tara, status, sessao_id, bling_pedido_id
         FROM etiquetas
         WHERE tipo = 'extrusao' AND hora_impressao >= ? AND hora_impressao < ?
         ORDER BY hora_impressao DESC`
      ).all(_ini, _fim);

      const sessoes = db.prepare(
        `SELECT id, tipo, turno_codigo, operador, maquina, inicio, fim,
                total_kg, total_etiquetas, bling_status, bling_id, bling_erro
         FROM sessoes
         WHERE tipo = 'extrusao'
           AND ( (inicio >= ? AND inicio < ?) OR (fim >= ? AND fim < ?) )
         ORDER BY inicio DESC`
      ).all(_ini, _fim, _ini, _fim);

      const validas = etiquetas.filter(e => e.status !== 'cancelada');

      // Totais gerais
      const totais = {
        bobinas:            validas.length,
        kg_total:           Number(validas.reduce((a,b) => a + (b.peso || 0), 0).toFixed(2)),
        bipadas:            validas.filter(e => e.status === 'bipada').length,
        aguardando_bipe:    validas.filter(e => e.status === 'aguardando_bipe').length,
        canceladas:         etiquetas.length - validas.length,
        kg_bipados:         Number(validas.filter(e=>e.status==='bipada').reduce((a,b)=>a+(b.peso||0),0).toFixed(2)),
      };

      // Por turno (agrupa sessões do dia)
      const porTurno = {};
      for (const s of sessoes) {
        const tc = s.turno_codigo || '—';
        if (!porTurno[tc]) porTurno[tc] = { turno_codigo: tc, sessoes: [], totais: { bobinas: 0, kg: 0 } };
        const eDaSes = etiquetas.filter(e => e.sessao_id === s.id && e.status !== 'cancelada');
        const kg = Number(eDaSes.reduce((a,b) => a + (b.peso||0), 0).toFixed(2));
        porTurno[tc].sessoes.push({
          id: s.id, operador: s.operador, maquina: s.maquina,
          inicio: s.inicio, fim: s.fim,
          bobinas: eDaSes.length, kg,
          bling_status: s.bling_status, bling_id: s.bling_id, bling_erro: s.bling_erro,
          auto_finalizada: !!(s.bling_erro && s.bling_erro.startsWith('AUTO-')),
          aberta: s.fim == null,
        });
        porTurno[tc].totais.bobinas += eDaSes.length;
        porTurno[tc].totais.kg = Number((porTurno[tc].totais.kg + kg).toFixed(2));
      }

      // Por máquina
      const porMaquina = {};
      for (const e of validas) {
        const m = e.maquina || '—';
        if (!porMaquina[m]) porMaquina[m] = { maquina: m, bobinas: 0, kg: 0 };
        porMaquina[m].bobinas++;
        porMaquina[m].kg = Number((porMaquina[m].kg + (e.peso || 0)).toFixed(2));
      }

      // Por produto (cor|tipo|largura)
      const porProduto = {};
      for (const e of validas) {
        const k = `${e.cor||'?'}|${e.tipo_bobina||'?'}|${e.largura||'?'}`;
        if (!porProduto[k]) {
          porProduto[k] = { cor: e.cor, tipo_bobina: e.tipo_bobina, largura: e.largura, sku: e.sku, bobinas: 0, kg: 0 };
        }
        porProduto[k].bobinas++;
        porProduto[k].kg = Number((porProduto[k].kg + (e.peso || 0)).toFixed(2));
      }

      // Por hora do dia (0-23)
      const porHora = {};
      for (const e of validas) {
        const h = new Date(e.hora_impressao).getHours();
        const hStr = String(h).padStart(2, '0');
        if (!porHora[hStr]) porHora[hStr] = { hora: hStr, bobinas: 0, kg: 0 };
        porHora[hStr].bobinas++;
        porHora[hStr].kg = Number((porHora[hStr].kg + (e.peso || 0)).toFixed(2));
      }

      return jsonOk(res, {
        dia,
        gerado_em:   new Date().toISOString(),
        totais,
        por_turno:   Object.values(porTurno),
        por_maquina: Object.values(porMaquina).sort((a,b) => a.maquina.localeCompare(b.maquina)),
        por_produto: Object.values(porProduto).sort((a,b) => b.kg - a.kg),
        por_hora:    Object.values(porHora).sort((a,b) => a.hora.localeCompare(b.hora)),
        bobinas:     etiquetas,   // bruta, ordenada por hora desc; UI filtra/pagina
      });
    }

    // GET /extrusao/export.csv[?dia=YYYY-MM-DD]
    // CSV completo on-the-fly com dados FRESCOS (status atual + bipagem + bling_id).
    // Útil pra Excel/Power BI. Difere do CSV append-only de logs/extrusao/.
    if (pathname === '/extrusao/export.csv' && req.method === 'GET') {
      const dia = parsed.query.dia || dataLocalISO();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) return jsonErr(res, 400, 'dia deve ser YYYY-MM-DD');

      const { ini: _iniCsv, fim: _fimCsv } = rangeUTCdoDiaLocal(dia);
      const etiquetas = db.prepare(
        `SELECT * FROM etiquetas
         WHERE tipo = 'extrusao' AND hora_impressao >= ? AND hora_impressao < ?
         ORDER BY hora_impressao ASC`
      ).all(_iniCsv, _fimCsv);

      const safe = v => v == null ? '' : String(v).replace(/[;\r\n]/g, ' ');
      const cabecalho = 'data;hora_imp;hora_bip;id;seq_sessao;turno;operador;maquina;cor;tipo;largura;sku;peso_liq;peso_bruto;tara;sessao_id;status;bling_pedido_id\n';
      const linhas = etiquetas.map(e => {
        const dt = new Date(e.hora_impressao);
        const data = dt.toISOString().slice(0,10);
        const hora = dt.toLocaleTimeString('pt-BR', { hour12: false });
        const horaBip = e.hora_bipagem ? new Date(e.hora_bipagem).toLocaleTimeString('pt-BR', { hour12: false }) : '';
        return [
          data, hora, horaBip, e.id, e.seq_sessao,
          e.turno_codigo, e.operador, e.maquina,
          e.cor, e.tipo_bobina, e.largura, e.sku,
          e.peso, e.peso_bruto, e.tara,
          e.sessao_id, e.status, e.bling_pedido_id,
        ].map(safe).join(';');
      });

      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="extrusao_${dia}.csv"`);
      // BOM UTF-8 pra Excel reconhecer acentos sem precisar mudar encoding
      res.end('\uFEFF' + cabecalho + linhas.join('\n') + (linhas.length ? '\n' : ''));
      return;
    }

    if (pathname === '/healthcheck' || pathname === '/status') {
      const counts = {
        etiquetas: db.prepare('SELECT COUNT(*) AS n FROM etiquetas').get().n,
        sessoes:   db.prepare('SELECT COUNT(*) AS n FROM sessoes').get().n,
        pendentes_bling: db.prepare(`SELECT COUNT(*) AS n FROM sessoes WHERE bling_status IN ('pendente','pendente_config','erro')`).get().n,
      };
      return jsonOk(res, {
        servidor: 'online',
        versao: VERSION,
        commit: commitAtual(),
        impressora: PRINTER_DETECTADA ? PRINTER_ATIVA : null,    // A6: null se não detectada
        impressora_detectada: PRINTER_DETECTADA,
        impressao_simulada: !PRINTER_DETECTADA || configGet('print_simular', '0') === '1',
        printer: PRINTER_DETECTADA ? PRINTER_ATIVA : null,       // alias
        proximoSeq: {                                       // compatibilidade com HTML antigo
          recebimento: getProximoSeq('recebimento'),
          retorno:     getProximoSeq('retorno'),
          retirada:    getProximoSeq('retirada'),
          outras:      getProximoSeq('outras'),
        },
        totalEtiquetas: counts.etiquetas,                   // alias
        balanca:   { portaAberta: balanca.portaAberta, recebendo: balancaRecebendo(), ultimoPeso: balanca.ultimoPeso, estavel: balanca.pesoEstavel, bytesTotal: balanca.bytesTotal },
        bling:     { autenticado: !!(tk.accessToken || tk.refreshToken), token_expira_em_s: tk.expiresAt ? Math.max(0, Math.round((tk.expiresAt - Date.now())/1000)) : null, simulacao: configGet('bling_simular', '1') === '1' },
        banco:     counts,
      });
    }

    // ─── BLING: OAuth start ───
    // Bling exige o parâmetro 'state' (não pode ser vazio).
    // Guardamos o state em config pra validar quando o callback voltar.
    if (pathname === '/bling/auth/start') {
      const state = crypto.randomBytes(16).toString('hex');
      configSet('oauth_state', state);
      configSet('oauth_state_at', String(Date.now()));
      const authUrl = `https://${BLING_HOST}/Api/v3/oauth/authorize?response_type=code&client_id=${encodeURIComponent(CLIENT_ID)}&state=${state}`;
      logI('bling', `OAuth iniciado — state=${state.substring(0,8)}...`);
      return jsonOk(res, { authUrl, state });
    }

    // ─── BLING: callback (alternativa, se usar /bling/callback em vez de :8888) ───
    if (pathname === '/bling/callback') {
      const { code, error, state } = parsed.query;
      const html = (ok, msg) => `<html><body style="font-family:sans-serif;padding:40px;background:#0d0f14;color:${ok?'#00ff9d':'#ff4466'}">
        <h2>${ok ? '✓ Bling autenticado!' : '❌ Erro'}</h2><p>${msg}</p>
        ${ok ? '<script>setTimeout(()=>window.close(),2000)</script>' : '<p><a href="/" style="color:#00d4ff">Voltar</a></p>'}
        </body></html>`;
      if (error || !code) { res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'}); return res.end(html(false, error||'sem código')); }
      const stateEsperado = configGet('oauth_state', null);
      if (stateEsperado && state !== stateEsperado) {
        logW('bling', `State inválido no callback`, { esperado: stateEsperado?.substring(0,8), recebido: state?.substring(0,8) });
        res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});
        return res.end(html(false, 'state inválido (possível CSRF ou sessão antiga)'));
      }
      try { await trocarCodigo(code); res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'}); return res.end(html(true, 'Pode fechar.')); }
      catch(e) { res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'}); return res.end(html(false, e.message)); }
    }

    // ─── BLING: status ───
    if (pathname === '/bling/status') {
      return jsonOk(res, {
        autenticado: !!(tk.accessToken || tk.refreshToken),
        expirado:    tk.expiresAt > 0 && Date.now() >= tk.expiresAt,
        temRefresh:  !!tk.refreshToken,
        tokenInvalido: _tokenInvalido,
      });
    }

    // ─── SISTEMA: encerrar o quiosque de forma limpa ───
    // POST /sistema/encerrar
    // Fecha o navegador do quiosque e encerra o próprio servidor. Cria o
    // arquivo-sinal 'eko-encerrar.flag' — o INICIAR.bat vê esse arquivo e NÃO
    // reabre (sem ele, o loop de auto-recuperação reabriria o servidor em 5s).
    // Usado pelo botão "Fechar agora" da caixa de saída: window.close() não
    // funciona em janela Chrome --app (não foi aberta por script).
    if (pathname === '/sistema/encerrar' && req.method === 'POST') {
      jsonOk(res, { encerrando: true });
      logI('sistema', 'Encerramento solicitado pela tela — fechando navegador e servidor.');
      setTimeout(() => {
        try { fs.writeFileSync(path.join(__dirname, 'eko-encerrar.flag'), String(Date.now())); } catch (e) {}
        if (process.platform === 'win32') {
          try {
            const { spawn } = require('child_process');
            // Fecha as janelas do navegador do quiosque (Chrome e o fallback Edge).
            spawn('taskkill', ['/IM', 'chrome.exe', '/F'], { detached: true, stdio: 'ignore' }).unref();
            spawn('taskkill', ['/IM', 'msedge.exe', '/F'], { detached: true, stdio: 'ignore' }).unref();
          } catch (e) {}
        }
        setTimeout(() => process.exit(0), 700);
      }, 200);
      return;
    }

    // ─── POST /sistema/atualizar  { senha } ───
    // Dispara, a partir de OUTRA máquina na rede, a atualização do código a
    // partir do GitHub. Quem executa o git NÃO é este processo: ele apenas
    // grava a bandeira e sai. O INICIAR.bat já é um laço supervisor que
    // reinicia o node — ele vê a bandeira, aplica o git e sobe de novo.
    // Isso evita SSH, tarefa agendada e credencial de Windows guardada.
    //
    // Travas, nesta ordem:
    //   1. senha de supervisor (a mesma da trava de saída das telas)
    //   2. janela segura — ver avaliarJanelaAtualizacao() lá em cima:
    //      nada esperando bipe, toda sessão aberta já com etiqueta viva
    //      (à prova da limpeza de startup), silêncio e nada em voo
    //   3. segunda conferência depois de uma pausa: se um comando da
    //      operação chegar nesse meio-tempo, o operador ganha
    //   4. o próprio git: merge --ff-only nunca inventa merge
    //
    //  Sessão aberta NÃO impede mais a atualização — a Extrusão roda
    //  24h e nunca teria sessão fechada. O que impede é trabalho no ar.
    if (pathname === '/sistema/atualizar' && req.method === 'POST') {
      let body;
      try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }

      const hashAtual = configGet('senha_saida_hash', hashSenha('1234'));
      if (hashSenha((body && body.senha) || '') !== hashAtual) {
        logDesvio({ tipo: 'tentativa_atualizacao_senha_incorreta', tela: 'remoto',
                    detalhe: 'senha incorreta em /sistema/atualizar' });
        return jsonErr(res, 401, 'Senha de supervisor incorreta.');
      }

      const QUIETO_S = Math.max(10, parseInt(configGet('atualizar_silencio_s', '45'), 10) || 45);

      const janela = avaliarJanelaAtualizacao(QUIETO_S);
      if (!janela.pode) {
        logW('sistema', `Atualização adiada: ${janela.motivo}`);
        return jsonErr(res, 409, janela.motivo, { janela, tente_de_novo: true });
      }

      // Pausa curta e segunda conferência. Se qualquer comando da
      // operação chegar aqui no meio, ele ganha: a atualização é
      // adiada e NADA acontece na estação.
      await new Promise(r => setTimeout(r, 1200));
      const confirma = avaliarJanelaAtualizacao(QUIETO_S);
      if (!confirma.pode) {
        logW('sistema', `Atualização adiada na conferência final: ${confirma.motivo}`);
        return jsonErr(res, 409,
          'Chegou operação bem na hora — atualização adiada. Nada foi alterado na estação.',
          { janela: confirma, tente_de_novo: true });
      }

      const pend = db.prepare(
        `SELECT COUNT(*) AS n FROM sessoes WHERE bling_status IN ('pendente','pendente_config','erro')`
      ).get().n;

      // A bandeira é gravada ANTES de responder: se não der para
      // gravar, ninguém encerra e a estação segue exatamente como está.
      try {
        fs.writeFileSync(path.join(__dirname, 'eko-atualizar.flag'), String(Date.now()));
      } catch (e) {
        logE('sistema', 'Não consegui gravar eko-atualizar.flag — atualização cancelada', { erro: e.message });
        return jsonErr(res, 500, 'Não consegui gravar a bandeira de atualização. Nada foi alterado.');
      }

      jsonOk(res, {
        atualizando: true,
        versao_atual: VERSION,
        commit_atual: commitAtual(),
        pendentes_bling: pend,
        parado_s: confirma.parado_s,
        sessoes_abertas: confirma.abertas.length,
        sessoes_preservadas: confirma.abertas.map(s => ({
          id: s.id, tipo: s.tipo, turno_codigo: s.turno_codigo, operador: s.operador,
        })),
        aviso: 'O servidor vai encerrar e voltar em alguns segundos. As sessões abertas continuam abertas, com tudo que já foi bipado.',
      });
      logI('sistema', `Atualização remota autorizada — ${confirma.abertas.length} sessão(ões) aberta(s) preservada(s); estação parada há ${confirma.parado_s}s.`);
      setTimeout(() => process.exit(0), 400);
      return;
    }

    // ─── SEGURANÇA: trava de saída por senha de supervisor ───
    // POST /seguranca/validar-saida { senha, tela }
    // Valida a senha numérica. Se correta → {ok:true}. Se incorreta →
    // registra a tentativa no log de desvios (com tela e hora) → {ok:false}.
    if (pathname === '/seguranca/validar-saida' && req.method === 'POST') {
      let body;
      try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
      const tela = body.tela || 'desconhecida';
      const hashAtual = configGet('senha_saida_hash', hashSenha('1234'));   // default inicial: 1234
      if (hashSenha(body.senha || '') === hashAtual) {
        logI('seguranca', `Saída autorizada em ${tela}`);
        return jsonOk(res, { ok: true });
      }
      logDesvio({ tipo: 'tentativa_saida_senha_incorreta', tela, detalhe: 'senha de saída incorreta' });
      return jsonOk(res, { ok: false });
    }

    // POST /seguranca/definir-senha { senhaAtual, novaSenha }
    // Troca a senha de saída. Exige a senha atual (default inicial: 1234).
    if (pathname === '/seguranca/definir-senha' && req.method === 'POST') {
      let body;
      try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
      const hashAtual = configGet('senha_saida_hash', hashSenha('1234'));
      if (hashSenha(body.senhaAtual || '') !== hashAtual) {
        logDesvio({ tipo: 'troca_senha_negada', tela: 'config', detalhe: 'senha atual incorreta' });
        return jsonErr(res, 403, 'Senha atual incorreta');
      }
      const nova = String(body.novaSenha || '');
      if (!/^\d{4,8}$/.test(nova)) return jsonErr(res, 400, 'A nova senha deve ter de 4 a 8 dígitos');
      configSet('senha_saida_hash', hashSenha(nova));
      logI('seguranca', 'Senha de saída alterada');
      return jsonOk(res, { ok: true });
    }

    // GET /seguranca/desvios[?mes=YYYY-MM] — lista tentativas registradas
    if (pathname === '/seguranca/desvios' && req.method === 'GET') {
      const mes = parsed.query.mes || (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; })();
      const arq = path.join(LOG_DIR, `desvios-${mes}.jsonl`);
      let registros = [];
      try {
        if (fs.existsSync(arq)) {
          registros = fs.readFileSync(arq, 'utf8').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch(e) { return null; } }).filter(Boolean);
        }
      } catch(e) {}
      return jsonOk(res, { mes, total: registros.length, registros });
    }

    // ─── BALANÇA ───
    // GET /balanca/portas — lista as portas COM disponíveis no sistema.
    // Útil pra descobrir em qual porta a balança está ligada (ex: ao mudar
    // de máquina). Mostra qual é a porta atualmente configurada (SERIAL_PORT).
    if (pathname === '/balanca/portas' && req.method === 'GET') {
      let SerialPort;
      try { ({ SerialPort } = require('serialport')); }
      catch(e) { return jsonErr(res, 500, 'Módulo serialport indisponível'); }
      try {
        const lista = await SerialPort.list();
        const portas = lista.map(p => ({
          porta: p.path,
          fabricante: p.manufacturer || null,
          numeroSerie: p.serialNumber || null,
          pnpId: p.pnpId || null,
          configurada: p.path === SERIAL_PORT,
        }));
        return jsonOk(res, { porta_configurada: SERIAL_PORT, baud: SERIAL_BAUD, portas });
      } catch(e) {
        return jsonErr(res, 500, 'Falha ao listar portas: ' + e.message);
      }
    }
    if (pathname === '/balanca/raw' && req.method === 'GET') {
      return jsonOk(res, {
        raw: balanca.ultimoRaw, peso: balanca.ultimoPeso, porta: SERIAL_PORT,
        portaAberta: balanca.portaAberta, recebendo: balancaRecebendo(), pesoEstavel: balanca.pesoEstavel,
        bytesTotal: balanca.bytesTotal, ultimoByteTs: balanca.ultimoByteTs,
      });
    }
    if (pathname === '/balanca/peso' && req.method === 'GET') {
      return jsonOk(res, { peso: balanca.ultimoPeso, estavel: balanca.pesoEstavel, portaAberta: balanca.portaAberta });
    }

    // ─── IMPRESSORAS ───
    if (pathname === '/impressoras' && req.method === 'GET') {
      return detectarImpressora((match, installed) => {
        jsonOk(res, { ativa: match || PRINTER_ATIVA, candidates: PRINTER_NAMES, installed });
      });
    }
    if (pathname === '/impressora/redetectar' && req.method === 'POST') {
      return detectarImpressora((match, installed) => {
        if (match) { PRINTER_ATIVA = match; PRINTER_DETECTADA = true; logI('print', `Re-detecção: ATIVA = ${PRINTER_ATIVA}`); jsonOk(res, { printer: PRINTER_ATIVA, installed }); }
        else jsonErr(res, 404, 'Nenhuma impressora conhecida encontrada', { candidates: PRINTER_NAMES, installed });
      });
    }

    // ─── ETIQUETAS ───
    // GET /proximo-seq?tipo=recebimento|retorno|retirada
    if (pathname === '/proximo-seq' && req.method === 'GET') {
      const tipo = parsed.query.tipo;
      if (!['recebimento','retorno','retirada'].includes(tipo)) return jsonErr(res, 400, 'tipo inválido');
      return jsonOk(res, { tipo, seq: getProximoSeq(tipo) });
    }

    // GET /etiqueta/:id  e  GET /etiquetas/:id  (compatibilidade)
    let m;
    if ((m = pathname.match(/^\/etiquetas?\/([RTSEOP]\d+)$/)) && req.method === 'GET') {
      const et = dbStmts.getEtiqueta.get(m[1]);
      if (!et) return jsonErr(res, 404, `Etiqueta ${m[1]} não encontrada`);
      return jsonOk(res, { etiqueta: et });
    }

    // POST /etiqueta/:id/bipar
    if ((m = pathname.match(/^\/etiquetas?\/([RTSEO]\d+)\/bipar$/)) && req.method === 'POST') {
      const et = dbStmts.getEtiqueta.get(m[1]);
      if (!et) return jsonErr(res, 404, `Etiqueta ${m[1]} não encontrada`);

      // ── TRAVA 1: bipagem duplicada (EXTRUSÃO) ────────────────────────
      // Até aqui o /bipar não olhava o status. Consequências reais, vistas
      // no turno de 30/08/2026:
      //   · bipar de novo uma já bipada reescrevia hora_bipagem, gravava
      //     outra linha no CSV de produção e, no modo 'individual',
      //     disparava um SEGUNDO pedido no Bling;
      //   · bipar uma CANCELADA a trazia de volta para 'bipada' — foi o que
      //     aconteceu às 14:55:19 com a E0001292, cancelada às 14:55:05.
      // Agora só 'aguardando_bipe' passa. Escopo: extrusão, conforme
      // definido com o Frederico. MP/PA seguem como antes.
      if (et.tipo === 'extrusao' && et.status !== 'aguardando_bipe') {
        const quando = et.hora_bipagem
          ? new Date(et.hora_bipagem).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
          : null;
        let motivo;
        if (et.status === 'bipada') {
          motivo = `A bobina ${et.id} já foi bipada${quando ? ' em ' + quando : ''}. Ela já está contada — não bipe de novo.`;
        } else if (et.status === 'cancelada') {
          motivo = `A bobina ${et.id} foi CANCELADA e não volta atrás. Se a bobina é boa, pese e imprima uma etiqueta nova.`;
        } else {
          motivo = `A bobina ${et.id} está com status "${et.status}" e não pode ser bipada.`;
        }
        logDesvio({
          tipo: 'bipagem_recusada_' + et.status,
          tela: 'extrusao',
          detalhe: `${et.id} · maquina ${et.maquina || '—'} · turno ${et.turno_codigo || '—'} · sessao ${et.sessao_id || '—'}`,
        });
        return jsonErr(res, 409, motivo, {
          etiqueta_id: et.id, status: et.status, ja_bipada_em: et.hora_bipagem || null,
          trava: 'bipagem_duplicada',
        });
      }

      dbStmts.marcarBipada.run('bipada', new Date().toISOString(), m[1]);

      // v52: registra a bipagem no log de produção (CSV por área, p/ dashboard)
      gravarLogProducaoBipagem(et);

      // Etiqueta de extrusão em modo individual → dispara pedido Bling agora
      if (et.tipo === 'extrusao') {
        const modo = configGet('bling_extrusao_modo', 'individual');
        if (modo === 'individual') {
          const r = await enviarBlingIndividualExtrusao(m[1]);
          return jsonOk(res, {
            etiqueta: dbStmts.getEtiqueta.get(m[1]),
            bling:    r,
          });
        }
        // modo 'lote' → não envia agora, espera finalizar sessão (igual MP)
      }

      return jsonOk(res, { etiqueta: dbStmts.getEtiqueta.get(m[1]) });
    }

    // POST /etiqueta/:id/cancelar
    if ((m = pathname.match(/^\/etiquetas?\/([RTSEOP]\d+)\/cancelar$/)) && req.method === 'POST') {
      const et = dbStmts.getEtiqueta.get(m[1]);
      dbStmts.marcarCancelada.run('cancelada', m[1]);
      // Registra o cancelamento no CSV de produção (evento=cancelamento): como a
      // etiqueta permanece no banco, essa linha sinaliza que o item foi excluído.
      if (et) { try { gravarLogProducaoBipagem(et, 'cancelamento'); } catch(e) {} }
      // B4: se a etiqueta pertencia a uma sessão já fechada, recalcula os
      // totais pra que o histórico continue batendo com as etiquetas válidas.
      if (et && et.sessao_id) recalcularTotaisSessao(et.sessao_id);
      return jsonOk(res, {});
    }

    // POST /etiqueta/:id/consumir — usado na RETIRADA
    // Body: { sessao_id: int }
    // Bloqueia se a etiqueta já estiver consumida (retorna 409 com data/hora original).
    // Cria uma "etiqueta virtual" de retirada (tipo='retirada', ref_id apontando pra original),
    // marca a original como status='consumida', e vincula a virtual à sessão.
    if ((m = pathname.match(/^\/etiquetas?\/([RTSEO]\d+)\/consumir$/)) && req.method === 'POST') {
      const origId = m[1];
      let body;
      try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
      const sessaoIdRet = parseInt(body.sessao_id);
      if (!sessaoIdRet) return jsonErr(res, 400, 'sessao_id obrigatório');
      const sessao = dbStmts.getSessao.get(sessaoIdRet);
      if (!sessao) return jsonErr(res, 404, 'Sessão não encontrada');
      if (sessao.tipo !== 'retirada') return jsonErr(res, 400, `Sessão #${sessaoIdRet} não é de retirada (tipo=${sessao.tipo})`);

      const orig = dbStmts.getEtiqueta.get(origId);
      if (!orig) return jsonErr(res, 404, `Etiqueta ${origId} não encontrada`);
      if (orig.status === 'cancelada') return jsonErr(res, 400, `Etiqueta ${origId} está cancelada`);
      if (orig.status === 'consumida') {
        // Já consumida — MAS se o consumo foi estornado/cancelado, a etiqueta
        // está livre de novo e pode ser bipada normalmente. Só bloqueia se
        // existir um consumo ATIVO (não cancelado).
        const consumoAtivo = db.prepare(`SELECT id, hora_impressao FROM etiquetas WHERE tipo='retirada' AND ref_id = ? AND status != 'cancelada' ORDER BY hora_impressao DESC LIMIT 1`).get(origId);
        if (consumoAtivo) {
          return jsonErr(res, 409, `Etiqueta ${origId} já foi retirada`, {
            ja_consumida: true,
            etiqueta: orig,
            consumo: consumoAtivo,
          });
        }
        // Sem consumo ativo (foi estornado) → segue o fluxo normal e consome de
        // novo (cria nova virtual). A original será re-marcada 'consumida' abaixo.
      }
      // status === 'aguardando_bipe' ou 'bipada' — pode consumir

      // Cria etiqueta virtual de retirada
      const seqRet = getProximoSeq('retirada');
      const idVirt = 'S' + String(seqRet).padStart(7, '0');
      const seqSessaoRet = proximoSeqSessao(sessaoIdRet);
      const tr = makeTransaction(() => {
        dbStmts.insertEtiqueta.run({
          id:             idVirt,
          seq:            seqRet,
          seq_sessao:     seqSessaoRet,
          tipo:           'retirada',
          sub_tipo:       'graos-bipados',
          material_key:   orig.material_key,
          material_nome:  orig.material_nome,
          material_label: orig.material_label,
          cor:            orig.cor,
          fornecedor:     orig.fornecedor,
          lote:           orig.lote,
          peso:           orig.peso,                 // mesmo peso da original (palete inteiro)
          qtd_sacos:      null,
          codigo:         orig.codigo,
          sku:            orig.sku,
          status:         'bipada',                  // já entra bipada (registro válido)
          ref_id:         origId,                    // aponta pra etiqueta original consumida
          hora_impressao: new Date().toISOString(),
          sessao_id:      sessaoIdRet,
          impressora:     null,
          operador:       null, maquina: null, largura: null, tipo_bobina: null,
          turno_codigo:   null, peso_bruto: null, tara: null,
        });
        incrementaSeq('retirada', seqRet);
        // Marca a original como consumida
        db.prepare(`UPDATE etiquetas SET status = 'consumida', hora_bipagem = ? WHERE id = ?`)
          .run(new Date().toISOString(), origId);
      });
      tr();
      logI('retirada', `Consumida ${origId} → ${idVirt} (sessão #${sessaoIdRet})`, {
        material: orig.material_key, peso: orig.peso, fornecedor: orig.fornecedor
      });
      // Registra a retirada no log de produção (CSV materia-prima) — a virtual
      // nasce 'bipada' e não passa pelo /bipar, então registramos aqui.
      try { gravarLogProducaoBipagem(dbStmts.getEtiqueta.get(idVirt)); } catch(e) {}
      return jsonOk(res, {
        etiqueta_consumida: origId,
        etiqueta_virtual:   dbStmts.getEtiqueta.get(idVirt),
      });
    }

    // POST /etiquetas/:id/estornar
    // Estorna UM item de retirada (etiqueta virtual 'S'): cancela a virtual e,
    // se ela consumiu uma etiqueta original (ref_id), devolve a original para
    // 'bipada' (apta a ser bipada de novo). Aditivos contados (sem ref_id) só
    // são cancelados. Idempotente.
    if ((m = pathname.match(/^\/etiquetas?\/([RTSEO]\d+)\/estornar$/)) && req.method === 'POST') {
      const virtId = m[1];
      const v = dbStmts.getEtiqueta.get(virtId);
      if (!v) return jsonErr(res, 404, `Item ${virtId} não encontrado`);
      if (v.tipo !== 'retirada') return jsonErr(res, 400, `Item ${virtId} não é uma retirada (tipo=${v.tipo})`);
      const original = v.ref_id ? dbStmts.getEtiqueta.get(v.ref_id) : null;
      const tr = makeTransaction(() => {
        // Cancela a virtual (some da retirada e do Bling)
        if (v.status !== 'cancelada') {
          db.prepare(`UPDATE etiquetas SET status = 'cancelada' WHERE id = ?`).run(virtId);
        }
        // Devolve a etiqueta original consumida para 'bipada' (apta a bipar)
        if (v.ref_id) {
          db.prepare(`UPDATE etiquetas SET status = 'bipada', hora_bipagem = NULL WHERE id = ? AND status = 'consumida'`).run(v.ref_id);
        }
      });
      tr();
      logI('retirada', `Estorno ${virtId}${v.ref_id ? ' → liberou ' + v.ref_id : ''} (sessão #${v.sessao_id})`);
      return jsonOk(res, {
        estornada:          virtId,
        original_liberada:  v.ref_id || null,
        original:           v.ref_id ? dbStmts.getEtiqueta.get(v.ref_id) : null,
      });
    }

    // POST /etiquetas/:id/reimprimir — reimprime uma etiqueta JÁ EXISTENTE com o
    // MESMO número, sem criar nova nem alterar status. Uso: quando o código de
    // barras impresso saiu fraco/borrado e não lê no leitor — tira uma cópia nova.
    if ((m = pathname.match(/^\/etiquetas?\/([RTSEO]\d+)\/reimprimir$/)) && req.method === 'POST') {
      const idRe = m[1];
      const et = dbStmts.getEtiqueta.get(idRe);
      if (!et) return jsonErr(res, 404, `Etiqueta ${idRe} não encontrada`);
      if (et.status === 'cancelada') return jsonErr(res, 400, `Etiqueta ${idRe} está cancelada — não faz sentido reimprimir`);
      // Reconstrói os dados a partir do que foi salvo, para gerar o MESMO EPL.
      const dadosRe = {
        tipo:           et.tipo,
        material_nome:  et.material_nome,
        materialNomeEt: et.material_nome,
        cor:            et.cor,
        peso:           et.peso,
        codigo:         et.codigo,
        sku:            et.sku,
        lote:           et.lote,
        fornecedor:     et.fornecedor,
        seq:            et.seq,
        seq_sessao:     et.seq_sessao,
        // campos de bobina (extrusão), caso a etiqueta seja de extrusão
        tipo_bobina:    et.tipo_bobina,
        largura:        et.largura,
        operador:       et.operador,
        maquina:        et.maquina,
        turno_codigo:   et.turno_codigo,
      };
      const eplRe = gerarEPL(dadosRe);
      logI('print', `Reimprimindo ${idRe} (${et.tipo}) — mesmo número, sem alterar status`);
      imprimir(eplRe, null, (ok, out, err, printer) => {
        if (!ok) {
          logE('print', `Falha ao reimprimir ${idRe}`, { erro: err || out });
          return jsonErr(res, 500, 'Falha na reimpressão: ' + (err || out || 'impressora'));
        }
        logI('print', `${idRe} reimpresso em "${printer}"`);
        return jsonOk(res, { id: idRe, reimpresso: true, printer });
      });
      return;
    }

    // POST /etiquetas/:id/corrigir — corrige as INFORMAÇÕES de uma etiqueta de
    // recebimento (material/cor/fornecedor/código/SKU) mantendo o MESMO número e
    // o MESMO peso (não repesa), e reimprime. Uso: big bag pesado com material
    // escolhido errado — bipa, corrige os dados e reimprime sem pesar de novo.
    if ((m = pathname.match(/^\/etiquetas?\/(R\d+)\/corrigir$/)) && req.method === 'POST') {
      const idC = m[1];
      let body; try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
      const et = dbStmts.getEtiqueta.get(idC);
      if (!et) return jsonErr(res, 404, `Etiqueta ${idC} não encontrada`);
      if (et.tipo !== 'recebimento') return jsonErr(res, 400, `Correção disponível apenas para recebimento (${idC} é ${et.tipo})`);
      if (et.status === 'cancelada') return jsonErr(res, 400, `Etiqueta ${idC} está cancelada`);
      try { exigeCampos(body, ['materialKey','fornecedor','codigo','sku']); }
      catch(e) { return jsonErr(res, 400, e.message); }

      dbStmts.corrigirEtiqueta.run({
        id:             idC,
        material_key:   body.materialKey,
        material_nome:  body.materialNomeEt || body.material_nome || et.material_nome,
        material_label: body.material_label || null,
        cor:            body.cor != null ? body.cor : null,
        fornecedor:     body.fornecedor,
        lote:           (body.lote != null && body.lote !== '') ? body.lote : et.lote,
        codigo:         body.codigo,
        sku:            body.sku,
      });
      if (et.sessao_id) recalcularTotaisSessao(et.sessao_id);

      const novo = dbStmts.getEtiqueta.get(idC);
      // Rastro da correção no CSV de produção (evento=correcao).
      try { gravarLogProducaoBipagem(novo, 'correcao'); } catch(e) {}
      logI('print', `Corrigindo ${idC}: ${et.material_key}/${et.cor || '-'}/${et.fornecedor} -> ${novo.material_key}/${novo.cor || '-'}/${novo.fornecedor} (peso ${novo.peso} mantido)`);

      // Reimprime com os dados NOVOS, mesmo número de etiqueta.
      const dadosRe = {
        tipo:           novo.tipo,
        material_nome:  novo.material_nome,
        materialNomeEt: novo.material_nome,
        cor:            novo.cor,
        peso:           novo.peso,
        codigo:         novo.codigo,
        sku:            novo.sku,
        lote:           novo.lote,
        fornecedor:     novo.fornecedor,
        seq:            novo.seq,
        seq_sessao:     novo.seq_sessao,
      };
      const eplC = gerarEPL(dadosRe);
      imprimir(eplC, null, (ok, out, err, printer) => {
        if (!ok) {
          logE('print', `Correção de ${idC} salva, mas falha ao reimprimir`, { erro: err || out });
          return jsonErr(res, 500, 'Correção salva, mas falha na reimpressão: ' + (err || out || 'impressora'));
        }
        logI('print', `${idC} corrigido e reimpresso em "${printer}"`);
        return jsonOk(res, { id: idC, corrigida: true, etiqueta: novo, printer });
      });
      return;
    }

    // POST /retirada/aditivo
    // Body: { sessao_id, materialKey ('PIG'|'DESSEC'), cor (se PIG), fornecedor, qtd_sacos }
    // Cria etiqueta virtual de retirada para aditivo contado (sem etiqueta original).
    if (pathname === '/retirada/aditivo' && req.method === 'POST') {
      let body;
      try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
      try {
        exigeCampos(body, ['sessao_id','materialKey','fornecedor']);
      } catch(e) { return jsonErr(res, 400, e.message); }
      const sessaoIdRet = parseInt(body.sessao_id);
      const sessao = dbStmts.getSessao.get(sessaoIdRet);
      if (!sessao) return jsonErr(res, 404, 'Sessão não encontrada');
      if (sessao.tipo !== 'retirada') return jsonErr(res, 400, `Sessão #${sessaoIdRet} não é de retirada`);
      const KG_SACO = 25;
      // Sacos fechados (25 kg) e/ou PESO AVULSO. O avulso cobre o saco aberto,
      // antigo ou sem etiqueta, que não tem o peso padrão — sem ele, esse
      // material ficaria de fora da retirada.
      const qtdSacos  = parseInt(body.qtd_sacos) || 0;
      const pesoAvulso = Number(String(body.peso_avulso ?? 0).replace(',', '.')) || 0;
      if (qtdSacos < 0)  return jsonErr(res, 400, 'qtd_sacos não pode ser negativo');
      if (pesoAvulso < 0) return jsonErr(res, 400, 'peso avulso não pode ser negativo');
      if (qtdSacos < 1 && pesoAvulso <= 0) {
        return jsonErr(res, 400, 'Informe a quantidade de sacos ou um peso avulso');
      }
      const peso = Number((qtdSacos * KG_SACO + pesoAvulso).toFixed(3));
      const matKey = String(body.materialKey).toUpperCase();
      if (!['PIG','DESSEC'].includes(matKey)) return jsonErr(res, 400, `materialKey inválido para aditivo contado: ${matKey} (use PIG ou DESSEC)`);
      const cor = (matKey === 'PIG') ? (body.cor || null) : null;
      if (matKey === 'PIG' && !cor) return jsonErr(res, 400, 'cor obrigatória para PIG');

      const seqRet = getProximoSeq('retirada');
      const idVirt = 'S' + String(seqRet).padStart(7, '0');
      const seqSessaoRet = proximoSeqSessao(sessaoIdRet);
      const corLabel = cor || '';
      const skuForn = '.' + String(body.fornecedor).replace(/[^A-Za-z0-9]/g,'').substring(0,6).toUpperCase();
      const matLabel = matKey === 'PIG' ? 'Pigmento' : 'Dessecante';
      const marca = pesoAvulso > 0
        ? (qtdSacos > 0 ? `${qtdSacos}SC+${pesoAvulso}KG` : 'AVULSO')
        : 'SACOS';
      const sku = `${matKey}${cor ? '.' + corLabel.substring(0,3).toUpperCase() : ''}${skuForn} | ${peso} | ${marca}`;
      const codigo = body.codigo || `${matKey}${cor ? cor.substring(0,1).toUpperCase() : ''}`;

      const tr = makeTransaction(() => {
        dbStmts.insertEtiqueta.run({
          id:             idVirt,
          seq:            seqRet,
          seq_sessao:     seqSessaoRet,
          tipo:           'retirada',
          sub_tipo:       'aditivo-saida',
          material_key:   matKey,
          material_nome:  matLabel,
          material_label: matLabel,
          cor:            cor,
          fornecedor:     body.fornecedor,
          lote:           'SACOS',
          peso:           peso,
          qtd_sacos:      qtdSacos,
          codigo:         codigo,
          sku:            sku,
          status:         'bipada',
          ref_id:         null,
          hora_impressao: new Date().toISOString(),
          sessao_id:      sessaoIdRet,
          impressora:     null,
          operador:       null, maquina: null, largura: null, tipo_bobina: null,
          turno_codigo:   null, peso_bruto: null, tara: null,
        });
        incrementaSeq('retirada', seqRet);
      });
      tr();
      logI('retirada', `Aditivo registrado ${idVirt}: ${matKey}${cor?'/'+cor:''} ${qtdSacos}×${KG_SACO}kg = ${peso}kg (sessão #${sessaoIdRet})`);
      try { gravarLogProducaoBipagem(dbStmts.getEtiqueta.get(idVirt)); } catch(e) {}
      return jsonOk(res, { etiqueta: dbStmts.getEtiqueta.get(idVirt) });
    }

    // POST /retorno/aditivo
    // Body: { sessao_id, materialKey ('PIG'|'DESSEC'), cor (se PIG), fornecedor, qtd_sacos }
    // Cria etiqueta virtual de RETORNO (compra) para aditivo contado em sacos
    // fechados. Nasce 'bipada' — cada lote vira um item na lista, somável.
    if (pathname === '/retorno/aditivo' && req.method === 'POST') {
      let body;
      try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
      try {
        exigeCampos(body, ['sessao_id','materialKey','fornecedor','qtd_sacos']);
      } catch(e) { return jsonErr(res, 400, e.message); }
      const sessaoIdRto = parseInt(body.sessao_id);
      const sessaoRto = dbStmts.getSessao.get(sessaoIdRto);
      if (!sessaoRto) return jsonErr(res, 404, 'Sessão não encontrada');
      if (sessaoRto.tipo !== 'retorno') return jsonErr(res, 400, `Sessão #${sessaoIdRto} não é de retorno`);
      const qtdSacosRto = parseInt(body.qtd_sacos);
      if (!qtdSacosRto || qtdSacosRto < 1) return jsonErr(res, 400, 'qtd_sacos deve ser inteiro >= 1');
      const KG_SACO_RTO = 25;
      const pesoRto = qtdSacosRto * KG_SACO_RTO;
      const matKeyRto = String(body.materialKey).toUpperCase();
      if (!['PIG','DESSEC'].includes(matKeyRto)) return jsonErr(res, 400, `materialKey inválido para aditivo contado: ${matKeyRto} (use PIG ou DESSEC)`);
      const corRto = (matKeyRto === 'PIG') ? (body.cor || null) : null;
      if (matKeyRto === 'PIG' && !corRto) return jsonErr(res, 400, 'cor obrigatória para PIG');

      const seqRto = getProximoSeq('retorno');
      const idVirtRto = 'T' + String(seqRto).padStart(7, '0');
      const seqSessaoRto = proximoSeqSessao(sessaoIdRto);
      const corLabelRto = corRto || '';
      const skuFornRto = '.' + String(body.fornecedor).replace(/[^A-Za-z0-9]/g,'').substring(0,6).toUpperCase();
      const matLabelRto = matKeyRto === 'PIG' ? 'Pigmento' : 'Dessecante';
      const skuRto = `${matKeyRto}${corRto ? '.' + corLabelRto.substring(0,3).toUpperCase() : ''}${skuFornRto} | ${pesoRto} | SACOS`;
      const codigoRto = body.codigo || `${matKeyRto}${corRto ? corRto.substring(0,1).toUpperCase() : ''}`;

      const trRto = makeTransaction(() => {
        dbStmts.insertEtiqueta.run({
          id:             idVirtRto,
          seq:            seqRto,
          seq_sessao:     seqSessaoRto,
          tipo:           'retorno',
          sub_tipo:       'aditivo-fechado',
          material_key:   matKeyRto,
          material_nome:  matLabelRto,
          material_label: matLabelRto,
          cor:            corRto,
          fornecedor:     body.fornecedor,
          lote:           'SACOS',
          peso:           pesoRto,
          qtd_sacos:      qtdSacosRto,
          codigo:         codigoRto,
          sku:            skuRto,
          status:         'bipada',
          ref_id:         null,
          hora_impressao: new Date().toISOString(),
          sessao_id:      sessaoIdRto,
          impressora:     null,
          operador:       null, maquina: null, largura: null, tipo_bobina: null,
          turno_codigo:   null, peso_bruto: null, tara: null,
        });
        incrementaSeq('retorno', seqRto);
      });
      trRto();
      logI('retorno', `Aditivo retorno ${idVirtRto}: ${matKeyRto}${corRto?'/'+corRto:''} ${qtdSacosRto}×${KG_SACO_RTO}kg = ${pesoRto}kg (sessão #${sessaoIdRto})`);
      try { gravarLogProducaoBipagem(dbStmts.getEtiqueta.get(idVirtRto)); } catch(e) {}
      return jsonOk(res, { etiqueta: dbStmts.getEtiqueta.get(idVirtRto) });
    }

    // POST /produto-acabado/item
    // Registra um item de produto acabado (fardos de sacola) numa sessão
    // 'produto-acabado'. body: { sessao_id, corKey (AM|BC|PT|REC), formato
    // (ex 40x50), fardos }. Cada fardo = 25 kg. Nasce já 'bipada' (não há
    // bipagem física) — a etiqueta tem prefixo 'P'. material_key = corKey
    // guarda a cor; lote = formato; sku = paSku(cor,formato); a SKU é a chave
    // da variação no Bling (o id-pai vem de PA_CORES no envio).
    if (pathname === '/produto-acabado/item' && req.method === 'POST') {
      let body;
      try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
      try { exigeCampos(body, ['sessao_id','corKey','formato','fardos','maquina']); }
      catch(e) { return jsonErr(res, 400, e.message); }

      const sessaoIdPA = parseInt(body.sessao_id);
      const sessaoPA = dbStmts.getSessao.get(sessaoIdPA);
      if (!sessaoPA) return jsonErr(res, 404, 'Sessão não encontrada');
      if (sessaoPA.tipo !== 'produto-acabado') return jsonErr(res, 400, `Sessão #${sessaoIdPA} não é de produto acabado`);

      const corKey = String(body.corKey).toUpperCase();
      if (!PA_CORES[corKey]) return jsonErr(res, 400, `Cor inválida: ${corKey} (use AM, BC, PT ou REC)`);
      const formato = String(body.formato).toLowerCase().replace(/\s+/g, '');
      if (!PA_FORMATOS.includes(formato)) return jsonErr(res, 400, `Formato inválido: ${body.formato}`);
      const fardos = parseInt(body.fardos);
      if (!fardos || fardos < 1) return jsonErr(res, 400, 'fardos deve ser inteiro >= 1');
      const maq = String(body.maquina).toUpperCase();
      if (!PA_MAQUINAS.includes(maq)) return jsonErr(res, 400, `Máquina inválida: ${body.maquina} (use P1 ou P2)`);
      // A máquina produz esse formato?
      const permitidosMaq = PA_FORMATOS_POR_MAQUINA[maq];
      if (permitidosMaq && !permitidosMaq.includes(formato)) {
        const outra = Object.keys(PA_FORMATOS_POR_MAQUINA).find(k => k !== maq && PA_FORMATOS_POR_MAQUINA[k].includes(formato));
        logW('pa', `Bloqueado: ${formato} não é produzido na ${maq}`, { sessao: sessaoIdPA });
        return jsonErr(res, 400,
          `A máquina ${maq} não produz o formato ${formato.replace('x',' × ')}.` + (outra ? ` Esse formato é da ${outra}.` : ''),
          { maquina: maq, formato, permitidos: permitidosMaq, sugestao: outra || null });
      }

      const cor    = PA_CORES[corKey];
      const peso   = fardos * PA_KG_FARDO;
      const sku    = paSku(corKey, formato);
      const seqPA  = getProximoSeq('produto-acabado');
      const idVirt = 'P' + String(seqPA).padStart(7, '0');
      const seqSessaoPA = proximoSeqSessao(sessaoIdPA);

      const trPA = makeTransaction(() => {
        dbStmts.insertEtiqueta.run({
          id:             idVirt,
          seq:            seqPA,
          seq_sessao:     seqSessaoPA,
          tipo:           'produto-acabado',
          sub_tipo:       'fardo',
          material_key:   corKey,
          material_nome:  cor.nome,
          material_label: cor.label,
          cor:            cor.nome,
          fornecedor:     sessaoPA.fornecedor || (PA_TURNOS[sessaoPA.turno_codigo] && PA_TURNOS[sessaoPA.turno_codigo].nome) || 'PRODUTO ACABADO',
          lote:           formato,
          peso:           peso,
          qtd_sacos:      fardos,
          codigo:         sku,
          sku:            sku,
          status:         'bipada',
          ref_id:         null,
          hora_impressao: new Date().toISOString(),
          sessao_id:      sessaoIdPA,
          impressora:     null,
          operador:       null, maquina: maq, largura: null, tipo_bobina: null,
          turno_codigo:   sessaoPA.turno_codigo || null,
          peso_bruto:     null, tara: null,
        });
        incrementaSeq('produto-acabado', seqPA);
      });
      trPA();
      logI('produto-acabado', `Item ${idVirt}: [${maq}] ${cor.nome} ${formato} ${fardos} fardo(s) × ${PA_KG_FARDO}kg = ${peso}kg [SKU ${sku}] (sessão #${sessaoIdPA})`);
      try { gravarLogProducaoBipagem(dbStmts.getEtiqueta.get(idVirt)); } catch(e) {}
      return jsonOk(res, { etiqueta: dbStmts.getEtiqueta.get(idVirt) });
    }

    // GET /etiquetas?tipo=&status=&limit=
    if (pathname === '/etiquetas' && req.method === 'GET') {
      const { tipo, status, limit } = parsed.query;
      let q = 'SELECT * FROM etiquetas WHERE 1=1';
      const params = [];
      if (tipo)   { q += ' AND tipo = ?';   params.push(tipo); }
      if (status) { q += ' AND status = ?'; params.push(status); }
      q += ' ORDER BY hora_impressao DESC LIMIT ?';
      params.push(parseInt(limit) || 100);
      const rows = db.prepare(q).all(...params);
      return jsonOk(res, { etiquetas: rows, total: rows.length });
    }

    // POST /print/etiqueta  e  POST /etiquetas  (compatibilidade: ambos imprimem)
    if ((pathname === '/print/etiqueta' || pathname === '/etiquetas') && req.method === 'POST') {
      let dados;
      try { dados = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
      try {
        exigeCampos(dados, ['tipo','fornecedor','peso','codigo','sku','lote']);
        if (!dados.materialKey && !dados.material_key) throw new Error('Campo obrigatório ausente: materialKey');
      } catch(e) { return jsonErr(res, 400, e.message); }
      // seq é atribuído pelo servidor (C2) — qualquer seq vindo do corpo é ignorado.
      return imprimirEPersistirEtiqueta(dados, resp => {
        if (resp.ok) jsonOk(res, resp);
        else jsonErr(res, 500, resp.erro, { printer: resp.printer });
      });
    }

    // POST /etiquetas/extrusao  → cria + imprime etiqueta de bobina
    // Body: { sessao_id, cor, tipo_bobina, largura, operador, maquina, turno_codigo,
    //         peso, peso_bruto?, tara?, printerName? }
    // Resposta: { id, seq, seq_sessao, sku, codigo, bobina:{id,sku} }
    // Não dispara envio Bling — esse acontece ao bipar (modo individual) ou
    // ao finalizar sessão (modo lote).
    if (pathname === '/etiquetas/extrusao' && req.method === 'POST') {
      let body;
      try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
      try {
        exigeCampos(body, ['sessao_id','cor','tipo_bobina','largura','peso']);
      } catch(e) { return jsonErr(res, 400, e.message); }

      const sessao = dbStmts.getSessao.get(parseInt(body.sessao_id));
      if (!sessao) return jsonErr(res, 404, 'Sessão não encontrada');
      if (sessao.tipo !== 'extrusao') return jsonErr(res, 400, `Sessão #${sessao.id} não é de extrusão (tipo=${sessao.tipo})`);

      // Resolve a bobina pelo mapa (cor|tipo|largura → id Bling + SKU)
      const mapaBobinas = JSON.parse(configGet('mapa_bobina_bling', '{}'));
      const chave = `${String(body.cor).toUpperCase()}|${String(body.tipo_bobina).toUpperCase()}|${body.largura}`;
      const bobina = mapaBobinas[chave];
      if (!bobina) return jsonErr(res, 400, `Bobina "${chave}" não está mapeada. Configure mapa_bobina_bling.`);

      // Fornecedor (turno) → herda da sessão se não vier
      const turno = body.turno_codigo || sessao.turno_codigo;
      if (!turno) return jsonErr(res, 400, 'turno_codigo obrigatório (sessão sem turno)');

      // ── TRAVA 2: peso repetido na MESMA MÁQUINA ──────────────────────
      // Duas etiquetas com bruto, tara e líquido idênticos, na mesma
      // máquina, dentro da janela, são quase sempre a MESMA bobina pesada
      // duas vezes (tela recarregada, segunda aba, celular, clique repetido).
      // Foi o caso de 30/08/2026: E0001291 e E0001292, C1, 713.500 / 8.000
      // / 705.500, com 5 segundos de diferença.
      //
      // POR MÁQUINA de propósito: na virada de turno os operadores tiram
      // uma bobina de CADA máquina e pesam quase juntas. C1 e C2 não se
      // atrapalham.
      //
      // Bloqueia de vez para o operador. A única saída é a senha de
      // supervisor — sem ela, uma bobina legítima com peso repetido pararia
      // a produção, o que não é aceitável nesta fábrica.
      // ATENÇÃO à ordem: um retry com o MESMO clientToken é legítimo (a
      // resposta se perdeu na rede) e já é resolvido pela idempotência lá
      // dentro do imprimirEPersistirEtiqueta. Se a trava rodasse antes dela,
      // o retry honesto viraria "peso repetido" e o operador ficaria preso.
      const jaProcessado = !!idempotenciaGet(body.clientToken);

      const janelaMin = Math.max(1, parseInt(configGet('extrusao_janela_peso_min', '15'), 10) || 15);
      const maqAtual  = String(body.maquina || sessao.maquina || '').trim().toUpperCase();
      const pLiq      = Number(body.peso);
      const pBruto    = body.peso_bruto != null ? Number(body.peso_bruto) : null;
      const pTara     = body.tara       != null ? Number(body.tara)       : null;
      const desdeISO  = new Date(Date.now() - janelaMin * 60000).toISOString();

      const gemea = db.prepare(`
        SELECT id, seq_sessao, hora_impressao, status, peso, peso_bruto, tara
          FROM etiquetas
         WHERE sessao_id = ? AND tipo = 'extrusao' AND status != 'cancelada'
           AND UPPER(TRIM(COALESCE(maquina, ''))) = ?
           AND hora_impressao >= ?
           AND ROUND(peso, 3) = ROUND(?, 3)
           AND ROUND(COALESCE(peso_bruto, -1), 3) = ROUND(?, 3)
           AND ROUND(COALESCE(tara,       -1), 3) = ROUND(?, 3)
         ORDER BY hora_impressao DESC
         LIMIT 1
      `).get(sessao.id, maqAtual, desdeISO, pLiq,
             pBruto == null ? -1 : pBruto, pTara == null ? -1 : pTara);

      if (gemea && !jaProcessado) {
        const hashSup = configGet('senha_saida_hash', hashSenha('1234'));
        const autorizada = body.senha_supervisor && hashSenha(body.senha_supervisor) === hashSup;
        const quando = new Date(gemea.hora_impressao)
          .toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
        if (!autorizada) {
          if (body.senha_supervisor) {
            logDesvio({ tipo: 'peso_repetido_senha_incorreta', tela: 'extrusao',
                        detalhe: `${maqAtual} · ${pLiq} kg · gemea ${gemea.id}` });
          }
          logW('extrusao', `Impressão bloqueada: peso repetido na ${maqAtual}`, {
            gemea: gemea.id, peso: pLiq, peso_bruto: pBruto, tara: pTara, janela_min: janelaMin });
          logDesvio({ tipo: 'impressao_bloqueada_peso_repetido', tela: 'extrusao',
                      detalhe: `${maqAtual} · liq ${pLiq} · bruto ${pBruto} · tara ${pTara} · igual a ${gemea.id} de ${quando}` });
          return jsonErr(res, 409,
            `A ${maqAtual} já registrou este mesmo peso às ${quando} — bobina ${gemea.id}` +
            (gemea.seq_sessao ? ` (Bobina #${gemea.seq_sessao})` : '') +
            `. Bruto ${Number(gemea.peso_bruto).toFixed(3)} · tara ${Number(gemea.tara).toFixed(3)} · líquido ${Number(gemea.peso).toFixed(3)}. ` +
            `Se é a MESMA bobina, não imprima de novo. Se é outra bobina com o peso idêntico, chame o supervisor.`,
            { trava: 'peso_repetido', exige_senha_supervisor: true,
              gemea: { id: gemea.id, seq_sessao: gemea.seq_sessao, hora: gemea.hora_impressao,
                       peso: gemea.peso, peso_bruto: gemea.peso_bruto, tara: gemea.tara, status: gemea.status },
              janela_min: janelaMin, maquina: maqAtual });
        }
        logDesvio({ tipo: 'peso_repetido_autorizado_supervisor', tela: 'extrusao',
                    detalhe: `${maqAtual} · ${pLiq} kg · gemea ${gemea.id} de ${quando}` });
        logW('extrusao', `Peso repetido LIBERADO por senha de supervisor na ${maqAtual}`, { gemea: gemea.id, peso: pLiq });
      }

      // seq é reservado atomicamente dentro de imprimirEPersistirEtiqueta (C1)
      return imprimirEPersistirEtiqueta({
        tipo: 'extrusao',
        clientToken:    body.clientToken || null,
        material_key:  'BOBINA',
        material_nome: `${body.cor} · ${body.tipo_bobina} · ${body.largura}`,
        material_label: bobina.sku,
        cor:            body.cor,
        tipo_bobina:    body.tipo_bobina,
        largura:        body.largura,
        operador:       body.operador || sessao.operador || '—',
        maquina:        body.maquina  || sessao.maquina  || '—',
        turno_codigo:   turno,
        fornecedor:     turno,                          // pra etiqueta o "fornecedor" é o turno
        lote:           turno,                          // mesmo valor — bobinas não têm lote externo
        peso:           Number(body.peso),
        peso_bruto:     body.peso_bruto != null ? Number(body.peso_bruto) : null,
        tara:           body.tara       != null ? Number(body.tara)       : null,
        codigo:         bobina.sku,
        sku:            bobina.sku,
        sessao_id:      sessao.id,
        printerName:    body.printerName || null,
      }, resp => {
        if (resp.ok) jsonOk(res, { ...resp, bobina });
        else jsonErr(res, 500, resp.erro, { printer: resp.printer });
      });
    }

    // POST /etiquetas/capa  { sessao_id, capa_sku, peso, peso_bruto?, tara?, maquina, operador?, turno_codigo? }
    // Bobina CAPA: entra na MESMA sessão de extrusão (sub_tipo='capa'), com
    // produto próprio (CAPAS_CATALOGO). Sem cor e sem código gravimétrico.
    if (pathname === '/etiquetas/capa' && req.method === 'POST') {
      let body;
      try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
      try { exigeCampos(body, ['sessao_id','capa_sku','peso','maquina']); }
      catch(e) { return jsonErr(res, 400, e.message); }

      const sessao = dbStmts.getSessao.get(parseInt(body.sessao_id));
      if (!sessao) return jsonErr(res, 404, 'Sessão não encontrada');
      if (sessao.tipo !== 'extrusao') return jsonErr(res, 400, `Sessão #${sessao.id} não é de extrusão (tipo=${sessao.tipo})`);

      const capa = CAPAS_CATALOGO[body.capa_sku];
      if (!capa) return jsonErr(res, 400, `Capa "${body.capa_sku}" não cadastrada.`);

      const turno = body.turno_codigo || sessao.turno_codigo;
      if (!turno) return jsonErr(res, 400, 'turno_codigo obrigatório (sessão sem turno)');

      return imprimirEPersistirEtiqueta({
        tipo:           'extrusao',
        sub_tipo:       'capa',
        clientToken:    body.clientToken || null,
        material_key:   'CAPA',
        material_nome:  capa.nome,
        material_label: body.capa_sku,
        cor:            null,                          // capas não têm cor
        tipo_bobina:    'CAPA',
        largura:        capa.dim,                      // ex "70 x 90" (label/resumo)
        operador:       body.operador || sessao.operador || '—',
        maquina:        body.maquina,
        turno_codigo:   turno,
        fornecedor:     turno,
        lote:           turno,
        peso:           Number(body.peso),
        peso_bruto:     body.peso_bruto != null ? Number(body.peso_bruto) : null,
        tara:           body.tara       != null ? Number(body.tara)       : null,
        codigo:         body.capa_sku,                 // sem cód. gravimétrico → usa o SKU
        sku:            body.capa_sku,
        sessao_id:      sessao.id,
        printerName:    body.printerName || null,
      }, resp => {
        if (resp.ok) jsonOk(res, { ...resp, capa });
        else jsonErr(res, 500, resp.erro, { printer: resp.printer });
      });
    }

    // POST /etiquetas/outras — OUTRAS PESAGENS (aparas/borra/varredura).
    // Sessão tipo='outras'. Sem operador/máquina/turno. item_codigo é a chave do
    // OUTRAS_CATALOGO (vira sku/codigo da etiqueta). Aparas não têm produto no
    // Bling; borra/varredura têm (resolvido no envio). Body: { sessao_id,
    // item_codigo, peso, peso_bruto?, tara?, clientToken? }
    if (pathname === '/etiquetas/outras' && req.method === 'POST') {
      let body;
      try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
      try { exigeCampos(body, ['sessao_id','item_codigo','peso']); }
      catch(e) { return jsonErr(res, 400, e.message); }

      const sessao = dbStmts.getSessao.get(parseInt(body.sessao_id));
      if (!sessao) return jsonErr(res, 404, 'Sessão não encontrada');
      if (sessao.tipo !== 'outras') return jsonErr(res, 400, `Sessão #${sessao.id} não é de Outras Pesagens (tipo=${sessao.tipo})`);

      const item = OUTRAS_CATALOGO[body.item_codigo];
      if (!item) return jsonErr(res, 400, `Item "${body.item_codigo}" não cadastrado em Outras Pesagens.`);

      return imprimirEPersistirEtiqueta({
        tipo:           'outras',
        clientToken:    body.clientToken || null,
        material_key:   item.categoria,                // APARA | RESIDUO
        material_nome:  item.nome,                     // ex "Apara Amarela", "Borra"
        material_label: body.item_codigo,
        cor:            item.cor,                       // cor da apara, ou null
        fornecedor:     'EKOPLASTIC',                   // NOT NULL — sem fornecedor real
        lote:           (function(){ const s = dataLocalISO().split('-'); return s[2] + s[1] + s[0].slice(-2); })(),  // DDMMAA (data local)
        peso:           Number(body.peso),
        peso_bruto:     body.peso_bruto != null ? Number(body.peso_bruto) : null,
        tara:           body.tara       != null ? Number(body.tara)       : null,
        codigo:         body.item_codigo,               // sem cód. gravimétrico → usa o código do item
        sku:            body.item_codigo,               // p/ borra/varredura é o SKU real (RES.BORRA / RES.VARREDURA)
        sessao_id:      sessao.id,
        printerName:    body.printerName || null,
      }, resp => {
        if (resp.ok) jsonOk(res, { ...resp, item });
        else jsonErr(res, 500, resp.erro, { printer: resp.printer });
      });
    }

    // ─── SESSÕES ───
    // POST /sessoes  { tipo, fornecedor?, operador?, maquina?, turno_codigo? }
    if (pathname === '/sessoes' && req.method === 'POST') {
      let body;
      try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
      if (!['recebimento','retorno','retirada','extrusao','outras','produto-acabado'].includes(body.tipo)) return jsonErr(res, 400, 'tipo inválido');
      let dataLanc = null;
      if (body.data_lancamento != null && body.data_lancamento !== '') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.data_lancamento))) return jsonErr(res, 400, 'data_lancamento inválida (use AAAA-MM-DD)');
        dataLanc = String(body.data_lancamento);
      }
      const info = dbStmts.abrirSessao.run(
        body.tipo,
        new Date().toISOString(),
        body.fornecedor   || null,
        body.operador     || null,
        body.maquina      || null,
        body.turno_codigo || null,
        dataLanc,
      );
      logI('sessao', `Aberta sessão #${info.lastInsertRowid} (${body.tipo}${body.turno_codigo ? ', turno=' + body.turno_codigo : ''}${body.operador ? ', op=' + body.operador : ''})`);
      return jsonOk(res, { sessao_id: info.lastInsertRowid });
    }

    // GET /sessoes/:id
    if ((m = pathname.match(/^\/sessoes\/(\d+)$/)) && req.method === 'GET') {
      const s = dbStmts.getSessao.get(parseInt(m[1]));
      if (!s) return jsonErr(res, 404, 'Sessão não encontrada');
      const etiquetas = db.prepare(`SELECT * FROM etiquetas WHERE sessao_id = ? AND status != 'cancelada' ORDER BY hora_impressao`).all(s.id);
      return jsonOk(res, { sessao: s, etiquetas });
    }

    // POST /sessoes/:id/finalizar  → fecha + envia pro Bling
    // Relatório PARCIAL (momentâneo): imprime o MESMO resumo do final, mas NÃO
    // finaliza a sessão, NÃO cancela pendentes e NÃO envia ao Bling. Pode ser
    // chamado quantas vezes quiser ao longo do turno/recebimento/retirada/retorno.
    if ((m = pathname.match(/^\/sessoes\/(\d+)\/relatorio-atual$/)) && req.method === 'POST') {
      const id = parseInt(m[1]);
      const s = dbStmts.getSessao.get(id);
      if (!s) return jsonErr(res, 404, 'Sessão não encontrada');
      const r = imprimirResumoSessao(s, { parcial: true });
      if (!r || !r.ok) {
        const msg = (r && r.motivo === 'sem_itens_bipados') ? 'Nenhum item bipado ainda para imprimir'
                  : (r && r.motivo === 'tipo_nao_aplicavel') ? 'Relatório não disponível para este tipo de sessão'
                  : 'Não foi possível imprimir o relatório';
        return jsonErr(res, 400, msg);
      }
      logI('sessao', `Relatório PARCIAL impresso (sessão #${id}, tipo ${s.tipo})`);
      return jsonOk(res, { resumo: r, parcial: true });
    }

    if ((m = pathname.match(/^\/sessoes\/(\d+)\/finalizar$/)) && req.method === 'POST') {
      const id = parseInt(m[1]);
      const s = dbStmts.getSessao.get(id);
      if (!s) return jsonErr(res, 404, 'Sessão não encontrada');
      if (s.fim) return jsonErr(res, 400, 'Sessão já finalizada');

      // Cenário 02: NÃO finaliza o turno com bobinas impressas ainda não
      // bipadas. Antes elas eram canceladas em silêncio aqui — o que fazia o
      // operador não perceber a bobina esquecida. Agora a finalização é
      // bloqueada e devolve a lista, pra ele bipar (ou excluir as que não
      // valem) antes de fechar. O auto-fim de turno abandonado segue cancelando
      // por conta própria (lá não há operador pra decidir).
      const pendentes = db.prepare(
        `SELECT id FROM etiquetas WHERE sessao_id = ? AND status = 'aguardando_bipe'`
      ).all(id);
      if (pendentes.length > 0) {
        logW('sessao', `Finalização #${id} bloqueada: ${pendentes.length} bobina(s) não bipada(s)`, { ids: pendentes.map(e => e.id) });
        return jsonErr(res, 409,
          `Há ${pendentes.length} etiqueta(s) impressa(s) ainda não bipada(s). Bipe todas — ou exclua as que não valem — antes de finalizar o turno.`,
          { pendentes: pendentes.map(e => e.id) });
      }

      const tot = totaisDaSessao(s, id);
      dbStmts.fecharSessao.run(new Date().toISOString(), tot.total_kg, tot.qtd, 'pendente', id);
      logI('sessao', `Finalizando #${id}`, { kg: tot.total_kg, etiquetas: tot.qtd, pendentes_canceladas: pendentes.length });
      // v53/v55: imprime o resumo na térmica 100x100 (recebimento → big bags; extrusão → bobinas)
      const resumo = imprimirResumoSessao(s);
      const blingResp = await enviarSessaoBling(id);
      return jsonOk(res, { sessao_id: id, totais: tot, pendentes_canceladas: pendentes.length, bling: blingResp, resumo });
    }

    // POST /sessoes/:id/reenviar-bling   body opcional: { forcar: true }
    if ((m = pathname.match(/^\/sessoes\/(\d+)\/reenviar-bling$/)) && req.method === 'POST') {
      let bodyR = {}; try { bodyR = await lerBodyJson(req); } catch(e) {}
      const r = await enviarSessaoBling(parseInt(m[1]), { forcar: !!(bodyR && bodyR.forcar) });
      return jsonOk(res, { bling: r });
    }

    // GET /sessoes/:id/payload-bling  → payload que foi enviado (ou seria)
    if ((m = pathname.match(/^\/sessoes\/(\d+)\/payload-bling$/)) && req.method === 'GET') {
      const sessaoId = parseInt(m[1]);
      const s = dbStmts.getSessao.get(sessaoId);
      if (!s) return jsonErr(res, 404, 'Sessão não encontrada');
      // Tenta pegar payload persistido (sessão simulada)
      const persistido = configGet(`payload_sessao_${sessaoId}`, null);
      if (persistido) {
        return jsonOk(res, { sessao: s, payload: JSON.parse(persistido), origem: 'persistido' });
      }
      // Senão, monta agora
      const etiquetas = db.prepare(`SELECT * FROM etiquetas WHERE sessao_id = ? AND status = 'bipada'`).all(sessaoId);
      const mapaForn  = JSON.parse(configGet('mapa_fornecedor_bling', '{}'));
      const mapaSku   = JSON.parse(configGet('mapa_produto_bling', '{}'));
      const idEko     = configGet('id_ekoplastic_bling', null);
      const payload   = montarPayloadBling(s, etiquetas, mapaForn, mapaSku, idEko);
      return jsonOk(res, { sessao: s, payload, origem: 'preview' });
    }

    // POST /sessoes/:id/cancelar  → marca etiquetas como canceladas e sessão também
    if ((m = pathname.match(/^\/sessoes\/(\d+)\/cancelar$/)) && req.method === 'POST') {
      const id = parseInt(m[1]);
      const s = dbStmts.getSessao.get(id);
      if (!s) return jsonErr(res, 404, 'Sessão não encontrada');
      if (s.fim) return jsonErr(res, 400, 'Sessão já finalizada — use reenviar-bling se for o caso');
      const tr = makeTransaction(() => {
        // Se for retirada: devolve as etiquetas ORIGINAIS consumidas por esta
        // sessão para 'bipada' (aptas a bipar de novo). Tem que rodar ANTES de
        // cancelar as virtuais, pois a subquery depende delas ainda ativas.
        db.prepare(`
          UPDATE etiquetas SET status = 'bipada', hora_bipagem = NULL
          WHERE status = 'consumida' AND id IN (
            SELECT ref_id FROM etiquetas
            WHERE sessao_id = ? AND tipo = 'retirada' AND ref_id IS NOT NULL
              AND status IN ('bipada','aguardando_bipe')
          )
        `).run(id);
        db.prepare(`UPDATE etiquetas SET status = 'cancelada' WHERE sessao_id = ? AND status IN ('aguardando_bipe','bipada')`).run(id);
        db.prepare(`UPDATE sessoes SET fim = ?, bling_status = 'cancelada' WHERE id = ?`).run(new Date().toISOString(), id);
      });
      tr();
      logI('sessao', `Cancelada #${id}`);
      return jsonOk(res, { sessao_id: id, status: 'cancelada' });
    }

    // GET /sessoes/abertas[?tipo=recebimento|retorno|retirada|extrusao]
    // Retorna sessões com fim IS NULL (não finalizadas, não canceladas) + etiquetas
    // Usado pelo frontend pra "retomar" sessão ao reabrir a tela.
    if (pathname === '/sessoes/abertas' && req.method === 'GET') {
      const { tipo } = parsed.query;
      let q = 'SELECT * FROM sessoes WHERE fim IS NULL';
      const params = [];
      if (tipo) { q += ' AND tipo = ?'; params.push(tipo); }
      q += ' ORDER BY inicio DESC';
      const sessoes = db.prepare(q).all(...params);
      const result = sessoes.map(s => {
        const etiquetas = db.prepare(
          `SELECT * FROM etiquetas WHERE sessao_id = ? AND status != 'cancelada' ORDER BY seq_sessao, hora_impressao`
        ).all(s.id);
        return { ...s, etiquetas };
      });
      return jsonOk(res, { sessoes: result, total: result.length });
    }

    // GET /sessoes/pendentes-bling — sessões finalizadas cujo envio ao Bling NÃO
    // foi concluído (pendente_config / erro / pendente). Usada pela tela de
    // Manutenção pra listar e reenviar com 1 clique (POST /sessoes/:id/reenviar-bling).
    if (pathname === '/sessoes/pendentes-bling' && req.method === 'GET') {
      const rows = db.prepare(
        `SELECT id, tipo, inicio, fim, fornecedor, total_kg, total_etiquetas, bling_status, bling_id, bling_erro
         FROM sessoes
         WHERE bling_status IN ('pendente','pendente_config','erro')
         ORDER BY id DESC LIMIT 100`
      ).all();
      return jsonOk(res, { sessoes: rows, total: rows.length });
    }
    // Retorna sessões finalizadas pelo sistema (não pelo operador) nas
    // últimas N horas. Identifica pela marca em bling_erro/observação.
    // Usada pelo frontend pra avisar o operador que voltou.
    if (pathname === '/sessoes/auto-finalizadas-recentes' && req.method === 'GET') {
      const { tipo, horas } = parsed.query;
      const horasN = Math.min(48, Math.max(1, parseInt(horas) || 4));
      const desde = new Date(Date.now() - horasN * 3600 * 1000).toISOString();
      let q = `SELECT id, tipo, turno_codigo, operador, maquina, inicio, fim, total_kg,
                      total_etiquetas, bling_status, bling_id, bling_erro
               FROM sessoes
               WHERE fim IS NOT NULL
                 AND fim >= ?
                 AND bling_erro LIKE 'AUTO-%'`;
      const params = [desde];
      if (tipo) { q += ' AND tipo = ?'; params.push(tipo); }
      q += ' ORDER BY fim DESC';
      const sessoes = db.prepare(q).all(...params);
      return jsonOk(res, { sessoes, total: sessoes.length });
    }

    // GET /sessoes/finalizadas-recentes?horas=N&tipo=...
    // TODAS as sessões finalizadas (qualquer origem) nas últimas N horas (máx 168 = 7d).
    // Usada na Manutenção para reenviar ao Bling uma sessão JÁ enviada (após excluir o
    // pedido lá e corrigir as etiquetas).
    if (pathname === '/sessoes/finalizadas-recentes' && req.method === 'GET') {
      const { tipo, horas } = parsed.query;
      const horasN = Math.min(168, Math.max(1, parseInt(horas) || 48));
      const desde  = new Date(Date.now() - horasN * 3600 * 1000).toISOString();
      let q = `SELECT id, tipo, fornecedor, turno_codigo, operador, maquina, inicio, fim,
                      total_kg, total_etiquetas, bling_status, bling_id, bling_erro
               FROM sessoes
               WHERE fim IS NOT NULL
                 AND fim >= ?`;
      const params = [desde];
      if (tipo) { q += ' AND tipo = ?'; params.push(tipo); }
      q += ' ORDER BY fim DESC LIMIT 200';
      const sessoes = db.prepare(q).all(...params);
      // Recalcula os totais AGORA, pela mesma regra do envio. O valor gravado na
      // sessão é a foto de quando ela foi fechada — se foi fechada por uma versão
      // antiga (antes do big bag retirado passar a contar na entrada), ele está
      // defasado. Mostrar o valor atual deixa o operador conferir ANTES de reenviar.
      for (const s of sessoes) {
        try {
          const t = totaisDaSessao(s, s.id);
          s.total_atual_kg    = Number((t.total_kg || 0).toFixed(3));
          s.total_atual_itens = t.qtd;
          s.divergente = (s.total_atual_itens !== s.total_etiquetas)
                      || (Number(s.total_atual_kg) !== Number(s.total_kg));
        } catch(e) { s.total_atual_kg = null; s.total_atual_itens = null; s.divergente = false; }
      }
      return jsonOk(res, { sessoes, total: sessoes.length });
    }

    // POST /sessoes/abertas/cancelar-todas[?tipo=X]
    // Cancela em lote todas as sessões com fim IS NULL.
    // Útil pra limpar sessões de teste ou abandonadas.
    // Sem parâmetro: cancela TODAS as abertas (qualquer tipo).
    // Com ?tipo=retirada: cancela só as desse tipo.
    if (pathname === '/sessoes/abertas/cancelar-todas' && req.method === 'POST') {
      const { tipo } = parsed.query;
      let q = 'SELECT id, tipo, fornecedor, inicio FROM sessoes WHERE fim IS NULL';
      const params = [];
      if (tipo) { q += ' AND tipo = ?'; params.push(tipo); }
      q += ' ORDER BY id';
      const sessoes = db.prepare(q).all(...params);
      if (!sessoes.length) {
        return jsonOk(res, { canceladas: 0, sessoes: [] });
      }
      const agora = new Date().toISOString();
      const stmtEtiq = db.prepare(`UPDATE etiquetas SET status = 'cancelada' WHERE sessao_id = ? AND status IN ('aguardando_bipe','bipada')`);
      const stmtSes  = db.prepare(`UPDATE sessoes SET fim = ?, bling_status = 'cancelada' WHERE id = ?`);
      const tr = makeTransaction(() => {
        for (const s of sessoes) {
          stmtEtiq.run(s.id);
          stmtSes.run(agora, s.id);
        }
      });
      tr();
      const ids = sessoes.map(s => s.id);
      logI('sessao', `Cancelamento em lote: ${ids.length} sessão(ões) [#${ids.join(', #')}]${tipo ? ` tipo=${tipo}` : ''}`);
      return jsonOk(res, { canceladas: sessoes.length, sessoes });
    }

    // GET /sessoes?status=pendente|pendente_config|erro
    if (pathname === '/sessoes' && req.method === 'GET') {
      const { status, tipo, limit } = parsed.query;
      let q = 'SELECT * FROM sessoes WHERE 1=1';
      const params = [];
      if (status) { q += ' AND bling_status = ?'; params.push(status); }
      if (tipo)   { q += ' AND tipo = ?';         params.push(tipo); }
      q += ' ORDER BY id DESC LIMIT ?';
      params.push(parseInt(limit) || 50);
      const rows = db.prepare(q).all(...params);
      return jsonOk(res, { sessoes: rows, total: rows.length });
    }

    // ─── CONFIG (mapa de fornecedores → ID Bling, etc) ───
    // ══════════════════════════════════════════════════════════════
    //  INVENTÁRIO (leitura por celular) — só leitura/consulta, não cria
    //  nem baixa etiqueta. Compara a soma das etiquetas bipadas com o
    //  saldo do Bling, por produto (material+cor+fornecedor).
    // ══════════════════════════════════════════════════════════════

    // Lista os produtos disponíveis para inventariar (a partir do mapa de
    // produtos do Bling, só os materiais de MP conhecidos).
    // Baixa o certificado do servidor para instalar como confiável no celular.
    // No iPhone, o Safari BLOQUEIA a câmera em sites cujo certificado não é
    // confiável — instalar e confiar neste arquivo resolve.
    if (pathname === '/cert-ekoplastic.pem' && req.method === 'GET') {
      try {
        const certPath = path.join(__dirname, 'cert', 'cert.pem');
        if (!fs.existsSync(certPath)) return jsonErr(res, 404, 'Certificado ainda não foi gerado (o HTTPS precisa ter subido pelo menos uma vez).');
        const buf = fs.readFileSync(certPath);
        res.writeHead(200, {
          'Content-Type': 'application/x-x509-ca-cert',
          'Content-Disposition': 'attachment; filename="ekoplastic.pem"',
          'Content-Length': buf.length,
        });
        return res.end(buf);
      } catch(e) { return jsonErr(res, 500, 'Erro ao ler o certificado: ' + e.message); }
    }

    // ══════════════════════════════════════════════════════════════
    //  RETIRADA DE BOBINAS (celular) — baixa individual no Bling.
    //  Cada bobina vira UM pedido de venda próprio (contato interno
    //  EKOPLASTIC), descontando o estoque daquele cor/tipo/largura.
    // ══════════════════════════════════════════════════════════════

    // ══════════════════════════════════════════════════════════════
    //  COLABORADORES — senha (PIN) de acesso às telas de operação.
    //  Cada pessoa tem um PIN próprio; o nome fica gravado na sessão
    //  e sai no resumo impresso como responsável.
    // ══════════════════════════════════════════════════════════════

    // Lista os colaboradores (NUNCA devolve o hash do PIN).
    // ══════════════════════════════════════════════════════════════
    //  DASHBOARD — histórico consolidado de todos os módulos.
    //  Lê o banco local (nada de planilha): filtra por período, tipo,
    //  turno, máquina, fornecedor, material e status.
    // ══════════════════════════════════════════════════════════════

    // Períodos disponíveis + números gerais (para montar os filtros na tela).
    // Histórico de cores por máquina+formato no Produto Acabado.
    // Não existe regra fixa (toda cor roda em toda máquina/formato), então a
    // proteção não pode ser uma trava: é o histórico que diz o que é comum.
    // Combinação nunca vista antes = provável engano, e o operador confirma.
    // Gera um DASHBOARD AUTÔNOMO: um único arquivo .html com todos os dados
    // embutidos dentro dele. Funciona sem servidor — dá para copiar para o
    // Google Drive, mandar por e-mail ou abrir em qualquer computador.
    // Truque: injeta os dados + um "fetch" falso que responde no lugar do
    // servidor, então a mesma tela do dashboard funciona offline sem alteração.
    // ══════════════════════════════════════════════════════════════
    //  ETIQUETA DE GAIOLA (Produto Acabado) — só para CONTAGEM.
    //  Gera o QR que o inventário vai ler. Não cria lançamento nem
    //  envia nada ao Bling: a produção continua sendo lançada como é hoje.
    // ══════════════════════════════════════════════════════════════
    // ══════════════════════════════════════════════════════════════
    //  SINCRONIZAR MATÉRIA-PRIMA COM O BLING
    //  Procura no Bling os produtos de MP e mostra os que ainda não
    //  estão no sistema, já interpretando material/cor/fornecedor pelo
    //  nome. O operador confere, informa o código gravimétrico e
    //  confirma — sem precisar de nova versão do sistema.
    // ══════════════════════════════════════════════════════════════

    // Procura produtos novos no Bling.
    if (pathname === '/sync/mp/procurar' && req.method === 'GET') {
      try {
        const token = await getToken();
        const mapaProd = JSON.parse(configGet('mapa_produto_bling', '{}'));
        const mapaForn = JSON.parse(configGet('mapa_fornecedor_bling', '{}'));
        const cat = lerCatalogoMP();

        // Nomes conhecidos, para reconhecer o que vier do Bling.
        const materiais = Object.keys(cat.materiais || {});
        const coresConhecidas = [...new Set(Object.values(cat.materiais || {}).flatMap(m => m.cores || []))];
        const fornConhecidos  = [...new Set(Object.values(cat.fornecedores || {}).flat())];

        const norm = t => String(t || '').toUpperCase()
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .replace(/[^A-Z0-9]+/g, ' ').trim();

        // Interpreta o produto do Bling: qual material, cor e fornecedor.
        // ORDEM IMPORTA: o fornecedor é identificado primeiro e retirado do
        // texto, senão nomes como "Cristal Master" seriam lidos como a cor
        // "Cristal". Nomes mais longos têm prioridade pelo mesmo motivo.
        const porTamanho = (a, b) => norm(b).length - norm(a).length;
        const fornOrdenados  = [...fornConhecidos].sort(porTamanho);
        const coresOrdenadas = [...coresConhecidas].sort(porTamanho);
        const interpretar = (nome, codigo) => {
          let N = norm(nome) + ' ' + norm(codigo);
          const apelidos = { GBD: ['GBD', 'GRAO BAIXA', 'BAIXA DENSIDADE'], POLI: ['POLI', 'POLINYLON', 'NYLON'],
                             CARBO: ['CARBO', 'CARBONATO'], PIG: ['PIG', 'PIGMENTO'], DESSEC: ['DESSEC', 'DESSECANTE'] };
          let material = null;
          for (const m of materiais) {
            const alvos = apelidos[m] || [m];
            if (alvos.some(a => N.includes(norm(a)))) { material = m; break; }
          }
          const semEspaco = t => norm(t).replace(/ /g, '');
          const forn = fornOrdenados.find(f => N.includes(norm(f)) || N.replace(/ /g, '').includes(semEspaco(f))) || null;
          if (forn) {
            // Remove o fornecedor do texto nas duas formas: com espaços (vem do
            // nome, "CRISTAL MASTER") e sem (vem do código, "CRISTALMASTER").
            N = N.split(norm(forn)).join(' ');
            N = N.split(' ').map(p => p.includes(semEspaco(forn)) ? ' ' : p).join(' ');
          }
          const cor = coresOrdenadas.find(c => N.includes(norm(c))) || null;
          return { material, cor, fornecedor: forn };
        };

        // Busca paginada dos produtos do Bling.
        const achados = [];
        let pagina = 1, paginasLidas = 0;
        while (pagina <= 20) {
          const r = await proxyChamada(token, 'GET', '/Api/v3/produtos', `?pagina=${pagina}&limite=100&criterio=2`, '');
          let d = {}; try { d = JSON.parse(r.body); } catch(e) {}
          const lista = Array.isArray(d.data) ? d.data : [];
          paginasLidas++;
          if (!lista.length) break;
          for (const p of lista) {
            const codigo = String(p.codigo || '');
            const nome   = String(p.nome || '');
            const info = interpretar(nome, codigo);
            if (!info.material) continue;                       // não é matéria-prima reconhecida
            const chave = chaveProduto(info.material, info.cor || '', info.fornecedor || '');
            achados.push({
              bling_id: String(p.id), codigo, nome,
              material: info.material, cor: info.cor, fornecedor: info.fornecedor,
              chave,
              ja_existe: !!mapaProd[chave],
              formato: p.formato || null,                        // 'S' simples / 'V' com variação
              completo: !!(info.material && info.fornecedor),     // dá para cadastrar direto?
            });
          }
          if (lista.length < 100) break;
          pagina++;
        }

        const novos = achados.filter(a => !a.ja_existe);
        return jsonOk(res, {
          paginas_lidas: paginasLidas,
          total_mp_encontrados: achados.length,
          ja_cadastrados: achados.length - novos.length,
          novos,
          fornecedores_sem_contato: [...new Set(novos.filter(n => n.fornecedor && !mapaForn[n.fornecedor]).map(n => n.fornecedor))],
        });
      } catch(e) {
        return jsonErr(res, 502, 'Erro ao consultar o Bling: ' + e.message);
      }
    }

    // Procura o contato (fornecedor) no Bling pelo nome.
    if (pathname === '/sync/mp/contato' && req.method === 'GET') {
      const nome = String(parsed.query.nome || '').trim();
      if (!nome) return jsonErr(res, 400, 'Informe o nome do fornecedor');
      try {
        const token = await getToken();
        const r = await proxyChamada(token, 'GET', '/Api/v3/contatos', `?pesquisa=${encodeURIComponent(nome)}&limite=20`, '');
        let d = {}; try { d = JSON.parse(r.body); } catch(e) {}
        const lista = (Array.isArray(d.data) ? d.data : []).map(c => ({
          id: String(c.id), nome: c.nome, documento: c.numeroDocumento || null, tipo: c.tipo || null,
        }));
        return jsonOk(res, { contatos: lista });
      } catch(e) { return jsonErr(res, 502, 'Erro ao consultar contatos: ' + e.message); }
    }

    // Grava no sistema o que o operador confirmou.
    if (pathname === '/sync/mp/confirmar' && req.method === 'POST') {
      let body; try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
      const itens = Array.isArray(body.itens) ? body.itens : [];
      if (!itens.length) return jsonErr(res, 400, 'Nenhum item para cadastrar');

      const mapaProd = JSON.parse(configGet('mapa_produto_bling', '{}'));
      const mapaForn = JSON.parse(configGet('mapa_fornecedor_bling', '{}'));
      const mapaSku  = JSON.parse(configGet('mapa_sku_variacao_mp', '{}'));
      const cat = lerCatalogoMP();
      const fornCat  = JSON.parse(configGet('mp_fornecedores', '{}'));
      const codigos  = JSON.parse(configGet('mp_codigos_gravimetricos', '[]'));

      const feitos = [], erros = [];
      for (const it of itens) {
        try {
          const material = String(it.material || '').toUpperCase();
          const cor  = it.cor || null;
          const forn = String(it.fornecedor || '').trim();
          if (!material || !forn) { erros.push({ item: it, erro: 'material e fornecedor são obrigatórios' }); continue; }
          if (!cat.materiais[material]) { erros.push({ item: it, erro: `material ${material} desconhecido` }); continue; }

          const chave = chaveProduto(material, cor || '', forn);
          mapaProd[chave] = String(it.bling_id);
          if (it.contato_id) mapaForn[forn] = String(it.contato_id);
          // produto com variação precisa da SKU para resolver a variação certa
          if (it.formato === 'V' && it.codigo) mapaSku[chave] = String(it.codigo);

          if (!Array.isArray(fornCat[material])) fornCat[material] = [];
          if (!fornCat[material].includes(forn)) fornCat[material].push(forn);

          if (it.codigo_gravimetrico) {
            const jaTem = codigos.some(c => c.matKey === material && (c.cor || null) === (cor || null) && (c.forn || null) === forn);
            if (!jaTem) codigos.push({ matKey: material, cor: cor || null, forn, codigo: String(it.codigo_gravimetrico).toUpperCase() });
          }
          feitos.push({ chave, bling_id: it.bling_id, fornecedor: forn, codigo_gravimetrico: it.codigo_gravimetrico || null });
        } catch(e) { erros.push({ item: it, erro: e.message }); }
      }

      configSet('mapa_produto_bling', JSON.stringify(mapaProd));
      configSet('mapa_fornecedor_bling', JSON.stringify(mapaForn));
      configSet('mapa_sku_variacao_mp', JSON.stringify(mapaSku));
      configSet('mp_fornecedores', JSON.stringify(fornCat));
      configSet('mp_codigos_gravimetricos', JSON.stringify(codigos));
      for (const f of feitos) logI('sync', `Cadastrado pelo Bling: ${f.chave} → produto ${f.bling_id}${f.codigo_gravimetrico ? ' · código ' + f.codigo_gravimetrico : ''}`);
      return jsonOk(res, { cadastrados: feitos.length, feitos, erros });
    }

    if (pathname === '/produto-acabado/etiqueta-gaiola' && req.method === 'POST') {
      let body; try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
      const corKey  = String(body.corKey || '').toUpperCase();
      const formato = String(body.formato || '');
      const fardos  = parseInt(body.fardos, 10);
      if (!PA_CORES[corKey])            return jsonErr(res, 400, `Cor inválida: ${body.corKey}`);
      if (!PA_FORMATOS.includes(formato)) return jsonErr(res, 400, `Formato inválido: ${formato}`);
      if (!Number.isFinite(fardos) || fardos < 1) return jsonErr(res, 400, 'Informe a quantidade de fardos (mínimo 1)');
      if (fardos > 999) return jsonErr(res, 400, 'Quantidade muito alta (máximo 999 fardos)');

      // Garante que a sequência exista: sem a linha na tabela, o incremento
      // não tem efeito e o número repetiria — o que quebraria o bloqueio de
      // leitura repetida no inventário.
      try { db.prepare(`INSERT OR IGNORE INTO seqs (tipo, valor) VALUES ('gaiola-pa', 1)`).run(); } catch(e) {}
      const seq = getProximoSeq('gaiola-pa');
      const id  = 'G' + String(seq).padStart(7, '0');
      const kg  = fardos * PA_KG_FARDO;
      const epl = gerarEPLGaiolaPA({ id, corKey, formato, fardos });

      // Guarda o registro da gaiola (para reimpressão e para o inventário
      // conferir a etiqueta lida). Fica em config, fora da tabela de
      // etiquetas, para não misturar com os lançamentos de produção.
      try {
        let gaiolas = {};
        try { gaiolas = JSON.parse(configGet('gaiolas_pa', '{}')); } catch(e) {}
        gaiolas[id] = { id, corKey, formato, fardos, kg, criadaEm: new Date().toISOString(), operador: body.operador || null };
        // mantém as 2000 mais recentes
        const chaves = Object.keys(gaiolas).sort();
        while (chaves.length > 2000) delete gaiolas[chaves.shift()];
        configSet('gaiolas_pa', JSON.stringify(gaiolas));
      } catch(e) { logW('gaiola', 'Não consegui registrar a gaiola: ' + e.message); }
      incrementaSeq('gaiola-pa', seq);

      const impr = await new Promise(resolve => {
        try { imprimir(epl, body.impressora, (ok, saida, erro, impressora) => resolve({ ok: !!ok, impressora, erro: erro || null })); }
        catch(e) { resolve({ ok: false, erro: e.message }); }
      });
      logI('gaiola', `Etiqueta de gaiola ${id}: ${formato} ${PA_CORES[corKey].nome} · ${fardos} fardos (${kg} kg)`);
      return jsonOk(res, { id, corKey, formato, fardos, kg,
                           cor_nome: PA_CORES[corKey].nome,
                           conteudo_qr: `EKOPA|${id}|${formato}|${corKey}|${fardos}|${kg}`,
                           impressao: impr });
    }

    // Reimprime uma etiqueta de gaiola já gerada (mesmo QR).
    if (pathname === '/produto-acabado/gaiola-reimprimir' && req.method === 'POST') {
      let body; try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
      const id = String(body.id || '').toUpperCase();
      let gaiolas = {};
      try { gaiolas = JSON.parse(configGet('gaiolas_pa', '{}')); } catch(e) {}
      const g = gaiolas[id];
      if (!g) return jsonErr(res, 404, `Gaiola ${id} não encontrada`);
      const impr = await new Promise(resolve => {
        try { imprimir(gerarEPLGaiolaPA(g), body.impressora, (ok, saida, erro, impressora) => resolve({ ok: !!ok, impressora, erro: erro || null })); }
        catch(e) { resolve({ ok: false, erro: e.message }); }
      });
      logI('gaiola', `Etiqueta de gaiola ${id} reimpressa`);
      return jsonOk(res, { id, impressao: impr, ...g });
    }

    // Lista as gaiolas do dia (a tela mostra o que já foi etiquetado).
    if (pathname === '/produto-acabado/gaiolas-hoje' && req.method === 'GET') {
      let gaiolas = {};
      try { gaiolas = JSON.parse(configGet('gaiolas_pa', '{}')); } catch(e) {}
      const hoje = dataLocalISO();
      const lista = Object.values(gaiolas)
        .filter(g => (g.criadaEm || '').slice(0, 10) === hoje)
        .sort((a, b) => String(b.criadaEm).localeCompare(String(a.criadaEm)));
      return jsonOk(res, { gaiolas: lista, qtd: lista.length,
                           total_fardos: lista.reduce((a, g) => a + (g.fardos || 0), 0),
                           total_kg: lista.reduce((a, g) => a + (g.kg || 0), 0) });
    }

    // ── INVENTÁRIO DE PRODUTO ACABADO ──────────────────────────────
    // Mesma ideia do inventário de MP, mas contando gaiolas por QR.

    // Combinações cor × formato disponíveis para inventariar.
    if (pathname === '/inventario/pa/produtos' && req.method === 'GET') {
      const produtos = [];
      for (const [corKey, cor] of Object.entries(PA_CORES)) {
        for (const formato of PA_FORMATOS) {
          produtos.push({ corKey, cor: cor.nome, formato, sku: paSku(corKey, formato),
                          rotulo: `${formato.replace('x', ' × ')} · ${cor.nome}` });
        }
      }
      return jsonOk(res, { produtos, kgPorFardo: PA_KG_FARDO });
    }

    // Consulta o saldo no Bling de um produto acabado (resolve pelo SKU).
    if (pathname === '/inventario/pa/saldo' && req.method === 'GET') {
      const corKey  = String(parsed.query.corKey || '').toUpperCase();
      const formato = String(parsed.query.formato || '');
      const cor = PA_CORES[corKey];
      if (!cor) return jsonErr(res, 400, `Cor inválida: ${corKey}`);
      if (!PA_FORMATOS.includes(formato)) return jsonErr(res, 400, `Formato inválido: ${formato}`);
      const sku = paSku(corKey, formato);
      try {
        const token = await getToken();
        const idReal = Number(await resolverIdVariacaoPA(token, sku, cor.bling_pai));
        const r = await proxyChamada(token, 'GET', '/Api/v3/estoques/saldos', '?idsProdutos[]=' + idReal, '');
        let d = {}; try { d = JSON.parse(r.body); } catch(e) {}
        const item = Array.isArray(d.data) ? d.data[0] : (d.data || null);
        if (!item) return jsonErr(res, 502, 'O Bling não retornou saldo para este produto (confira o escopo "Controle de estoque").', { sku, idReal });
        return jsonOk(res, { sku, idProduto: idReal, saldoFisico: Number(item.saldoFisicoTotal || 0),
                             saldoVirtual: Number(item.saldoVirtualTotal || 0) });
      } catch(e) {
        return jsonErr(res, 502, 'Erro ao consultar saldo no Bling: ' + e.message);
      }
    }

    // Confere uma etiqueta de gaiola lida no inventário.
    if ((m = pathname.match(/^\/inventario\/pa\/gaiola\/([A-Z0-9]+)$/)) && req.method === 'GET') {
      const id = m[1];
      let gaiolas = {};
      try { gaiolas = JSON.parse(configGet('gaiolas_pa', '{}')); } catch(e) {}
      const g = gaiolas[id];
      if (!g) return jsonErr(res, 404, `Gaiola ${id} não encontrada no sistema`);
      return jsonOk(res, { gaiola: g });
    }

    if (pathname === '/dashboard/exportar-html' && req.method === 'GET') {
      const dias = Math.min(730, Math.max(1, parseInt(parsed.query.dias) || 180));
      const desde = new Date(Date.now() - dias * 86400000).toISOString().slice(0, 10);
      try {
        const linhas = db.prepare(
          `SELECT e.id, e.tipo, e.sub_tipo, e.material_key, e.material_nome, e.cor, e.fornecedor, e.lote,
                  e.peso, e.qtd_sacos, e.codigo, e.sku, e.status, e.ref_id, e.hora_impressao, e.hora_bipagem,
                  e.sessao_id, e.operador, e.maquina, e.largura, e.tipo_bobina, e.turno_codigo, e.bling_pedido_id,
                  s.bling_status, s.bling_id, s.bling_erro
             FROM etiquetas e LEFT JOIN sessoes s ON s.id = e.sessao_id
            WHERE date(e.hora_impressao) >= ?
            ORDER BY e.hora_impressao DESC`
        ).all(desde);
        const sessoes = db.prepare(
          `SELECT s.*, (SELECT COUNT(*) FROM etiquetas x WHERE x.sessao_id = s.id) AS itens
             FROM sessoes s WHERE date(s.inicio) >= ? ORDER BY s.inicio DESC`
        ).all(desde);
        const baixas = [];
        try {
          for (const c of db.prepare(`SELECT chave, valor FROM config WHERE chave LIKE 'baixas_bobinas_%' ORDER BY chave DESC LIMIT 400`).all()) {
            const dia = c.chave.replace('baixas_bobinas_', '');
            if (dia < desde) continue;
            let lista = []; try { lista = JSON.parse(c.valor); } catch(e) {}
            for (const b of lista) baixas.push({ ...b, dia });
          }
        } catch(e) {}
        let inventario = { itens: [] };
        try { inventario = JSON.parse(configGet('inventario_atual', '{"itens":[]}')); } catch(e) {}

        const tpl = fs.readFileSync(path.join(PUBLIC_DIR, 'dashboard.html'), 'utf8');
        const dados = { linhas, sessoes, baixas, inventario, geradoEm: new Date().toISOString(), dias, desde };
        const injecao = `
<script id="eko-dados-embutidos">
/* ══════════════════════════════════════════════════════════════════════
   DASHBOARD AUTÔNOMO — Ekoplastic
   Todos os dados estão dentro deste arquivo. Não precisa de servidor,
   internet ou instalação: basta abrir num navegador.
   ══════════════════════════════════════════════════════════════════════ */
window.EKO_OFFLINE = ${JSON.stringify(dados).replace(/</g, '\\u003c')};
(function(){
  const D = window.EKO_OFFLINE;
  const dentro = (iso, de, ate) => { const d = (iso||'').slice(0,10); if (de && d < de) return false; if (ate && d > ate) return false; return true; };
  function filtrar(q){
    const de = q.get('de'), ate = q.get('ate');
    const tipos = (q.get('tipos')||'').split(',').map(x=>x.trim()).filter(Boolean);
    return D.linhas.filter(l => {
      if (!dentro(l.hora_impressao, de, ate)) return false;
      if (q.get('tipo') && l.tipo !== q.get('tipo')) return false;
      if (tipos.length && !tipos.includes(l.tipo)) return false;
      if (q.get('turno') && (l.turno_codigo||'') !== q.get('turno')) return false;
      if (q.get('maquina') && (l.maquina||'') !== q.get('maquina')) return false;
      if (q.get('fornecedor') && (l.fornecedor||'') !== q.get('fornecedor')) return false;
      if (q.get('material') && (l.material_key||'') !== q.get('material')) return false;
      if (q.get('status') && l.status !== q.get('status')) return false;
      if (q.get('operador') && (l.operador||'') !== q.get('operador')) return false;
      if (q.get('cor') && (l.cor||'') !== q.get('cor')) return false;
      const b = (q.get('busca')||'').toLowerCase();
      if (b && !((l.id||'').toLowerCase().includes(b) || (l.lote||'').toLowerCase().includes(b) || (l.sku||'').toLowerCase().includes(b))) return false;
      return true;
    });
  }
  const agrupar = (arr, chave) => {
    const m = new Map();
    for (const l of arr) {
      const k = chave(l);
      const o = m.get(k) || { chave: k, qtd: 0, kg: 0 };
      o.qtd++; o.kg += Number(l.peso)||0; m.set(k, o);
    }
    return [...m.values()].sort((a,b)=>b.kg-a.kg);
  };
  const respostas = {
    '/dashboard/opcoes': () => {
      const uni = f => [...new Set(D.linhas.map(f).filter(v=>v!=null&&v!==''))].sort();
      const datas = D.linhas.map(l=>(l.hora_impressao||'').slice(0,10)).filter(Boolean).sort();
      return { ok:true, periodo:{ inicio:datas[0]||null, fim:datas[datas.length-1]||null },
        turnos:uni(l=>l.turno_codigo), maquinas:uni(l=>l.maquina), operadores:uni(l=>l.operador),
        fornecedores:uni(l=>l.fornecedor), materiais:uni(l=>l.material_key), cores:uni(l=>l.cor) };
    },
    '/dashboard/resumo': q => {
      const f = filtrar(q);
      const conta = st => f.filter(l=>l.status===st).length;
      return { ok:true,
        totais:{ qtd:f.length, kg:f.reduce((a,l)=>a+(Number(l.peso)||0),0),
                 canceladas:conta('cancelada'), pendentes:conta('aguardando_bipe'), consumidas:conta('consumida') },
        porDia: agrupar(f, l=>(l.hora_impressao||'').slice(0,10)).sort((a,b)=>a.chave.localeCompare(b.chave)).map(x=>({dia:x.chave,qtd:x.qtd,kg:x.kg})),
        porTipo: agrupar(f, l=>l.tipo),
        porTurno: agrupar(f, l=>l.turno_codigo||'—'),
        porMaquina: agrupar(f, l=>l.maquina||'—'),
        porForn: agrupar(f, l=>l.fornecedor||'—').slice(0,20),
        porMaterial: agrupar(f, l=>(l.material_key||'—')+(l.cor?('|'+l.cor):'')).map(x=>{
          const [c,cor]=x.chave.split('|'); return { chave:c, cor:cor||'', qtd:x.qtd, kg:x.kg }; }).slice(0,25),
        porOperador: agrupar(f, l=>l.operador||'—').slice(0,20),
        porStatus: agrupar(f, l=>l.status).sort((a,b)=>b.qtd-a.qtd),
      };
    },
    '/dashboard/movimentos': q => {
      const f = filtrar(q);
      const lim = parseInt(q.get('limite'))||200, off = parseInt(q.get('offset'))||0;
      return { ok:true, total:f.length, linhas:f.slice(off, off+lim), limite:lim, offset:off };
    },
    '/dashboard/sessoes': q => {
      const de=q.get('de'), ate=q.get('ate');
      let ss = D.sessoes.filter(s => dentro(s.inicio, de, ate));
      if (q.get('tipo')) ss = ss.filter(s=>s.tipo===q.get('tipo'));
      if (q.get('turno')) ss = ss.filter(s=>(s.turno_codigo||'')===q.get('turno'));
      if (q.get('status')) ss = ss.filter(s=>s.bling_status===q.get('status'));
      return { ok:true, sessoes: ss };
    },
    '/dashboard/extras': () => ({ ok:true, baixas: D.baixas, inventario: D.inventario }),
  };
  // Substitui o acesso ao servidor pelos dados embutidos.
  window.fetch = function(url){
    const u = String(url).split('?');
    const q = new URLSearchParams(u[1]||'');
    const fn = respostas[u[0]];
    const corpo = fn ? fn(q) : { ok:false, erro:'indisponível no arquivo offline' };
    return Promise.resolve({ ok:true, status:200, json: () => Promise.resolve(corpo) });
  };
  // Marca visualmente que é um retrato, não a tela ao vivo.
  document.addEventListener('DOMContentLoaded', function(){
    const h = document.querySelector('header');
    if (!h) return;
    const tag = document.createElement('span');
    tag.style.cssText = 'font-size:11px;font-weight:800;letter-spacing:0.5px;background:rgba(0,224,208,0.14);'
      + 'color:#00e0d0;border:1px solid #00e0d0;border-radius:20px;padding:5px 11px;';
    const dt = new Date(D.geradoEm);
    tag.textContent = 'ARQUIVO · gerado em ' + dt.toLocaleString('pt-BR');
    h.appendChild(tag);
    const v = document.querySelector('header .voltar'); if (v) v.remove();
  });
})();
</script>`;
        // injeta antes do script principal do dashboard
        const marca = '<script>\nconst URL_BASE=';
        const html = tpl.includes(marca) ? tpl.replace(marca, injecao + '\n' + marca) : tpl.replace('</head>', injecao + '\n</head>');

        // salva na pasta do sistema (ao lado dos logs) e devolve para download
        const dir = path.join(__dirname, 'dashboard');
        ensureDir(dir);
        const nome = `dashboard-${dataLocalISO()}.html`;
        try { fs.writeFileSync(path.join(dir, nome), html, 'utf8'); } catch(e) { logW('dash', 'Não consegui salvar em disco: ' + e.message); }
        logI('dash', `Dashboard autônomo gerado: ${nome} (${linhas.length} registros, ${dias} dias)`);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Disposition': `attachment; filename="${nome}"`,
          'X-Eko-Arquivo': nome, 'X-Eko-Registros': String(linhas.length),
        });
        return res.end(html);
      } catch(e) {
        return jsonErr(res, 500, 'Erro ao gerar o arquivo: ' + e.message);
      }
    }

    if (pathname === '/produto-acabado/frequencia-cor' && req.method === 'GET') {
      const maq  = String(parsed.query.maquina || '').toUpperCase();
      const fmt  = String(parsed.query.formato || '');
      const dias = Math.min(365, Math.max(30, parseInt(parsed.query.dias) || 120));
      const desde = new Date(Date.now() - dias * 86400000).toISOString().slice(0, 10);
      try {
        // No PA: material_key = cor, lote = formato
        const linhas = db.prepare(
          `SELECT material_key AS cor, COUNT(*) AS qtd, MAX(date(hora_impressao)) AS ultimo
             FROM etiquetas
            WHERE tipo = 'produto-acabado' AND status != 'cancelada'
              AND maquina = ? AND lote = ? AND date(hora_impressao) >= ?
            GROUP BY material_key ORDER BY qtd DESC`
        ).all(maq, fmt, desde);
        const total = linhas.reduce((a, l) => a + l.qtd, 0);
        // Sem histórico nenhum dessa máquina+formato: não dá para opinar.
        const semBase = total === 0;
        const porCor = {};
        for (const l of linhas) porCor[l.cor] = { qtd: l.qtd, ultimo: l.ultimo, pct: total ? Math.round((l.qtd / total) * 100) : 0 };
        return jsonOk(res, { maquina: maq, formato: fmt, dias, total, semBase, porCor });
      } catch(e) { return jsonErr(res, 500, 'Erro ao consultar histórico: ' + e.message); }
    }

    if (pathname === '/dashboard/opcoes' && req.method === 'GET') {
      const uni = (sql) => { try { return db.prepare(sql).all().map(r => r.v).filter(v => v != null && v !== ''); } catch(e) { return []; } };
      const per = (() => {
        try { return db.prepare(`SELECT MIN(date(hora_impressao)) AS ini, MAX(date(hora_impressao)) AS fim FROM etiquetas`).get(); }
        catch(e) { return {}; }
      })();
      return jsonOk(res, {
        periodo:     { inicio: per && per.ini, fim: per && per.fim },
        turnos:      uni(`SELECT DISTINCT turno_codigo AS v FROM etiquetas ORDER BY v`),
        maquinas:    uni(`SELECT DISTINCT maquina AS v FROM etiquetas ORDER BY v`),
        operadores:  uni(`SELECT DISTINCT operador AS v FROM etiquetas ORDER BY v`),
        fornecedores:uni(`SELECT DISTINCT fornecedor AS v FROM etiquetas ORDER BY v`),
        materiais:   uni(`SELECT DISTINCT material_key AS v FROM etiquetas ORDER BY v`),
        cores:       uni(`SELECT DISTINCT cor AS v FROM etiquetas ORDER BY v`),
      });
    }

    // Números do período (cartões + quebras por dia/turno/máquina/etc).
    if (pathname === '/dashboard/resumo' && req.method === 'GET') {
      const q = parsed.query;
      const de  = String(q.de  || '').slice(0, 10);
      const ate = String(q.ate || '').slice(0, 10);
      const cond = [], par = [];
      if (de)  { cond.push(`date(e.hora_impressao) >= ?`); par.push(de); }
      if (ate) { cond.push(`date(e.hora_impressao) <= ?`); par.push(ate); }
      for (const [campo, chave] of [['tipo','tipo'],['turno_codigo','turno'],['maquina','maquina'],
                                    ['fornecedor','fornecedor'],['material_key','material'],['status','status'],['operador','operador']]) {
        const v = q[chave];
        if (v) { cond.push(`e.${campo} = ?`); par.push(String(v)); }
      }
      // "tipos" aceita vários (ex.: a aba Matéria-Prima = recebimento+retirada+retorno)
      if (q.tipos) {
        const lista = String(q.tipos).split(',').map(x => x.trim()).filter(Boolean);
        if (lista.length) { cond.push(`e.tipo IN (${lista.map(() => '?').join(',')})`); par.push(...lista); }
      }
      const onde = cond.length ? ('WHERE ' + cond.join(' AND ')) : '';
      const roda = (sql, extra = []) => { try { return db.prepare(sql).all(...par, ...extra); } catch(e) { logW('dash', sql + ' :: ' + e.message); return []; } };

      const totais = roda(`SELECT COUNT(*) AS qtd, COALESCE(SUM(e.peso),0) AS kg,
                             SUM(CASE WHEN e.status='cancelada' THEN 1 ELSE 0 END) AS canceladas,
                             SUM(CASE WHEN e.status='aguardando_bipe' THEN 1 ELSE 0 END) AS pendentes,
                             SUM(CASE WHEN e.status='consumida' THEN 1 ELSE 0 END) AS consumidas
                           FROM etiquetas e ${onde}`)[0] || {};
      return jsonOk(res, {
        totais,
        porDia:    roda(`SELECT date(e.hora_impressao) AS dia, COUNT(*) AS qtd, COALESCE(SUM(e.peso),0) AS kg
                         FROM etiquetas e ${onde} GROUP BY dia ORDER BY dia`),
        porTipo:   roda(`SELECT e.tipo AS chave, COUNT(*) AS qtd, COALESCE(SUM(e.peso),0) AS kg
                         FROM etiquetas e ${onde} GROUP BY e.tipo ORDER BY kg DESC`),
        porTurno:  roda(`SELECT COALESCE(e.turno_codigo,'—') AS chave, COUNT(*) AS qtd, COALESCE(SUM(e.peso),0) AS kg
                         FROM etiquetas e ${onde} GROUP BY chave ORDER BY kg DESC`),
        porMaquina:roda(`SELECT COALESCE(e.maquina,'—') AS chave, COUNT(*) AS qtd, COALESCE(SUM(e.peso),0) AS kg
                         FROM etiquetas e ${onde} GROUP BY chave ORDER BY kg DESC`),
        porForn:   roda(`SELECT COALESCE(e.fornecedor,'—') AS chave, COUNT(*) AS qtd, COALESCE(SUM(e.peso),0) AS kg
                         FROM etiquetas e ${onde} GROUP BY chave ORDER BY kg DESC LIMIT 20`),
        porMaterial:roda(`SELECT COALESCE(e.material_key,'—') AS chave, COALESCE(e.cor,'') AS cor, COUNT(*) AS qtd, COALESCE(SUM(e.peso),0) AS kg
                         FROM etiquetas e ${onde} GROUP BY chave, cor ORDER BY kg DESC LIMIT 25`),
        porOperador:roda(`SELECT COALESCE(e.operador,'—') AS chave, COUNT(*) AS qtd, COALESCE(SUM(e.peso),0) AS kg
                         FROM etiquetas e ${onde} GROUP BY chave ORDER BY kg DESC LIMIT 20`),
        porStatus: roda(`SELECT e.status AS chave, COUNT(*) AS qtd, COALESCE(SUM(e.peso),0) AS kg
                         FROM etiquetas e ${onde} GROUP BY e.status ORDER BY qtd DESC`),
      });
    }

    // Lista detalhada de movimentos (cada etiqueta), com paginação.
    if (pathname === '/dashboard/movimentos' && req.method === 'GET') {
      const q = parsed.query;
      const cond = [], par = [];
      const de  = String(q.de  || '').slice(0, 10);
      const ate = String(q.ate || '').slice(0, 10);
      if (de)  { cond.push(`date(e.hora_impressao) >= ?`); par.push(de); }
      if (ate) { cond.push(`date(e.hora_impressao) <= ?`); par.push(ate); }
      for (const [campo, chave] of [['tipo','tipo'],['turno_codigo','turno'],['maquina','maquina'],
                                    ['fornecedor','fornecedor'],['material_key','material'],['status','status'],['operador','operador'],['cor','cor']]) {
        const v = q[chave];
        if (v) { cond.push(`e.${campo} = ?`); par.push(String(v)); }
      }
      if (q.tipos) {
        const lista = String(q.tipos).split(',').map(x => x.trim()).filter(Boolean);
        if (lista.length) { cond.push(`e.tipo IN (${lista.map(() => '?').join(',')})`); par.push(...lista); }
      }
      if (q.busca) { cond.push(`(e.id LIKE ? OR e.lote LIKE ? OR e.sku LIKE ?)`); const b = '%' + String(q.busca) + '%'; par.push(b, b, b); }
      const onde = cond.length ? ('WHERE ' + cond.join(' AND ')) : '';
      const limite = Math.min(parseInt(q.limite) || 200, 1000);
      const desloc = parseInt(q.offset) || 0;
      try {
        const total = db.prepare(`SELECT COUNT(*) AS n FROM etiquetas e ${onde}`).get(...par).n;
        const linhas = db.prepare(
          `SELECT e.id, e.tipo, e.sub_tipo, e.material_key, e.material_nome, e.cor, e.fornecedor, e.lote,
                  e.peso, e.qtd_sacos, e.codigo, e.sku, e.status, e.ref_id, e.hora_impressao, e.hora_bipagem,
                  e.sessao_id, e.operador, e.maquina, e.largura, e.tipo_bobina, e.turno_codigo, e.bling_pedido_id,
                  s.bling_status, s.bling_id, s.bling_erro
             FROM etiquetas e LEFT JOIN sessoes s ON s.id = e.sessao_id
             ${onde} ORDER BY e.hora_impressao DESC LIMIT ? OFFSET ?`
        ).all(...par, limite, desloc);
        return jsonOk(res, { total, linhas, limite, offset: desloc });
      } catch(e) { return jsonErr(res, 500, 'Erro na consulta: ' + e.message); }
    }

    // Sessões do período (com status de envio ao Bling e erros).
    if (pathname === '/dashboard/sessoes' && req.method === 'GET') {
      const q = parsed.query;
      const cond = [], par = [];
      const de  = String(q.de  || '').slice(0, 10);
      const ate = String(q.ate || '').slice(0, 10);
      if (de)  { cond.push(`date(s.inicio) >= ?`); par.push(de); }
      if (ate) { cond.push(`date(s.inicio) <= ?`); par.push(ate); }
      if (q.tipo)   { cond.push(`s.tipo = ?`);          par.push(String(q.tipo)); }
      if (q.turno)  { cond.push(`s.turno_codigo = ?`);  par.push(String(q.turno)); }
      if (q.status) { cond.push(`s.bling_status = ?`);  par.push(String(q.status)); }
      const onde = cond.length ? ('WHERE ' + cond.join(' AND ')) : '';
      try {
        const linhas = db.prepare(
          `SELECT s.*, (SELECT COUNT(*) FROM etiquetas x WHERE x.sessao_id = s.id) AS itens
             FROM sessoes s ${onde} ORDER BY s.inicio DESC LIMIT 500`
        ).all(...par);
        return jsonOk(res, { sessoes: linhas });
      } catch(e) { return jsonErr(res, 500, 'Erro na consulta: ' + e.message); }
    }

    // Baixas de bobina e inventários salvos (ficam em config, não em etiquetas).
    if (pathname === '/dashboard/extras' && req.method === 'GET') {
      const baixas = [];
      try {
        const chaves = db.prepare(`SELECT chave, valor FROM config WHERE chave LIKE 'baixas_bobinas_%' ORDER BY chave DESC LIMIT 62`).all();
        for (const c of chaves) {
          const dia = c.chave.replace('baixas_bobinas_', '');
          let lista = []; try { lista = JSON.parse(c.valor); } catch(e) {}
          for (const b of lista) baixas.push({ ...b, dia });
        }
      } catch(e) {}
      let inventario = { itens: [] };
      try { inventario = JSON.parse(configGet('inventario_atual', '{"itens":[]}')); } catch(e) {}
      return jsonOk(res, { baixas, inventario });
    }

    if (pathname === '/colaboradores' && req.method === 'GET') {
      let lista = [];
      try { lista = JSON.parse(configGet('colaboradores', '[]')); } catch(e) {}
      return jsonOk(res, { colaboradores: lista.map(c => ({
        id: c.id, nome: c.nome, telas: c.telas || [], ativo: c.ativo !== false,
      })) });
    }

    // Cadastra ou atualiza um colaborador (usado pela tela de Manutenção).
    if (pathname === '/colaboradores/salvar' && req.method === 'POST') {
      let body; try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
      const nome = String(body.nome || '').trim();
      const pin  = String(body.pin || '').trim();
      const telas = Array.isArray(body.telas) ? body.telas.filter(t => ['mp','pa','bobinas'].includes(t)) : [];
      if (!nome) return jsonErr(res, 400, 'Nome obrigatório');
      if (!telas.length) return jsonErr(res, 400, 'Selecione ao menos uma tela');
      let lista = [];
      try { lista = JSON.parse(configGet('colaboradores', '[]')); } catch(e) {}
      const id = body.id || ('C' + Date.now());
      const idx = lista.findIndex(c => c.id === id);
      if (idx < 0 && !pin) return jsonErr(res, 400, 'PIN obrigatório no cadastro');
      if (pin && !/^\d{4,8}$/.test(pin)) return jsonErr(res, 400, 'O PIN deve ter de 4 a 8 números');
      // PIN não pode repetir (senão a entrada ficaria ambígua)
      if (pin) {
        const h = hashSenha(pin);
        if (lista.some(c => c.id !== id && c.pin_hash === h)) return jsonErr(res, 400, 'Este PIN já está em uso por outro colaborador');
      }
      const reg = {
        id, nome, telas, ativo: body.ativo !== false,
        pin_hash: pin ? hashSenha(pin) : (idx >= 0 ? lista[idx].pin_hash : null),
      };
      if (idx >= 0) lista[idx] = reg; else lista.push(reg);
      configSet('colaboradores', JSON.stringify(lista));
      logI('acesso', `Colaborador ${idx >= 0 ? 'atualizado' : 'cadastrado'}: ${nome} (${telas.join(', ')})`);
      return jsonOk(res, { salvo: true, id });
    }

    if (pathname === '/colaboradores/remover' && req.method === 'POST') {
      let body; try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
      let lista = [];
      try { lista = JSON.parse(configGet('colaboradores', '[]')); } catch(e) {}
      const antes = lista.length;
      const alvo = lista.find(c => c.id === body.id);
      lista = lista.filter(c => c.id !== body.id);
      configSet('colaboradores', JSON.stringify(lista));
      if (alvo) logI('acesso', `Colaborador removido: ${alvo.nome}`);
      return jsonOk(res, { removidos: antes - lista.length });
    }

    // Entrada na tela: valida o PIN e devolve o nome do responsável.
    if (pathname === '/colaboradores/entrar' && req.method === 'POST') {
      let body; try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
      const pin  = String(body.pin || '').trim();
      const tela = String(body.tela || '').trim();
      let lista = [];
      try { lista = JSON.parse(configGet('colaboradores', '[]')); } catch(e) {}
      if (!lista.length) return jsonErr(res, 503, 'Nenhum colaborador cadastrado. Peça à manutenção para cadastrar.', { sem_cadastro: true });
      const h = hashSenha(pin);
      const c = lista.find(x => x.pin_hash === h && x.ativo !== false);
      if (!c) {
        logDesvio({ tipo: 'pin_incorreto', tela, detalhe: 'PIN não confere' });
        return jsonErr(res, 401, 'Senha não confere');
      }
      if (tela && !(c.telas || []).includes(tela)) {
        logDesvio({ tipo: 'pin_sem_permissao', tela, detalhe: `${c.nome} não tem acesso a ${tela}` });
        return jsonErr(res, 403, `${c.nome}, você não tem acesso a esta tela`);
      }
      logI('acesso', `${c.nome} entrou em ${tela || '?'}`);
      return jsonOk(res, { id: c.id, nome: c.nome, telas: c.telas || [] });
    }

    // Turnos disponíveis para a retirada (cada um é o cliente da venda).
    if (pathname === '/bobinas/turnos' && req.method === 'GET') {
      let mapa = {};
      try { mapa = JSON.parse(configGet('mapa_turno_bobina', '{}')); } catch(e) {}
      const turnos = Object.entries(mapa).map(([codigo, t]) => ({ codigo, label: t.label || codigo, contatoId: t.contatoId }));
      return jsonOk(res, { turnos });
    }

    // Consulta a bobina antes de dar baixa (o operador confere na tela).
    if ((m = pathname.match(/^\/bobinas\/([A-Z]\d+)$/)) && req.method === 'GET') {
      const bid = m[1];
      const e = dbStmts.getEtiqueta.get(bid);
      if (!e) return jsonErr(res, 404, `Etiqueta ${bid} não encontrada`);
      if (e.tipo !== 'extrusao') return jsonErr(res, 400, `${bid} não é bobina de extrusão (é ${e.tipo})`);
      const mapaBobinas = JSON.parse(configGet('mapa_bobina_bling', '{}'));
      const chave = `${(e.cor||'').toUpperCase()}|${(e.tipo_bobina||'').toUpperCase()}|${e.largura}`;
      const prod = (e.sub_tipo === 'capa') ? (CAPAS_CATALOGO[e.sku] || {}) : (mapaBobinas[chave] || {});
      return jsonOk(res, { bobina: {
        id: e.id, cor: e.cor, tipo_bobina: e.tipo_bobina, largura: e.largura, peso: e.peso,
        sub_tipo: e.sub_tipo, sku: prod.sku || e.sku, status: e.status,
        operador: e.operador, maquina: e.maquina, hora_impressao: e.hora_impressao,
        bling_pedido_id: e.bling_pedido_id,
        produto_id: prod.id || null, chave,
      }});
    }

    // Dá baixa: cria o pedido de venda no Bling e marca a bobina como consumida.
    // Envia PRIMEIRO ao Bling e só marca como consumida se der certo — assim
    // nunca fica baixada aqui e não baixada lá (o operador pode tentar de novo).
    if (pathname === '/bobinas/baixa' && req.method === 'POST') {
      let body; try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
      const bid = String(body.id || '').trim().toUpperCase();
      if (!bid) return jsonErr(res, 400, 'id da bobina obrigatório');
      const e = dbStmts.getEtiqueta.get(bid);
      if (!e) return jsonErr(res, 404, `Etiqueta ${bid} não encontrada`);
      if (e.tipo !== 'extrusao') return jsonErr(res, 400, `${bid} não é bobina de extrusão`);
      if (e.status === 'cancelada') return jsonErr(res, 400, `Bobina ${bid} está cancelada`);
      if (e.status === 'consumida') {
        return jsonErr(res, 409, `Bobina ${bid} JÁ teve baixa`, {
          ja_baixada: true, quando: e.hora_bipagem || null, pedido: e.bling_pedido_id || null,
        });
      }

      const mapaBobinas = JSON.parse(configGet('mapa_bobina_bling', '{}'));
      const chave = `${(e.cor||'').toUpperCase()}|${(e.tipo_bobina||'').toUpperCase()}|${e.largura}`;
      const prod = (e.sub_tipo === 'capa') ? (CAPAS_CATALOGO[e.sku] || {}) : (mapaBobinas[chave] || {});
      if (!prod.id) return jsonErr(res, 400, `Sem produto no Bling para ${chave} — cadastre o mapa de bobinas antes.`);

      // O CLIENTE da venda é o turno que retirou (Turno A / C / Extra).
      const turnoCod = String(body.turno || '').trim().toUpperCase();
      if (!turnoCod) return jsonErr(res, 400, 'Selecione o turno antes de dar baixa');
      let mapaTurnos = {};
      try { mapaTurnos = JSON.parse(configGet('mapa_turno_bobina', '{}')); } catch(err) {}
      const turno = mapaTurnos[turnoCod];
      if (!turno || !turno.contatoId) return jsonErr(res, 400, `Turno "${turnoCod}" não cadastrado (mapa_turno_bobina)`);
      const idEko = turno.contatoId;

      // Observação do pedido: traz os dados de PRODUÇÃO gravados na etiqueta
      // (quem produziu, em qual máquina, quando e em que turno) — é o que dá
      // rastreabilidade da bobina dentro do Bling.
      const fmtDataHora = (iso) => {
        if (!iso) return null;
        try {
          return new Date(iso).toLocaleString('pt-BR', {
            timeZone: 'America/Sao_Paulo',
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit',
          });
        } catch(err) { return String(iso); }
      };
      const mapaTurnosExt = (() => { try { return JSON.parse(configGet('mapa_turno_extrusao', '{}')); } catch(err) { return {}; } })();
      const turnoProd = mapaTurnosExt[e.turno_codigo];
      const linhas = [];
      linhas.push(`RETIRADA DE BOBINA · Etiqueta ${bid}`);
      linhas.push(`Bobina: ${e.cor} · ${e.tipo_bobina} · ${e.largura} · ${Number(e.peso).toFixed(1)} kg`);
      const dadosProducao = [];
      if (e.operador) dadosProducao.push(`Operador ${e.operador}`);
      if (e.maquina)  dadosProducao.push(`Máquina ${e.maquina}`);
      if (e.hora_impressao) dadosProducao.push(fmtDataHora(e.hora_impressao));
      if (turnoProd && turnoProd.label) dadosProducao.push(turnoProd.label);
      else if (e.turno_codigo) dadosProducao.push(`Turno ${e.turno_codigo}`);
      if (dadosProducao.length) linhas.push(`Produção: ${dadosProducao.join(' · ')}`);
      const ret = [`${turno.label || turnoCod}`, fmtDataHora(new Date().toISOString())];
      if (body.destino)  ret.push(`Destino ${body.destino}`);
      if (body.operador) ret.push(`Retirado por ${body.operador}`);
      linhas.push(`Retirada: ${ret.filter(Boolean).join(' · ')}`);
      const observacoes = linhas.join('\n');

      // Descrição do item (linha única, aparece no item do pedido).
      const desc = `Bobina ${bid} · ${e.cor} ${e.tipo_bobina} ${e.largura} · ${Number(e.peso).toFixed(1)} kg`
                 + (e.operador ? ` · Op ${e.operador}` : '')
                 + (e.maquina ? ` · Maq ${e.maquina}` : '')
                 + ` · ${turno.label || turnoCod}`
                 + (body.destino ? ` · Destino ${body.destino}` : '');
      const simular = configGet('bling_simular', '1') === '1';
      let blingId = null;

      if (simular) {
        blingId = 'SIM-BOB-' + Date.now();
        logI('bling', `Baixa de bobina ${bid} SIMULADA (${blingId}) — ${turno.label || turnoCod}`);
      } else {
        try {
          const token = await getToken();
          const payload = JSON.stringify({
            data: dataLocalISO(),
            contato: { id: Number(idEko) },
            itens: [{
              produto:    { id: Number(prod.id) },
              ...(prod.sku ? { codigo: prod.sku } : {}),
              descricao:  desc,
              quantidade: Number(Number(e.peso).toFixed(3)),
              valor:      1,
            }],
            observacoes: observacoes,
          });
          const r = await proxyChamada(token, 'POST', '/Api/v3/pedidos/vendas', '', payload);
          let d = {}; try { d = JSON.parse(r.body); } catch(err) {}
          if (r.status >= 400 || !(d.data && d.data.id)) {
            const msg = (d.error && (d.error.description || d.error.message)) || `HTTP ${r.status}`;
            logW('bling', `Baixa de bobina ${bid} FALHOU: ${msg}`);
            return jsonErr(res, 502, `Bling recusou a baixa: ${msg}`, { detalhe: r.body ? String(r.body).slice(0, 400) : null });
          }
          blingId = String(d.data.id);
          logI('bling', `Baixa de bobina ${bid} enviada ao Bling (pedido ${blingId})`);
        } catch(err) {
          logW('bling', `Erro ao dar baixa na bobina ${bid}`, { erro: err && err.message });
          return jsonErr(res, 502, 'Erro ao enviar ao Bling: ' + (err && err.message));
        }
      }

      // Só marca como consumida DEPOIS que o Bling aceitou.
      const agora = new Date().toISOString();
      db.prepare(`UPDATE etiquetas SET status='consumida', hora_bipagem=?, bling_pedido_id=? WHERE id=?`)
        .run(agora, blingId && !String(blingId).startsWith('SIM-') ? Number(blingId) : null, bid);

      // Guarda no histórico do dia (para a tela mostrar o que já saiu).
      try {
        const hoje = dataLocalISO();
        const ch = 'baixas_bobinas_' + hoje;
        let lista = []; try { lista = JSON.parse(configGet(ch, '[]')); } catch(err) {}
        lista.unshift({ id: bid, cor: e.cor, tipo_bobina: e.tipo_bobina, largura: e.largura, peso: e.peso,
                        pedido: blingId, turno: turnoCod, turno_label: turno.label || turnoCod,
                        destino: body.destino || null, operador: body.operador || null, hora: agora });
        configSet(ch, JSON.stringify(lista.slice(0, 500)));
      } catch(err) {}

      return jsonOk(res, { baixada: true, id: bid, pedido: blingId, modo: simular ? 'simulacao' : 'real',
                           turno: turnoCod, turno_label: turno.label || turnoCod,
                           bobina: { cor: e.cor, tipo_bobina: e.tipo_bobina, largura: e.largura, peso: e.peso } });
    }

    // Histórico das baixas de hoje (a tela mostra o que já foi retirado).
    if (pathname === '/bobinas/baixas-hoje' && req.method === 'GET') {
      let lista = [];
      try { lista = JSON.parse(configGet('baixas_bobinas_' + dataLocalISO(), '[]')); } catch(e) {}
      const total = lista.reduce((a, b) => a + (Number(b.peso) || 0), 0);
      return jsonOk(res, { baixas: lista, qtd: lista.length, total_kg: +total.toFixed(3) });
    }

    if (pathname === '/inventario/produtos' && req.method === 'GET') {
      const cat = lerCatalogoMP();
      let mapaProd = {};
      try { mapaProd = JSON.parse(configGet('mapa_produto_bling', '{}')); } catch(e) {}
      const produtos = [];
      for (const chave of Object.keys(mapaProd)) {
        const partes = chave.split(':');
        const material = partes[0], cor = partes[1] || null, fornecedor = partes[2] || null;
        if (!cat.materiais[material]) continue;   // só MP conhecida (ignora bobina/PA)
        produtos.push({ material, materialNome: (cat.materiais[material].popular || material), cor, fornecedor, chave,
                        manual: !!MP_CONTAGEM_MANUAL[material], kgPorSaco: MP_CONTAGEM_MANUAL[material] || null });
      }
      produtos.sort((a,b) => a.chave.localeCompare(b.chave));
      return jsonOk(res, { produtos });
    }

    // Consulta o saldo do Bling para um produto (resolvendo variação por SKU).
    if (pathname === '/inventario/saldo' && req.method === 'GET') {
      const material = String(parsed.query.material || '').trim();
      const cor = String(parsed.query.cor || '').trim();
      const fornecedor = String(parsed.query.fornecedor || '').trim();
      const chave = chaveProduto(material, cor, fornecedor);
      let mapaProd = {}, mapaSku = {};
      try { mapaProd = JSON.parse(configGet('mapa_produto_bling', '{}')); } catch(e) {}
      try { mapaSku = JSON.parse(configGet('mapa_sku_variacao_mp', '{}')); } catch(e) {}
      const idProduto = mapaProd[chave];
      if (!idProduto) return jsonErr(res, 404, `Produto não cadastrado no Bling para ${chave}`);
      try {
        const token = await getToken();
        let idReal = Number(idProduto);
        if (mapaSku[chave]) idReal = Number(await resolverIdVariacaoPA(token, mapaSku[chave], idProduto));
        const r = await proxyChamada(token, 'GET', '/Api/v3/estoques/saldos', '?idsProdutos[]=' + idReal, '');
        let d = {}; try { d = JSON.parse(r.body); } catch(e) {}
        const item = Array.isArray(d.data) ? d.data[0] : (d.data || null);
        if (!item) return jsonErr(res, 502, 'O Bling não retornou saldo para este produto (confira se o app tem o escopo "Controle de estoque").', { idReal });
        return jsonOk(res, { chave, idProduto: idReal, saldoFisico: Number(item.saldoFisicoTotal || 0), saldoVirtual: Number(item.saldoVirtualTotal || 0) });
      } catch(e) {
        return jsonErr(res, 502, 'Erro ao consultar saldo no Bling: ' + e.message);
      }
    }

    // Inventário em andamento (itens já finalizados) — persistido no banco.
    if (pathname === '/inventario/atual' && req.method === 'GET') {
      let inv = { itens: [] };
      try { inv = JSON.parse(configGet('inventario_atual', '{"itens":[]}')); } catch(e) {}
      if (!Array.isArray(inv.itens)) inv.itens = [];
      return jsonOk(res, { inventario: inv });
    }

    // Salva um item finalizado (substitui se o mesmo produto for refeito).
    if (pathname === '/inventario/salvar' && req.method === 'POST') {
      let body; try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
      let inv = { inicio: new Date().toISOString(), itens: [] };
      try { const cur = configGet('inventario_atual', null); if (cur) inv = JSON.parse(cur); } catch(e) {}
      if (!inv.inicio) inv.inicio = new Date().toISOString();
      if (!Array.isArray(inv.itens)) inv.itens = [];
      const item = {
        material: String(body.material || ''), cor: body.cor || null, fornecedor: body.fornecedor || null,
        materialNome: body.materialNome || null,
        leituras: Array.isArray(body.leituras) ? body.leituras : [],
        somaLeitura: Number(body.somaLeitura) || 0,
        saldoBling: (body.saldoBling === null || body.saldoBling === undefined) ? null : Number(body.saldoBling),
        finalizadoEm: new Date().toISOString(),
      };
      item.divergencia = (item.saldoBling === null) ? null : +(item.somaLeitura - item.saldoBling).toFixed(3);
      const chave = chaveProduto(item.material, item.cor, item.fornecedor);
      const idx = inv.itens.findIndex(i => chaveProduto(i.material, i.cor, i.fornecedor) === chave);
      if (idx >= 0) inv.itens[idx] = item; else inv.itens.push(item);
      configSet('inventario_atual', JSON.stringify(inv));
      return jsonOk(res, { salvo: true, inventario: inv });
    }

    // Zera o inventário (finalização geral / começar um novo).
    if (pathname === '/inventario/limpar' && req.method === 'POST') {
      configSet('inventario_atual', JSON.stringify({ itens: [] }));
      logI('inventario', 'Inventário zerado (finalização geral ou novo)');
      return jsonOk(res, { limpo: true });
    }

    if (pathname === '/catalogo-mp' && req.method === 'GET') {
      const c = lerCatalogoMP();
      return jsonOk(res, { fornecedores: c.fornecedores, codigos: c.codigos, materiais: c.materiais });
    }

    // Cadastro de código gravimétrico pela tela de Manutenção (material + cor +
    // fornecedor → código). Grava no mesmo lugar que a tela de Recebimento lê.
    if (pathname === '/catalogo-mp/codigo' && req.method === 'POST') {
      let body; try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
      const matKey = String(body.matKey || '').trim().toUpperCase();
      const cor    = (body.cor    === null || body.cor    === undefined || body.cor    === '') ? null : String(body.cor).trim();
      const forn   = (body.forn   === null || body.forn   === undefined || body.forn   === '') ? null : String(body.forn).trim();
      const codigo = String(body.codigo || '').trim().toUpperCase();
      const cat = lerCatalogoMP();

      if (!cat.materiais[matKey]) return jsonErr(res, 400, `Material desconhecido: ${matKey || '(vazio)'}`);
      if (!/^[A-Z0-9]{1,10}$/.test(codigo)) return jsonErr(res, 400, 'O código deve ter de 1 a 10 letras ou números, sem espaços.');
      const coresMat = Array.isArray(cat.materiais[matKey].cores) ? cat.materiais[matKey].cores : [];
      if (coresMat.length > 0) {
        if (!cor) return jsonErr(res, 400, 'Selecione a cor.');
        if (!coresMat.includes(cor)) return jsonErr(res, 400, `Cor inválida para ${matKey}: ${cor}`);
      } else if (cor) {
        return jsonErr(res, 400, `${matKey} não usa cor.`);
      }
      const fornsMat = Array.isArray(cat.fornecedores[matKey]) ? cat.fornecedores[matKey] : [];
      if (forn && !fornsMat.includes(forn)) return jsonErr(res, 400, `Fornecedor não cadastrado em ${matKey}: ${forn}`);

      const codigos = cat.codigos;
      const mesmaComb = c => c.matKey === matKey && (c.cor || null) === cor && (c.forn || null) === forn;
      // Aviso (não bloqueia): mesmo código já usado por outra combinação.
      const conflitos = codigos.filter(c => c.codigo === codigo && !mesmaComb(c))
        .map(c => ({ matKey: c.matKey, cor: c.cor, forn: c.forn }));

      const idx = codigos.findIndex(mesmaComb);
      const anterior = idx >= 0 ? codigos[idx].codigo : null;
      if (idx >= 0) {
        codigos[idx] = { matKey, cor, forn, codigo };
      } else if (forn) {
        // A busca no cliente devolve o 1º match e uma entrada com forn=null vale
        // para qualquer fornecedor — então a específica precisa vir ANTES dela.
        const iCoringa = codigos.findIndex(c => c.matKey === matKey && (c.cor || null) === cor && (c.forn || null) === null);
        if (iCoringa >= 0) codigos.splice(iCoringa, 0, { matKey, cor, forn, codigo });
        else codigos.push({ matKey, cor, forn, codigo });
      } else {
        codigos.push({ matKey, cor, forn, codigo });
      }
      dbStmts.configSet.run('mp_codigos_gravimetricos', JSON.stringify(codigos));
      logI('db', `Código gravimétrico ${anterior ? 'atualizado' : 'cadastrado'}: ${matKey}/${cor || '-'}/${forn || 'todos'} = ${codigo}${anterior ? ` (era ${anterior})` : ''}`);
      return jsonOk(res, { salvo: true, atualizado: idx >= 0, anterior, conflitos, codigos });
    }

    if (pathname === '/catalogo-mp/codigo/remover' && req.method === 'POST') {
      let body; try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
      const matKey = String(body.matKey || '').trim().toUpperCase();
      const cor    = (body.cor  === null || body.cor  === undefined || body.cor  === '') ? null : String(body.cor).trim();
      const forn   = (body.forn === null || body.forn === undefined || body.forn === '') ? null : String(body.forn).trim();
      const cat = lerCatalogoMP();
      const codigos = cat.codigos;
      const idx = codigos.findIndex(c => c.matKey === matKey && (c.cor || null) === cor && (c.forn || null) === forn);
      if (idx < 0) return jsonErr(res, 404, 'Combinação não encontrada.');
      const removido = codigos[idx].codigo;
      codigos.splice(idx, 1);
      dbStmts.configSet.run('mp_codigos_gravimetricos', JSON.stringify(codigos));
      logI('db', `Código gravimétrico removido: ${matKey}/${cor || '-'}/${forn || 'todos'} (era ${removido})`);
      return jsonOk(res, { removido: true, codigo: removido, codigos });
    }
    if (pathname === '/config' && req.method === 'GET') {
      const all = db.prepare('SELECT chave, valor FROM config').all();
      const obj = {};
      for (const r of all) obj[r.chave] = r.valor;
      return jsonOk(res, { config: obj });
    }
    if (pathname === '/config' && req.method === 'POST') {
      let body; try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
      for (const [k,v] of Object.entries(body)) configSet(k, typeof v === 'string' ? v : JSON.stringify(v));
      logI('config', `Atualizado: ${Object.keys(body).join(', ')}`);
      return jsonOk(res, {});
    }

    // ─── PROXY /bling/* ───
    if (pathname.startsWith('/bling/') && pathname !== '/bling/status' && pathname !== '/bling/auth/start' && pathname !== '/bling/callback') {
      let token;
      try { token = await getToken(); } catch(e) { return jsonErr(res, 401, e.message); }
      const blingPath = pathname.replace('/bling', '/Api/v3');
      const body = await lerBody(req);
      try {
        let r = await proxyChamada(token, req.method, blingPath, parsed.search, body || null);
        if (r.status === 401 && tk.refreshToken) {
          await renovarToken();
          r = await proxyChamada(tk.accessToken, req.method, blingPath, parsed.search, body || null);
        }
        res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(r.body);
      } catch(e) { jsonErr(res, 502, 'Falha ao conectar com Bling', { detalhe: e.message }); }
      return;
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
    });

  } catch(e) {
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
  if (conta) OPS_EM_VOO++;
  try {
    return await requestHandlerBase(req, res);
  } finally {
    if (conta) { OPS_EM_VOO--; ULTIMA_OP_MS = Date.now(); }
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
    if (match) { PRINTER_ATIVA = match; PRINTER_DETECTADA = true; logI('print', `Impressora ATIVA: ${PRINTER_ATIVA}`); }
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
