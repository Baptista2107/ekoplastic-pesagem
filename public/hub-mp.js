/* ══════════════════════════════════════════════════════════════════════
   HUB DO ALMOXARIFADO (hub-mp.js) — 25/11/2026

   Gustavo: "pro coletor do Bruno vou precisar de um hub de aplicativos onde
   ele consegue fazer entrada e retirada, mapeamento e inventário; nesse hub
   pra ele não ter que usar link nem nada". No mesmo dia: "o hub também tem
   de lançar PA".

   A página /hub-mp.html é a tela inicial do app "Ekoplastic MP" (coletor
   TC60). Ela só leva às telas que já existem; não grava nada e não pede
   senha: cada tela continua pedindo o PIN dela, como no Mini PC.

   A lista TELAS é a fonte da verdade dos botões. O app Android tem a sua
   lista de páginas permitidas (android/build.sh, VARIANTE=mp), e o teste
   testes/hub-coletor.js confere que as duas batem.

   Este arquivo roda no navegador (window.EkoHub) e no Node (module.exports,
   para o teste).
   ══════════════════════════════════════════════════════════════════════ */
(function (raiz) {
  'use strict';

  const HUB = '/hub-mp.html';

  // sessoes: tipos de sessão (GET /sessoes/abertas) que acendem o "em
  // andamento" do botão. Retorno de produção é aberto pela tela de Entrada
  // (aba "Retorno de produção" dentro dela), por isso conta lá.
  const TELAS = [
    { id: 'entrada',    nome: 'Entrada',         sub: 'Recebimento e retorno de MP',
      url: '/mp-recebimento-retorno.html?aba=recebimento', ico: '📥', cor: '#00d4ff', sessoes: ['recebimento', 'retorno'] },
    { id: 'retirada',   nome: 'Retirada',        sub: 'Saída de MP para a produção',
      url: '/mp-retirada.html',                            ico: '📤', cor: '#f07040', sessoes: ['retirada'] },
    { id: 'mapeamento', nome: 'Mapeamento',      sub: 'Endereço de bag e gaiola',
      url: '/enderecamento.html',                          ico: '🗺', cor: '#2ee6a6', sessoes: [] },
    { id: 'inventario', nome: 'Inventário',      sub: 'Contagem de MP e PA',
      url: '/inventario.html',                             ico: '📋', cor: '#ffc250', sessoes: [] },
    { id: 'pa',         nome: 'Produto Acabado', sub: 'Lançamento de fardos',
      url: '/produto-acabado.html',                        ico: '📦', cor: '#b892ff', sessoes: ['produto-acabado'] },
  ];

  /** Caminho (sem ?…) de uma URL do hub. */
  function caminho(url) { return String(url).split('?')[0].split('#')[0]; }

  /** Páginas que o app pode abrir: o hub e as telas, sem repetir. */
  function caminhosPermitidos() {
    const lista = [HUB];
    for (const t of TELAS) { const c = caminho(t.url); if (!lista.includes(c)) lista.push(c); }
    return lista;
  }

  /** Resposta de GET /sessoes/abertas → { idDaTela: quantas sessões abertas }.
   *  Resposta ruim ou vazia → tudo zero (o botão só não acende). */
  function abertasPorTela(resposta) {
    const conta = {};
    for (const t of TELAS) conta[t.id] = 0;
    const lista = resposta && resposta.ok && Array.isArray(resposta.sessoes) ? resposta.sessoes : [];
    for (const s of lista) {
      if (!s || typeof s.tipo !== 'string') continue;
      for (const t of TELAS) if (t.sessoes.includes(s.tipo)) conta[t.id]++;
    }
    return conta;
  }

  function textoAberta(n) {
    return n ? `● ${n} em andamento` : '';
  }

  // ───────────────────────── navegador ─────────────────────────
  function montar(doc) {
    const lista = doc.getElementById('hub-telas');
    if (!lista) return;
    lista.textContent = '';
    for (const t of TELAS) {
      const a = doc.createElement('a');
      a.className = 'tela';
      a.id = 'hub-' + t.id;
      a.href = t.url;
      a.style.setProperty('--cor', t.cor);
      const ico = doc.createElement('span'); ico.className = 'ico'; ico.textContent = t.ico;
      const txt = doc.createElement('span'); txt.className = 'txt';
      const nm = doc.createElement('b'); nm.textContent = t.nome;
      const sb = doc.createElement('small'); sb.textContent = t.sub;
      const ab = doc.createElement('em'); ab.className = 'aberta'; ab.id = 'hub-aberta-' + t.id;
      txt.append(nm, sb, ab);
      a.append(ico, txt);
      lista.appendChild(a);
    }
  }

  function pintarAbertas(doc, resposta) {
    const conta = abertasPorTela(resposta);
    for (const t of TELAS) {
      const el = doc.getElementById('hub-aberta-' + t.id);
      if (el) el.textContent = textoAberta(conta[t.id]);
    }
  }

  async function atualizar(doc) {
    const st = doc.getElementById('hub-status');
    try {
      const r = await fetch('/sessoes/abertas', { cache: 'no-store' });
      const d = await r.json();
      if (!r.ok || !d || !d.ok) throw new Error('resposta ' + r.status);
      pintarAbertas(doc, d);
      if (st) { st.className = 'status on'; st.textContent = 'Mini PC conectado'; }
    } catch (e) {
      if (st) { st.className = 'status off'; st.textContent = 'Sem conexão com o Mini PC'; }
    }
  }

  const api = { HUB, TELAS, caminho, caminhosPermitidos, abertasPorTela, textoAberta, montar, pintarAbertas, atualizar };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (raiz && raiz.document) {
    raiz.EkoHub = api;
    const doc = raiz.document;
    const ini = () => {
      montar(doc);
      atualizar(doc);
      setInterval(() => atualizar(doc), 10000);
      const v = doc.getElementById('hub-versao');
      try { if (v && raiz.EkoApp && raiz.EkoApp.versao) v.textContent = 'app v' + raiz.EkoApp.versao(); } catch (e) {}
    };
    if (doc.readyState !== 'loading') ini(); else doc.addEventListener('DOMContentLoaded', ini);
  }
})(typeof window !== 'undefined' ? window : null);
