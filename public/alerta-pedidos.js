/* ══════════════════════════════════════════════════════════════════════
   ALERTA DE PEDIDO DE RETIRADA NO COLETOR (alerta-pedidos.js) — 25/11/2026

   Gustavo: "deixa um alerta de pedido de retirada no coletor da melhor forma
   possível, pode fazer o coletor vibrar e colocar alerta na tela e um botão
   de ver pedido direto na tela de retirada".

   Roda só no app "Ekoplastic MP" (coletor do Bruno): o app (v2.2) põe este
   arquivo em TODA tela que abre, e o hub já o carrega sozinho. No monitor do
   Mini PC e no navegador comum não faz nada (sem "EkoColetor" no user-agent).

   A cada 15 s pergunta ao Mini PC GET /retirada/pedidos (o mesmo que a tela
   de Retirada usa; o Mini PC guarda 10 s e busca na VPS). Pedido aberto que o
   coletor ainda não mostrou:
     - vibra (e apita) uma vez — EkoApp.alertar() do app 2.2; no 2.1 tenta a
       vibração do navegador;
     - faixa amarela no alto da tela, por cima do que estiver aberto, com
       "VER PEDIDO" (abre a Retirada) e ✕ (some, o pedido continua na
       Retirada).
   Na própria tela de Retirada não há faixa (os pedidos já estão nela): só
   vibra quando chega um novo.

   O que já foi mostrado fica no aparelho (localStorage, mesmo endereço para
   todas as telas), então trocar de tela não vibra de novo pelo mesmo pedido.
   Pedido cancelado ou atendido sai da faixa no próximo giro.

   Este arquivo roda no navegador e no Node (module.exports, para o teste
   testes/alerta-pedidos.js).
   ══════════════════════════════════════════════════════════════════════ */
