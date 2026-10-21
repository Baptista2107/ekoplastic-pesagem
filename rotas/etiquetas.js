// ════════════════════════════════════════════════════════════════════
//  ROTAS — etiquetas: leitura, bipagem, impressão e aditivos
// ════════════════════════════════════════════════════════════════════

const {
  CAPAS_CATALOGO, OUTRAS_CATALOGO, PA_CORES, PA_FORMATOS, PA_FORMATOS_POR_MAQUINA, PA_KG_FARDO,
  PA_MAQUINAS, PA_TURNOS,
} = require('../lib/config');
const {
  dataLocalISO, gravarLogProducaoBipagem, hashSenha, logDesvio, logE, logI, logW,
} = require('../lib/log');
const {
  configGet, db, dbStmts, getProximoSeq, incrementaSeq, makeTransaction, recalcularTotaisSessao,
} = require('../lib/db');
const { kgIndicadoDe, lerCatalogoMP, MP_MATERIAIS_PADRAO } = require('../lib/materiais');
const { gerarEPL, imprimir } = require('../lib/impressao');
const { exigeCampos, jsonErr, jsonOk, lerBodyJson, NAO_TRATADA } = require('../lib/http');
const {
  aplicarSubstituicao, chaveProduto, idempotenciaGet, imprimirEPersistirEtiqueta,
  materiaisPorSacos, mensagemProdutoTrocado, paSku, proximoSeqSessao, substituicaoAtiva,
} = require('../lib/negocio');
const { enviarBlingIndividualExtrusao } = require('../lib/turnos');

