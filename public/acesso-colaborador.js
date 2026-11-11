/* ══════════════════════════════════════════════════════════════════════
   ACESSO POR COLABORADOR (acesso-colaborador.js)

   Portão de entrada das telas de operação. Mostra um teclado numérico em
   tela cheia; o colaborador digita o PIN dele e, se tiver permissão para
   aquela tela, entra. O NOME fica disponível em window.EKO_RESPONSAVEL e
   deve ser enviado ao abrir a sessão (campo `operador`), pois é ele que
   sai no resumo impresso como responsável.

   Uso na tela:
     <script src="/acesso-colaborador.js"></script>
     EkoAcesso.exigir('mp', nome => { ...inicia a tela... });

   Telas: 'mp' (matéria-prima), 'pa' (produto acabado), 'bobinas'.
   ══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const NOMES_TELA = { mp: 'Matéria-Prima', pa: 'Produto Acabado', bobinas: 'Retirada de Bobinas' };
  // Teto da liberação sem pedir a senha de novo (um turno). Rede de segurança:
  // nas telas de processo da MP a liberação acaba antes, ao ENCERRAR o processo.
  const HORAS_LIBERADO = 8;

  // A liberação fica guardada na sessão do navegador, numa CHAVE. Por padrão a
  // chave é a tela ('mp', 'pa'). Desde 11/11/2026 (Gustavo: "as telas retirada,
  // entrada e retorno têm que ter senha nos frames; a senha vale até a pessoa
  // encerrar") cada frame da MP tem a sua (mp-recebimento, mp-retirada,
  // mp-retorno). A permissão conferida no servidor continua sendo a da tela ('mp').
  // Antes, a liberação 'mp' valia 8 h para as três abas, e quem voltasse da
  // Extrusão seguia no nome de quem entrou primeiro.
  function chaveLib(chave) { return 'eko_liberado_' + chave; }
  function lerLiberacao(chave) {
    try {
      const bruto = sessionStorage.getItem(chaveLib(chave));
      if (!bruto) return null;
      const o = JSON.parse(bruto);
      if (!o || !o.nome || !o.ts) return null;
      if (Date.now() - o.ts > HORAS_LIBERADO * 3600 * 1000) { sessionStorage.removeItem(chaveLib(chave)); return null; }
      return o;
    } catch (e) { return null; }
  }
  function gravarLiberacao(chave, dados) {
    try { sessionStorage.setItem(chaveLib(chave), JSON.stringify({ nome: dados.nome, id: dados.id, ts: Date.now() })); } catch (e) {}
  }
  // Última chamada de exigir() por chave: encerrar() pede a senha de novo e
  // chama o mesmo aoEntrar (a tela já iniciada só troca o responsável).
  const PEDIDOS = {};
  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  function css() {
    if (document.getElementById('eko-acesso-css')) return;
    const st = document.createElement('style');
    st.id = 'eko-acesso-css';
    st.textContent = `
      #eko-acesso{position:fixed; inset:0; z-index:99999; background:#0a1119;
        display:flex; align-items:center; justify-content:center; padding:20px;
        font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;}
      #eko-acesso .cx{width:100%; max-width:380px; text-align:center;}
      #eko-acesso .tl{font-size:15px; color:#94a8c4; font-weight:800; letter-spacing:1.2px; text-transform:uppercase;}
      #eko-acesso .tela{font-size:26px; font-weight:900; color:#eef4fb; margin:8px 0 4px;}
      #eko-acesso .hint{font-size:15px; color:#94a8c4; margin-bottom:22px;}
      #eko-acesso .pts{display:flex; gap:12px; justify-content:center; margin-bottom:10px; min-height:22px;}
      #eko-acesso .pt{width:16px; height:16px; border-radius:50%; background:#2a3a52;}
      #eko-acesso .pt.on{background:#00ff9d;}
      #eko-acesso .msg{min-height:26px; font-size:15px; font-weight:700; color:#ff6b6b; margin-bottom:12px;}
      #eko-acesso .msg.ok{color:#00ff9d;}
      #eko-acesso .kb{display:grid; grid-template-columns:repeat(3,1fr); gap:12px;}
      #eko-acesso .kb button{padding:22px 0; font-size:28px; font-weight:800; border-radius:16px;
        border:1.5px solid #2a3a52; background:#131f30; color:#eef4fb; font-family:inherit; cursor:pointer;}
      #eko-acesso .kb button:active{transform:scale(0.96); background:#1d2c42;}
      #eko-acesso .kb button.acao{font-size:20px; color:#94a8c4;}
      #eko-acesso .kb button.ok{background:#00ff9d; color:#052916; border-color:#00ff9d;}
      #eko-acesso .rodape{margin-top:20px;}
      #eko-acesso .rodape a{color:#94a8c4; font-size:14px; text-decoration:none;}
    `;
    document.head.appendChild(st);
  }

  function montar(tela, aoEntrar, opc) {
    opc = opc || {};
    const chave = opc.chave || tela;
    if (document.getElementById('eko-acesso')) return;   // já aberto (clique duplo em encerrar)
    css();
    const nomeTela = escHtml(opc.nomeTela || NOMES_TELA[tela] || tela);
    const ov = document.createElement('div');
    ov.id = 'eko-acesso';
    ov.innerHTML = `
      <div class="cx">
        <div class="tl">Acesso</div>
        <div class="tela">${nomeTela}</div>
        <div class="hint">Digite sua senha para começar</div>
        <div class="pts" id="eko-pts"></div>
        <div class="msg" id="eko-msg"></div>
        <div class="kb" id="eko-kb"></div>
        <div class="rodape"><a href="/" target="_top">← voltar ao menu</a></div>
      </div>`;
    document.body.appendChild(ov);

    let pin = '';
    let travado = false;
    const elPts = ov.querySelector('#eko-pts');
    const elMsg = ov.querySelector('#eko-msg');

    function pintar() {
      elPts.innerHTML = '';
      for (let i = 0; i < pin.length; i++) {
        const d = document.createElement('div'); d.className = 'pt on'; elPts.appendChild(d);
      }
    }
    function msg(txt, ok) { elMsg.textContent = txt || ''; elMsg.className = 'msg' + (ok ? ' ok' : ''); }

    async function tentar() {
      if (travado || pin.length < 4) { if (pin.length && pin.length < 4) msg('A senha tem pelo menos 4 números'); return; }
      travado = true; msg('Verificando…', true);
      try {
        const r = await fetch('/colaboradores/entrar', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin, tela }),
        });
        const d = await r.json();
        if (r.ok && d.ok) {
          msg('Bem-vindo, ' + d.nome, true);
          window.EKO_RESPONSAVEL = d.nome;
          window.EKO_RESPONSAVEL_ID = d.id;
          gravarLiberacao(chave, d);
          setTimeout(() => {
            ov.remove();
            try { aoEntrar && aoEntrar(d.nome, d); } catch (e) { console.error(e); }
          }, 450);
          return;
        }
        msg((d && d.erro) || 'Senha não confere');
      } catch (e) {
        msg('Erro ao verificar: ' + e.message);
      }
      pin = ''; pintar(); travado = false;
    }

    const kb = ov.querySelector('#eko-kb');
    const teclas = ['1','2','3','4','5','6','7','8','9','apagar','0','entrar'];
    for (const t of teclas) {
      const b = document.createElement('button');
      if (t === 'apagar')      { b.className = 'acao'; b.textContent = '⌫'; b.onclick = () => { pin = pin.slice(0, -1); pintar(); msg(''); }; }
      else if (t === 'entrar') { b.className = 'ok';   b.textContent = '✓';  b.onclick = tentar; }
      else                     { b.textContent = t;    b.onclick = () => { if (pin.length < 8) { pin += t; pintar(); msg(''); if (pin.length === 8) tentar(); } }; }
      kb.appendChild(b);
    }

    // teclado físico (o leitor de código de barras também digita). Etiqueta
    // começa com letra (R0001234, E0002428): com letra no meio, é bipe, não
    // senha — descarta até o Enter, sem gastar tentativa de PIN.
    let bipe = false;
    document.addEventListener('keydown', function ouvir(ev) {
      if (!document.getElementById('eko-acesso')) { document.removeEventListener('keydown', ouvir); return; }
      if (ev.key && ev.key.length === 1 && /[A-Za-z]/.test(ev.key)) { bipe = true; pin = ''; pintar(); return; }
      if (ev.key === 'Enter') {
        if (bipe) { bipe = false; pin = ''; pintar(); msg('Isso foi um bipe. Digite a sua senha primeiro.'); return; }
        tentar(); return;
      }
      if (bipe) return;
      if (ev.key >= '0' && ev.key <= '9') { if (pin.length < 8) { pin += ev.key; pintar(); msg(''); } }
      else if (ev.key === 'Backspace') { pin = pin.slice(0, -1); pintar(); }
    });
  }

  // Caixa "sessão aberta por outra pessoa" (11/11/2026, Gustavo: "sim, abre a
  // opção"). O servidor nunca troca o nome gravado na sessão: quem continua,
  // continua no nome de quem abriu. A pessoa escolhe sabendo disso.
  function perguntarSessaoDeOutro(info) {
    return new Promise(resolve => {
      css();
      const velho = document.getElementById('eko-outro');
      if (velho) velho.remove();
      const ov = document.createElement('div');
      ov.id = 'eko-outro';
      ov.style.cssText = 'position:fixed; inset:0; z-index:99998; background:rgba(10,17,25,0.94);'
        + 'display:flex; align-items:center; justify-content:center; padding:20px;'
        + 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;';
      const desde = info.desde ? new Date(info.desde) : null;
      const quando = desde && !isNaN(desde)
        ? desde.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
      const itens = Number(info.itens) || 0;
      ov.innerHTML =
        '<div style="width:100%; max-width:440px; background:#0f1626; border:1px solid #f59e0b; border-radius:18px; padding:26px 24px; text-align:center; color:#eef4fb;">' +
          '<div style="font-size:40px; line-height:1; margin-bottom:8px;">⚠️</div>' +
          '<div style="font-size:19px; font-weight:900; margin-bottom:8px;">' + escHtml(info.processo || 'Sessão') + ' aberta por ' + escHtml(info.operador) + '</div>' +
          '<div style="font-size:14px; color:#94a8c4; line-height:1.5; margin-bottom:18px;">' +
            (quando ? 'Desde ' + escHtml(quando) + ' · ' : '') + itens + (itens === 1 ? ' item' : ' itens') + '.<br>' +
            'Se você continuar, o que você fizer agora fica no nome de <b>' + escHtml(info.operador) + '</b>.' +
          '</div>' +
          (info.aviso ? '<div style="font-size:14px; color:#ff9b9b; font-weight:700; line-height:1.45; margin:-6px 0 16px;">' + escHtml(info.aviso) + '</div>' : '') +
          '<button id="eko-outro-encerrar" style="width:100%; padding:15px; border:none; border-radius:12px; background:#00ff9d; color:#052916; font-size:15px; font-weight:900; cursor:pointer; margin-bottom:10px;">Encerrar a de ' + escHtml(info.operador) + ' e começar a minha</button>' +
          '<button id="eko-outro-continuar" style="width:100%; padding:13px; border:1.5px solid #2a3a52; border-radius:12px; background:#131f30; color:#cbd5e8; font-size:14px; font-weight:800; cursor:pointer;">Continuar no nome de ' + escHtml(info.operador) + '</button>' +
        '</div>';
      document.body.appendChild(ov);
      const fim = escolha => { ov.remove(); resolve(escolha); };
      ov.querySelector('#eko-outro-encerrar').onclick = () => fim('encerrar');
      ov.querySelector('#eko-outro-continuar').onclick = () => fim('continuar');
    });
  }

  window.EkoAcesso = {
    // Exige login antes de liberar a tela. Chama aoEntrar(nome) quando validado.
    // opc.chave: onde a liberação fica guardada (padrão = tela); opc.nomeTela:
    // título do teclado. A permissão conferida no servidor é sempre `tela`.
    exigir(tela, aoEntrar, opc) {
      opc = opc || {};
      const chave = opc.chave || tela;
      PEDIDOS[chave] = { tela, aoEntrar, opc };
      const quandoPronto = fn => {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
        else fn();
      };
      const pedirSenha = () => quandoPronto(() => montar(tela, aoEntrar, opc));
      const lib = lerLiberacao(chave);
      if (!lib) return pedirSenha();
      const seguir = () => {
        window.EKO_RESPONSAVEL = lib.nome;
        window.EKO_RESPONSAVEL_ID = lib.id;
        quandoPronto(() => { try { aoEntrar && aoEntrar(lib.nome, lib); } catch (e) { console.error(e); } });
      };
      // opc.aindaValida(lib) → Promise<bool>: a tela confirma que a liberação
      // ainda vale (na MP: há processo aberto no nome dessa pessoa). Sem
      // processo, a pessoa saiu sem fazer nada: pede a senha de novo — senão
      // quem chega depois entra no nome dela. Erro na conferência = pede a senha.
      if (typeof opc.aindaValida !== 'function') return seguir();
      Promise.resolve()
        .then(() => opc.aindaValida(lib))
        .then(vale => { if (vale) seguir(); else { window.EkoAcesso.sair(chave); pedirSenha(); } },
              () => { window.EkoAcesso.sair(chave); pedirSenha(); });
    },
    // Teclado de senha ou caixa "sessão de outro" na tela: a tela não deve
    // aceitar bipe nem abrir sessão (ninguém está identificado ainda).
    bloqueando() { return !!(document.getElementById('eko-acesso') || document.getElementById('eko-outro')); },
    // Encerra a liberação (trocar de responsável / fim de turno).
    sair(chave) {
      try { sessionStorage.removeItem(chaveLib(chave)); } catch (e) {}
      window.EKO_RESPONSAVEL = null; window.EKO_RESPONSAVEL_ID = null;
      const tag = document.getElementById('eko-resp-tag');
      if (tag) tag.remove();
    },
    // Processo encerrado (finalizou ou cancelou): a senha vale até aqui. Apaga a
    // liberação e mostra o teclado de novo, sem recarregar a tela (o aviso de
    // "enviado" continua visível por baixo).
    encerrar(chave) {
      this.sair(chave);
      const p = PEDIDOS[chave];
      if (p) montar(p.tela, p.aoEntrar, p.opc);
    },
    liberado(chave) { return !!lerLiberacao(chave); },
    // Nome do responsável logado (para mandar como `operador` na sessão).
    responsavel() { return window.EKO_RESPONSAVEL || null; },
    perguntarSessaoDeOutro,
  };
})();