(function (raiz) {
  'use strict';

  const CHAVE = 'eko_pedidos_alerta';
  const RETIRADA = '/mp-retirada.html';
  const GIRO_MS = 15000;
  const GUARDA_MS = 7 * 24 * 3600 * 1000;   // id visto há mais de 7 dias sai da memória

  /** Pedidos abertos da resposta de GET /retirada/pedidos (resposta ruim → nenhum). */
  function abertos(resp) {
    if (!resp || resp.ok === false || resp.desligado || !Array.isArray(resp.pedidos)) return [];
    return resp.pedidos.filter(p => p && p.id != null && p.status === 'aberto' && !p.cancelado_em);
  }

  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  /** "2 bags", "1 bag", "25 kg". */
  function quantidade(p) {
    if (p.unidade === 'kg') {
      const kg = num(p.kg_pedidos);
      return kg == null ? 'kg' : `${String(Math.round(kg * 10) / 10).replace('.', ',')} kg`;
    }
    const n = num(p.bags_pedidos);
    return n == null ? 'bags' : `${n} ${n === 1 ? 'bag' : 'bags'}`;
  }

  /** "2 bags · COLORIDO BAIXA DENSIDADE · Piquiri · lote 123". */
  function resumo(p) {
    const partes = [quantidade(p), p.material_nome || p.material_key || 'material'];
    if (p.fornecedor) partes.push(p.fornecedor);
    if (p.lote_fmt || p.lote) partes.push('lote ' + (p.lote_fmt || p.lote));
    return partes.join(' · ');
  }

  /** Estado guardado → { alertados: {id: ms}, vistos: {id: ms} } (lixo → vazio). */
  function lerEstado(texto) {
    try {
      const e = JSON.parse(texto);
      if (e && typeof e === 'object') {
        return { alertados: obj(e.alertados), vistos: obj(e.vistos) };
      }
    } catch (e) {}
    return { alertados: {}, vistos: {} };
  }
  function obj(o) { return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; }

  function podar(mapa, agora) {
    const out = {};
    for (const [id, ms] of Object.entries(mapa)) if (agora - Number(ms) < GUARDA_MS) out[id] = ms;
    return out;
  }

  /**
   * Um giro. naRetirada = a tela aberta é a de Retirada.
   * → { vibrar, faixa: [pedidos que a faixa mostra], estado: novo estado }
   *   vibrar: chegou pedido que nunca vibrou neste aparelho.
   *   faixa: abertos que o operador ainda não viu (VER/✕ ou tela de Retirada).
   */
  function decidir(resp, estado, agora, naRetirada) {
    const lista = abertos(resp);
    const alertados = podar(estado.alertados, agora);
    const vistos = podar(estado.vistos, agora);
    let vibrar = false;
    for (const p of lista) {
      const id = String(p.id);
      if (!(id in alertados)) { alertados[id] = agora; vibrar = true; }
      if (naRetirada) vistos[id] = vistos[id] || agora;
    }
    const faixa = naRetirada ? [] : lista.filter(p => !(String(p.id) in vistos));
    return { vibrar, faixa, estado: { alertados, vistos } };
  }

  /** Marca como vistos os pedidos da faixa (VER PEDIDO ou ✕). */
  function marcarVistos(estado, pedidos, agora) {
    const vistos = Object.assign({}, estado.vistos);
    for (const p of pedidos) vistos[String(p.id)] = vistos[String(p.id)] || agora;
    return { alertados: Object.assign({}, estado.alertados), vistos };
  }

  /** Textos da faixa: { titulo, linha, botao }. */
  function textoFaixa(pedidos) {
    const n = pedidos.length;
    if (!n) return null;
    const p = pedidos[0];
    const quem = p.autor_nome ? ` (${p.autor_nome})` : '';
    if (n === 1) return { titulo: '📦 PEDIDO DE RETIRADA' + quem, linha: resumo(p), botao: 'VER PEDIDO' };
    return { titulo: `📦 ${n} PEDIDOS DE RETIRADA`, linha: resumo(p) + ` · e mais ${n - 1}`, botao: 'VER PEDIDOS' };
  }

  /** Só no app do coletor. */
  function noApp(ua) { return /EkoColetor\//.test(String(ua || '')); }

  // ───────────────────────── navegador ─────────────────────────
  const CSS =
    '#eko-alerta-pedido,#eko-alerta-pedido *{all:revert;box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;}' +
    '#eko-alerta-pedido{position:fixed;left:0;right:0;top:0;z-index:2147483000;background:#facc15;color:#111;' +
      'padding:10px 12px 12px;box-shadow:0 6px 18px rgba(0,0,0,.55);border-bottom:3px solid #111;}' +
    '#eko-alerta-pedido .eap-tit{display:block;margin:0;font-size:16px;line-height:20px;font-weight:900;letter-spacing:.3px;}' +
    '#eko-alerta-pedido .eap-lin{display:block;margin:4px 0 10px;font-size:16px;line-height:21px;font-weight:700;overflow-wrap:anywhere;}' +
    '#eko-alerta-pedido .eap-bts{display:flex;gap:10px;}' +
    // !important: o celular.css das telas põe min-height:44px!important em todo botão.
    '#eko-alerta-pedido button{margin:0!important;min-height:56px!important;height:auto!important;padding:6px 10px!important;' +
      'border-radius:10px!important;font-size:18px!important;line-height:22px!important;font-weight:900!important;cursor:pointer;' +
      'border:3px solid #111!important;-webkit-tap-highlight-color:transparent;}' +
    '#eko-alerta-pedido .eap-ver{flex:1!important;background:#111!important;color:#facc15!important;}' +
    '#eko-alerta-pedido .eap-ver:active{background:#333!important;}' +
    '#eko-alerta-pedido .eap-fechar{width:56px!important;flex:0 0 56px!important;background:#facc15!important;color:#111!important;}' +
    '#eko-alerta-pedido .eap-fechar:active{background:#e0b400!important;}';

  function iniciar(win) {
    const doc = win.document;
    if (win.__ekoAlertaPedidos) return;
    win.__ekoAlertaPedidos = 1;
    if (!noApp(win.navigator && win.navigator.userAgent)) return;

    let estado = lerEstado(lerLS());
    let naFaixa = [];

    function lerLS() { try { return win.localStorage.getItem(CHAVE); } catch (e) { return null; } }
    function gravar() { try { win.localStorage.setItem(CHAVE, JSON.stringify(estado)); } catch (e) {} }
    function naRetirada() { return win.location.pathname === RETIRADA; }

    function alertar() {
      try { if (win.EkoApp && typeof win.EkoApp.alertar === 'function') { win.EkoApp.alertar(); return; } } catch (e) {}
      try { if (win.navigator.vibrate) win.navigator.vibrate([500, 200, 500, 200, 800]); } catch (e) {}
    }

    function tirarFaixa() {
      const f = doc.getElementById('eko-alerta-pedido');
      if (f) f.remove();
    }

    function vistos() {
      estado = marcarVistos(estado, naFaixa, Date.now());
      gravar();
    }

    function pintar(pedidos) {
      naFaixa = pedidos;
      const t = textoFaixa(pedidos);
      if (!t) { tirarFaixa(); return; }
      if (!doc.getElementById('eko-alerta-css')) {
        const st = doc.createElement('style'); st.id = 'eko-alerta-css'; st.textContent = CSS;
        (doc.head || doc.documentElement).appendChild(st);
      }
      let f = doc.getElementById('eko-alerta-pedido');
      if (!f) {
        f = doc.createElement('div'); f.id = 'eko-alerta-pedido'; f.setAttribute('role', 'alert');
        const tit = doc.createElement('b'); tit.className = 'eap-tit';
        const lin = doc.createElement('span'); lin.className = 'eap-lin';
        const bts = doc.createElement('div'); bts.className = 'eap-bts';
        const ver = doc.createElement('button'); ver.type = 'button'; ver.className = 'eap-ver';
        const fe = doc.createElement('button'); fe.type = 'button'; fe.className = 'eap-fechar';
        fe.textContent = '✕'; fe.setAttribute('aria-label', 'Fechar aviso');
        ver.addEventListener('click', () => { vistos(); tirarFaixa(); win.location.href = RETIRADA; });
        fe.addEventListener('click', () => { vistos(); tirarFaixa(); });
        bts.append(ver, fe); f.append(tit, lin, bts);
        doc.body.appendChild(f);
      }
      f.querySelector('.eap-tit').textContent = t.titulo;
      f.querySelector('.eap-lin').textContent = t.linha;
      f.querySelector('.eap-ver').textContent = t.botao;
    }

    let girando = false;
    async function giro() {
      if (girando) return;
      girando = true;
      try {
        const r = await win.fetch('/retirada/pedidos', { cache: 'no-store' });
        if (!r.ok) return;
        const d = await r.json();
        const out = decidir(d, estado, Date.now(), naRetirada());
        estado = out.estado; gravar();
        if (out.vibrar) alertar();
        pintar(out.faixa);
      } catch (e) {
        // Mini PC fora: a faixa que já está fica; nada novo.
      } finally { girando = false; }
    }

    const ini = () => {
      giro();
      win.setInterval(giro, GIRO_MS);
      doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'visible') giro(); });
    };
    if (doc.readyState !== 'loading') ini(); else doc.addEventListener('DOMContentLoaded', ini);
  }

  const api = { CHAVE, RETIRADA, GIRO_MS, abertos, quantidade, resumo, lerEstado, decidir, marcarVistos, textoFaixa, noApp, iniciar };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (raiz && raiz.document) { raiz.EkoAlertaPedidos = api; iniciar(raiz); }
})(typeof window !== 'undefined' ? window : null);