// Devolve NAO_TRATADA quando nenhuma rota daqui atende o pedido.
async function rotasEtiquetas(req, res, parsed, pathname) {
  let m;

  if ((m = pathname.match(/^\/etiquetas?\/([RTSEOP]\d+)$/)) && req.method === 'GET') {
    const et = dbStmts.getEtiqueta.get(m[1]);
    if (!et) return jsonErr(res, 404, `Etiqueta ${m[1]} não encontrada`);
    // Etiqueta de produto trocado é lida como o produto novo (ver
    // aplicarSubstituicao). Sem troca valendo, volta exatamente o registro.
    return jsonOk(res, { etiqueta: aplicarSubstituicao(et) });
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
          etiqueta: aplicarSubstituicao(orig),
          consumo: consumoAtivo,
        });
      }
      // Sem consumo ativo (foi estornado) → segue o fluxo normal e consome de
      // novo (cria nova virtual). A original será re-marcada 'consumida' abaixo.
    }
    // status === 'aguardando_bipe' ou 'bipada' — pode consumir

    // Produto trocado: a retirada sai como o produto NOVO (é ele que tem
    // saldo no Bling). A etiqueta original fica como foi impressa.
    const lida = aplicarSubstituicao(orig);

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
        material_key:   lida.material_key,
        material_nome:  lida.material_nome,
        material_label: lida.material_label,
        cor:            lida.cor,
        fornecedor:     lida.fornecedor,
        lote:           orig.lote,
        peso:           orig.peso,                 // mesmo peso da original (palete inteiro)
        qtd_sacos:      null,
        codigo:         lida.codigo,
        sku:            lida.sku,
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
    logI('retirada', `Consumida ${origId} → ${idVirt} (sessão #${sessaoIdRet})`
      + (lida.substituida_de ? ` — lida como ${chaveProduto(lida.material_key, lida.cor, lida.fornecedor)} (troca de produto)` : ''), {
      material: lida.material_key, peso: orig.peso, fornecedor: lida.fornecedor
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
    const etReg = dbStmts.getEtiqueta.get(idRe);
    if (!etReg) return jsonErr(res, 404, `Etiqueta ${idRe} não encontrada`);
    if (etReg.status === 'cancelada') return jsonErr(res, 400, `Etiqueta ${idRe} está cancelada — não faz sentido reimprimir`);
    // Produto trocado: a cópia sai com o nome do produto que vale hoje.
    const et = aplicarSubstituicao(etReg);
    // Reconstrói os dados a partir do que foi salvo, para gerar o MESMO EPL.
    const dadosRe = {
      tipo:           et.tipo,
      sub_tipo:       et.sub_tipo,                   // capa/recuperada saem com o mesmo layout
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
    // Corrigir PARA um produto que foi trocado seria dar entrada nele por
    // outra porta — mesma regra do recebimento.
    {
      const trocaC = substituicaoAtiva(String(body.materialKey).toUpperCase(), body.cor || null, body.fornecedor);
      if (trocaC) return jsonErr(res, 409, mensagemProdutoTrocado(trocaC), { trava: 'produto_substituido', substituto: trocaC.para });
    }

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
    // QUEM PODE SAIR POR SACOS é quem ENTRA por sacos: os aditivos de
    // sempre (MP_CONTAGEM_MANUAL) e o material criado pela tela marcado
    // como "por sacos". Com nomes fixos aqui dentro, um material novo
    // contado em sacos passava no recebimento e era recusado na retirada
    // — meio caminho, que é pior que caminho nenhum.
    const matKey = String(body.materialKey).toUpperCase();
    const porSacosMap = materiaisPorSacos();
    const porSacos = Object.keys(porSacosMap);
    if (!porSacosMap[matKey]) return jsonErr(res, 400,
      `materialKey inválido para aditivo contado: ${matKey} (use ${porSacos.join(', ')})`);
    const KG_SACO = porSacosMap[matKey];
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
    const kiRet = kgIndicadoDe(matKey);
    if (kiRet && (pesoAvulso > 0 || qtdSacos * KG_SACO > kiRet.max))
      return jsonErr(res, 400, `${matKey}: um saco de ${kiRet.passo} em ${kiRet.passo} kg, até ${kiRet.max} kg por item`);
    const peso = Number((qtdSacos * KG_SACO + pesoAvulso).toFixed(3));
    // Cor só é exigida de quem TEM cor no catálogo — hoje só o pigmento.
    const materiaisCat = (() => { try { return lerCatalogoMP().materiais || {}; } catch(e) { return {}; } })();
    const catMat = materiaisCat[matKey] || MP_MATERIAIS_PADRAO[matKey] || {};
    const temCor = Array.isArray(catMat.cores) && catMat.cores.length > 0;
    const cor = temCor ? (body.cor || null) : null;
    if (temCor && !cor) return jsonErr(res, 400, `cor obrigatória para ${matKey}`);

    const seqRet = getProximoSeq('retirada');
    const idVirt = 'S' + String(seqRet).padStart(7, '0');
    const seqSessaoRet = proximoSeqSessao(sessaoIdRet);
    const corLabel = cor || '';
    const skuForn = '.' + String(body.fornecedor).replace(/[^A-Za-z0-9]/g,'').substring(0,6).toUpperCase();
    const matLabel = catMat.popular || matKey;
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
    // Volta por sacos quem sai por sacos (mesma lista da retirada). O
    // Carbonato fica de fora como sempre ficou: ele não volta em sacos.
    const matKeyRto = String(body.materialKey).toUpperCase();
    const porSacosRto = materiaisPorSacos();
    delete porSacosRto.CARBO;
    if (!porSacosRto[matKeyRto]) return jsonErr(res, 400,
      `materialKey inválido para aditivo contado: ${matKeyRto} (use ${Object.keys(porSacosRto).join(', ')})`);
    const KG_SACO_RTO = porSacosRto[matKeyRto];
    const pesoRto = qtdSacosRto * KG_SACO_RTO;
    const kiRto = kgIndicadoDe(matKeyRto);
    if (kiRto && pesoRto > kiRto.max)
      return jsonErr(res, 400, `${matKeyRto}: um saco de ${kiRto.passo} em ${kiRto.passo} kg, até ${kiRto.max} kg por item`);
    // Cor só para quem tem cor no catálogo (o Pigmento).
    const catMatRto = (() => { try { return (lerCatalogoMP().materiais || {})[matKeyRto] || MP_MATERIAIS_PADRAO[matKeyRto] || {}; } catch(e) { return MP_MATERIAIS_PADRAO[matKeyRto] || {}; } })();
    const temCorRto = Array.isArray(catMatRto.cores) && catMatRto.cores.length > 0;
    const corRto = temCorRto ? (body.cor || null) : null;
    if (temCorRto && !corRto) return jsonErr(res, 400, `cor obrigatória para ${matKeyRto}`);

    const seqRto = getProximoSeq('retorno');
    const idVirtRto = 'T' + String(seqRto).padStart(7, '0');
    const seqSessaoRto = proximoSeqSessao(sessaoIdRto);
    const corLabelRto = corRto || '';
    const skuFornRto = '.' + String(body.fornecedor).replace(/[^A-Za-z0-9]/g,'').substring(0,6).toUpperCase();
    const matLabelRto = matKeyRto === 'PIG' ? 'Pigmento' : matKeyRto === 'DESSEC' ? 'Dessecante' : (catMatRto.popular || matKeyRto);
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
    // ── TROCA DE PRODUTO ──────────────────────────────────────────
    // Entrada NOVA (recebimento, ou retorno sem etiqueta de origem) de um
    // produto que foi trocado é recusada: daqui pra frente só o produto
    // novo. O retorno COM etiqueta de origem não é recusado — ele volta
    // como o produto novo (a tela já recebe a etiqueta lida assim; aqui é
    // a garantia para quem bipou um segundo antes da troca ligar).
    // Uma nova tentativa de algo que JÁ foi impresso passa direto.
    const tipoEnt = dados.tipo || 'recebimento';
    if ((tipoEnt === 'recebimento' || tipoEnt === 'retorno') && !idempotenciaGet(dados.clientToken)) {
      const matEnt = String(dados.materialKey || dados.material_key).toUpperCase();
      const troca = substituicaoAtiva(matEnt, dados.cor || null, dados.fornecedor);
      if (troca) {
        const temOrigem = !!(dados.ref_id || dados.origId);
        if (tipoEnt === 'recebimento' || !temOrigem) {
          logW('print', `Recusado: entrada de ${troca.de} — produto trocado por ${troca.para}`, { tipo: tipoEnt });
          return jsonErr(res, 409, mensagemProdutoTrocado(troca), { trava: 'produto_substituido', substituto: troca.para });
        }
        const lida = aplicarSubstituicao({ tipo: tipoEnt, material_key: matEnt, material_nome: dados.materialNomeEt || dados.material_nome,
                                           cor: dados.cor || null, fornecedor: dados.fornecedor, codigo: dados.codigo, sku: dados.sku });
        logI('print', `Retorno de ${dados.ref_id || dados.origId}: ${troca.de} volta como ${troca.para} (troca de produto)`);
        dados.materialKey = lida.material_key; delete dados.material_key;
        dados.materialNomeEt = lida.material_nome; dados.material_nome = lida.material_nome;
        dados.cor = lida.cor; dados.fornecedor = lida.fornecedor;
        dados.codigo = lida.codigo; dados.sku = lida.sku;
      }
    }
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

    // Emendas (01/10/2026): 0 a 99, obrigatório na tela; o servidor aceita
    // ausente (tela antiga) e grava NULL.
    const emendas = (body.emendas === undefined || body.emendas === null || body.emendas === '') ? null : Number(body.emendas);
    if (emendas !== null && !(Number.isInteger(emendas) && emendas >= 0 && emendas <= 99))
      return jsonErr(res, 400, 'Emendas deve ser um número de 0 a 99');

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
      if (resp.ok && emendas !== null && !resp.idempotente) {
        try { db.prepare(`UPDATE etiquetas SET emendas = ? WHERE id = ?`).run(emendas, resp.id); } catch (e) {}
      }
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

  // POST /etiquetas/bobina-recuperada  { cor, tipo_bobina, largura, peso, senha_supervisor, clientToken? }
  // BOBINA RECUPERADA (21/10/2026, Vinicius): bobina achada SEM etiqueta, de
  // origem que não dá para provar (3 verdes, uma só com "WA" do operador).
  // Ganha um número E novo só para voltar ao estoque e poder ser montada numa
  // sacoleira. Sem operador, máquina, turno nem sessão de extrusão — não é
  // produção: não entra em sessão (o Bling da extrusão sai pela sessão) e a
  // VPS tira sub_tipo='recuperada' de toda conta de produção. Nasce 'bipada'
  // (já está no estoque físico). Senha de supervisor: cria estoque do nada.
  if (pathname === '/etiquetas/bobina-recuperada' && req.method === 'POST') {
    let body;
    try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
    try { exigeCampos(body, ['cor','tipo_bobina','largura','peso']); }
    catch(e) { return jsonErr(res, 400, e.message); }
    const jaProcessado = !!idempotenciaGet(body.clientToken);
    if (!jaProcessado) {
      const hashSup = configGet('senha_saida_hash', hashSenha('1234'));
      if (!body.senha_supervisor || hashSenha(String(body.senha_supervisor)) !== hashSup) {
        if (body.senha_supervisor) logDesvio({ tipo: 'bobina_recuperada_senha_incorreta', tela: 'outras' });
        return jsonErr(res, 403, 'Senha de supervisor incorreta', { exige_senha_supervisor: true });
      }
    }
    const mapaBobinas = JSON.parse(configGet('mapa_bobina_bling', '{}'));
    const chave = `${String(body.cor).toUpperCase()}|${String(body.tipo_bobina).toUpperCase()}|${body.largura}`;
    const bobina = mapaBobinas[chave];
    if (!bobina) return jsonErr(res, 400, `Bobina "${chave}" não existe no cadastro de bobinas`);
    const peso = Math.round(Number(body.peso) * 10) / 10;
    if (!(peso >= 20 && peso <= 1500)) return jsonErr(res, 400, 'Peso líquido deve ficar entre 20 e 1.500 kg');
    return imprimirEPersistirEtiqueta({
      tipo: 'extrusao',
      sub_tipo:       'recuperada',
      clientToken:    body.clientToken || null,
      material_key:   'BOBINA',
      material_nome:  `${body.cor} · ${body.tipo_bobina} · ${body.largura}`,
      material_label: bobina.sku,
      cor:            body.cor,
      tipo_bobina:    body.tipo_bobina,
      largura:        body.largura,
      fornecedor:     'RECUPERADA',
      lote:           'RECUPERADA',
      peso,
      codigo:         bobina.sku,
      sku:            bobina.sku,
      printerName:    body.printerName || null,
    }, resp => {
      if (!resp.ok) return jsonErr(res, 500, resp.erro, { printer: resp.printer });
      if (!resp.idempotente) {
        const agora = new Date().toISOString();
        db.prepare(`UPDATE etiquetas SET status = 'bipada', hora_bipagem = ? WHERE id = ?`).run(agora, resp.id);
        logI('extrusao', `BOBINA RECUPERADA ${resp.id}: ${chave} ${peso.toFixed(1)} kg (sem origem, fora da produção)`);
      }
      jsonOk(res, { ...resp, bobina });
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

  return NAO_TRATADA;
}

module.exports = rotasEtiquetas;
