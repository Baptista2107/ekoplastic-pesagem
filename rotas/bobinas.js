// ════════════════════════════════════════════════════════════════════
//  ROTAS — coletor das sacoleiras (bobinas, turnos do corte, inventário)
// ════════════════════════════════════════════════════════════════════

const { CAPAS_CATALOGO, PA_FORMATOS_POR_MAQUINA } = require('../lib/config');
const { dataLocalISO, hashSenha, logDesvio, logI, logW, rangeUTCdoDiaLocal } = require('../lib/log');
const { configGet, configSet, db, dbStmts, makeTransaction } = require('../lib/db');
const { getToken, proxyChamada } = require('../lib/bling');
const {
  assumirFormatoEscolhido, baixaBobinaNoBling, bobinaAbertaNa, clpSacoleiras, corPaDaBobina,
  cortandoSemBobina, devolverProximaBobina, encerrarBobina,
  formatoDaBobina, herdaSoltos, imprimirEtiquetaRefugo, inventarioAberto, lerFardos,
  lerFormatoDaMaquina, lerMaquinasCorte, lerParte, lerSoltos, marcarProximaBobina, montagensDaBobina,
  montarProximaBobina, normalizarDestinoBobina, PACOTES_POR_FARDO, pacotesParciaisDe, PESO_FARDO_KG,
  proximaBobinaNa, refugoAbertoDe,
  registrarParcial, resumoInventario, setupDaBobina, situacaoBobina, soltosNaMaquina,
  SQL_PACOTES_PARTE, sugerirFormato, TARAS_EIXO, turnoCorteAberto, TURNOS_CORTE,
  turnosBaixaBobina, txtPacotes,
} = require('../lib/bobinas');
const { jsonErr, jsonOk, lerBodyJson, NAO_TRATADA } = require('../lib/http');

