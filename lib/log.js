// ════════════════════════════════════════════════════════════════════
//  LOGS — arquivo diário, movimentação de MP, CSV de extrusão/produção
//
//  Tudo que o sistema registra passa por aqui (logs/AAAA-MM-DD.log e subpastas).
// ════════════════════════════════════════════════════════════════════

const fs     = require('fs');
const path   = require('path');
const crypto = require('node:crypto');

const { BACKUP_DIR, LOG_DIR, PUBLIC_DIR, RAIZ } = require('./config');

// ════════════════════════════════════════════════════════════════════
//  LOGGER (arquivo diário em logs/AAAA-MM-DD.log)
// ════════════════════════════════════════════════════════════════════

function ensureDir(d) { try { fs.mkdirSync(d, { recursive: true }); } catch(e) {} }
const MP_LOG_DIR = path.join(LOG_DIR, 'mp');
ensureDir(LOG_DIR);
 ensureDir(MP_LOG_DIR);
 ensureDir(BACKUP_DIR);
 ensureDir(PUBLIC_DIR);

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
// nesse arquivo — pra ver dados frescos, use o endpoint /extrusao/dashboard,
// que consulta direto o SQLite.
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
// Estado do inicio automatico do Windows, gravado pelo
// conferir-inicio-automatico.ps1 a cada subida e a cada atualizacao
// remota. Vai no /healthcheck para dar para conferir de OUTRA maquina se
// o atalho da estacao aponta para a pasta certa - sem ir ate ela.
// Foi o que faltou em 29/08/2026: o Mini PC reiniciou e subiu o sistema
// antigo, e nao havia como saber disso de longe.
function estadoInicioAutomatico() {
  try {
    const bruto = fs.readFileSync(path.join(RAIZ, 'eko-autostart.json'), 'utf8');
    const e = JSON.parse(bruto);
    return {
      ok:            e.ok === true,
      corrigido:     e.corrigido === true,
      esperado:      e.esperado || null,
      encontrado:    e.encontrado || null,
      verificado_em: e.verificado_em || null,
      desativados:   Array.isArray(e.desativados) ? e.desativados.length : 0,
      erro:          e.erro || null,
    };
  } catch (err) {
    return { ok: null, motivo: 'ainda nao verificado nesta instalacao' };
  }
}

function commitAtual() {
  try {
    const head = fs.readFileSync(path.join(RAIZ, '.git', 'HEAD'), 'utf8').trim();
    const m = head.match(/^ref:\s*(.+)$/);
    if (!m) return head.slice(0, 7);                    // HEAD destacado: o proprio sha
    const ref = fs.readFileSync(path.join(RAIZ, '.git', m[1].trim()), 'utf8').trim();
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

module.exports = { commitAtual, dataLocalISO, ensureDir, estadoInicioAutomatico,
  gravarLogExtrusaoCSV, gravarLogProducaoBipagem, hashSenha, logD, logDesvio, logE, logI, logW,
  rangeUTCdoDiaLocal, };
