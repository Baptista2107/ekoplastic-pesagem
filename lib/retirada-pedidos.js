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
//    · "teste"    → nada trava; a tela pergunta o motivo mas deixa seguir
//                   (sem NENHUM pedido aberto nem pergunta: sai direto, 16/11).
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
// Motivo que a VPS recusou de vez (400 que não é o teto por hora): sai da
// fila e fica guardado aqui, para não travar os motivos seguintes.
const CHAVE_RECUSADOS = 'retirada_fora_recusados';
// Mesmos limites da VPS (mp_pedido_retirada.MOTIVO_MAX / _RE_ETIQ): o que
// passa daqui a VPS aceita; antes (até 16/11) a tela deixava 300 e a VPS
// recusava acima de 200, e o item recusado travava a fila para sempre.
const MOTIVO_MAX = 200;
const RE_ETIQ_VPS = /^[RST]\d{7}$/;
const ERRO_TETO_HORA = 'muitos registros na última hora';

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
// Retorno guardado sem a forma esperada (config mexida, versão antiga) vale
// como "sem lista": nada trava e a próxima busca grava um bom por cima.
const retornoValido = u => !!(u && Number.isFinite(u.em) && u.dados && Array.isArray(u.dados.pedidos));
// Pedido que não é objeto (null, texto) não entra em conta nenhuma.
const soPedidos = l => (Array.isArray(l) ? l : []).filter(p => p && typeof p === 'object' && !Array.isArray(p));
function ultimoBom() {
  if (!_ultimo) _ultimo = lerJsonConfig(CHAVE_ULTIMO);
  if (!retornoValido(_ultimo)) _ultimo = null;
  return _ultimo;
}

