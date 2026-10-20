// ════════════════════════════════════════════════════════════════════
//  AUTO-FINALIZAÇÃO de turnos de Extrusão por horário
// ════════════════════════════════════════════════════════════════════

const { dataLocalISO, logDesvio, logE, logI, logW } = require('./log');
const { configGet, db, dbStmts } = require('./db');
const { proxyChamada } = require('./bling');
const { enviarSessaoBling } = require('./negocio');

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

const _avisos30minDados = new Set();
const _pendenteAvisado  = new Set();

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
  // 'consumida' = já montada na sacoleira pelo coletor: foi pesada, entra.
  const bipadas    = validas.filter(e => e.status === 'bipada' || e.status === 'consumida');
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

module.exports = { checarSessoesParaAutoFim, enviarBlingIndividualExtrusao, };