// Devolve NAO_TRATADA quando nenhuma rota daqui atende o pedido.
async function rotasBobinas(req, res, parsed, pathname) {
  let m;

  // Turnos disponíveis para a retirada (cada um é o cliente da venda).
  if (pathname === '/bobinas/turnos' && req.method === 'GET') {
    const bling = baixaBobinaNoBling();
    const turnos = turnosBaixaBobina(bling);
    return jsonOk(res, { turnos, bling });
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
      destino: e.destino || null, baixa_em: e.baixa_em || null,
      encerrada_em: e.encerrada_em || null, fardos: e.fardos, pacotes: e.pacotes,
      refugo: refugoAbertoDe(e.id), tara_eixo: TARAS_EIXO[e.largura] || 0,
    }, bling: baixaBobinaNoBling() });
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
    // Bobina de REFUGO (02/10/2026): já teve baixa, saiu da sacoleira e voltou
    // ao estoque pela pesagem de refugo — pode montar de novo (nova montagem).
    const refugo = (e.status === 'consumida' && e.encerrada_em) ? refugoAbertoDe(bid) : null;
    if (e.status === 'consumida' && !refugo) {
      return jsonErr(res, 409, `Bobina ${bid} JÁ teve baixa`, {
        ja_baixada: true, quando: e.hora_bipagem || null, pedido: e.bling_pedido_id || null,
      });
    }

    // Sacoleira de destino: obrigatória e só P1/P2 — é a chave que liga a
    // bobina aos fardos daquela máquina (o fardo grava `maquina` P1/P2).
    const destino = normalizarDestinoBobina(body.destino);
    if (!destino) return jsonErr(res, 400, 'Escolha a sacoleira de destino (P1 ou P2)');
    // Quem bipou (29/09/2026, Gustavo) deixou de ser perguntado em 19/10/2026
    // (Vinicius: "esta informação ainda não faz sentido"): vai quando vier.
    const operador = (body.operador ? String(body.operador).trim().slice(0, 80) : null) || null;
    // Sem turno do corte aberto não monta bobina (01/10/2026, Gustavo): a
    // bobina e os fardos dela ficariam fora de turno, sem dono no resumo.
    if (!turnoCorteAberto(destino)) {
      return jsonErr(res, 409, `Sacoleira ${destino} sem turno aberto. O supervisor inicia o turno antes de bipar.`,
                     { sem_turno: true });
    }

    // Com o Bling desligado (padrão desde 28/09/2026 — decisão do Frederico:
    // "por ora nada no Bling"), a baixa só registra aqui. Nenhum pedido de
    // venda é criado e o mapa de produtos/contatos do Bling não é exigido.
    // Bobina de refugo reaproveitada nunca vai ao Bling: a 1ª baixa já levou
    // o peso inteiro dela (Gustavo, 02/10/2026: refugo "só no sistema").
    // Recuperada (21/10/2026) também não: nasceu sem produção no Bling.
    const bling = (refugo || e.sub_tipo === 'recuperada') ? false : baixaBobinaNoBling();

    // Turno: só existe para o Bling (é o cliente da venda). Sem Bling a tela
    // não pergunta, e a baixa vale igual sem ele.
    const turnoCod = String(body.turno || '').trim().toUpperCase();
    let turno = { codigo: null, label: '' };
    if (bling || turnoCod) {
      if (!turnoCod) return jsonErr(res, 400, 'Selecione o turno antes de dar baixa');
      turno = turnosBaixaBobina(bling).find(t => t.codigo === turnoCod);
      if (!turno) return jsonErr(res, 400, `Turno "${turnoCod}" não cadastrado (mapa_turno_bobina)`);
    }

    let prod = {}, idEko = null;
    if (bling) {
      const mapaBobinas = JSON.parse(configGet('mapa_bobina_bling', '{}'));
      const chave = `${(e.cor||'').toUpperCase()}|${(e.tipo_bobina||'').toUpperCase()}|${e.largura}`;
      prod = (e.sub_tipo === 'capa') ? (CAPAS_CATALOGO[e.sku] || {}) : (mapaBobinas[chave] || {});
      if (!prod.id) return jsonErr(res, 400, `Sem produto no Bling para ${chave} — cadastre o mapa de bobinas antes.`);
      // O CLIENTE da venda é o turno que retirou (Turno A / C / Extra).
      if (!turno.contatoId) return jsonErr(res, 400, `Turno "${turnoCod}" sem contato no Bling (mapa_turno_bobina)`);
      idEko = turno.contatoId;
    }

    // Troca de bobina: se a sacoleira já tem bobina aberta, ela sai agora e
    // precisa dos fardos que deu. Conferido ANTES do Bling, para não criar
    // pedido de uma baixa que vai ser recusada aqui.
    const aberta = bobinaAbertaNa(destino);
    // A BIPAGEM SÓ INICIA BOBINA (16/10/2026, Vinicius): o fim é o botão
    // "✓ Bobina finalizou". Encerrar a anterior pela bipagem da seguinte
    // trocava as janelas de metros do CLP (E0001983 184% × E0001989 20%).
    // Com bobina aberta na sacoleira a baixa é recusada — inclusive vinda de
    // tela antiga (cache) que ainda manda fardos_anterior. O código da troca
    // abaixo fica, mas não é mais alcançado.
    if (aberta && aberta.id !== bid) {
      return jsonErr(res, 409, `A Sacoleira ${destino} ainda está com a bobina ${aberta.id}. `
        + `Toque em "✓ Bobina finalizou" na ${destino} antes de bipar a nova.`,
        { ocupada: true, anterior: { id: aberta.id } });
    }
    const pedeFardos = !!aberta && aberta.id !== bid;
    const fardosAnterior = lerFardos(body.fardos_anterior);
    if (pedeFardos && fardosAnterior === null) {
      return jsonErr(res, 409, `Informe quantos fardos a bobina ${aberta.id} deu antes de trocar`, {
        precisa_fardos: true,
        anterior: { id: aberta.id, cor: aberta.cor, tipo_bobina: aberta.tipo_bobina,
                    largura: aberta.largura, peso: aberta.peso, baixa_em: aberta.baixa_em,
                    pacotes_parciais: pacotesParciaisDe(aberta.id).pacotes,
                    soltos_inicio: soltosNaMaquina(destino) },
      });
    }
    const parteAnterior = pedeFardos ? lerParte(destino, body.fardos_anterior, body.soltos_anterior,
                                                  lerFormatoDaMaquina(destino, body.formato_anterior)) : null;
    if (parteAnterior && parteAnterior.erro) return jsonErr(res, 400, parteAnterior.erro);

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
    ret.push(`Destino Sacoleira ${destino}`);
    if (body.operador) ret.push(`Retirado por ${body.operador}`);
    linhas.push(`Retirada: ${ret.filter(Boolean).join(' · ')}`);
    const observacoes = linhas.join('\n');

    // Descrição do item (linha única, aparece no item do pedido).
    const desc = `Bobina ${bid} · ${e.cor} ${e.tipo_bobina} ${e.largura} · ${Number(e.peso).toFixed(1)} kg`
               + (e.operador ? ` · Op ${e.operador}` : '')
               + (e.maquina ? ` · Maq ${e.maquina}` : '')
               + (turnoCod ? ` · ${turno.label || turnoCod}` : '')
               + ` · Destino Sacoleira ${destino}`;
    const simular = configGet('bling_simular', '1') === '1';
    let blingId = null;

    if (!bling) {
      logI('bobinas', `Baixa de bobina ${bid} → Sacoleira ${destino} — sem Bling`);
    } else if (simular) {
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

    // Formato escolhido no ✓ Bobina finalizou (20/10/2026): o comprimento do
    // CLP na hora do bipe decide se a máquina já está no formato escolhido.
    const clpBaixa = proximaBobinaNa(destino) ? await clpSacoleiras() : null;
    // Só marca como consumida DEPOIS que o Bling aceitou (ou direto, com o
    // Bling desligado). O WHERE status confere de novo: dois celulares
    // bipando a mesma bobina ao mesmo tempo não dão duas baixas.
    const agora = new Date().toISOString();
    // O formato que a bobina que SAI virou: confirmado (ou trocado) pelo
    // operador no mesmo modal dos fardos. Só formato da própria máquina.
    const formatoAnterior = pedeFardos ? lerFormatoDaMaquina(destino, body.formato_anterior) : null;
    const origemAnterior = body.formato_anterior_origem === 'sugerido' ? 'sugerido' : 'escolhido';
    // Fecha a anterior e abre a nova juntas: nunca fica a sacoleira com
    // duas bobinas abertas, nem sem nenhuma por uma falha no meio.
    let totalAnterior = null;
    const trocar = makeTransaction(() => {
      let upd;
      if (refugo) {
        // Nova montagem da bobina de refugo: guarda a anterior (para o
        // desfazer) e reabre. fardos/pacotes ficam: o encerramento soma.
        const estadoAntes = JSON.stringify({ destino: e.destino, baixa_em: e.baixa_em, baixa_turno: e.baixa_turno,
          baixa_operador: e.baixa_operador, encerrada_em: e.encerrada_em, encerrada_motivo: e.encerrada_motivo,
          formato_cortado: e.formato_cortado, formato_origem: e.formato_origem });
        upd = db.prepare(
          `UPDATE etiquetas SET destino=?, baixa_em=?, baixa_turno=?, baixa_operador=?, encerrada_em=NULL,
                    encerrada_motivo=NULL, formato_cortado=NULL, formato_origem=NULL, alterado_em=?
              WHERE id=? AND status='consumida' AND encerrada_em IS NOT NULL`)
          .run(destino, agora, turnoCod || null, operador, agora, bid);
        if (upd.changes) db.prepare(
          `UPDATE bobina_refugos SET reaproveitado_em=?, reaproveitado_destino=?, estado_antes=?, alterado_em=?
              WHERE id=? AND reaproveitado_em IS NULL`).run(agora, destino, estadoAntes, agora, refugo.id);
      } else {
        upd = db.prepare(
          `UPDATE etiquetas SET status='consumida', hora_bipagem=?, bling_pedido_id=?,
                    destino=?, baixa_em=?, baixa_turno=?, baixa_operador=?, alterado_em=?
              WHERE id=? AND status NOT IN ('consumida','cancelada')`)
          .run(agora, blingId && !String(blingId).startsWith('SIM-') ? Number(blingId) : null,
               destino, agora, turnoCod || null, operador, agora, bid);
      }
      if (!upd.changes) return false;
      if (pedeFardos) totalAnterior = encerrarBobina(aberta.id, parteAnterior, 'troca', agora, formatoAnterior,
                                                     origemAnterior, destino, operador);
      return true;
    });
    if (!trocar()) return jsonErr(res, 409, `Bobina ${bid} JÁ teve baixa`, { ja_baixada: true });
    // O bipe tira o aviso "BIPE A PRÓXIMA BOBINA" e a bobina nova assume o
    // formato escolhido no ✓ Bobina finalizou (montarProximaBobina).
    const prox = clpBaixa ? montarProximaBobina(destino, { id: bid, baixa_em: agora },
      sugerirFormato(destino, e, clpBaixa.dados ? clpBaixa.dados[destino] : null)) : null;
    if (prox) logI('bobinas', `Sacoleira ${destino}: ${bid} entrou no pedido de bipe de ${prox.de || '?'}`
      + ` · formato escolhido ${prox.formato || '?'}`);
    if (pedeFardos) logI('bobinas', `Sacoleira ${destino}: ${aberta.id} saiu com ${txtPacotes(parteAnterior.pacotes)} neste trecho`
      + ` (${parteAnterior.fechados} fechado(s), ${parteAnterior.soltos} solto(s)) · total da bobina ${txtPacotes(totalAnterior)}`
      + (formatoAnterior ? ` · ${formatoAnterior}` : '') + ` · entrou ${bid} por ${operador}`);

    // Guarda no histórico do dia (para a tela mostrar o que já saiu).
    try {
      const hoje = dataLocalISO();
      const ch = 'baixas_bobinas_' + hoje;
      let lista = []; try { lista = JSON.parse(configGet(ch, '[]')); } catch(err) {}
      lista.unshift({ id: bid, cor: e.cor, tipo_bobina: e.tipo_bobina, largura: e.largura, peso: e.peso,
                      pedido: blingId, turno: turnoCod, turno_label: turno.label || turnoCod,
                      destino: 'Sacoleira ' + destino, operador, hora: agora });
      configSet(ch, JSON.stringify(lista.slice(0, 500)));
    } catch(err) {}

    if (refugo) logI('bobinas', `${bid} (refugo de ${refugo.pesado_em}) REAPROVEITADA na Sacoleira ${destino} por ${operador}`);
    return jsonOk(res, { baixada: true, id: bid, pedido: blingId, destino, bling, reaproveitada: !!refugo,
                         modo: !bling ? 'sem_bling' : (simular ? 'simulacao' : 'real'),
                         turno: turnoCod, turno_label: turno.label || turnoCod,
                         bobina: { cor: e.cor, tipo_bobina: e.tipo_bobina, largura: e.largura, peso: e.peso } });
  }

  // O que está montado em cada sacoleira agora.
  if (pathname === '/bobinas/abertas' && req.method === 'GET') {
    // 29/09/2026: cada sacoleira traz também o formato que ela está
    // cortando (sugestão pelo CLP, travada pela máquina e pela bobina) e a
    // cor do produto acabado — a tela mostra na bobina atual e pré-seleciona
    // no modal dos fardos. Sem CLP a sugestão vem vazia e a tela pede.
    const clp = await clpSacoleiras();
    const sacoleiras = ['P1', 'P2'].map(p => {
      const a = bobinaAbertaNa(p);
      const px = a ? null : proximaBobinaNa(p);
      const leitura = clp.dados ? clp.dados[p] : null;
      const fmt = a ? formatoDaBobina(p, a, leitura) : null;
      return { sacoleira: p, bobina: a ? {
        id: a.id, cor: a.cor, tipo_bobina: a.tipo_bobina, largura: a.largura, peso: a.peso,
        baixa_em: a.baixa_em, baixa_operador: a.baixa_operador,
        // Fardos já informados nos fins de turno anteriores (a bobina seguiu montada).
        pacotes_parciais: pacotesParciaisDe(a.id).pacotes,
        // Pacotes que ficaram soltos no fardo aberto quando esta parte começou.
        // Só os que esta bobina aproveita (mesma cor e formato — herdaSoltos).
        soltos_inicio: soltosNaMaquina(p, fmt && fmt.sugerido),
        cor_pa: corPaDaBobina(a.cor), formato: fmt,
        // A última coisa registrada nesta bobina foi uma troca de formato:
        // a próxima contagem é "desde a troca".
        desde_troca: (db.prepare(`SELECT momento FROM bobina_parciais WHERE etiqueta_id = ? ORDER BY id DESC LIMIT 1`)
                        .get(a.id) || {}).momento === 'setup',
      } : null, permitidos: PA_FORMATOS_POR_MAQUINA[p] || [],
        // ✓ Bobina finalizou com a próxima por bipar (20/10/2026): a tela
        // mostra o aviso grande; vermelho se a máquina voltou a cortar.
        ...(!a && px ? { aguardando_bipe: true, formato_proximo: px.formato || null,
                         cortando_sem_bobina: cortandoSemBobina(px, leitura) } : {}),
        clp: leitura ? { comprimento_mm: leitura.comprimento_mm, operando: leitura.operando,
                         tempo: leitura.tempo } : null };
    });
    return jsonOk(res, { sacoleiras, clp_erro: clp.erro, peso_fardo_kg: PESO_FARDO_KG });
  }

  // ── Turno do corte (ver turnoCorteAberto, lá em cima) ──
  // GET: o turno aberto de cada sacoleira e os últimos registros.
  if (pathname === '/bobinas/turno-corte' && req.method === 'GET') {
    const sacoleiras = ['P1', 'P2'].map(p => ({ sacoleira: p, turno: turnoCorteAberto(p) }));
    const recentes = db.prepare(`SELECT * FROM turnos_corte ORDER BY inicio DESC, id DESC LIMIT 12`).all();
    return jsonOk(res, { sacoleiras, recentes,
                         turnos: Object.entries(TURNOS_CORTE).map(([codigo, label]) => ({ codigo, label })) });
  }

  // POST iniciar { senha, turno: 'A'|'C'|'EXTRA', maquinas: ['P1','P2'], operador }
  // POST encerrar { senha, maquinas, operador }
  // Sem senha desde 05/10/2026 (era a do supervisor). Iniciar numa sacoleira
  // com turno aberto encerra o aberto no mesmo instante (motivo 'troca').
  if ((pathname === '/bobinas/turno-corte/iniciar' || pathname === '/bobinas/turno-corte/encerrar')
      && req.method === 'POST') {
    let body; try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
    const iniciar = pathname.endsWith('/iniciar');
    // Sem senha desde 05/10/2026 (Gustavo: "tira qualquer tipo de senha do
    // sistema de estoque de bobina"). O ENCERRAR voltou a pedir a senha do
    // supervisor em 19/10/2026 (Vinicius: quem encerra é o responsável por
    // conferir que está tudo certo antes de fechar o turno). Iniciar segue livre.
    if (!iniciar) {
      const hashAtual = configGet('senha_saida_hash', hashSenha('1234'));
      if (hashSenha(String((body && body.senha) || '')) !== hashAtual) {
        logDesvio({ tipo: 'turno_corte_senha_incorreta', tela: 'bobinas',
                    detalhe: 'senha incorreta ao encerrar turno do corte' });
        return jsonErr(res, 401, 'Senha de supervisor incorreta.', { senha_incorreta: true });
      }
    }
    const maqs = lerMaquinasCorte(body.maquinas);
    if (!maqs) return jsonErr(res, 400, 'Escolha a sacoleira (P1, P2 ou as duas)');
    const operador = (body.operador ? String(body.operador).trim().slice(0, 80) : null) || null;
    const agora = new Date().toISOString();
    const fechar = db.prepare(
      `UPDATE turnos_corte SET fim = ?, fim_motivo = ?, encerrado_por = ?, alterado_em = ? WHERE id = ?`);

    // Fardos do turno que fecha (ver bobina_parciais, lá em cima): toda
    // sacoleira cujo turno fecha agora E que tem bobina montada precisa
    // dizer quanto a bobina deu neste turno. Vale para "Encerrar" e para
    // "Iniciar" por cima de um turno aberto (a troca também fecha um turno).
    // Body: parciais: { P1: { fardos, formato, formato_origem }, P2: {...} }
    const turno = iniciar ? String(body.turno || '').trim().toUpperCase() : null;
    if (iniciar && !TURNOS_CORTE[turno]) return jsonErr(res, 400, 'Turno inválido (A, C ou Extra)');
    const fechando = maqs.map(p => turnoCorteAberto(p)).filter(Boolean);
    if (!iniciar && !fechando.length) return jsonErr(res, 409, `Nenhum turno aberto na ${maqs.join(' e ')}`);
    const partes = [], faltam = [];
    const inf = (body && typeof body.parciais === 'object' && body.parciais) || {};
    for (const t of fechando) {
      const b = bobinaAbertaNa(t.maquina);
      if (!b) continue;
      const dado = inf[t.maquina] || {};
      if (lerFardos(dado.fardos) === null) {
        faltam.push({ sacoleira: t.maquina, turno: t.turno, id: b.id, cor: b.cor, tipo_bobina: b.tipo_bobina,
                      largura: b.largura, peso: b.peso, baixa_em: b.baixa_em, baixa_operador: b.baixa_operador,
                      pacotes_parciais: pacotesParciaisDe(b.id).pacotes, soltos_inicio: soltosNaMaquina(t.maquina) });
        continue;
      }
      const parte = lerParte(t.maquina, dado.fardos, dado.soltos, lerFormatoDaMaquina(t.maquina, dado.formato));
      if (parte.erro) return jsonErr(res, 400, `${t.maquina}: ${parte.erro}`);
      partes.push({ maq: t.maquina, id: b.id, parte, formato: lerFormatoDaMaquina(t.maquina, dado.formato),
                    origem: dado.formato_origem === 'sugerido' ? 'sugerido' : 'escolhido' });
    }
    if (faltam.length) {
      return jsonErr(res, 409, `Informe quantos fardos a bobina deu neste turno: ${faltam.map(f => `${f.sacoleira} (${f.id})`).join(', ')}`,
                     { precisa_fardos: true, bobinas: faltam });
    }
    // A parte é gravada ANTES de fechar o turno, para ficar amarrada a ele.
    const gravarPartes = () => {
      for (const p of partes) {
        registrarParcial(p.id, p.maq, p.parte, 'turno', agora, operador, p.formato, p.origem);
        db.prepare(`UPDATE etiquetas SET alterado_em = ? WHERE id = ?`).run(agora, p.id);
      }
    };
    const txtPartes = partes.length ? ` · no turno: ${partes.map(p => `${p.maq} ${p.id} ${txtPacotes(p.parte.pacotes)}`).join(', ')}` : '';
    const respPartes = () => partes.map(p => ({ sacoleira: p.maq, id: p.id, pacotes: p.parte.pacotes,
                                                fardos_fechados: p.parte.fechados, soltos: p.parte.soltos }));

    if (!iniciar) {
      makeTransaction(() => {
        gravarPartes();
        for (const t of fechando) fechar.run(agora, 'encerrado', operador, agora, t.id);
      })();
      logI('bobinas', `Turno do corte ENCERRADO: ${fechando.map(t => `${t.maquina} ${t.turno}`).join(', ')}`
        + txtPartes + (operador ? ` por ${operador}` : ''));
      return jsonOk(res, { encerrados: fechando.map(t => ({ maquina: t.maquina, turno: t.turno, inicio: t.inicio })), fim: agora,
                           parciais: respPartes() });
    }
    const trocados = [];
    makeTransaction(() => {
      gravarPartes();
      for (const p of maqs) {
        const ab = turnoCorteAberto(p);
        if (ab) { fechar.run(agora, 'troca', operador, agora, ab.id); trocados.push({ maquina: p, turno: ab.turno, inicio: ab.inicio }); }
        db.prepare(`INSERT INTO turnos_corte (maquina, turno, inicio, aberto_por, alterado_em) VALUES (?,?,?,?,?)`)
          .run(p, turno, agora, operador, agora);
      }
    })();
    logI('bobinas', `Turno do corte INICIADO: ${TURNOS_CORTE[turno]} na ${maqs.join(' e ')}`
      + (trocados.length ? ` (encerrou ${trocados.map(t => `${t.maquina} ${t.turno}`).join(', ')})` : '')
      + txtPartes + (operador ? ` por ${operador}` : ''));
    return jsonOk(res, { iniciado: { turno, maquinas: maqs, inicio: agora }, encerrados: trocados,
                         parciais: respPartes() });
  }

  // Finalizar: a bobina saiu da sacoleira SEM outra no lugar (máquina
  // parou, acabou o pedido). Fecha a aberta com os fardos que ela deu.
  // Body { sacoleira: 'P1'|'P2', fardos, operador }.
  // Desfazer: a leitura saiu errada e a bobina registrada NÃO é a que foi
  // para a máquina (28/09/2026: o leitor leu R… pela metade, o app de então
  // completou com "E" e apontou E0001674). A bobina volta para o estoque.
  // Só a entrada MAIS RECENTE de cada sacoleira pode ser desfeita: uma
  // anterior já foi encerrada pela troca seguinte, e desfazer no meio
  // deixaria a sequência da máquina sem sentido. A bobina que esta troca
  // encerrou NÃO é reaberta: ela saiu da máquina de verdade, e os fardos
  // informados dela valem. Corrige-se bipando a bobina certa depois.
  // ── Inventário de bobinas (ver inventarioAberto, lá em cima) ──
  if (pathname === '/bobinas/inventario' && req.method === 'GET') {
    const inv = inventarioAberto();
    if (inv) return jsonOk(res, { aberto: true, ...resumoInventario(inv) });
    const ult = db.prepare(`SELECT * FROM inventario_bobinas WHERE fim IS NOT NULL ORDER BY id DESC LIMIT 1`).get();
    return jsonOk(res, { aberto: false, ultimo: ult ? { id: ult.id, inicio: ult.inicio, fim: ult.fim,
      qtd: db.prepare(`SELECT COUNT(*) n FROM inventario_bobinas_itens WHERE inventario_id=?`).get(ult.id).n } : null });
  }
  if (pathname === '/bobinas/inventario/abrir' && req.method === 'POST') {
    let body; try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
    let inv = inventarioAberto();
    if (!inv) {
      const operador = (body.operador ? String(body.operador).trim().slice(0, 80) : null) || null;
      const r = db.prepare(`INSERT INTO inventario_bobinas (inicio, operador) VALUES (?, ?)`)
        .run(new Date().toISOString(), operador);
      inv = db.prepare(`SELECT * FROM inventario_bobinas WHERE id = ?`).get(Number(r.lastInsertRowid));
      logI('bobinas', `Inventário de bobinas #${inv.id} aberto${operador ? ' por ' + operador : ''}`);
    }
    return jsonOk(res, { aberto: true, ...resumoInventario(inv) });
  }
  if (pathname === '/bobinas/inventario/ler' && req.method === 'POST') {
    let body; try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
    const inv = inventarioAberto();
    if (!inv) return jsonErr(res, 409, 'Nenhum inventário aberto');
    const bid = String(body.id || '').trim().toUpperCase();
    const e = bid && dbStmts.getEtiqueta.get(bid);
    if (!e) return jsonErr(res, 404, `Etiqueta ${bid} não encontrada`);
    if (e.tipo !== 'extrusao') return jsonErr(res, 400, `${bid} não é bobina (é ${e.tipo})`);
    const ja = db.prepare(`SELECT 1 FROM inventario_bobinas_itens WHERE inventario_id=? AND etiqueta_id=?`).get(inv.id, bid);
    if (ja) return jsonOk(res, { repetida: true, id: bid });
    const situacao = situacaoBobina(e);
    const operador = (body.operador ? String(body.operador).trim().slice(0, 80) : null) || null;
    db.prepare(`INSERT INTO inventario_bobinas_itens (inventario_id, etiqueta_id, lido_em, situacao, operador)
                  VALUES (?, ?, ?, ?, ?)`).run(inv.id, bid, new Date().toISOString(), situacao, operador);
    return jsonOk(res, { lida: true, id: bid, situacao,
      bobina: { cor: e.cor, tipo_bobina: e.tipo_bobina, largura: e.largura, peso: e.peso, destino: e.destino } });
  }
  if (pathname === '/bobinas/inventario/remover' && req.method === 'POST') {
    let body; try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
    const inv = inventarioAberto();
    if (!inv) return jsonErr(res, 409, 'Nenhum inventário aberto');
    const bid = String(body.id || '').trim().toUpperCase();
    db.prepare(`DELETE FROM inventario_bobinas_itens WHERE inventario_id=? AND etiqueta_id=?`).run(inv.id, bid);
    return jsonOk(res, { removida: true, id: bid });
  }
  if (pathname === '/bobinas/inventario/concluir' && req.method === 'POST') {
    let body; try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
    const inv = inventarioAberto();
    if (!inv) return jsonErr(res, 409, 'Nenhum inventário aberto');
    db.prepare(`UPDATE inventario_bobinas SET fim = ? WHERE id = ?`).run(new Date().toISOString(), inv.id);
    const fechado = db.prepare(`SELECT * FROM inventario_bobinas WHERE id = ?`).get(inv.id);
    const r = resumoInventario(fechado);
    logI('bobinas', `Inventário de bobinas #${inv.id} concluído: ${r.qtd} bobina(s), ${r.kg} kg`);
    return jsonOk(res, { concluido: true, ...r });
  }
  // Lista em texto (uma linha por bobina, separada por ;) para copiar e
  // mandar adiante. ?id=N; sem id, o aberto ou o último concluído.
  if (pathname === '/bobinas/inventario/lista' && req.method === 'GET') {
    const id = parseInt(parsed.query.id, 10);
    const inv = id ? db.prepare(`SELECT * FROM inventario_bobinas WHERE id = ?`).get(id)
                   : (inventarioAberto() || db.prepare(`SELECT * FROM inventario_bobinas ORDER BY id DESC LIMIT 1`).get());
    if (!inv) return jsonErr(res, 404, 'Nenhum inventário');
    const r = resumoInventario(inv);
    const linhas = [`INVENTARIO DE BOBINAS #${inv.id} · inicio ${inv.inicio} · fim ${inv.fim || 'em aberto'} · ${r.qtd} bobinas · ${r.kg} kg`,
                    'etiqueta;cor;tipo;largura;peso_kg;extrusora;impressa_em;situacao_no_sistema;lida_em'];
    for (const x of r.itens.slice().reverse())
      linhas.push([x.id, x.cor, x.tipo_bobina, x.largura, x.peso, x.maquina, x.hora_impressao, x.situacao, x.lido_em].join(';'));
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(linhas.join('\n') + '\n');
  }

  // ── ZERAR O COLETOR (02/10/2026, Gustavo: "limpar todas as bipagens do
  // coletor" — eram TESTE, tudo inclusive inventários). Senha de supervisor.
  // Sem "confirmar": true só conta (ensaio). Com ele, numa transação:
  //   · bobinas montadas/encerradas voltam a 'bipada' (em estoque)
  //     — MENOS as que geraram pedido no Bling (ficam e são
  //     listadas: desfazer aqui deixaria o Bling com uma venda sem bobina);
  //   · apaga fardos por turno, trocas de formato, refugos, turnos do corte,
  //     inventários de bobinas e o histórico do dia (baixas_bobinas_<dia>).
  // Não mexe em etiqueta de MP, PA, outras pesagens nem na impressão da bobina.
  if (pathname === '/bobinas/zerar-coletor' && req.method === 'POST') {
    let body; try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
    const hashAtual = configGet('senha_saida_hash', hashSenha('1234'));
    if (hashSenha((body && body.senha) || '') !== hashAtual) return jsonErr(res, 401, 'Senha de supervisor incorreta.');
    const n = sql => db.prepare(sql).get().n;
    const bobinas = db.prepare(`SELECT id, destino, baixa_em, baixa_operador, fardos, bling_pedido_id FROM etiquetas
                                   WHERE tipo = 'extrusao' AND status = 'consumida' ORDER BY baixa_em`).all();
    const voltam = bobinas.filter(b => !b.bling_pedido_id);
    const ficam  = bobinas.filter(b =>  b.bling_pedido_id);
    const contagem = {
      bobinas_voltam_ao_estoque: voltam.length,
      bobinas_com_pedido_no_bling_ficam: ficam.map(b => ({ id: b.id, pedido: b.bling_pedido_id })),
      fardos_por_turno: n(`SELECT COUNT(*) n FROM bobina_parciais`),
      trocas_de_formato: n(`SELECT COUNT(*) n FROM bobina_setups`),
      refugos: n(`SELECT COUNT(*) n FROM bobina_refugos`),
      turnos_do_corte: n(`SELECT COUNT(*) n FROM turnos_corte`),
      inventarios_de_bobinas: n(`SELECT COUNT(*) n FROM inventario_bobinas`),
      historico_do_dia: n(`SELECT COUNT(*) n FROM config WHERE chave LIKE 'baixas_bobinas_%'`),
    };
    if (body.confirmar !== true)
      return jsonOk(res, { ensaio: true, ...contagem, aviso: 'Nada foi alterado. Repita com "confirmar": true para zerar.' });
    const agora = new Date().toISOString();
    makeTransaction(() => {
      const upd = db.prepare(
        `UPDATE etiquetas SET status='bipada', destino=NULL, baixa_em=NULL, baixa_turno=NULL,
                  baixa_operador=NULL, fardos=NULL, pacotes=NULL, encerrada_em=NULL, encerrada_motivo=NULL,
                  formato_cortado=NULL, formato_origem=NULL, alterado_em=?
            WHERE id = ? AND status = 'consumida' AND bling_pedido_id IS NULL`);
      for (const b of voltam) upd.run(agora, b.id);
      // As que ficam (pedido no Bling) não podem seguir "montadas": a
      // sacoleira começa vazia. Encerra sem fardos, motivo 'zerado'.
      const fecha = db.prepare(`UPDATE etiquetas SET encerrada_em=?, encerrada_motivo='zerado', alterado_em=?
                                   WHERE id = ? AND encerrada_em IS NULL`);
      for (const b of ficam) fecha.run(agora, agora, b.id);
      db.exec(`DELETE FROM bobina_parciais; DELETE FROM bobina_setups; DELETE FROM bobina_refugos;
                 DELETE FROM turnos_corte; DELETE FROM inventario_bobinas_itens; DELETE FROM inventario_bobinas;
                 DELETE FROM config WHERE chave LIKE 'baixas_bobinas_%';
                 DELETE FROM config WHERE chave LIKE 'proxima_bobina_%';`);
    })();
    logW('bobinas', `COLETOR ZERADO (${String(body.operador || '').trim() || 'sem nome'}): ` + JSON.stringify(contagem)
      + ` · bobinas de volta ao estoque: ${voltam.map(b => b.id).join(', ') || '—'}`);
    return jsonOk(res, { zerado: true, ...contagem });
  }

  // ── REFUGO DE BOBINA (02/10/2026, Gustavo — ver bobina_refugos) ──────
  // POST /bobinas/refugo { id, peso_bruto, operador? }: a bobina já saiu da
  // sacoleira (finalizada no coletor) e volta ao estoque como refugo. O peso
  // vem com o eixo: desconta a tara da largura (mesmo mapa da extrusão).
  if (pathname === '/bobinas/refugo' && req.method === 'POST') {
    let body; try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
    let bid = String(body.id || '').trim().toUpperCase();
    if (/^\d+$/.test(bid)) bid = 'E' + bid.padStart(7, '0');
    const e = bid && dbStmts.getEtiqueta.get(bid);
    if (!e) return jsonErr(res, 404, `Etiqueta ${bid || '—'} não encontrada`);
    if (e.tipo !== 'extrusao') return jsonErr(res, 400, `${bid} não é bobina de extrusão`);
    if (e.status === 'cancelada') return jsonErr(res, 400, `Bobina ${bid} está cancelada`);
    if (e.status !== 'consumida' || !e.baixa_em)
      return jsonErr(res, 409, `${bid} nunca foi montada numa sacoleira — não é refugo, está no estoque normal`);
    if (!e.encerrada_em)
      return jsonErr(res, 409, `${bid} ainda está montada na Sacoleira ${e.destino}. Finalize no coletor primeiro.`,
                     { na_sacoleira: e.destino });
    const ja = refugoAbertoDe(bid);
    if (ja) return jsonErr(res, 409, `${bid} já está no estoque como refugo (${Number(ja.peso).toFixed(1)} kg)`,
                           { ja_refugo: true });
    const bruto = Number(body.peso_bruto);
    if (!(bruto > 0) || bruto > 2000) return jsonErr(res, 400, 'Peso inválido');
    const tara = TARAS_EIXO[e.largura] || 0;
    const liq = Math.round(Math.max(0, bruto - tara) * 10) / 10;
    if (!(liq > 0)) return jsonErr(res, 400, `Peso ${bruto} kg não passa do eixo (${tara} kg)`);
    if (e.peso && liq > Number(e.peso) + 5)
      return jsonErr(res, 400, `Refugo de ${liq.toFixed(1)} kg é maior que a bobina inteira (${Number(e.peso).toFixed(1)} kg). Confira a etiqueta.`);
    const agora = new Date().toISOString();
    const operador = (body.operador ? String(body.operador).trim().slice(0, 80) : null) || null;
    let r;
    makeTransaction(() => {
      r = db.prepare(`INSERT INTO bobina_refugos (etiqueta_id, peso, peso_bruto, tara, pesado_em, operador,
                                                    destino_antes, pacotes_antes, alterado_em)
                        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(bid, liq, bruto, tara, agora, operador, e.destino || null,
             e.pacotes == null ? (e.fardos == null ? 0 : e.fardos * PACOTES_POR_FARDO) : e.pacotes, agora);
      db.prepare(`UPDATE etiquetas SET alterado_em = ? WHERE id = ?`).run(agora, bid);   // reexporta à VPS
    })();
    logI('bobinas', `REFUGO: ${bid} (${e.cor} ${e.tipo_bobina} ${e.largura}, ${Number(e.peso).toFixed(1)} kg) voltou da `
      + `Sacoleira ${e.destino} com ${liq.toFixed(1)} kg (bruto ${bruto} − eixo ${tara})${operador ? ' por ' + operador : ''}`);
    const resp = { id: Number(r.lastInsertRowid), etiqueta_id: bid, peso: liq, peso_bruto: bruto, tara,
                   pesado_em: agora, destino_antes: e.destino,
                   bobina: { cor: e.cor, tipo_bobina: e.tipo_bobina, largura: e.largura, peso: e.peso, fardos: e.fardos } };
    // 06/10/2026: sai a etiqueta do refugo. Falha de impressora NÃO desfaz o
    // registro — a tela avisa e o botão 🖨 da lista reimprime.
    imprimirEtiquetaRefugo(bid, resp, (ok, info) =>
      jsonOk(res, { refugo: resp, etiqueta_impressa: ok, etiqueta_erro: ok ? null : info }));
    return;
  }

  // GET /bobinas/refugos?dia=AAAA-MM-DD (padrão: hoje) — a lista da tela.
  // ?estoque=1 → os que estão no estoque como refugo agora (qualquer dia).
  if (pathname === '/bobinas/refugos' && req.method === 'GET') {
    const SEL = `SELECT r.*, e.cor, e.tipo_bobina, e.largura, e.peso AS peso_bobina, e.fardos
                     FROM bobina_refugos r LEFT JOIN etiquetas e ON e.id = r.etiqueta_id`;
    // 06/10/2026: as que saíram como REFUGO no coletor e ainda não foram
    // repesadas (sem refugo registrado depois do encerramento).
    const aguardando = db.prepare(`SELECT e.id, e.cor, e.tipo_bobina, e.largura, e.peso, e.destino, e.fardos,
                                            e.pacotes, e.encerrada_em
                                       FROM etiquetas e
                                      WHERE e.tipo = 'extrusao' AND e.encerrada_motivo = 'refugo'
                                        AND e.status = 'consumida'
                                        AND NOT EXISTS (SELECT 1 FROM bobina_refugos r WHERE r.etiqueta_id = e.id
                                                          AND r.cancelado_em IS NULL AND r.pesado_em >= e.encerrada_em)
                                      ORDER BY e.encerrada_em`).all();
    if (String(parsed.query.estoque || '') === '1') {
      const refugos = db.prepare(`${SEL} WHERE r.reaproveitado_em IS NULL AND r.cancelado_em IS NULL
                                     ORDER BY r.pesado_em DESC`).all();
      return jsonOk(res, { refugos, aguardando, kg: refugos.reduce((a, x) => a + (Number(x.peso) || 0), 0) });
    }
    const dia = /^\d{4}-\d{2}-\d{2}$/.test(String(parsed.query.dia || '')) ? String(parsed.query.dia) : dataLocalISO();
    const { ini, fim } = rangeUTCdoDiaLocal(dia);
    const refugos = db.prepare(`${SEL} WHERE r.pesado_em >= ? AND r.pesado_em < ? AND r.cancelado_em IS NULL
                                   ORDER BY r.pesado_em DESC`).all(ini, fim);
    return jsonOk(res, { dia, refugos, aguardando, kg: refugos.reduce((a, x) => a + (Number(x.peso) || 0), 0) });
  }

  // POST /bobinas/refugo/:id/etiqueta — (re)imprime a etiqueta do refugo
  // (06/10/2026): mesmo número da bobina, peso do refugo, tarja REFUGO.
  if ((m = pathname.match(/^\/bobinas\/refugo\/(\d+)\/etiqueta$/)) && req.method === 'POST') {
    const rf = db.prepare(`SELECT * FROM bobina_refugos WHERE id = ?`).get(Number(m[1]));
    if (!rf) return jsonErr(res, 404, 'Refugo não encontrado');
    if (rf.cancelado_em) return jsonErr(res, 400, `Refugo de ${rf.etiqueta_id} foi cancelado`);
    imprimirEtiquetaRefugo(rf.etiqueta_id, rf, (ok, info) =>
      ok ? jsonOk(res, { impresso: true, etiqueta_id: rf.etiqueta_id, printer: info })
         : jsonErr(res, 500, 'Falha na impressão: ' + info));
    return;
  }

  // POST /bobinas/refugo/:id/cancelar — pesagem de refugo errada. Só antes
  // de a bobina ser reaproveitada (aí é o desfazer da montagem).
  if ((m = pathname.match(/^\/bobinas\/refugo\/(\d+)\/cancelar$/)) && req.method === 'POST') {
    const rf = db.prepare(`SELECT * FROM bobina_refugos WHERE id = ?`).get(Number(m[1]));
    if (!rf || rf.cancelado_em) return jsonErr(res, 404, 'Refugo não encontrado');
    if (rf.reaproveitado_em)
      return jsonErr(res, 409, `${rf.etiqueta_id} já voltou para a Sacoleira ${rf.reaproveitado_destino} — desfaça lá primeiro`);
    const agora = new Date().toISOString();
    makeTransaction(() => {
      db.prepare(`UPDATE bobina_refugos SET cancelado_em = ?, alterado_em = ? WHERE id = ?`).run(agora, agora, rf.id);
      db.prepare(`UPDATE etiquetas SET alterado_em = ? WHERE id = ?`).run(agora, rf.etiqueta_id);
    })();
    logW('bobinas', `REFUGO cancelado: ${rf.etiqueta_id} (${Number(rf.peso).toFixed(1)} kg)`);
    return jsonOk(res, { cancelado: true, id: rf.id, etiqueta_id: rf.etiqueta_id });
  }

  if (pathname === '/bobinas/desfazer' && req.method === 'POST') {
    let body; try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
    const bid = String(body.id || '').trim().toUpperCase();
    const e = bid && dbStmts.getEtiqueta.get(bid);
    if (!e) return jsonErr(res, 404, `Etiqueta ${bid} não encontrada`);
    if (e.tipo !== 'extrusao' || e.status !== 'consumida' || !e.destino)
      return jsonErr(res, 400, `${bid} não está registrada numa sacoleira`);
    // Bobina de REFUGO reaproveitada (02/10/2026): desfazer a montagem nova
    // devolve ela ao estoque como refugo, com a montagem anterior intacta.
    const reap = db.prepare(`SELECT * FROM bobina_refugos WHERE etiqueta_id = ? AND reaproveitado_em = ?
                                  AND cancelado_em IS NULL`).get(bid, e.baixa_em || '');
    if (reap) {
      if (e.encerrada_em) return jsonErr(res, 409, `${bid} já saiu da Sacoleira ${e.destino} — não dá para desfazer`);
      const parcR = pacotesParciaisDe(bid).pacotes;
      if (parcR > 0)
        return jsonErr(res, 409, `${bid} já tem ${txtPacotes(parcR)} informados nesta montagem — foi usada, não dá para desfazer`);
      let ant = {}; try { ant = JSON.parse(reap.estado_antes || '{}'); } catch (err) {}
      const agoraD = new Date().toISOString();
      makeTransaction(() => {
        db.prepare(`UPDATE etiquetas SET destino=?, baixa_em=?, baixa_turno=?, baixa_operador=?, encerrada_em=?,
                             encerrada_motivo=?, formato_cortado=?, formato_origem=?, alterado_em=?
                       WHERE id = ? AND status = 'consumida' AND encerrada_em IS NULL`)
          .run(ant.destino || null, ant.baixa_em || null, ant.baixa_turno || null, ant.baixa_operador || null,
               ant.encerrada_em || agoraD, ant.encerrada_motivo || null, ant.formato_cortado || null,
               ant.formato_origem || null, agoraD, bid);
        db.prepare(`UPDATE bobina_refugos SET reaproveitado_em=NULL, reaproveitado_destino=NULL, estado_antes=NULL,
                             alterado_em=? WHERE id = ?`).run(agoraD, reap.id);
      })();
      const operadorD = (body.operador ? String(body.operador).trim().slice(0, 80) : null) || null;
      logW('bobinas', `DESFEITA a montagem de ${bid} (refugo) na Sacoleira ${e.destino} — volta ao estoque como refugo`
        + (operadorD ? ' por ' + operadorD : ''));
      return jsonOk(res, { desfeita: true, id: bid, sacoleira: e.destino, refugo: true });
    }
    if (e.bling_pedido_id)
      return jsonErr(res, 409, `${bid} já gerou o pedido ${e.bling_pedido_id} no Bling — cancele lá primeiro`);
    // Deu fardo → foi usada de verdade. 28/09/2026: depois de desfazer a
    // E0001674 (entrada errada), a E0001747 virou a "última" da P1 e também
    // foi desfeita — perdendo os 30 fardos de uma bobina que saiu da máquina.
    if (e.fardos != null && Number(e.fardos) > 0)
      return jsonErr(res, 409, `${bid} já tem ${e.fardos} fardo(s) informados — foi usada, não dá para desfazer`);
    // Idem com fardos de fim de turno: a bobina segue montada, mas já rendeu.
    const parc = pacotesParciaisDe(bid).pacotes;
    if (parc > 0)
      return jsonErr(res, 409, `${bid} já tem ${txtPacotes(parc)} informados em fim de turno — foi usada, não dá para desfazer`);
    const ultima = db.prepare(
      `SELECT id FROM etiquetas WHERE tipo='extrusao' AND destino = ? AND baixa_em IS NOT NULL
          ORDER BY baixa_em DESC LIMIT 1`).get(e.destino);
    if (!ultima || ultima.id !== bid)
      return jsonErr(res, 409, `Só dá para desfazer a última bobina da Sacoleira ${e.destino} (${ultima ? ultima.id : '—'})`);
    db.prepare(`UPDATE etiquetas SET status='bipada', destino=NULL, baixa_em=NULL, baixa_turno=NULL,
                         baixa_operador=NULL, fardos=NULL, pacotes=NULL, encerrada_em=NULL, encerrada_motivo=NULL,
                         alterado_em=?
                   WHERE id = ? AND status = 'consumida'`).run(new Date().toISOString(), bid);
    const operador = (body.operador ? String(body.operador).trim().slice(0, 80) : null) || null;
    devolverProximaBobina(e.destino, bid);   // volta o "BIPE A PRÓXIMA BOBINA", se veio de um
    logW('bobinas', `DESFEITA a entrada de ${bid} na Sacoleira ${e.destino} (era de ${e.baixa_em}, `
      + `fardos ${e.fardos == null ? '—' : e.fardos})${operador ? ' por ' + operador : ''}`);
    return jsonOk(res, { desfeita: true, id: bid, sacoleira: e.destino });
  }

  if (pathname === '/bobinas/finalizar' && req.method === 'POST') {
    let body; try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
    const sac = normalizarDestinoBobina(body.sacoleira);
    if (!sac) return jsonErr(res, 400, 'Sacoleira inválida (P1 ou P2)');
    const a = bobinaAbertaNa(sac);
    if (!a) return jsonErr(res, 409, `A Sacoleira ${sac} não tem bobina aberta`);
    if (lerFardos(body.fardos) === null) return jsonErr(res, 400, `Informe quantos fardos a bobina ${a.id} deu`);
    const parte = lerParte(sac, body.fardos, body.soltos, lerFormatoDaMaquina(sac, body.formato));
    if (parte.erro) return jsonErr(res, 400, parte.erro);
    const formatoFim = lerFormatoDaMaquina(sac, body.formato);
    const operador = (body.operador ? String(body.operador).trim().slice(0, 80) : null) || null;
    // REFUGO pelo coletor (06/10/2026, Gustavo): mesma conta do encerrar,
    // motivo 'refugo'. A bobina sai da máquina sem acabar e fica AGUARDANDO
    // REPESAGEM (GET /bobinas/refugos → aguardando) até alguém bipar a
    // etiqueta antiga em Outras pesagens → REFUGO e pesar. Fora do
    // aproveitamento da VPS (lá só entram 'troca' e 'finalizada').
    // "✓ Bobina finalizou" (16/10/2026, Vinicius) manda acabou:true = a
    // bobina ACABOU na máquina → motivo 'troca', o mesmo de quando o fim
    // vinha pela bipagem da seguinte. É o que a VPS conta como bobina
    // completa (aproveitamento, m/kg, previsão); 'finalizada' lá é "saiu
    // antes de acabar" e fica fora da média.
    const motivo = body.refugo === true ? 'refugo' : body.acabou === true ? 'troca' : 'finalizada';
    // Formato da PRÓXIMA bobina (20/10/2026, Gustavo): escolhido no mesmo
    // ✓ Bobina finalizou — a troca de formato com bobina nova não pede fardos
    // de novo. Só com a bobina que acabou (não no refugo).
    let formatoProx = null;
    if (motivo === 'troca' && body.formato_proximo !== undefined && body.formato_proximo !== null) {
      formatoProx = lerFormatoDaMaquina(sac, body.formato_proximo);
      if (!formatoProx) return jsonErr(res, 400, `Formato ${body.formato_proximo} não é da ${sac}`);
    }
    let total = parte.pacotes;
    const quando = new Date().toISOString();
    makeTransaction(() => {
      total = encerrarBobina(a.id, parte, motivo, quando, formatoFim,
                             body.formato_origem === 'sugerido' ? 'sugerido' : 'escolhido', sac, operador);
      if (formatoProx) marcarProximaBobina(sac, formatoProx, a.id, quando);
    })();
    logI('bobinas', `Sacoleira ${sac}: ${a.id} ${motivo === 'refugo' ? 'saiu como REFUGO' : 'finalizada'} com ${txtPacotes(parte.pacotes)} neste trecho`
      + ` (${parte.fechados} fechado(s), ${parte.soltos} solto(s)) · total ${txtPacotes(total)}${operador ? ' por ' + operador : ''}`
      + (formatoProx ? ` · próxima vai cortar ${formatoProx}` + (formatoFim && formatoFim !== formatoProx ? ` (troca de ${formatoFim})` : '') : ''));
    return jsonOk(res, { finalizada: true, refugo: motivo === 'refugo', sacoleira: sac, id: a.id,
                         pacotes: parte.pacotes, pacotes_total: total, formato_proximo: formatoProx });
  }

  // Troca de formato com a bobina montada (02/10/2026, Gustavo — ver
  // bobina_setups). Body { sacoleira, fardos, soltos, formato, formato_origem,
  // formato_novo, operador }: fardos/soltos/formato são do formato QUE ESTAVA
  // rodando. formato_novo (20/10/2026): o operador escolhe na hora, e a troca
  // já fica definida (assumirFormatoEscolhido). Sem ele (tela antiga), o novo
  // é decidido depois, pelo comprimento do CLP (formatoDaBobina). Sem senha.
  if (pathname === '/bobinas/trocar-formato' && req.method === 'POST') {
    let body; try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
    const sac = normalizarDestinoBobina(body.sacoleira);
    if (!sac) return jsonErr(res, 400, 'Sacoleira inválida (P1 ou P2)');
    const a = bobinaAbertaNa(sac);
    if (!a) return jsonErr(res, 409, `A Sacoleira ${sac} não tem bobina montada`);
    const pend = setupDaBobina(a.id);
    if (pend && !pend.definido_em)
      return jsonErr(res, 409, `Já há uma troca de formato na ${sac} aguardando a sacoleira mudar o comprimento`);
    if (lerFardos(body.fardos) === null) return jsonErr(res, 400, 'Informe quantos fardos fecharam no formato que estava rodando');
    const parte = lerParte(sac, body.fardos, body.soltos, lerFormatoDaMaquina(sac, body.formato));
    if (parte.erro) return jsonErr(res, 400, parte.erro);
    const formatoAntes = lerFormatoDaMaquina(sac, body.formato);
    let formatoNovo = null;
    if (body.formato_novo !== undefined && body.formato_novo !== null && body.formato_novo !== '') {
      formatoNovo = lerFormatoDaMaquina(sac, body.formato_novo);
      if (!formatoNovo) return jsonErr(res, 400, `Formato ${body.formato_novo} não é da ${sac}`);
      if (formatoNovo === formatoAntes) return jsonErr(res, 400, `O formato novo é o mesmo que estava rodando (${formatoAntes})`);
    }
    const operador = (body.operador ? String(body.operador).trim().slice(0, 80) : null) || null;
    const clp = await clpSacoleiras();
    const sug = sugerirFormato(sac, a, clp.dados ? clp.dados[sac] : null);
    // Setup que mudou sem aviso (detectarSetupSemAviso): o comprimento de
    // ANTES é o que estava quando a bobina cortava o formato antigo.
    let vig = null; try { vig = JSON.parse(configGet('formato_vigente_' + sac, 'null')); } catch (e) {}
    const mmAntes = (vig && vig.etq === a.id && vig.detectado && vig.detectado.mm_antes) || sug.comprimento_mm;
    const agora = new Date().toISOString();
    makeTransaction(() => {
      registrarParcial(a.id, sac, parte, 'setup', agora, operador, formatoAntes,
                       body.formato_origem === 'sugerido' ? 'sugerido' : 'escolhido');
      const pid = db.prepare(`SELECT last_insert_rowid() AS id`).get().id;
      db.prepare(`INSERT INTO bobina_setups (etiqueta_id, maquina, parte_id, formato_antes, comprimento_antes_mm, pedido_em, operador,
                                             formato_novo, definido_em)
                    VALUES (?,?,?,?,?,?,?,?,?)`).run(a.id, sac, pid, formatoAntes, mmAntes, agora, operador,
                                                     formatoNovo, formatoNovo ? agora : null);
      if (formatoNovo) assumirFormatoEscolhido(sac, a.id, a.baixa_em, formatoNovo, sug);
      else configSet('formato_vigente_' + sac, 'null');   // a troca registrada assume daqui
      db.prepare(`UPDATE etiquetas SET alterado_em = ? WHERE id = ?`).run(agora, a.id);
    })();
    const total = pacotesParciaisDe(a.id).pacotes;
    logI('bobinas', `Sacoleira ${sac}: troca de formato na ${a.id} — ${formatoAntes || '?'} rendeu ${txtPacotes(parte.pacotes)}`
      + ` (${parte.fechados} fechado(s), ${parte.soltos} solto(s)) · `
      + (formatoNovo ? `formato novo ${formatoNovo}` : 'aguardando o comprimento mudar')
      + (sug.comprimento_mm ? ` (agora ${sug.comprimento_mm} mm)` : '') + (operador ? ` · ${operador}` : ''));
    return jsonOk(res, { setup: true, sacoleira: sac, id: a.id, formato_antes: formatoAntes, formato_novo: formatoNovo,
                         pacotes: parte.pacotes, pacotes_bobina: total, aguardando: !formatoNovo });
  }

  // Corrigir fardos FECHADOS e pacotes SOLTOS de uma parte, no resumo do
  // turno (01/10/2026, Gustavo: "vai que alguém digitou fardos a mais").
  // Senha do supervisor. Body { senha, parte_id, fardos, soltos, operador }.
  // pacotes = fechados × 5 + soltos − soltos do início, então:
  //   · Δfechados vale × 5 nesta parte;
  //   · Δsoltos muda esta parte E a parte SEGUINTE da mesma máquina, que
  //     começou contando com esses soltos (o "soltos do início" dela).
  // Bobina já encerrada (esta ou a da parte seguinte): o total da etiqueta
  // é refeito pela soma das partes.
  if (pathname === '/bobinas/parcial/editar' && req.method === 'POST') {
    let body; try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
    // Sem senha desde 05/10/2026 (Gustavo) — ver /bobinas/turno-corte.
    const parte = db.prepare(`SELECT * FROM bobina_parciais WHERE id = ?`).get(Number(body.parte_id));
    if (!parte) return jsonErr(res, 404, 'Parte não encontrada');
    // fardos opcional desde 06/10/2026 (dá para corrigir só o formato).
    const novos = (body.fardos === undefined || body.fardos === null || body.fardos === '')
      ? (Number(parte.fardos) || 0) : lerFardos(body.fardos);
    if (novos === null) return jsonErr(res, 400, 'Fardos deve ser um número de 0 a 999');
    // FORMATO (06/10/2026, Gustavo — caso E0001823: setup trocado com a
    // máquina parada, bobina encerrada em seguida e gravada no formato novo).
    // Só os formatos da máquina; vira formato_origem 'corrigido', que a VPS
    // respeita (não troca pelo CLP).
    let formatoNovo = null;
    if (body.formato !== undefined && body.formato !== null && body.formato !== '') {
      formatoNovo = lerFormatoDaMaquina(parte.maquina, body.formato);
      if (!formatoNovo) return jsonErr(res, 400, `Formato ${body.formato} não é da ${parte.maquina}`);
      if (formatoNovo === parte.formato) formatoNovo = null;
    }
    const soltosAntes = Number(parte.soltos_fim) || 0;
    const soltosNovo = (body.soltos === undefined || body.soltos === null || body.soltos === '') ? soltosAntes : lerSoltos(body.soltos);
    if (soltosNovo === null) return jsonErr(res, 400, 'Pacotes soltos deve ser de 0 a 4');
    const antigos = Number(parte.fardos) || 0;
    const pacAntes = parte.pacotes != null ? Number(parte.pacotes) : antigos * PACOTES_POR_FARDO;
    const dSoltos = soltosNovo - soltosAntes;
    const pacNovo = pacAntes + (novos - antigos) * PACOTES_POR_FARDO + dSoltos;
    if (pacNovo < 0) return jsonErr(res, 400, `Com ${novos} fardo(s) e ${soltosNovo} solto(s) a parte ficaria negativa — confira`);
    // A seguinte só começou contando com estes soltos se os aproveitou
    // (herdaSoltos: não depois de troca de formato, nem com outra cor ou
    // outro formato); se não aproveitou, mudar os soltos daqui não mexe nela.
    const corDe = (etq) => (db.prepare(`SELECT cor FROM etiquetas WHERE id = ?`).get(etq) || {}).cor;
    const seg0 = dSoltos ? db.prepare(
      `SELECT * FROM bobina_parciais WHERE maquina = ? AND id > ? ORDER BY id LIMIT 1`).get(parte.maquina, parte.id) : null;
    const seguinte = (seg0 && herdaSoltos(
      { momento: parte.momento, formato: formatoNovo || parte.formato, cor: corDe(parte.etiqueta_id) },
      { formato: seg0.formato, cor: corDe(seg0.etiqueta_id) })) ? seg0 : null;
    const pacSeg = seguinte ? (seguinte.pacotes != null ? Number(seguinte.pacotes) : Number(seguinte.fardos) * PACOTES_POR_FARDO) - dSoltos : null;
    if (seguinte && pacSeg < 0)
      return jsonErr(res, 400, `Com ${soltosNovo} solto(s) a parte seguinte da ${parte.maquina} (${seguinte.etiqueta_id}) ficaria negativa — confira`);
    const operador = (body.operador ? String(body.operador).trim().slice(0, 80) : null) || null;
    const agora = new Date().toISOString();
    const refazTotal = (etq) => {
      const e = db.prepare(`SELECT encerrada_em FROM etiquetas WHERE id = ?`).get(etq);
      if (e && e.encerrada_em) {
        const t = db.prepare(`SELECT COALESCE(SUM(${SQL_PACOTES_PARTE}), 0) AS n FROM bobina_parciais WHERE etiqueta_id = ?`).get(etq).n;
        db.prepare(`UPDATE etiquetas SET fardos = ?, pacotes = ?, alterado_em = ? WHERE id = ?`)
          .run(Math.round(t / PACOTES_POR_FARDO), t, agora, etq);
        return t;
      }
      db.prepare(`UPDATE etiquetas SET alterado_em = ? WHERE id = ?`).run(agora, etq);
      return null;
    };
    let total = null;
    makeTransaction(() => {
      db.prepare(`UPDATE bobina_parciais SET fardos = ?, pacotes = ?, soltos_fim = ?, editado_em = ?, editado_por = ?,
                           fardos_antes = COALESCE(fardos_antes, ?) WHERE id = ?`)
        .run(novos, pacNovo, soltosNovo, agora, operador, antigos, parte.id);
      if (formatoNovo) {
        db.prepare(`UPDATE bobina_parciais SET formato = ?, formato_origem = 'corrigido' WHERE id = ?`)
          .run(formatoNovo, parte.id);
        // A etiqueta guarda o formato da ÚLTIMA parte: muda se for ela.
        const ult = db.prepare(`SELECT id FROM bobina_parciais WHERE etiqueta_id = ? ORDER BY id DESC LIMIT 1`)
                      .get(parte.etiqueta_id);
        if (ult && ult.id === parte.id)
          db.prepare(`UPDATE etiquetas SET formato_cortado = ?, formato_origem = 'corrigido', alterado_em = ?
                         WHERE id = ? AND formato_cortado IS NOT NULL`).run(formatoNovo, agora, parte.etiqueta_id);
      }
      if (seguinte) {
        db.prepare(`UPDATE bobina_parciais SET pacotes = ?, editado_em = ?, editado_por = ? WHERE id = ?`)
          .run(pacSeg, agora, operador, seguinte.id);
        if (seguinte.etiqueta_id !== parte.etiqueta_id) refazTotal(seguinte.etiqueta_id);
      }
      total = refazTotal(parte.etiqueta_id);
    })();
    logI('bobinas', `Fardos corrigidos no resumo: ${parte.etiqueta_id} (${parte.maquina}, turno ${parte.turno || '—'}) `
      + `${antigos} → ${novos} fardo(s), soltos ${soltosAntes} → ${soltosNovo}`
      + (seguinte ? ` · parte seguinte ${seguinte.etiqueta_id} ajustada em ${-dSoltos} pc` : '')
      + (formatoNovo ? ` · formato ${parte.formato || '?'} → ${formatoNovo}` : '')
      + (total != null ? ` · total da bobina ${txtPacotes(total)}` : '') + (operador ? ` por ${operador}` : ''));
    return jsonOk(res, { id: parte.etiqueta_id, parte_id: parte.id, fardos: novos, soltos: soltosNovo, pacotes: pacNovo,
                         formato: formatoNovo || parte.formato,
                         pacotes_total: total, seguinte: seguinte ? { id: seguinte.etiqueta_id, pacotes: pacSeg } : null });
  }

  // Histórico das baixas de hoje (a tela mostra o que já foi retirado).
  // Lido da ETIQUETA, não da lista `baixas_bobinas_<dia>` do config: os
  // fardos chegam depois da baixa (na troca ou no Finalizar), e a lista é
  // um retrato do momento da baixa. baixa_em é UTC; o dia é o local (-03:00).
  // Lista POR TURNO (30/09/2026, Gustavo): cada sacoleira mostra o turno
  // do corte dela — o aberto, ou o último que fechou. Entra toda bobina que
  // esteve na máquina em algum momento do turno: a que já estava montada
  // quando o turno começou é do turno que entrou. Para cada uma: os fardos
  // DESTE turno (partes amarradas a ele), o total e o rendimento da bobina
  // (fardos × 25 kg ÷ peso). Rendimento só é final quando a bobina sai;
  // montada, é "até agora". Sacoleira que nunca teve turno: janela de hoje.
  if (pathname === '/bobinas/do-turno' && req.method === 'GET') {
    const agora = new Date().toISOString();
    const hoje0 = new Date(dataLocalISO() + 'T00:00:00-03:00').toISOString();
    const parteTurno = db.prepare(
      `SELECT COALESCE(SUM(${SQL_PACOTES_PARTE}), 0) AS n, COUNT(*) AS c, MAX(formato) AS f,
                MAX(id) AS pid, MAX(fardos) AS fech, MAX(editado_em) AS ed, MAX(fardos_antes) AS antes, MAX(soltos_fim) AS sf
           FROM bobina_parciais WHERE etiqueta_id = ? AND turno_corte_id = ?`);
    const porFormatoTurno = db.prepare(
      `SELECT formato, COALESCE(SUM(${SQL_PACOTES_PARTE}), 0) AS pacotes
           FROM bobina_parciais WHERE etiqueta_id = ? AND turno_corte_id = ?
          GROUP BY formato ORDER BY MIN(id)`);
    // Corrigir tocando na bobina da lista (07/10/2026, Gustavo: "ao clicar na
    // bobina ela abre uma tela de edição ... como se tivesse refazendo o
    // lançamento"): cada parte com o que foi lançado e os soltos do início
    // (pacotes = fechados × 5 + soltos − soltos do início), para a tela
    // refazer a conta igual ao lançamento.
    const partesDoTurno = db.prepare(
      `SELECT id, formato, fardos, soltos_fim, ${SQL_PACOTES_PARTE} AS pacotes, momento, registrado_em
           FROM bobina_parciais WHERE etiqueta_id = ? AND (? IS NULL OR turno_corte_id = ?) ORDER BY id`);
    const foiEditada = db.prepare(`SELECT 1 FROM bobina_parciais WHERE etiqueta_id = ? AND editado_em IS NOT NULL LIMIT 1`);
    // ?fechado=1 (01/10/2026): o último turno que FECHOU — é o resumo que a
    // tela mostra logo depois de encerrar ou trocar o turno.
    const soFechado = parsed.query.fechado === '1';
    const sacoleiras = ['P1', 'P2'].map(maq => {
      const t = (soFechado
        ? db.prepare(`SELECT * FROM turnos_corte WHERE maquina = ? AND fim IS NOT NULL ORDER BY fim DESC, id DESC LIMIT 1`).get(maq)
        : db.prepare(`SELECT * FROM turnos_corte WHERE maquina = ? ORDER BY (fim IS NULL) DESC, inicio DESC, id DESC LIMIT 1`).get(maq)) || null;
      const ini = t ? t.inicio : hoje0, fim = (t && t.fim) || agora;
      const bobinas = db.prepare(
        `SELECT id, cor, tipo_bobina, largura, peso, baixa_em, baixa_operador AS operador, bling_pedido_id AS pedido,
                  fardos, pacotes, encerrada_em, encerrada_motivo, formato_cortado
             FROM etiquetas WHERE tipo = 'extrusao' AND destino = ? AND baixa_em IS NOT NULL
              AND baixa_em <= ? AND (encerrada_em IS NULL OR encerrada_em >= ?)
            ORDER BY baixa_em DESC`).all(maq, fim, ini);
      // Bobina que saiu DESTA máquina como refugo e já voltou em outra
      // (07/10/2026, caso E0001797): a etiqueta aponta a máquina nova, mas a
      // parte dela neste turno continua daqui.
      if (t) {
        const ja = new Set(bobinas.map(b => b.id));
        const outras = db.prepare(
          `SELECT DISTINCT etiqueta_id AS id FROM bobina_parciais WHERE maquina = ? AND turno_corte_id = ?`).all(maq, t.id);
        for (const o of outras) {
          if (ja.has(o.id)) continue;
          const e = db.prepare(`SELECT id, cor, tipo_bobina, largura, peso, baixa_em, baixa_operador AS operador,
                                         bling_pedido_id AS pedido, fardos, pacotes, encerrada_em, encerrada_motivo, formato_cortado, destino
                                    FROM etiquetas WHERE id = ?`).get(o.id);
          const m = e && montagensDaBobina(e.id).find(x => x.destino === maq && x.encerrada_em && x.baixa_em <= fim && x.encerrada_em >= ini);
          if (!m) continue;
          bobinas.push({ ...e, baixa_em: m.baixa_em, operador: m.baixa_operador, encerrada_em: m.encerrada_em,
                         encerrada_motivo: m.encerrada_motivo, voltou_em: e.destino });
        }
        bobinas.sort((a, b) => (b.baixa_em || '').localeCompare(a.baixa_em || ''));
      }
      let pacotesTurno = 0;
      for (const b of bobinas) {
        const montada = !b.encerrada_em;
        // Montada sem nenhum fim de turno ainda: não há total ("na máquina"), não 0.
        // Tudo em PACOTES (fardo = 5; ver lerParte). Etiqueta antiga sem
        // `pacotes` vale fardos × 5.
        const parc = pacotesParciaisDe(b.id);
        const fechada = b.pacotes != null ? b.pacotes : (b.fardos != null ? b.fardos * PACOTES_POR_FARDO : null);
        const total = montada ? (parc.partes ? parc.pacotes : null) : fechada;
        const noTurno = t ? parteTurno.get(b.id, t.id) : { n: 0, c: 0 };
        // Sem turno registrado (janela de hoje): a bobina inteira conta aqui.
        b.pacotes_turno = t ? (noTurno.c ? noTurno.n : null) : total;
        b.formato_turno = (noTurno && noTurno.f) || b.formato_cortado || null;
        // Troca de formato no turno (02/10/2026): os pacotes de CADA formato,
        // na ordem em que rodaram. Uma entrada só = sem troca.
        b.formatos_turno = t ? porFormatoTurno.all(b.id, t.id) : [];
        // Editável no resumo só quando a bobina tem UMA parte neste turno.
        b.parte_id = (noTurno && noTurno.c === 1) ? noTurno.pid : null;
        b.fechados_turno = (noTurno && noTurno.c === 1) ? noTurno.fech : null;
        b.soltos_turno = (noTurno && noTurno.c === 1) ? (noTurno.sf || 0) : null;
        b.editado = !!(noTurno && noTurno.ed);
        b.fardos_antes = (noTurno && noTurno.ed) ? noTurno.antes : null;
        b.partes_turno = partesDoTurno.all(b.id, t ? t.id : null, t ? t.id : null).map(p => ({
          ...p, soltos_fim: Number(p.soltos_fim) || 0,
          soltos_inicio: Math.max(0, (Number(p.fardos) || 0) * PACOTES_POR_FARDO + (Number(p.soltos_fim) || 0) - Number(p.pacotes)) }));
        // Só o sinal (Gustavo: "não precisa dizer o quê, só que foi editada").
        b.editada = !!foiEditada.get(b.id);
        b.pacotes_total = total;
        b.montada = montada;
        b.veio_de_antes = b.baixa_em < ini;
        b.rendimento_pct = (total != null && Number(b.peso) > 0)
          ? Math.round(total * (PESO_FARDO_KG / PACOTES_POR_FARDO) / Number(b.peso) * 100) : null;
        b.rendimento_final = !montada;
        b.refugo = b.encerrada_motivo === 'refugo';   // saiu daqui como refugo (07/10/2026)
        b.cor_pa = corPaDaBobina(b.cor);
        if (b.pacotes_turno) pacotesTurno += b.pacotes_turno;
      }
      return { sacoleira: maq, turno: t ? { id: t.id, turno: t.turno, label: TURNOS_CORTE[t.turno] || t.turno,
                                              inicio: t.inicio, fim: t.fim } : null,
               bobinas, pacotes_turno: pacotesTurno, kg_turno: pacotesTurno * (PESO_FARDO_KG / PACOTES_POR_FARDO) };
    });
    return jsonOk(res, { sacoleiras, peso_fardo_kg: PESO_FARDO_KG, pacotes_por_fardo: PACOTES_POR_FARDO });
  }

  return NAO_TRATADA;
}

module.exports = rotasBobinas;
