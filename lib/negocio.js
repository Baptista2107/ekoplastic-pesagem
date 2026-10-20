// ════════════════════════════════════════════════════════════════════
//  AÇÕES DE NEGÓCIO — sessões, numeração e envio ao Bling
// ════════════════════════════════════════════════════════════════════

const {
  CAPAS_CATALOGO, MP_CONTAGEM_MANUAL, OUTRAS_CATALOGO, PA_CORES, PA_KG_FARDO, PA_TURNOS,
} = require('./config');
const {
  dataLocalISO, gravarLogExtrusaoCSV, gravarLogProducaoBipagem, logD, logE, logI, logW,
} = require('./log');
const { configGet, configSet, db, dbStmts, makeTransaction, sessaoContaConsumida } = require('./db');
const { corLabelPadrao, kgIndicadoDe, lerCatalogoMP, MP_MATERIAIS_PADRAO } = require('./materiais');
const { blingHostApi, blingHostSugerido, blingRecusouEndereco, getToken, proxyChamada } = require('./bling');
const { _grupoMP, _grupoOutras, gerarEPL, imprimir } = require('./impressao');
const impressaoMod = require('./impressao');   // variaveis que mudam de valor: ler sempre por aqui

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

// ════════════════════════════════════════════════════════════════════
//  AÇÕES DE NEGÓCIO
// ════════════════════════════════════════════════════════════════════

