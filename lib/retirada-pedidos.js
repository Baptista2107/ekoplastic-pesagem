// ════════════════════════════════════════════════════════════════════
//  PEDIDO DE RETIRADA DE MP (06/11/2026, Gustavo)
//  ------------------------------------------------------------------
//  O Willian pede no painel da VPS (aba MP) material + lote + nº de bags.
//  Revisto 10/11/2026 (Gustavo): pode escolher também o PESO do bag
//  (pedido.peso em kg; null = qualquer peso do lote). Aqui no Mini PC:
//    · a tela de Retirada mostra os pedidos abertos (lista vem da VPS);
//    · cada bag bipado que bate material+cor+fornecedor+lote — e o peso,
//      quando o pedido tem peso — de um pedido aberto conta para ele (o de
//      peso escolhido antes do de "qualquer peso");
//    · mesmo lote com peso diferente = fora do pedido (pede motivo);
//    · bag fora de pedido: só sai com MOTIVO ("estoque furado" existe — o
//      bag do lote pedido pode não estar lá). O motivo vai para a VPS.
//  Modo (quem manda é a VPS):
//    · "teste"    → nada trava; a tela pergunta o motivo mas deixa seguir.
//    · "producao" → sem pedido não sai; bag fora só com motivo.
//  Sem lista da VPS (rede fora, ou lista velha demais) → NÃO trava: a
//  fábrica não pode parar por causa da rede.
//  Aditivo contado por sacos (lote 'SACOS') fica fora da regra.
//  Pedido em KG (12/11/2026, Gustavo): produto que sai por saco (Pigmento,
//  Dessecante, Auxiliar de Fluxo, Compatibilizante) é pedido em kg no
//  painel (`unidade: 'kg'`, kg_pedidos/kg_atendidos/kg_saco; bags_pedidos
//  vem null). Quem conta o kg é a VPS (pelas S que chegam no envio ao vivo);
//  aqui a tela mostra "X de Y kg · ≈ N sacos". O palete/bag inteiro (R) do
//  mesmo material, cor e fornecedor, de QUALQUER lote, é do pedido em kg.
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
// Peso em kg com 1 casa (como a VPS e a etiqueta gravam) ou null.
function pesoN(v) {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}
function chaveBag(o) {
  return [norm(o.material_key), norm(o.cor), norm(o.fornecedor), norm(o.lote)].join('|');
}
// Pedido em kg (produto por saco): sem lote, sem nº de bags.
const emKg = p => !!p && String(p.unidade || '').toLowerCase() === 'kg';
// Mesma régua da VPS (mp_bags._n + FORN_PESAGEM_PARA_BLING): sem acento,
// maiúsculas, espaços juntos e o apelido do fornecedor na grafia do Bling.
// Assim o palete que a VPS conta para o pedido também casa aqui.
const FORN_APELIDO = { 'FORCOPLAST': 'FORKOPLAST', 'FG': 'FG RESINAS', 'WT DOS SANTOS': 'WT PLASTICOS' };
const nVps = v => String(v == null ? '' : v).normalize('NFD').replace(/\p{Mn}/gu, '')
  .toUpperCase().split(/\s+/).filter(Boolean).join(' ');
const fornVps = v => { const f = nVps(v); return FORN_APELIDO[f] || f; };
const chaveProduto = o => [nVps(o.material_key), nVps(o.cor), fornVps(o.fornecedor)].join('|');
// Folga da VPS (_tolerancia_kg): meio saco.
const folgaKg = p => (Number(p.kg_saco) || 25) / 2;
const kgN = v => { const n = Number(v); return (v == null || v === '' || typeof v === 'boolean' || !Number.isFinite(n)) ? 0 : n; };
const quando = p => { const t = Date.parse(p.criado_em); return Number.isFinite(t) ? t : Infinity; };

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
// pedido". Pedido em kg: a mesma coisa pelo PESO da S (o palete inteiro),
// senão o 2º palete entrava como "do pedido" antes da VPS fechar o 1º.
function atendidosLocais() {
  const out = {};
  const linhas = db.prepare(`SELECT id, ref_id, peso, pedido_retirada FROM etiquetas
    WHERE tipo = 'retirada' AND status != 'cancelada' AND pedido_retirada IS NOT NULL`).all();
  for (const l of linhas) {
    let p; try { p = JSON.parse(l.pedido_retirada); } catch (e) { continue; }
    if (!p || p.fora || p.pedido_id == null) continue;
    const k = String(p.pedido_id);
    (out[k] = out[k] || []).push({ origem: l.ref_id || l.id, s: l.id, peso: kgN(l.peso) });
  }
  return out;
}

