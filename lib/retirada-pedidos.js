// ════════════════════════════════════════════════════════════════════
//  PEDIDO DE RETIRADA DE MP (06/11/2026, Gustavo)
//  ------------------------------------------------------------------
//  O Willian pede no painel da VPS (aba MP) material + lote + nº de bags,
//  nunca um bag específico. Aqui no Mini PC:
//    · a tela de Retirada mostra os pedidos abertos (lista vem da VPS);
//    · cada bag bipado que bate material+cor+fornecedor+lote de um pedido
//      aberto conta para ele;
//    · bag fora de pedido: só sai com MOTIVO ("estoque furado" existe — o
//      bag do lote pedido pode não estar lá). O motivo vai para a VPS.
//  Modo (quem manda é a VPS):
//    · "teste"    → nada trava; a tela pergunta o motivo mas deixa seguir.
//    · "producao" → sem pedido não sai; bag fora só com motivo.
//  Sem lista da VPS (rede fora, ou lista velha demais) → NÃO trava: a
//  fábrica não pode parar por causa da rede.
//  Aditivo contado por sacos (lote 'SACOS') fica fora da regra.
//  CHAVE LOCAL `retirada_pedidos_ligado` (config): só com '1' este Mini PC
//  pergunta à VPS e aplica a regra. Padrão DESLIGADO: atualizar o sistema
//  não muda nada até alguém ligar (POST /config) — e os testes antigos, que
//  não apontam a VPS para lugar nenhum, nunca falam com a VPS de verdade.
// ════════════════════════════════════════════════════════════════════

const { logI, logW } = require('./log');
const { configGet, configSet, db } = require('./db');

// EKO_RETIRADA_CACHE_MS: só para teste (testes/retirada-pedidos.js); padrão 10 s.
const CACHE_MS = process.env.EKO_RETIRADA_CACHE_MS != null ? Number(process.env.EKO_RETIRADA_CACHE_MS) : 10 * 1000;
// Depois de uma falha, não pergunta de novo por PAUSA_MS: o bipe consulta a
// VPS antes de decidir, e com a rede fora cada bipe esperaria o timeout.
const PAUSA_MS = process.env.EKO_RETIRADA_PAUSA_MS != null ? Number(process.env.EKO_RETIRADA_PAUSA_MS) : 30 * 1000;
const LISTA_VALE_MS = 30 * 60 * 1000;    // lista mais velha que isso não trava nada
const TIMEOUT_MS = 3000;
const CHAVE_ULTIMO = 'retirada_pedidos_ultimo';
const CHAVE_FILA = 'retirada_fora_fila';

function ligado() { return String(configGet('retirada_pedidos_ligado', '0')) === '1'; }

function origemVps() {
  return new URL(configGet('vps_sacoleiras_url', 'http://100.107.130.114:8765/api/sacoleiras/agora')).origin;
}

const norm = v => String(v == null ? '' : v).trim().toUpperCase();
function chaveBag(o) {
  return [norm(o.material_key), norm(o.cor), norm(o.fornecedor), norm(o.lote)].join('|');
}

function lerJsonConfig(chave) {
  try { return JSON.parse(configGet(chave, 'null')); } catch (e) { return null; }
}

// Último retorno BOM da VPS: { em: ms, dados: {modo, pedidos} }. Fica na
// tabela config (disco) para sobreviver a um reinício do servidor.
let _ultimo = null;
let _buscando = null;
let _falhouEm = 0;
function ultimoBom() {
  if (!_ultimo) _ultimo = lerJsonConfig(CHAVE_ULTIMO);
  return _ultimo;
}

