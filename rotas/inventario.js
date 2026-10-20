// ════════════════════════════════════════════════════════════════════
//  ROTAS — inventário de MP
// ════════════════════════════════════════════════════════════════════

const { logI } = require('../lib/log');
const { configGet, configSet } = require('../lib/db');
const { lerCatalogoMP } = require('../lib/materiais');
const { getToken, proxyChamada } = require('../lib/bling');
const { jsonErr, jsonOk, lerBodyBinario, lerBodyJson, NAO_TRATADA } = require('../lib/http');
const {
  chaveProduto, listarSubstituicoes, materiaisPorSacos, resolverIdVariacaoPA,
} = require('../lib/negocio');

// Devolve NAO_TRATADA quando nenhuma rota daqui atende o pedido.
async function rotasInventario(req, res, parsed, pathname) {
  let m;

  if (pathname === '/inventario/produtos' && req.method === 'GET') {
    const cat = lerCatalogoMP();
    let mapaProd = {};
    try { mapaProd = JSON.parse(configGet('mapa_produto_bling', '{}')); } catch(e) {}
    const produtos = [];
    const porSacosInv = materiaisPorSacos();
    // Produto trocado (ex.: Polinylon Tallpack Cristal → Resina EVOH) sai
    // da lista enquanto a troca vale: as etiquetas dele são lidas como o
    // produto novo e é nele que entram na contagem.
    const trocadosInv = new Set(listarSubstituicoes().filter(t => t.ativa).map(t => t.de.toLowerCase()));
    for (const chave of Object.keys(mapaProd)) {
      const partes = chave.split(':');
      const material = partes[0], cor = partes[1] || null, fornecedor = partes[2] || null;
      if (!cat.materiais[material]) continue;   // só MP conhecida (ignora bobina/PA)
      if (trocadosInv.has(chave.toLowerCase())) continue;
      produtos.push({ material, materialNome: (cat.materiais[material].popular || material), cor, fornecedor, chave,
                      manual: !!porSacosInv[material], kgPorSaco: porSacosInv[material] || null });
    }
    produtos.sort((a,b) => a.chave.localeCompare(b.chave));
    return jsonOk(res, { produtos });
  }

  // Consulta o saldo do Bling para um produto (resolvendo variação por SKU).
  if (pathname === '/inventario/saldo' && req.method === 'GET') {
    const material = String(parsed.query.material || '').trim();
    const cor = String(parsed.query.cor || '').trim();
    const fornecedor = String(parsed.query.fornecedor || '').trim();
    const chave = chaveProduto(material, cor, fornecedor);
    let mapaProd = {}, mapaSku = {};
    try { mapaProd = JSON.parse(configGet('mapa_produto_bling', '{}')); } catch(e) {}
    try { mapaSku = JSON.parse(configGet('mapa_sku_variacao_mp', '{}')); } catch(e) {}
    const idProduto = mapaProd[chave];
    if (!idProduto) return jsonErr(res, 404, `Produto não cadastrado no Bling para ${chave}`);
    try {
      const token = await getToken();
      let idReal = Number(idProduto);
      if (mapaSku[chave]) idReal = Number(await resolverIdVariacaoPA(token, mapaSku[chave], idProduto));
      const r = await proxyChamada(token, 'GET', '/Api/v3/estoques/saldos', '?idsProdutos[]=' + idReal, '');
      let d = {}; try { d = JSON.parse(r.body); } catch(e) {}
      const item = Array.isArray(d.data) ? d.data[0] : (d.data || null);
      if (!item) return jsonErr(res, 502, 'O Bling não retornou saldo para este produto (confira se o app tem o escopo "Controle de estoque").', { idReal });
      return jsonOk(res, { chave, idProduto: idReal, saldoFisico: Number(item.saldoFisicoTotal || 0), saldoVirtual: Number(item.saldoVirtualTotal || 0) });
    } catch(e) {
      return jsonErr(res, 502, 'Erro ao consultar saldo no Bling: ' + e.message);
    }
  }

  // Inventário em andamento (itens já finalizados) — persistido no banco.
  if (pathname === '/inventario/atual' && req.method === 'GET') {
    let inv = { itens: [] };
    try { inv = JSON.parse(configGet('inventario_atual', '{"itens":[]}')); } catch(e) {}
    if (!Array.isArray(inv.itens)) inv.itens = [];
    return jsonOk(res, { inventario: inv });
  }

  // Salva um item finalizado (substitui se o mesmo produto for refeito).
  // ── Rascunho da contagem em andamento (28/09/2026, VPS) ──
  // A tela de inventário guardava a contagem em andamento SÓ no aparelho
  // (localStorage). Trocar de coletor, limpar os dados do app ou começar
  // outra contagem sem salvar perdia tudo. Agora cada leitura grava também
  // aqui, um rascunho por aparelho (config `inventario_rascunhos`), e a
  // tela retoma dele. Os produtos SALVOS continuam em /inventario/salvar.
  if (pathname === '/inventario/rascunho' && req.method === 'GET') {
    let m = {}; try { m = JSON.parse(configGet('inventario_rascunhos', '{}')); } catch(e) {}
    const lista = Object.entries(m).map(([dispositivo, r]) => ({ dispositivo, ...r }))
      .sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return jsonOk(res, { rascunhos: lista });
  }
  if (pathname === '/inventario/rascunho' && req.method === 'POST') {
    let body; try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
    const disp = String(body.dispositivo || '').trim().slice(0, 60);
    if (!disp) return jsonErr(res, 400, 'dispositivo obrigatório');
    let m = {}; try { m = JSON.parse(configGet('inventario_rascunhos', '{}')); } catch(e) {}
    if (body.apagar) delete m[disp];
    else {
      if (!body.dados || typeof body.dados !== 'object') return jsonErr(res, 400, 'dados obrigatórios');
      m[disp] = { dados: body.dados, ts: Date.now(),
                  operador: (body.operador ? String(body.operador).slice(0, 80) : null) };
    }
    configSet('inventario_rascunhos', JSON.stringify(m));
    return jsonOk(res, { gravado: !body.apagar, apagado: !!body.apagar });
  }

  if (pathname === '/inventario/salvar' && req.method === 'POST') {
    let body; try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
    let inv = { inicio: new Date().toISOString(), itens: [] };
    try { const cur = configGet('inventario_atual', null); if (cur) inv = JSON.parse(cur); } catch(e) {}
    if (!inv.inicio) inv.inicio = new Date().toISOString();
    if (!Array.isArray(inv.itens)) inv.itens = [];
    const item = {
      material: String(body.material || ''), cor: body.cor || null, fornecedor: body.fornecedor || null,
      materialNome: body.materialNome || null,
      leituras: Array.isArray(body.leituras) ? body.leituras : [],
      somaLeitura: Number(body.somaLeitura) || 0,
      saldoBling: (body.saldoBling === null || body.saldoBling === undefined) ? null : Number(body.saldoBling),
      finalizadoEm: new Date().toISOString(),
    };
    item.divergencia = (item.saldoBling === null) ? null : +(item.somaLeitura - item.saldoBling).toFixed(3);
    const chave = chaveProduto(item.material, item.cor, item.fornecedor);
    const idx = inv.itens.findIndex(i => chaveProduto(i.material, i.cor, i.fornecedor) === chave);
    if (idx >= 0) inv.itens[idx] = item; else inv.itens.push(item);
    configSet('inventario_atual', JSON.stringify(inv));
    return jsonOk(res, { salvo: true, inventario: inv });
  }

  // PDF do inventário → Telegram (08/10/2026, Gustavo: "manda um PDF pro
  // Bruno quando finalizar" — Bruno Augusto e Vinicius). A tela manda o PDF
  // aqui no 🏁 Encerrar e só zera se a VPS responder ok. O corpo vai como
  // veio para o painel da VPS (mesma origem do vps_sacoleiras_url, que o
  // Mini PC já usa); quem decide os destinos e guarda a cópia é a VPS.
  if (pathname === '/inventario/enviar-pdf' && req.method === 'POST') {
    let corpo; try { corpo = await lerBodyBinario(req, 8 * 1024 * 1024); } catch(e) { return jsonErr(res, 413, e.message); }
    let base;
    try { base = new URL(configGet('vps_sacoleiras_url', 'http://100.107.130.114:8765/api/sacoleiras/agora')).origin; }
    catch(e) { return jsonErr(res, 500, 'endereço da VPS inválido'); }
    try {
      const r = await fetch(base + '/api/coletor/inventario-pdf', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: corpo,
        signal: AbortSignal.timeout(60000) });
      const d = await r.json().catch(() => ({ ok: false, erro: 'resposta inválida da VPS (HTTP ' + r.status + ')' }));
      logI('inventario', 'PDF enviado à VPS: ' + (d.ok ? ('ok → ' + (d.enviados || []).join(', ')) : ('FALHOU: ' + d.erro)));
      if (!d.ok) return jsonErr(res, 502, d.erro || 'a VPS recusou');
      return jsonOk(res, { enviados: d.enviados || [], falhas: d.falhas || [], guardado: d.guardado });
    } catch(e) {
      logI('inventario', 'PDF não chegou à VPS: ' + e.message);
      return jsonErr(res, 502, 'sem conexão com a VPS: ' + e.message);
    }
  }

  // Zera o inventário (finalização geral / começar um novo).
  if (pathname === '/inventario/limpar' && req.method === 'POST') {
    configSet('inventario_atual', JSON.stringify({ itens: [] }));
    logI('inventario', 'Inventário zerado (finalização geral ou novo)');
    return jsonOk(res, { limpo: true });
  }

  return NAO_TRATADA;
}

module.exports = rotasInventario;