// kg: o que a VPS já contou + o peso das S daqui que ela ainda não viu
// (a VPS lista as S que contou em etiquetas_atendidas). Fecha como a VPS:
// com pelo menos 1 saída e faltando menos de meio saco.
function mesclarKg(p, daqui) {
  const vps = Array.isArray(p.etiquetas_atendidas) ? p.etiquetas_atendidas : [];
  const viu = new Set(vps.map(String));
  const novas = daqui.filter(d => !viu.has(String(d.s)));
  const kgVps = kgN(p.kg_atendidos);
  const kg = Math.round((kgVps + novas.reduce((t, d) => t + d.peso, 0)) * 10) / 10;
  const todas = [...new Set([...vps, ...novas.map(d => d.s)])];
  const fechou = todas.length > 0 && kg >= kgN(p.kg_pedidos) - folgaKg(p);
  return { ...p, kg_atendidos: Math.max(kgVps, kg), bags_atendidos: todas.length, etiquetas_atendidas: todas,
           status: (p.status === 'atendido' || fechou) ? 'atendido' : 'aberto' };
}

function mesclar(pedidos) {
  const loc = atendidosLocais();
  return pedidos.map(p => {
    if (emKg(p)) return mesclarKg(p, loc[String(p.id)] || []);
    const daqui = (loc[String(p.id)] || []).map(d => d.origem);
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
  const mesmoLote = abertos.filter(p => chaveBag(p) === k);
  const pesoBag = pesoN(bag.peso);
  const casou = mesmoLote.find(p => pesoN(p.peso) != null && pesoN(p.peso) === pesoBag)
             || mesmoLote.find(p => pesoN(p.peso) == null)
             // palete/bag inteiro de produto pedido em kg: qualquer lote;
             // o mais antigo primeiro (FIFO, como a VPS atribui)
             || abertos.filter(p => emKg(p) && chaveProduto(p) === chaveProduto(bag))
                       .sort((a, b) => quando(a) - quando(b))[0];
  if (casou) return { pode: true, registro: { pedido_id: casou.id, fora: false, modo: lista.modo } };

  const fora = pedido && pedido.fora_do_pedido;
  const motivo = fora && typeof fora.motivo === 'string' ? fora.motivo.trim().slice(0, 300) : '';
  const pedidoId = fora && fora.pedido_id != null ? fora.pedido_id : null;
  if (motivo) return { pode: true, registro: { pedido_id: pedidoId, fora: true, motivo, modo: lista.modo } };

  const recusa = {
    pode: false, http: 409,
    corpo: { fora_do_pedido: true, modo: lista.modo, sem_pedido: abertos.length === 0,
             // mesmo lote de um pedido, mas o peso não bate com nenhum
             peso_diferente: mesmoLote.length > 0,
             pedidos: abertos.map(p => ({ id: p.id, material_nome: p.material_nome, material_key: p.material_key,
                                          cor: p.cor, fornecedor: p.fornecedor, lote: p.lote, peso: pesoN(p.peso),
                                          bags_pedidos: p.bags_pedidos, bags_atendidos: p.bags_atendidos,
                                          unidade: emKg(p) ? 'kg' : 'bag', kg_pedidos: p.kg_pedidos,
                                          kg_atendidos: p.kg_atendidos, kg_saco: p.kg_saco })) },
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

module.exports = { atualizar, avaliar, ligado, chaveBag, emKg, pesoN, enfileirarFora, enviarFila, listarPedidos, lerFila };
