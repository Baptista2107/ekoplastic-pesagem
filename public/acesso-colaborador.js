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
  // Quanto tempo a liberação vale sem pedir a senha de novo (um turno).
  const HORAS_LIBERADO = 8;

  // A liberação fica guardada na sessão do navegador e é compartilhada entre a
  // tela e as abas internas (iframes) — por isso a senha é pedida UMA vez ao
  // entrar no módulo, e não a cada aba. Fecha o navegador, pede de novo.
  function chaveLib(tela) { return 'eko_liberado_' + tela; }
  function lerLiberacao(tela) {
    try {
      const bruto = sessionStorage.getItem(chaveLib(tela));
      if (!bruto) return null;
      const o = JSON.parse(bruto);
      if (!o || !o.nome || !o.ts) return null;
      if (Date.now() - o.ts > HORAS_LIBERADO * 3600 * 1000) { sessionStorage.removeItem(chaveLib(tela)); return null; }
      return o;
    } catch (e) { return null; }
  }
  function gravarLiberacao(tela, dados) {
    try { sessionStorage.setItem(chaveLib(tela), JSON.stringify({ nome: dados.nome, id: dados.id, ts: Date.now() })); } catch (e) {}
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

  function montar(tela, aoEntrar) {
    css();
    const nomeTela = NOMES_TELA[tela] || tela;
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
        <div class="rodape"><a href="/">← voltar ao menu</a></div>
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
          gravarLiberacao(tela, d);
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

    // teclado físico (o leitor de código de barras também digita)
    document.addEventListener('keydown', function ouvir(ev) {
      if (!document.getElementById('eko-acesso')) { document.removeEventListener('keydown', ouvir); return; }
      if (ev.key >= '0' && ev.key <= '9') { if (pin.length < 8) { pin += ev.key; pintar(); msg(''); } }
      else if (ev.key === 'Backspace') { pin = pin.slice(0, -1); pintar(); }
      else if (ev.key === 'Enter') { tentar(); }
    });
  }

  window.EkoAcesso = {
    // Exige login antes de liberar a tela. Chama aoEntrar(nome) quando validado.
    exigir(tela, aoEntrar) {
      // Já liberado nesta sessão (ex.: entrou pelo menu do módulo e agora está
      // trocando de aba): não pede a senha de novo.
      const lib = lerLiberacao(tela);
      if (lib) {
        window.EKO_RESPONSAVEL = lib.nome;
        window.EKO_RESPONSAVEL_ID = lib.id;
        const seguir = () => { try { aoEntrar && aoEntrar(lib.nome, lib); } catch (e) { console.error(e); } };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', seguir);
        else seguir();
        return;
      }
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => montar(tela, aoEntrar));
      } else {
        montar(tela, aoEntrar);
      }
    },
    // Encerra a liberação (trocar de responsável / fim de turno).
    sair(tela) {
      try { sessionStorage.removeItem(chaveLib(tela)); } catch (e) {}
      window.EKO_RESPONSAVEL = null; window.EKO_RESPONSAVEL_ID = null;
    },
    liberado(tela) { return !!lerLiberacao(tela); },
    // Nome do responsável logado (para mandar como `operador` na sessão).
    responsavel() { return window.EKO_RESPONSAVEL || null; },
  };
})();
