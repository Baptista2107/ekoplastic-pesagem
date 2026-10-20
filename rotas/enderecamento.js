// ════════════════════════════════════════════════════════════════════
//  ROTAS — endereçamento do galpão
// ════════════════════════════════════════════════════════════════════

const { PA_CORES } = require('../lib/config');
const { logI, logW } = require('../lib/log');
const { configGet, db } = require('../lib/db');
const { GALPAO_NIVEIS, GALPAO_RUAS } = require('../lib/enderecamento');
const { gaiolasRegistro } = require('../lib/separacao');
const { jsonErr, jsonOk, lerBodyJson, NAO_TRATADA } = require('../lib/http');

// Devolve NAO_TRATADA quando nenhuma rota daqui atende o pedido.
async function rotasEnderecamento(req, res, parsed, pathname) {
  let m;

  // ══════════════════════════════════════════════════════════════
  //  ENDEREÇAMENTO DO GALPÃO  (04/09/2026)
  //  Amarra uma GAIOLA de produto acabado a um ENDEREÇO de
  //  prateleira. Os dois já têm QR impresso: o endereço carrega o
  //  código puro (01-02-007) e a gaiola carrega EKOPA|...
  // ══════════════════════════════════════════════════════════════

  // GET /enderecamento/mapa — todas as posições com quem mora nelas.
  if (pathname === '/enderecamento/mapa' && req.method === 'GET') {
    const linhas = db.prepare(`
        SELECT p.codigo, p.rua, p.nivel, p.posicao, p.tipo_gaiola, p.bloqueada, p.motivo,
               o.gaiola_id, o.entrada, o.formato, o.cor, o.fardos, o.kg,
               o.tipo_gaiola AS gaiola_tipo, o.operador_e
          FROM posicoes p
          LEFT JOIN ocupacoes o ON o.posicao = p.codigo AND o.saida IS NULL
         ORDER BY p.rua, p.nivel, p.posicao`).all();

    const agora = Date.now();
    const posicoes = linhas.map(l => ({
      codigo: l.codigo, rua: l.rua, nivel: l.nivel, posicao: l.posicao,
      tipo_gaiola: l.tipo_gaiola, bloqueada: !!l.bloqueada, motivo: l.motivo,
      ocupada: !!l.gaiola_id,
      gaiola: l.gaiola_id ? {
        id: l.gaiola_id, formato: l.formato, cor: l.cor,
        fardos: l.fardos, kg: l.kg, tipo: l.gaiola_tipo,
        entrada: l.entrada, operador: l.operador_e,
        // Sem baixa automática na saída, o mapa envelhece calado. O
        // número de dias é o que faz o esquecimento aparecer.
        dias: l.entrada ? Math.floor((agora - new Date(l.entrada).getTime()) / 86400000) : null,
      } : null,
    }));

    const ocupadas  = posicoes.filter(p => p.ocupada).length;
    const bloqueadas = posicoes.filter(p => p.bloqueada).length;
    return jsonOk(res, {
      posicoes,
      resumo: {
        total: posicoes.length,
        uteis: posicoes.length - bloqueadas,
        ocupadas,
        livres: posicoes.length - bloqueadas - ocupadas,
        bloqueadas,
        fardos: posicoes.reduce((a, p) => a + ((p.gaiola && p.gaiola.fardos) || 0), 0),
        kg: Number(posicoes.reduce((a, p) => a + ((p.gaiola && p.gaiola.kg) || 0), 0).toFixed(1)),
      },
      layout: { ruas: GALPAO_RUAS, niveis: GALPAO_NIVEIS },
    });
  }

  // GET /enderecamento/posicao/:codigo — detalhe + histórico curto.
  if ((m = pathname.match(/^\/enderecamento\/posicao\/(\d{2}-\d{2}-\d{3})$/)) && req.method === 'GET') {
    const p = db.prepare('SELECT * FROM posicoes WHERE codigo = ?').get(m[1]);
    if (!p) return jsonErr(res, 404, `Endereço ${m[1]} não existe`);
    const atual = db.prepare('SELECT * FROM ocupacoes WHERE posicao = ? AND saida IS NULL').get(m[1]);
    const historico = db.prepare(
      'SELECT * FROM ocupacoes WHERE posicao = ? ORDER BY id DESC LIMIT 20').all(m[1]);
    return jsonOk(res, { posicao: { ...p, bloqueada: !!p.bloqueada }, atual: atual || null, historico });
  }

  // GET /enderecamento/gaiola/:id — onde esta gaiola está (ou esteve).
  if ((m = pathname.match(/^\/enderecamento\/gaiola\/([A-Za-z0-9]+)$/)) && req.method === 'GET') {
    const id = m[1].toUpperCase();
    const atual = db.prepare('SELECT * FROM ocupacoes WHERE gaiola_id = ? AND saida IS NULL').get(id);
    const historico = db.prepare(
      'SELECT * FROM ocupacoes WHERE gaiola_id = ? ORDER BY id DESC LIMIT 20').all(id);
    let gaiola = null;
    try { gaiola = (JSON.parse(configGet('gaiolas_pa', '{}')))[id] || null; } catch(e) {}
    return jsonOk(res, { gaiola_id: id, atual: atual || null, historico, gaiola });
  }

  // POST /enderecamento/ocupar
  // { posicao, gaiola_id, formato?, cor?, fardos?, kg?, tipo_gaiola?, operador? }
  // Os campos do produto são opcionais: se a gaiola estiver registrada
  // no sistema, o que vale é o registro — a etiqueta pode ter sido
  // reimpressa com outros números. O que vem do QR é só reserva.
  if (pathname === '/enderecamento/ocupar' && req.method === 'POST') {
    let body; try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
    const cod = String(body.posicao || '').trim().toUpperCase();
    const gid = String(body.gaiola_id || '').trim().toUpperCase();
    if (!/^\d{2}-\d{2}-\d{3}$/.test(cod)) return jsonErr(res, 400, 'Endereço inválido (esperado RR-NN-PPP)');
    // Só gaiola de produto acabado. Se alguém bipar uma etiqueta de big
    // bag (R…) ou de bobina (E…) aqui, é engano — e melhor recusar do
    // que endereçar a coisa errada.
    if (!/^G\d+$/.test(gid)) {
      return jsonErr(res, 400, `"${gid || '(vazio)'}" não é uma etiqueta de gaiola. A etiqueta de gaiola começa com G.`);
    }

    // Gaiola ENCERRADA: já saiu numa separação. Se a etiqueta antiga
    // sobreviveu colada e alguém a bipa, o sistema recusa — aceitar
    // seria endereçar uma quantidade que não existe mais. A etiqueta
    // válida é a nova, gerada na aba Sobras.
    {
      const rEnc = gaiolasRegistro()[gid];
      if (rEnc && rEnc.encerrada_em) {
        const nova = db.prepare(
          'SELECT gaiola_nova FROM sobras WHERE gaiola_origem = ? AND gaiola_nova IS NOT NULL ORDER BY id DESC').get(gid);
        return jsonErr(res, 409,
          `A gaiola ${gid} foi encerrada numa separação. Esta etiqueta não vale mais`
          + (nova && nova.gaiola_nova ? ` — a etiqueta certa é a ${nova.gaiola_nova}.` : '.'),
          { encerrada: true, gaiola_nova: (nova && nova.gaiola_nova) || null });
      }
    }

    const p = db.prepare('SELECT * FROM posicoes WHERE codigo = ?').get(cod);
    if (!p) return jsonErr(res, 404, `Endereço ${cod} não existe`);
    if (p.bloqueada) return jsonErr(res, 409, `Endereço ${cod} está bloqueado: ${p.motivo || 'não paletizar'}`, { bloqueada: true });

    const ocupante = db.prepare('SELECT * FROM ocupacoes WHERE posicao = ? AND saida IS NULL').get(cod);
    if (ocupante) {
      if (ocupante.gaiola_id === gid) {
        return jsonOk(res, { ja_estava: true, posicao: cod, ocupacao: ocupante,
                             mensagem: `A gaiola ${gid} já está em ${cod}.` });
      }
      return jsonErr(res, 409, `Endereço ${cod} já tem a gaiola ${ocupante.gaiola_id}. Libere antes de colocar outra.`,
                     { ocupada: true, ocupacao: ocupante });
    }
    const outroLugar = db.prepare('SELECT * FROM ocupacoes WHERE gaiola_id = ? AND saida IS NULL').get(gid);
    if (outroLugar) {
      return jsonErr(res, 409, `A gaiola ${gid} já está endereçada em ${outroLugar.posicao}. Libere de lá primeiro.`,
                     { gaiola_em_outro_lugar: true, ocupacao: outroLugar });
    }

    // Dados da gaiola: registro do sistema tem prioridade sobre o QR.
    let reg = null;
    try { reg = (JSON.parse(configGet('gaiolas_pa', '{}')))[gid] || null; } catch(e) {}
    const corNome = reg ? ((PA_CORES[reg.corKey] && PA_CORES[reg.corKey].nome) || reg.corKey)
                        : (body.cor || null);
    const dados = {
      formato: reg ? reg.formato : (body.formato || null),
      cor:     corNome,
      fardos:  reg ? reg.fardos : (body.fardos != null ? parseInt(body.fardos, 10) : null),
      kg:      reg ? reg.kg     : (body.kg     != null ? Number(body.kg)          : null),
      tipo:    (body.tipo_gaiola ? String(body.tipo_gaiola).toUpperCase() : null),
    };

    const agoraISO = new Date().toISOString();
    try {
      db.prepare(`INSERT INTO ocupacoes (posicao, gaiola_id, entrada, operador_e, formato, cor, fardos, kg, tipo_gaiola)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(cod, gid, agoraISO, body.operador || null, dados.formato, dados.cor, dados.fardos, dados.kg, dados.tipo);
    } catch (e) {
      // As travas de "um por endereço" são do banco. Se duas leituras
      // chegarem juntas, uma delas cai aqui em vez de duplicar o dado.
      if (/UNIQUE/i.test(e.message)) {
        return jsonErr(res, 409, 'Outra leitura ocupou este endereço (ou esta gaiola) neste instante. Confira o mapa.', { corrida: true });
      }
      throw e;
    }

    // Gaiola grande em nível de cima: avisa, não impede. Ver comentário
    // do layout — quem impede de verdade é o tamanho do vão.
    const aviso = (dados.tipo === 'GRANDE' && p.nivel !== 1)
      ? `Atenção: gaiola GRANDE no nível ${String(p.nivel).padStart(2,'0')}, que foi feito para gaiolas pequenas.`
      : (!dados.tipo && p.nivel === 1 ? null : null);

    const ocup = db.prepare('SELECT * FROM ocupacoes WHERE posicao = ? AND saida IS NULL').get(cod);
    // Se esta gaiola é a etiqueta nova de uma SOBRA, endereçá-la é o
    // que fecha a pendência. Nenhum passo a mais para o operador: ele
    // bipa como bipa qualquer outra e a fila da aba Sobras diminui.
    let sobraFechada = null;
    try {
      const sb = db.prepare(
        `SELECT * FROM sobras WHERE gaiola_nova = ? AND status <> 'enderecada' ORDER BY id DESC`).get(gid);
      if (sb) {
        db.prepare(`UPDATE sobras SET status='enderecada', posicao_final=?, resolvida_em=? WHERE id=?`)
          .run(cod, new Date().toISOString(), sb.id);
        sobraFechada = { id: sb.id, sugerida: sb.posicao_sugerida, final: cod };
        logI('separacao', `Sobra ${sb.id} endereçada: gaiola ${gid} em ${cod}`
          + (sb.posicao_sugerida && sb.posicao_sugerida !== cod
              ? ` (sugerido era ${sb.posicao_sugerida})` : ''));
      }
    } catch (e) { logW('separacao', 'Falha ao fechar a sobra: ' + e.message); }

    logI('enderecamento', `Gaiola ${gid} endereçada em ${cod}`
      + (dados.formato ? ` (${dados.formato} ${dados.cor || ''}, ${dados.fardos || 0} fardos)` : '')
      + (body.operador ? ` — ${body.operador}` : ''));
    return jsonOk(res, { posicao: cod, ocupacao: ocup, aviso, sem_registro: !reg, sobra: sobraFechada });
  }

  // POST /enderecamento/liberar   { posicao? , gaiola_id? , motivo?, operador? }
  // Aceita os dois caminhos porque no chão de fábrica tanto faz o que
  // está mais à mão: a etiqueta do endereço ou a da gaiola.
  if (pathname === '/enderecamento/liberar' && req.method === 'POST') {
    let body; try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
    const cod = String(body.posicao || '').trim().toUpperCase();
    const gid = String(body.gaiola_id || '').trim().toUpperCase();
    if (!cod && !gid) return jsonErr(res, 400, 'Informe o endereço ou a gaiola');

    const ocup = cod
      ? db.prepare('SELECT * FROM ocupacoes WHERE posicao = ? AND saida IS NULL').get(cod)
      : db.prepare('SELECT * FROM ocupacoes WHERE gaiola_id = ? AND saida IS NULL').get(gid);
    if (!ocup) {
      return jsonErr(res, 404, cod ? `O endereço ${cod} já está vazio.` : `A gaiola ${gid} não está endereçada.`,
                     { ja_vazio: true });
    }
    if (cod && gid && ocup.gaiola_id !== gid) {
      return jsonErr(res, 409, `Em ${cod} está a gaiola ${ocup.gaiola_id}, não a ${gid}.`,
                     { divergente: true, ocupacao: ocup });
    }
    db.prepare('UPDATE ocupacoes SET saida = ?, operador_s = ?, motivo_saida = ? WHERE id = ?')
      .run(new Date().toISOString(), body.operador || null, body.motivo || null, ocup.id);
    logI('enderecamento', `Endereço ${ocup.posicao} liberado (gaiola ${ocup.gaiola_id})`
      + (body.motivo ? ` — ${body.motivo}` : '') + (body.operador ? ` — ${body.operador}` : ''));
    return jsonOk(res, { liberado: true, posicao: ocup.posicao, gaiola_id: ocup.gaiola_id });
  }

  // GET /enderecamento/historico?limit=
  if (pathname === '/enderecamento/historico' && req.method === 'GET') {
    const limite = Math.min(500, Math.max(1, parseInt(parsed.query.limit) || 100));
    const linhas = db.prepare('SELECT * FROM ocupacoes ORDER BY id DESC LIMIT ?').all(limite);
    return jsonOk(res, { movimentos: linhas });
  }

  return NAO_TRATADA;
}

module.exports = rotasEnderecamento;