// Cache de idempotência (C3): clientToken → resposta já produzida.
// Protege contra duplicação quando a impressão teve sucesso no servidor
// mas a resposta não chegou ao frontend e o operador tenta de novo.
// Entradas expiram após 5 min (a janela real de retry é de segundos).
const _tokensRecentes = new Map();
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
  logI('print', `Imprimindo ${id} (${tipo}, ${seloLabel} #${seqSessao||'-'}) → "${dados.printerName || impressaoMod.PRINTER_ATIVA}"`, {
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
// QUEM ENTRA E SAI POR SACOS (e quantos kg tem o saco)
// Os aditivos de sempre ficam em MP_CONTAGEM_MANUAL; um material criado
// pela tela (Cadastros Bling) traz "porSacos" no próprio cadastro. Antes
// esta lista era só a fixa: material novo contado em sacos precisava de
// atualização de código para entrar e sair por sacos.
// ──────────────────────────────────────────────────────────────────
function materiaisPorSacos() {
  const r = { ...MP_CONTAGEM_MANUAL };
  try {
    const mats = lerCatalogoMP().materiais || {};
    for (const [k, m] of Object.entries(mats)) {
      if (!m || m.porSacos !== true || r[k]) continue;
      r[k] = Number(m.kgPorSaco) > 0 ? Number(m.kgPorSaco) : 25;
    }
  } catch (e) { /* catálogo ilegível: fica a lista fixa, que é a de sempre */ }
  return r;
}

// ──────────────────────────────────────────────────────────────────
// TROCA DE PRODUTO (30/09/2026)
// Polinylon Tallpack Cristal/Leitoso passou a ser RESINA EVOH Tallpack
// Cristal/Leitoso. As etiquetas antigas CONTINUAM valendo — são as
// mesmas, coladas nos mesmos big bags — mas passam a ser LIDAS como o
// produto novo: a retirada baixa EVOH no Bling, o inventário conta EVOH,
// o retorno volta como EVOH. O registro original da etiqueta não muda.
//
// A troca só LIGA quando o produto novo está mapeado no Bling
// (mapa_produto_bling). Antes disso tudo segue exatamente como hoje —
// não há janela em que uma retirada fique sem produto para lançar.
// A configuração fica no banco (mp_substituicoes) e é gravada uma única
// vez: se um dia for esvaziada, uma atualização não a traz de volta.
// ──────────────────────────────────────────────────────────────────
// (MP_SUBSTITUICOES_PADRAO fica junto de MP_MATERIAIS_PADRAO: o seed roda antes daqui.)

// Todas as trocas cadastradas, cada uma dizendo se já está valendo.
function listarSubstituicoes() {
  let subs = {}, mapa = {};
  try { subs = JSON.parse(configGet('mp_substituicoes', '{}')) || {}; } catch (e) { subs = {}; }
  try { mapa = JSON.parse(configGet('mapa_produto_bling', '{}')) || {}; } catch (e) { mapa = {}; }
  const mapeados = new Set(Object.keys(mapa).map(k => k.toLowerCase()));
  let mats = {};
  try { mats = lerCatalogoMP().materiais || {}; } catch (e) {}
  const nomeDe = chave => {
    const [m, c, f] = String(chave).split(':');
    const pop = (mats[m] && mats[m].popular) || (MP_MATERIAIS_PADRAO[m] && MP_MATERIAIS_PADRAO[m].popular) || m;
    return [pop, c, f].filter(Boolean).join(' · ');
  };
  const lista = [];
  for (const [de, para] of Object.entries(subs)) {
    if (!de || !para || typeof para !== 'string') continue;
    const [material, cor, fornecedor] = para.split(':');
    if (!material) continue;
    lista.push({ de, para, ativa: mapeados.has(para.toLowerCase()),
                 de_nome: nomeDe(de), para_nome: nomeDe(para),
                 material, cor: cor || null, fornecedor: fornecedor || null });
  }
  return lista;
}

// A troca que vale AGORA para este produto (ou null). Sem diferença de
// maiúsculas: há etiquetas antigas com o fornecedor em caixa alta.
function substituicaoAtiva(mat, cor, forn) {
  const k = chaveProduto(mat, cor, forn).toLowerCase();
  return listarSubstituicoes().find(s => s.ativa && s.de.toLowerCase() === k) || null;
}

// Início da SKU impressa, pela mesma regra da tela de Recebimento:
// MATERIAL[.COR].FORNECEDOR(6 letras).
function prefixoSkuMP(mat, cor, forn) {
  let lab = '';
  if (cor) {
    let m = {};
    try { m = (lerCatalogoMP().materiais || {})[mat] || MP_MATERIAIS_PADRAO[mat] || {}; } catch (e) {}
    lab = String((m.corLabel && m.corLabel[cor]) || corLabelPadrao(cor)).toUpperCase();
  }
  const f = String(forn || '').replace(/[^A-Za-z0-9]/g, '').substring(0, 6).toUpperCase();
  return `${mat}${lab ? '.' + lab : ''}.${f}`;
}

// Como a etiqueta deve ser LIDA hoje. Devolve uma cópia — o registro no
// banco não é alterado. Só matéria-prima (recebimento/retorno/retirada).
function aplicarSubstituicao(et) {
  if (!et || !et.material_key) return et;
  if (!['recebimento', 'retorno', 'retirada'].includes(et.tipo)) return et;
  const s = substituicaoAtiva(et.material_key, et.cor, et.fornecedor);
  if (!s) return et;
  let cat = { materiais: {}, codigos: [] };
  try { cat = lerCatalogoMP(); } catch (e) {}
  const mat = (cat.materiais || {})[s.material] || MP_MATERIAIS_PADRAO[s.material] || {};
  const nome = String(mat.nomeEtiqueta || mat.popular || s.material).toUpperCase();
  // Código gravimétrico do produto novo, se já cadastrado; senão fica o antigo.
  const cod = (cat.codigos || []).find(c => c.matKey === s.material && (c.cor || null) === (s.cor || null)
                                            && (c.forn == null || c.forn === s.fornecedor));
  const sku = et.sku ? String(et.sku).replace(/^[^|]*?(?=\s*\||$)/, prefixoSkuMP(s.material, s.cor, s.fornecedor)) : et.sku;
  return { ...et,
    material_key: s.material, material_nome: nome, material_label: nome,
    cor: s.cor, fornecedor: s.fornecedor,
    codigo: cod ? cod.codigo : et.codigo, sku,
    substituida_de: { material_key: et.material_key, material_nome: et.material_nome, cor: et.cor,
                      fornecedor: et.fornecedor, codigo: et.codigo, sku: et.sku },
  };
}

// Mensagem para quem tenta dar ENTRADA num produto que foi trocado.
function mensagemProdutoTrocado(s) {
  return `${s.de_nome} foi substituído por ${s.para_nome}. `
       + `Selecione ${s.para_nome.split(' · ').join(' › ')} — o produto antigo não recebe mais entradas.`;
}

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
  // Peso do saco de cada material (25 kg na maioria; o Compatibilizante
  // PA/PE vem em sacos de 20 kg). Só entra no texto da descrição.
  const kgSacoMat = materiaisPorSacos();
  const itens = etiquetasOrdenadas.map(e => {
    const chave = chaveProduto(e.material_key, e.cor, e.fornecedor);
    const material = e.material_nome || e.material_key;
    const isAditivoContado = e.sub_tipo === 'aditivo-saida' || e.sub_tipo === 'aditivo-fechados';
    // kg indicado (Purga): qtd_sacos são porções de 5 kg de UM saco
    const sufixoSacos = !(e.qtd_sacos && e.qtd_sacos > 0) ? ''
      : kgIndicadoDe(e.material_key) ? ` · 1 saco de ${Number(e.peso)}kg`
      : ` · ${e.qtd_sacos} sacos × ${kgSacoMat[e.material_key] || 25}kg`;
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
  const statusValidos = sessaoContaConsumida(sessao.tipo)
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
    // Persiste o payload pra revisão posterior (config payload_sessao_<id>)
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
    // Recusa por endereço: em vez de despejar o HTTP 403 cru na tela do
    // operador, diz o que aconteceu e o que resolve. Já tentamos o host
    // indicado automaticamente antes de chegar aqui (ver blingRequisicao).
    const sugerido = blingHostSugerido(r);
    const erro = blingRecusouEndereco(r)
      ? `O Bling recusou o endereço "${blingHostApi()}" para chamadas de API`
        + (sugerido ? ` e pediu "${sugerido}"` : '')
        + '. A sessão está salva — corrija o endereço (config bling_host_api) e reenvie por Manutenção › Envios ao Bling.'
      : `HTTP ${r.status} ${r.body.substring(0,300)}`;
    dbStmts.updSessaoBling.run('erro', null, erro, sessaoId);
    logE('bling', `Sessão #${sessaoId} — falhou no envio`, { status: r.status, host: blingHostApi(), body: r.body.substring(0, 500) });
    return { ok: false, erro, ...(sugerido ? { host_bloqueado: true, host_sugerido: sugerido } : {}) };
  } catch(e) {
    dbStmts.updSessaoBling.run('erro', null, e.message, sessaoId);
    logE('bling', `Sessão #${sessaoId} — exceção`, { erro: e.message });
    return { ok: false, erro: e.message };
  }
}

module.exports = { aplicarSubstituicao, chaveProduto, enviarSessaoBling, idempotenciaGet,
  imprimirEPersistirEtiqueta, listarSubstituicoes, materiaisPorSacos, mensagemProdutoTrocado, paSku,
  proximoSeqSessao, resolverIdVariacaoPA, substituicaoAtiva, };