async function buscarVps() {
  const r = await fetch(origemVps() + '/api/mp/retirada/abertos', { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const d = await r.json();
  if (!d || d.ok !== true || !Array.isArray(d.pedidos)) throw new Error((d && d.erro) || ('HTTP ' + r.status));
  const dados = { modo: d.modo === 'producao' ? 'producao' : 'teste', pedidos: soPedidos(d.pedidos) };
  _ultimo = { em: Date.now(), dados };
  configSet(CHAVE_ULTIMO, JSON.stringify(_ultimo));
  return _ultimo;
}

// Quantos bags este Mini PC já tirou para cada pedido (retiradas não
// canceladas). A VPS só fica sabendo depois do envio ao vivo; até lá, a
// conta daqui é que impede o 4º bag de um pedido de 3 entrar como "do
// pedido". Pedido em kg: a mesma coisa pelo PESO da S (o palete inteiro),
// senão o 2º palete entrava como "do pedido" antes da VPS fechar o 1º.
// `desde` (ISO): só as saídas a partir daí — um dia antes do pedido aberto
// mais antigo basta (a S de um pedido nasce depois dele); sem isso a busca
// lia todas as retiradas com pedido desde sempre, 2x por bipe.
function atendidosLocais(desde) {
  const out = {};
  const linhas = desde
    ? db.prepare(`SELECT id, ref_id, peso, pedido_retirada FROM etiquetas
        WHERE tipo = 'retirada' AND status != 'cancelada' AND pedido_retirada IS NOT NULL
          AND hora_impressao >= ?`).all(desde)
    : db.prepare(`SELECT id, ref_id, peso, pedido_retirada FROM etiquetas
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
  // peso ≤ 0 a VPS descarta (nunca listaria): aqui também
  const novas = daqui.filter(d => d.peso > 0 && !viu.has(String(d.s)));
  const kgVps = kgN(p.kg_atendidos);
  const kg = Math.round((kgVps + novas.reduce((t, d) => t + d.peso, 0)) * 10) / 10;
  const todas = [...new Set([...vps, ...novas.map(d => d.s)])];
  const fechou = todas.length > 0 && kg >= kgN(p.kg_pedidos) - folgaKg(p);
  return { ...p, kg_atendidos: Math.max(kgVps, kg), bags_atendidos: todas.length, etiquetas_atendidas: todas,
           status: (p.status === 'atendido' || fechou) ? 'atendido' : 'aberto' };
}

// Saída por SACOS (/retirada/aditivo: lote 'SACOS', sem ref_id) não passa
// pelo avaliar e não ganha registro de pedido, mas é a saída mais comum
// desses produtos e a VPS conta todas pelo peso. As que a VPS ainda não
// listou vão, aqui, para o pedido em kg aberto mais antigo do mesmo produto
// criado antes delas — como lá (FIFO, a S inteira para um pedido só, fecha
// faltando menos de meio saco). Sem isso, depois de 8 sacos que fecham um
// pedido de 200 kg o palete seguinte ainda entrava como "do pedido".
function sacosLocaisKg(pedidos, loc) {
  const kgs = pedidos.filter(p => emKg(p) && Number.isFinite(quando(p)));
  const out = {};
  if (!kgs.length) return out;
  const viu = new Set();
  for (const p of pedidos) for (const e of (Array.isArray(p.etiquetas_atendidas) ? p.etiquetas_atendidas : [])) viu.add(String(e));
  const desde = new Date(Math.min(...kgs.map(quando)) - 24 * 3600 * 1000).toISOString();   // corte largo; o exato é abaixo
  const linhas = db.prepare(`SELECT id, material_key, cor, fornecedor, peso, hora_impressao FROM etiquetas
    WHERE tipo = 'retirada' AND status != 'cancelada' AND lote = 'SACOS' AND ref_id IS NULL
      AND hora_impressao >= ? ORDER BY hora_impressao, id`).all(desde);
  const est = {};
  for (const p of kgs) {
    const r = mesclarKg(p, loc[String(p.id)] || []);
    est[p.id] = { kg: r.kg_atendidos, fechado: r.status === 'atendido' };
  }
  for (const l of linhas) {
    const peso = kgN(l.peso), hora = Date.parse(l.hora_impressao);
    if (viu.has(String(l.id)) || !(peso > 0) || !Number.isFinite(hora)) continue;
    const k = chaveProduto(l);
    const p = kgs.filter(x => !est[x.id].fechado && chaveProduto(x) === k && quando(x) <= hora)
                 .sort((a, b) => quando(a) - quando(b))[0];
    if (!p) continue;
    est[p.id].kg += peso;
    (out[p.id] = out[p.id] || []).push({ origem: l.id, s: l.id, peso });
    if (est[p.id].kg >= kgN(p.kg_pedidos) - folgaKg(p)) est[p.id].fechado = true;
  }
  return out;
}

// A conta junta o que a VPS já contou com o que só este Mini PC sabe. A VPS
// lista em etiquetas_atendidas o id da S (a saída); daqui também vai a S —
// até 16/11/2026 ia o R de origem, e o mesmo bag contava 2x (num pedido de
// 3 bags, o 2º fechava o pedido e o 3º levava 409 em produção). S que a VPS
// já pôs em QUALQUER pedido é dela: a fila (FIFO) quem decide é lá; aqui só
// entra a S que ela ainda não viu.
function mesclar(pedidosVps) {
  const pedidos = soPedidos(pedidosVps);
  if (!pedidos.length) return [];
  // Corte pela data: só se TODO pedido tem data (sem data, lê tudo).
  const datas = pedidos.map(quando);
  const desde = pedidos.length && datas.every(Number.isFinite)
    ? new Date(Math.min(...datas) - 24 * 3600 * 1000).toISOString() : null;
  const loc = atendidosLocais(desde);
  const viuVps = new Set();
  for (const p of pedidos) for (const e of (Array.isArray(p.etiquetas_atendidas) ? p.etiquetas_atendidas : [])) viuVps.add(String(e));
  const naoVista = ds => (ds || []).filter(d => !viuVps.has(String(d.s)));
  const locN = {};
  for (const id of Object.keys(loc)) locN[id] = naoVista(loc[id]);
  const sacos = sacosLocaisKg(pedidos, locN);
  return pedidos.map(p => {
    if (emKg(p)) return mesclarKg(p, [...(locN[String(p.id)] || []), ...(sacos[String(p.id)] || [])]);
    const daqui = (locN[String(p.id)] || []).map(d => d.s);
    const vps = Array.isArray(p.etiquetas_atendidas) ? p.etiquetas_atendidas : [];
    const todas = [...new Set([...vps.map(String), ...daqui])];
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
  let pedidos;
  try { pedidos = mesclar(u.dados.pedidos); }
  catch (e) {
    // A conta local quebrou (banco, JSON): mostra a lista como a VPS mandou.
    logW('retirada', 'conta local dos pedidos falhou — lista sem a parte deste Mini PC', { erro: e.message });
    pedidos = soPedidos(u.dados.pedidos);
  }
  return { modo: u.dados.modo, pedidos, desatualizado,
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
// `lida` = a etiqueta como SAI (troca de produto aplicada): a S é gravada
// com o produto novo e é por ele que a VPS casa o pedido em kg.
// → { pode: true, registro: obj|null } | { pode: false, http: 409, corpo }
// Nunca levanta: erro na conta (lista guardada estranha, banco) deixa o bag
// sair sem registro — a retirada não pode parar por causa do pedido.
function avaliar(bag, pedido, lida) {
  try { return avaliarSemProtecao(bag, pedido, lida); }
  catch (e) {
    logW('retirada', `pedido de retirada: avaliação falhou, ${bag && bag.id} sai sem registro`, { erro: e.message });
    return { pode: true, registro: null };
  }
}

function avaliarSemProtecao(bag, pedido, lida) {
  if (norm(bag.lote) === 'SACOS') return { pode: true, registro: null };
  const lista = listaVigente();
  if (!lista) return { pode: true, registro: null };
  // FIFO, como a VPS (_atribuir ordena por criado_em, id)
  const abertos = lista.pedidos.filter(p => p.status === 'aberto')
    .sort((a, b) => (quando(a) - quando(b)) || String(a.id).localeCompare(String(b.id)));
  // A ordem de quem serve é a da VPS (mp_pedido_retirada._atribuir), do mais
  // restrito ao mais largo — senão o largo come o único bag que serve ao outro:
  //   1. bag ESCOLHIDO no painel (bags: [{id}]) — o bag é daquele pedido;
  //   2. mesmo lote e o peso escolhido; 3. mesmo lote, qualquer peso;
  //   4. POR PRODUTO (lote vazio: o único que a tela da VPS cria desde
  //      11/11/2026) — mesmo material, cor e fornecedor, QUALQUER lote de bag
  //      de verdade. Até 16/11 este caso não existia aqui: todo bag desses
  //      pedidos caía como "fora do pedido" (409 em produção);
  //   5. pedido em kg (produto por saco), qualquer lote.
  // Pedido com bag escolhido só recebe o bag escolhido (passos 2-4 pulam ele).
  const escolheu = p => !emKg(p) && Array.isArray(p.bags) && p.bags.some(b => b && b.id);
  const porProduto = p => !emKg(p) && !norm(p.lote);
  const k = chaveBag(bag);
  const kProd = [norm(bag.material_key), norm(bag.cor), norm(bag.fornecedor)].join('|');
  const bagDeLote = !!norm(bag.lote);          // SACOS já saiu lá em cima
  const mesmoLote = abertos.filter(p => !emKg(p) && !escolheu(p) && !porProduto(p) && chaveBag(p) === k);
  const pesoBag = pesoN(bag.peso);
  const casou = abertos.find(p => escolheu(p) && p.bags.some(b => b && norm(b.id) === norm(bag.id) && !b.saiu))
             || mesmoLote.find(p => pesoN(p.peso) != null && pesoN(p.peso) === pesoBag)
             || mesmoLote.find(p => pesoN(p.peso) == null)
             || (bagDeLote && abertos.find(p => porProduto(p) && !escolheu(p)
                  && [norm(p.material_key), norm(p.cor), norm(p.fornecedor)].join('|') === kProd))
             // palete/bag inteiro de produto pedido em kg: qualquer lote;
             // o mais antigo primeiro (FIFO, como a VPS atribui)
             || abertos.find(p => emKg(p) && chaveProduto(p) === chaveProduto(lida || bag));
  if (casou) return { pode: true, registro: { pedido_id: casou.id, fora: false, modo: lista.modo } };

  // Teste e NENHUM pedido aberto (16/11/2026): o bag sai como sempre saiu,
  // sem janela de motivo e sem registro — o aviso juntado de "retirada sem
  // pedido" da VPS (de 15 em 15 min) já conta essas saídas. Antes cada bipe
  // abria a janela e virava um Telegram por bag ao Willian, e é o caso mais
  // comum (lista vazia). Em produção continua: sem pedido não sai.
  if (lista.modo !== 'producao' && abertos.length === 0) return { pode: true, registro: null };

  const fora = pedido && pedido.fora_do_pedido;
  const motivo = fora && typeof fora.motivo === 'string' ? fora.motivo.trim().slice(0, MOTIVO_MAX) : '';
  const pedidoId = fora && fora.pedido_id != null && fora.pedido_id !== '' ? String(fora.pedido_id).slice(0, 30) : null;
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
function lerRecusados() { return lerJsonConfig(CHAVE_RECUSADOS) || {}; }
// Guarda só os RECUSADOS_MAX mais recentes (16/11/2026): a lista mora na
// tabela config e crescia sem limite.
const RECUSADOS_MAX = 200;
function guardarRecusado(id, registro) {
  const rec = lerRecusados();
  rec[id] = registro;
  const ids = Object.keys(rec);
  if (ids.length > RECUSADOS_MAX) {
    ids.sort((a, b) => String(rec[a].recusado_em || '').localeCompare(String(rec[b].recusado_em || '')));
    for (const velho of ids.slice(0, ids.length - RECUSADOS_MAX)) delete rec[velho];
  }
  configSet(CHAVE_RECUSADOS, JSON.stringify(rec));
}
// Erro do servidor (5xx) repetido no MESMO item: depois de FALHAS_5XX_MAX
// SEGUIDAS, espalhadas por pelo menos FALHAS_5XX_JANELA_MS, ele vai para os
// recusados — senão travaria a fila para sempre (ex.: texto que a VPS não
// consegue gravar). A janela (16/11/2026, revisão M4) é porque a fila roda a
// cada GET da tela (15 s): 5 erros de um deploy ruim de 1 minuto descartavam o
// motivo. Qualquer resposta que não seja 5xx (e VPS sem resposta) zera a conta.
const FALHAS_5XX_MAX = 5;
const FALHAS_5XX_JANELA_MS = 60 * 60 * 1000;

// Corpo no formato que a VPS aceita (registrar_fora_do_pedido): motivo
// ≤ 200, pedido_id texto ≤ 30 ou null, operador ≤ 60. Etiqueta fora de
// [RST] a VPS nunca aceita: nem entra na fila (só log).
function corpoParaVps(c) {
  const etiqueta_id = String((c && c.etiqueta_id) || '').trim();
  const motivo = typeof c.motivo === 'string' ? c.motivo.trim().slice(0, MOTIVO_MAX) : '';
  const sessao = c.sessao_id != null && c.sessao_id !== '' ? Number(c.sessao_id) : null;
  return {
    etiqueta_id, motivo,
    sessao_id: Number.isFinite(sessao) ? sessao : null,
    operador: c.operador ? String(c.operador).slice(0, 60) : null,
    pedido_id: c.pedido_id != null && c.pedido_id !== '' ? String(c.pedido_id).slice(0, 30) : null,
  };
}

function enfileirarFora(corpoBruto) {
  const corpo = corpoParaVps(corpoBruto || {});
  if (!RE_ETIQ_VPS.test(corpo.etiqueta_id) || !corpo.motivo) {
    logW('retirada', `fora do pedido NÃO enfileirado (a VPS não aceitaria): ${corpo.etiqueta_id || '?'}`,
         { motivo: corpo.motivo ? 'ok' : 'vazio' });
    return false;
  }
  const f = lerFila();
  f[corpo.etiqueta_id] = { corpo, em: new Date().toISOString() };
  gravarFila(f);
  return true;
}

// Recusa que não passa tentando de novo: 4xx que não é o teto por hora.
function recusaDeVez(status, erro) {
  if (status === 413) return true;
  if (status !== 400) return false;
  return String(erro || '') !== ERRO_TETO_HORA;
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
    // Tira da fila só o item que foi mandado — se a mesma etiqueta foi
    // enfileirada de novo durante o envio (corpo novo), ela fica.
    const tirar = (id, item) => {
      const atual = lerFila();
      if (atual[id] && atual[id].em === item.em) { delete atual[id]; gravarFila(atual); }
    };
    // Conta de 5xx no próprio item (se ninguém o trocou durante o envio).
    const contar = (id, item, falhas, desde) => {
      if (!falhas && !item.falhas_5xx) return;
      const atual = lerFila();
      if (!(atual[id] && atual[id].em === item.em)) return;
      if (falhas) { atual[id].falhas_5xx = falhas; atual[id].falhas_5xx_desde = desde; }
      else { delete atual[id].falhas_5xx; delete atual[id].falhas_5xx_desde; }
      gravarFila(atual);
    };
    for (const id of ids) {
      const item = f[id];
      let r, d;
      try {
        r = await fetch(base + '/api/mp/retirada/fora-do-pedido', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(corpoParaVps(item.corpo || {})), signal: AbortSignal.timeout(TIMEOUT_MS * 2) });
        d = await r.json().catch(() => null);
      } catch (e) {
        contar(id, item, 0);
        logW('retirada', `fora do pedido NÃO chegou à VPS (fica na fila): ${id}`, { erro: e.message });
        break;   // VPS fora: tenta o resto na próxima rodada
      }
      if (d && d.ok === true) {
        tirar(id, item);
        enviados++;
        logI('retirada', `fora do pedido entregue à VPS: ${id}`);
        continue;
      }
      const erro = (d && d.erro) || ('HTTP ' + r.status);
      const falhas5xx = r.status >= 500 ? (Number(item.falhas_5xx) || 0) + 1 : 0;
      const desde5xx = falhas5xx ? (item.falhas_5xx_desde || new Date().toISOString()) : null;
      const venceu5xx = falhas5xx >= FALHAS_5XX_MAX
        && Date.now() - new Date(desde5xx).getTime() >= FALHAS_5XX_JANELA_MS;
      if (recusaDeVez(r.status, d && d.erro) || venceu5xx) {
        // Recusa permanente (ou 5xx repetido): guardar à parte e seguir com
        // os próximos — antes ficava na frente da fila e nada mais chegava.
        guardarRecusado(id, { ...item, recusado_em: new Date().toISOString(), status: r.status, erro });
        tirar(id, item);
        logW('retirada', `fora do pedido RECUSADO pela VPS (guardado em ${CHAVE_RECUSADOS}): ${id}`, { status: r.status, erro });
        continue;
      }
      contar(id, item, falhas5xx, desde5xx);
      logW('retirada', `fora do pedido NÃO chegou à VPS (fica na fila): ${id}`, { status: r.status, erro, falhas_5xx: falhas5xx || undefined });
      break;     // teto por hora ou erro do servidor: tenta na próxima rodada
    }
    return enviados;
  })().finally(() => { _enviando = null; });
  return _enviando;
}

// Reenvio de fundo: a tela também puxa a fila a cada GET, mas sem tela
// aberta a fila ainda anda.
const _timer = setInterval(() => { enviarFila().catch(() => {}); }, 60 * 1000);
if (_timer.unref) _timer.unref();

// Lista fresca se der. Nunca levanta.
async function atualizar() { try { await listarPedidos(); } catch (e) {} }
// No bipe (/consumir) NÃO se espera a VPS (16/11/2026): a espera de até 3 s
// entre "o bag já saiu?" e a gravação deixava o 2º bipe do mesmo bag passar
// e gravar outra S (baixa dupla no Bling). O bipe decide com a lista
// guardada (a tela renova a cada 15 s) e a busca roda em segundo plano.
function atualizarFundo() { if (ligado()) atualizar(); }

module.exports = { atualizar, atualizarFundo, avaliar, ligado, chaveBag, emKg, pesoN, enfileirarFora, enviarFila,
                   listarPedidos, lerFila, lerRecusados, MOTIVO_MAX, FALHAS_5XX_JANELA_MS };
