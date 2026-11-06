// ════════════════════════════════════════════════════════════════════
//  ROTAS — pedidos de retirada de MP vindos do painel da VPS (06/11/2026)
//  A tela de Retirada não fala direto com a VPS: passa por aqui (mesmo
//  jeito do /inventario/enviar-pdf). Regra e fila em lib/retirada-pedidos.
// ════════════════════════════════════════════════════════════════════

const { jsonErr, jsonOk, lerBodyJson, NAO_TRATADA } = require('../lib/http');
const { enfileirarFora, enviarFila, listarPedidos } = require('../lib/retirada-pedidos');

async function rotasRetiradaPedidos(req, res, parsed, pathname) {
  // GET /retirada/pedidos — pedidos abertos (cache 10 s). VPS fora: último
  // bom com desatualizado:true; nunca houve lista: indisponivel:true.
  if (pathname === '/retirada/pedidos' && req.method === 'GET') {
    return jsonOk(res, await listarPedidos());
  }

  // POST /retirada/fora-do-pedido — repassa à VPS; VPS fora → fila em disco
  // (idempotente pela etiqueta). O consumo com motivo já enfileira sozinho;
  // esta rota existe para reenvio manual / outras telas.
  if (pathname === '/retirada/fora-do-pedido' && req.method === 'POST') {
    let b; try { b = await lerBodyJson(req); } catch (e) { return jsonErr(res, 400, e.message); }
    const etiqueta_id = String(b.etiqueta_id || '').trim();
    const motivo = typeof b.motivo === 'string' ? b.motivo.trim().slice(0, 300) : '';
    if (!/^[RTSEO]\d{7}$/.test(etiqueta_id)) return jsonErr(res, 400, 'etiqueta_id inválido');
    if (!motivo) return jsonErr(res, 400, 'motivo obrigatório');
    enfileirarFora({ etiqueta_id, sessao_id: b.sessao_id != null ? Number(b.sessao_id) : null,
                     operador: b.operador ? String(b.operador).slice(0, 80) : null,
                     motivo, pedido_id: b.pedido_id != null ? b.pedido_id : null });
    const enviados = await enviarFila().catch(() => 0);
    return jsonOk(res, { na_fila: enviados === 0 });
  }

  return NAO_TRATADA;
}

module.exports = rotasRetiradaPedidos;