async function buscarVps() {
  const r = await fetch(origemVps() + '/api/mp/retirada/abertos', { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const d = await r.json();
  if (!d || d.ok !== true || !Array.isArray(d.pedidos)) throw new Error((d && d.erro) || ('HTTP ' + r.status));
  const dados = { modo: d.modo === 'producao' ? 'producao' : 'teste', pedidos: d.pedidos };
  _ultimo = { em: Date.now(), dados };
  configSet(CHAVE_ULTIMO, JSON.stringify(_ultimo));
  return _ultimo;
}

// Quantos bags este Mini PC já tirou para cada pedido (retiradas não
// canceladas). A VPS só fica sabendo depois do envio ao vivo; até lá, a
// conta daqui é que impede o 4º bag de um pedido de 3 entrar como "do
// pedido".
function atendidosLocais() {
  const out = {};
  const linhas = db.prepare(`SELECT id, ref_id, pedido_retirada FROM etiquetas
    WHERE tipo = 'retirada' AND status != 'cancelada' AND pedido_retirada IS NOT NULL`).all();
  for (const l of linhas) {
    let p; try { p = JSON.parse(l.pedido_retirada); } catch (e) { continue; }
    if (!p || p.fora || p.pedido_id == null) continue;
    const k = String(p.pedido_id);
    (out[k] = out[k] || []).push(l.ref_id || l.id);
  }
  return out;
}

function mesclar(pedidos) {
  const loc = atendidosLocais();
  return pedidos.map(p => {
    const daqui = loc[String(p.id)] || [];
    const vps = Array.isArray(p.etiquetas_atendidas) ? p.etiquetas_atendidas : [];
    const todas = [...new Set([...vps, ...daqui])];
    const atend = Math.max(Number(p.bags_atendidos) || 0, todas.length);
    const pedidosN = Number(p.bags_pedidos) || 0;
    return { ...p, bags_atendidos: atend, etiquetas_atendidas: todas,
             status: (p.status === 'atendido' || (pedidosN > 0 && atend >= pedidosN)) ? 'atendido' : 'aberto' };
  });
}

// GET /retirada/pedidos. Nunca levanta: VPS fora devolve o último bom.
async function listarPedidos() {
  if (!ligado()) return { desligado: true, modo: null, pedidos: [] };
  const agora = Date.now();
  let u = ultimoBom();
  let desatualizado = false, erro = null;
  if (!u || agora - u.em > CACHE_MS) {
    if (_falhouEm && agora - _falhouEm < PAUSA_MS) {
      erro = 'VPS sem resposta (nova tentativa em instantes)'; desatualizado = true;
    } else {
      try {
        if (!_buscando) _buscando = buscarVps().finally(() => { _buscando = null; });
        u = await _buscando;
        _falhouEm = 0;
      } catch (e) {
        _falhouEm = Date.now();
        erro = e.message; desatualizado = true; u = ultimoBom();
      }
    }
  }
  enviarFila().catch(() => {});
  if (!u) return { indisponivel: true, erro, modo: null, pedidos: [] };
  return { modo: u.dados.modo, pedidos: mesclar(u.dados.pedidos), desatualizado,
           idade_s: Math.round((agora - u.em) / 1000), ...(erro ? { erro } : {}) };
}

// Lista que pode TRAVAR: só a que veio da VPS há menos de LISTA_VALE_MS.
function listaVigente() {
  if (!ligado()) return null;
  const u = ultimoBom();
  if (!u || Date.now() - u.em > LISTA_VALE_MS) return null;
  return { modo: u.dados.modo, pedidos: mesclar(u.dados.pedidos) };
}

// Decide se um bag pode sair. `bag` = etiqueta de ORIGEM como está no banco.
// pedido = { fora_do_pedido?: {motivo, pedido_id}, checar_pedido?: bool }
// → { pode: true, registro: obj|null } | { pode: false, http: 409, corpo }
function avaliar(bag, pedido) {
  if (norm(bag.lote) === 'SACOS') return { pode: true, registro: null };
  const lista = listaVigente();
  if (!lista) return { pode: true, registro: null };
  const abertos = lista.pedidos.filter(p => p.status === 'aberto');
  const k = chaveBag(bag);
  const casou = abertos.find(p => chaveBag(p) === k);
  if (casou) return { pode: true, registro: { pedido_id: casou.id, fora: false, modo: lista.modo } };

  const fora = pedido && pedido.fora_do_pedido;
  const motivo = fora && typeof fora.motivo === 'string' ? fora.motivo.trim().slice(0, 300) : '';
  const pedidoId = fora && fora.pedido_id != null ? fora.pedido_id : null;
  if (motivo) return { pode: true, registro: { pedido_id: pedidoId, fora: true, motivo, modo: lista.modo } };

  const recusa = {
    pode: false, http: 409,
    corpo: { fora_do_pedido: true, modo: lista.modo, sem_pedido: abertos.length === 0,
             pedidos: abertos.map(p => ({ id: p.id, material_nome: p.material_nome, material_key: p.material_key,
                                          cor: p.cor, fornecedor: p.fornecedor, lote: p.lote,
                                          bags_pedidos: p.bags_pedidos, bags_atendidos: p.bags_atendidos })) },
  };
  if (lista.modo === 'producao') return recusa;
  // Teste: a tela nova pede para checar antes (abre o modal); se o operador
  // seguiu sem motivo, ou a tela é antiga, sai e fica registrado.
  if (pedido && pedido.checar_pedido && !fora) return recusa;
  return { pode: true, registro: { pedido_id: pedidoId, fora: true, motivo: null, modo: lista.modo } };
}

// ── Fila de "saiu fora do pedido" para a VPS ────────────────────────
// Chave = etiqueta de origem: enfileirar de novo a mesma etiqueta só
// substitui (idempotente). Sai da fila quando a VPS responde ok.
function lerFila() { return lerJsonConfig(CHAVE_FILA) || {}; }
function gravarFila(f) { configSet(CHAVE_FILA, JSON.stringify(f)); }

function enfileirarFora(corpo) {
  const f = lerFila();
  f[corpo.etiqueta_id] = { corpo, em: new Date().toISOString() };
  gravarFila(f);
}

let _enviando = null;
function enviarFila() {
  if (_enviando) return _enviando;
  _enviando = (async () => {
    if (!ligado()) return 0;
    const f = lerFila();
    const ids = Object.keys(f);
    if (!ids.length) return 0;
    let base; try { base = origemVps(); } catch (e) { return 0; }
    let enviados = 0;
    for (const id of ids) {
      try {
        const r = await fetch(base + '/api/mp/retirada/fora-do-pedido', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(f[id].corpo), signal: AbortSignal.timeout(TIMEOUT_MS * 2) });
        const d = await r.json().catch(() => null);
        if (!d || d.ok !== true) throw new Error((d && d.erro) || ('HTTP ' + r.status));
        const atual = lerFila(); delete atual[id]; gravarFila(atual);
        enviados++;
        logI('retirada', `fora do pedido entregue à VPS: ${id}`);
      } catch (e) {
        logW('retirada', `fora do pedido NÃO chegou à VPS (fica na fila): ${id}`, { erro: e.message });
        break;   // VPS fora: tenta o resto na próxima rodada
      }
    }
    return enviados;
  })().finally(() => { _enviando = null; });
  return _enviando;
}

// Reenvio de fundo: a tela também puxa a fila a cada GET, mas sem tela
// aberta a fila ainda anda.
const _timer = setInterval(() => { enviarFila().catch(() => {}); }, 60 * 1000);
if (_timer.unref) _timer.unref();

// Antes de decidir um bipe: lista fresca se der (pedido acabado de criar no
// painel já vale). Nunca levanta.
async function atualizar() { try { await listarPedidos(); } catch (e) {} }

module.exports = { atualizar, avaliar, ligado, chaveBag, enfileirarFora, enviarFila, listarPedidos, lerFila };
