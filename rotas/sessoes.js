// ════════════════════════════════════════════════════════════════════
//  ROTAS — sessões e resumo do dia
// ════════════════════════════════════════════════════════════════════

const { dataLocalISO, logI, logW } = require('../lib/log');
const { db, dbStmts, makeTransaction, totaisDaSessao } = require('../lib/db');
const {
  coletarResumoDia, imprimirResumoDia, imprimirResumoSessao, RESUMO_DIA_TIPOS,
  resumoAutomaticoAtivo,
} = require('../lib/impressao');
const { jsonErr, jsonOk, lerBodyJson, NAO_TRATADA } = require('../lib/http');
const { enviarSessaoBling } = require('../lib/negocio');

// Devolve NAO_TRATADA quando nenhuma rota daqui atende o pedido.
async function rotasSessoes(req, res, parsed, pathname) {
  let m;

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

  // ─── RESUMO DO DIA (retirada / retorno / resíduos) ───
  // GET  /resumo-dia?tipo=retirada&data=AAAA-MM-DD  → PRÉVIA, não imprime.
  //      A tela usa isto pra mostrar "12 operações · 4.800 kg" ANTES de
  //      gastar etiqueta — e pra desabilitar o botão em dia sem movimento.
  // POST /resumo-dia  { tipo, data }                → imprime de fato.
  if (pathname === '/resumo-dia' && (req.method === 'GET' || req.method === 'POST')) {
    let p = {};
    if (req.method === 'POST') { try { p = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); } }
    else p = parsed.query || {};

    const tipo = String(p.tipo || '').trim().toLowerCase();
    const dia  = String(p.data || '').trim() || dataLocalISO();
    if (!RESUMO_DIA_TIPOS.includes(tipo)) {
      return jsonErr(res, 400, `Resumo do dia não se aplica a "${tipo || '(vazio)'}" (use: ${RESUMO_DIA_TIPOS.join(', ')})`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) return jsonErr(res, 400, 'data inválida (use AAAA-MM-DD)');

    if (req.method === 'GET') {
      const d = coletarResumoDia(tipo, dia);
      return jsonOk(res, {
        tipo, data: dia,
        itens: d.itens.length,
        sessoes: d.sessoes,
        abertas: d.abertas,
        total_kg: Number(d.totalKg.toFixed(3)),
        grupos: d.grupos.map(g => ({ label: g.label, itens: g.count, kg: Number(g.kg.toFixed(3)) })),
      });
    }

    const r = imprimirResumoDia(tipo, dia);
    if (!r.ok) {
      const msg = r.motivo === 'sem_itens'
        ? `Nada foi pesado em ${dia.split('-').reverse().join('/')} — não há o que imprimir.`
        : r.motivo === 'data_invalida' ? 'data inválida (use AAAA-MM-DD)'
        : r.motivo === 'tipo_nao_aplicavel' ? 'Resumo do dia não se aplica a este tipo'
        : 'Não foi possível imprimir o resumo do dia';
      return jsonErr(res, 400, msg, { motivo: r.motivo });
    }
    return jsonOk(res, { resumo: r });
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
    // v53/v55: imprime o resumo na térmica 100x150 (recebimento → big bags;
    // extrusão → bobinas). Desde 01/09/2026 isso vale só para os tipos de
    // FECHAMENTO (resumo_auto_tipos). Retirada, retorno e resíduos não
    // imprimem aqui: acumulam no "Resumo do dia" (POST /resumo-dia).
    let resumo;
    if (resumoAutomaticoAtivo(s.tipo)) {
      resumo = imprimirResumoSessao(s);
    } else {
      resumo = { ok: false, motivo: 'impressao_opcional', tipo: s.tipo,
                 dica: 'use o botao "Resumo do dia" nesta tela' };
      logI('resumo', `Sessão #${id} (${s.tipo}) finalizada sem imprimir resumo — impressão acumulada no resumo do dia`);
    }
    const blingResp = await enviarSessaoBling(id);
    return jsonOk(res, { sessao_id: id, totais: tot, pendentes_canceladas: pendentes.length, bling: blingResp, resumo });
  }

  // POST /sessoes/:id/reenviar-bling   body opcional: { forcar: true }
  if ((m = pathname.match(/^\/sessoes\/(\d+)\/reenviar-bling$/)) && req.method === 'POST') {
    let bodyR = {}; try { bodyR = await lerBodyJson(req); } catch(e) {}
    const r = await enviarSessaoBling(parseInt(m[1]), { forcar: !!(bodyR && bodyR.forcar) });
    return jsonOk(res, { bling: r });
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

  return NAO_TRATADA;
}

module.exports = rotasSessoes;
