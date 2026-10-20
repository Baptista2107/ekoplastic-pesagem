// ════════════════════════════════════════════════════════════════════
//  ROTAS — produto acabado: gaiolas e inventário de PA
// ════════════════════════════════════════════════════════════════════

const { PA_CORES, PA_FORMATOS, PA_KG_FARDO } = require('../lib/config');
const { dataLocalISO, logI, logW } = require('../lib/log');
const { configGet, configSet, db, getProximoSeq, incrementaSeq } = require('../lib/db');
const { getToken, proxyChamada } = require('../lib/bling');
const { gerarEPLGaiolaPA, imprimir } = require('../lib/impressao');
const { jsonErr, jsonOk, lerBodyJson, NAO_TRATADA } = require('../lib/http');
const { paSku, resolverIdVariacaoPA } = require('../lib/negocio');

// Devolve NAO_TRATADA quando nenhuma rota daqui atende o pedido.
async function rotasProdutoAcabado(req, res, parsed, pathname) {
  let m;

  if (pathname === '/produto-acabado/etiqueta-gaiola' && req.method === 'POST') {
    let body; try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
    const corKey  = String(body.corKey || '').toUpperCase();
    const formato = String(body.formato || '');
    const fardos  = parseInt(body.fardos, 10);
    if (!PA_CORES[corKey])            return jsonErr(res, 400, `Cor inválida: ${body.corKey}`);
    if (!PA_FORMATOS.includes(formato)) return jsonErr(res, 400, `Formato inválido: ${formato}`);
    if (!Number.isFinite(fardos) || fardos < 1) return jsonErr(res, 400, 'Informe a quantidade de fardos (mínimo 1)');
    if (fardos > 999) return jsonErr(res, 400, 'Quantidade muito alta (máximo 999 fardos)');
    // Tipo da gaiola (GRANDE/PEQUENA) — vai para o QR e serve ao
    // endereçamento. Opcional: etiqueta sem tipo continua valendo.
    const tipoGaiola = ['GRANDE','PEQUENA'].includes(String(body.tipo_gaiola || '').toUpperCase())
      ? String(body.tipo_gaiola).toUpperCase() : null;

    // Garante que a sequência exista: sem a linha na tabela, o incremento
    // não tem efeito e o número repetiria — o que quebraria o bloqueio de
    // leitura repetida no inventário.
    try { db.prepare(`INSERT OR IGNORE INTO seqs (tipo, valor) VALUES ('gaiola-pa', 1)`).run(); } catch(e) {}
    const seq = getProximoSeq('gaiola-pa');
    const id  = 'G' + String(seq).padStart(7, '0');
    const kg  = fardos * PA_KG_FARDO;
    const epl = gerarEPLGaiolaPA({ id, corKey, formato, fardos, tipo_gaiola: tipoGaiola });

    // Guarda o registro da gaiola (para reimpressão e para o inventário
    // conferir a etiqueta lida). Fica em config, fora da tabela de
    // etiquetas, para não misturar com os lançamentos de produção.
    try {
      let gaiolas = {};
      try { gaiolas = JSON.parse(configGet('gaiolas_pa', '{}')); } catch(e) {}
      gaiolas[id] = { id, corKey, formato, fardos, kg, tipo_gaiola: tipoGaiola,
                      criadaEm: new Date().toISOString(), operador: body.operador || null };
      // mantém as 2000 mais recentes
      const chaves = Object.keys(gaiolas).sort();
      while (chaves.length > 2000) delete gaiolas[chaves.shift()];
      configSet('gaiolas_pa', JSON.stringify(gaiolas));
    } catch(e) { logW('gaiola', 'Não consegui registrar a gaiola: ' + e.message); }
    incrementaSeq('gaiola-pa', seq);

    const impr = await new Promise(resolve => {
      try { imprimir(epl, body.impressora, (ok, saida, erro, impressora) => resolve({ ok: !!ok, impressora, erro: erro || null })); }
      catch(e) { resolve({ ok: false, erro: e.message }); }
    });
    logI('gaiola', `Etiqueta de gaiola ${id}: ${formato} ${PA_CORES[corKey].nome} · ${fardos} fardos (${kg} kg)`);
    return jsonOk(res, { id, corKey, formato, fardos, kg,
                         cor_nome: PA_CORES[corKey].nome,
                         tipo_gaiola: tipoGaiola,
                         conteudo_qr: `EKOPA|${id}|${formato}|${corKey}|${fardos}|${kg}`
                                      + (tipoGaiola ? `|${tipoGaiola}` : ''),
                         impressao: impr });
  }

  // Reimprime uma etiqueta de gaiola já gerada (mesmo QR).
  if (pathname === '/produto-acabado/gaiola-reimprimir' && req.method === 'POST') {
    let body; try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
    const id = String(body.id || '').toUpperCase();
    let gaiolas = {};
    try { gaiolas = JSON.parse(configGet('gaiolas_pa', '{}')); } catch(e) {}
    const g = gaiolas[id];
    if (!g) return jsonErr(res, 404, `Gaiola ${id} não encontrada`);
    const impr = await new Promise(resolve => {
      try { imprimir(gerarEPLGaiolaPA(g), body.impressora, (ok, saida, erro, impressora) => resolve({ ok: !!ok, impressora, erro: erro || null })); }
      catch(e) { resolve({ ok: false, erro: e.message }); }
    });
    logI('gaiola', `Etiqueta de gaiola ${id} reimpressa`);
    return jsonOk(res, { id, impressao: impr, ...g });
  }

  // Lista as gaiolas do dia (a tela mostra o que já foi etiquetado).
  if (pathname === '/produto-acabado/gaiolas-hoje' && req.method === 'GET') {
    let gaiolas = {};
    try { gaiolas = JSON.parse(configGet('gaiolas_pa', '{}')); } catch(e) {}
    const hoje = dataLocalISO();
    const lista = Object.values(gaiolas)
      .filter(g => (g.criadaEm || '').slice(0, 10) === hoje)
      .sort((a, b) => String(b.criadaEm).localeCompare(String(a.criadaEm)));
    return jsonOk(res, { gaiolas: lista, qtd: lista.length,
                         total_fardos: lista.reduce((a, g) => a + (g.fardos || 0), 0),
                         total_kg: lista.reduce((a, g) => a + (g.kg || 0), 0) });
  }

  // ── INVENTÁRIO DE PRODUTO ACABADO ──────────────────────────────
  // Mesma ideia do inventário de MP, mas contando gaiolas por QR.

  // Combinações cor × formato disponíveis para inventariar.
  if (pathname === '/inventario/pa/produtos' && req.method === 'GET') {
    const produtos = [];
    for (const [corKey, cor] of Object.entries(PA_CORES)) {
      for (const formato of PA_FORMATOS) {
        produtos.push({ corKey, cor: cor.nome, formato, sku: paSku(corKey, formato),
                        rotulo: `${formato.replace('x', ' × ')} · ${cor.nome}` });
      }
    }
    return jsonOk(res, { produtos, kgPorFardo: PA_KG_FARDO });
  }

  // Consulta o saldo no Bling de um produto acabado (resolve pelo SKU).
  if (pathname === '/inventario/pa/saldo' && req.method === 'GET') {
    const corKey  = String(parsed.query.corKey || '').toUpperCase();
    const formato = String(parsed.query.formato || '');
    const cor = PA_CORES[corKey];
    if (!cor) return jsonErr(res, 400, `Cor inválida: ${corKey}`);
    if (!PA_FORMATOS.includes(formato)) return jsonErr(res, 400, `Formato inválido: ${formato}`);
    const sku = paSku(corKey, formato);
    try {
      const token = await getToken();
      const idReal = Number(await resolverIdVariacaoPA(token, sku, cor.bling_pai));
      const r = await proxyChamada(token, 'GET', '/Api/v3/estoques/saldos', '?idsProdutos[]=' + idReal, '');
      let d = {}; try { d = JSON.parse(r.body); } catch(e) {}
      const item = Array.isArray(d.data) ? d.data[0] : (d.data || null);
      if (!item) return jsonErr(res, 502, 'O Bling não retornou saldo para este produto (confira o escopo "Controle de estoque").', { sku, idReal });
      return jsonOk(res, { sku, idProduto: idReal, saldoFisico: Number(item.saldoFisicoTotal || 0),
                           saldoVirtual: Number(item.saldoVirtualTotal || 0) });
    } catch(e) {
      return jsonErr(res, 502, 'Erro ao consultar saldo no Bling: ' + e.message);
    }
  }

  // Confere uma etiqueta de gaiola lida no inventário.
  if ((m = pathname.match(/^\/inventario\/pa\/gaiola\/([A-Z0-9]+)$/)) && req.method === 'GET') {
    const id = m[1];
    let gaiolas = {};
    try { gaiolas = JSON.parse(configGet('gaiolas_pa', '{}')); } catch(e) {}
    const g = gaiolas[id];
    if (!g) return jsonErr(res, 404, `Gaiola ${id} não encontrada no sistema`);
    return jsonOk(res, { gaiola: g });
  }

  if (pathname === '/produto-acabado/frequencia-cor' && req.method === 'GET') {
    const maq  = String(parsed.query.maquina || '').toUpperCase();
    const fmt  = String(parsed.query.formato || '');
    const dias = Math.min(365, Math.max(30, parseInt(parsed.query.dias) || 120));
    const desde = new Date(Date.now() - dias * 86400000).toISOString().slice(0, 10);
    try {
      // No PA: material_key = cor, lote = formato
      const linhas = db.prepare(
        `SELECT material_key AS cor, COUNT(*) AS qtd, MAX(date(hora_impressao)) AS ultimo
             FROM etiquetas
            WHERE tipo = 'produto-acabado' AND status != 'cancelada'
              AND maquina = ? AND lote = ? AND date(hora_impressao) >= ?
            GROUP BY material_key ORDER BY qtd DESC`
      ).all(maq, fmt, desde);
      const total = linhas.reduce((a, l) => a + l.qtd, 0);
      // Sem histórico nenhum dessa máquina+formato: não dá para opinar.
      const semBase = total === 0;
      const porCor = {};
      for (const l of linhas) porCor[l.cor] = { qtd: l.qtd, ultimo: l.ultimo, pct: total ? Math.round((l.qtd / total) * 100) : 0 };
      return jsonOk(res, { maquina: maq, formato: fmt, dias, total, semBase, porCor });
    } catch(e) { return jsonErr(res, 500, 'Erro ao consultar histórico: ' + e.message); }
  }

  return NAO_TRATADA;
}

module.exports = rotasProdutoAcabado;
