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
  // A mesma pessoa digitando de novo (a consulta ao servidor falhou e a senha foi
  // pedida por segurança, achado F10) não perde a sessão de outro que continuava.
  function gravarLiberacao(chave, dados) {
    const velha = lerLiberacao(chave);
    const nova = { nome: dados.nome, id: dados.id, ts: Date.now() };
    if (velha && velha.continuada != null && velha.nome === dados.nome) nova.continuada = velha.continuada;
    try { sessionStorage.setItem(chaveLib(chave), JSON.stringify(nova)); } catch (e) {}
  }
  // Sessão de OUTRA pessoa que esta pessoa escolheu continuar (16/11/2026,
  // Gustavo: "saiu voltou mas é a mesma operação segue no nome de quem tava").
  // Fica junto da liberação do frame: enquanto AQUELA sessão seguir aberta, quem
  // sai e volta não digita a senha de novo nem responde de novo à pergunta. O
  // teto de 8 h conta do login (o ts não muda); encerrar/trocar apaga tudo.
  function marcarContinuada(chave, sessaoId) {
    const lib = lerLiberacao(chave);
    if (!lib || sessaoId == null || sessaoId === '') return;
    lib.continuada = String(sessaoId);
    try { sessionStorage.setItem(chaveLib(chave), JSON.stringify(lib)); } catch (e) {}
  }
  // Última chamada de exigir() por chave: encerrar() pede a senha de novo e
  // chama o mesmo aoEntrar (a tela já iniciada só troca o responsável).
  const PEDIDOS = {};
  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  // ── Leitor bloqueado × decisão pendente (16/11/2026, 2ª revisão) ──────────
  // São coisas diferentes e antes estavam no mesmo contador:
  //  · LEITOR BLOQUEADO: enquanto não se sabe quem está na tela (conferindo a
  //    senha guardada) ou a tela ainda restaura a sessão aberta. Sempre com
  //    teto de tempo: leitor travado na fábrica não pode acontecer (achado B4).
  //  · DECISÃO PENDENTE: caixa "sessão de outro" ou confirmação aberta. Ela é
  //    de QUEM ENTROU. Se a pessoa sai da aba sem responder, quem volta pode
  //    ser outra: a decisão é descartada e a senha é pedida (achado B1 — antes
  //    o próximo respondia a caixa no nome de quem tinha entrado).
  // Teto (ms) da conferência e da restauração. window.EKO_TETO_CONFERIR_MS só
  // existe nos testes.
  function tetoMs() {
    const t = window.EKO_TETO_CONFERIR_MS;
    return (typeof t === 'number' && t > 0) ? t : 8000;
  }
  let conferindo = 0;      // conferências da senha guardada (aindaValida) em curso
  let segurando = 0;       // restaurações seguradas pela tela (segurar)
  let cobrindo = 0;        // restaurações que ainda cobrem a tela (até abrir a caixa)
  const COBERTURAS = new Set();
  const DECISOES = new Map();   // id da caixa → fim(valor)
  const CANCELADO = 'cancelado';
  // Película transparente sobre a tela enquanto conferindo/restaurando (achado
  // B2): o leitor já ficava parado, mas um toque em Imprimir ou em adicionar
  // sacos abria sessão no nome de quem estava antes. Fica ABAIXO do teclado e
  // das caixas; sai quando a caixa de decisão abre ou no teto.
  function pelicula() {
    if (!document.body) return;
    const precisa = conferindo > 0 || cobrindo > 0;
    let el = document.getElementById('eko-pelicula');
    if (precisa && !el) {
      el = document.createElement('div');
      el.id = 'eko-pelicula';
      el.style.cssText = 'position:fixed; inset:0; z-index:99990; background:transparent; cursor:progress;';
      document.body.appendChild(el);
    } else if (!precisa && el) el.remove();
  }
  function temCaixa() {
    return DECISOES.size > 0 || !!(document.getElementById('eko-outro') || document.getElementById('eko-confirma'));
  }
  function tecladoAberto() { return !!document.getElementById('eko-acesso'); }
  // opc.aindaValida(lib) com teto de tempo → 'vale' | 'nao' (não há processo
  // dela) | 'falha' (erro ou demora na consulta: não se sabe — achado F10).
  function conferirValida(lib, opc) {
    conferindo++; pelicula();
    let teto;
    const limite = new Promise((_, nao) => { teto = setTimeout(() => nao(new Error('demorou')), tetoMs()); });
    return Promise.race([Promise.resolve().then(() => opc.aindaValida(lib)), limite])
      .then(vale => (vale ? 'vale' : 'nao'), () => 'falha')
      .then(r => { clearTimeout(teto); conferindo--; pelicula(); return r; });
  }
  function descartarDecisoes() {
    for (const fim of [...DECISOES.values()]) fim(CANCELADO);
    for (const id of ['eko-outro', 'eko-confirma']) { const el = document.getElementById(id); if (el) el.remove(); }
  }
  function pedirDeNovo(chave) {
    const p = PEDIDOS[chave];
    descartarDecisoes();
    window.EkoAcesso.sair(chave);
    if (p) montar(p.tela, p.aoEntrar, p.opc);
  }
  // Frame VIVO (16/11/2026, achados F1/F2 do revisor): os iframes da MP
  // carregam uma vez só. Quem entrava numa aba, não fazia nada e ia para outra
  // aba deixava a senha valendo para o próximo, e o teto de 8 h só contava ao
  // recarregar. reconferir() roda ao voltar à aba (materia-prima.html chama);
  // verificarTeto() roda de minuto em minuto. Só nas telas com aindaValida
  // (os frames da MP): PA e Resíduos seguem como antes.
  const REFAZER = new Set();    // conferência que FALHOU: tenta de novo no relógio
  function reconferirChave(chave) {
    const p = PEDIDOS[chave];
    if (!p || typeof p.opc.aindaValida !== 'function') return Promise.resolve();
    if (tecladoAberto() || p.conferindo) return Promise.resolve();   // já pedindo a senha / já conferindo
    REFAZER.delete(chave);
    // Caixa sem resposta é de quem entrou antes (B1): quem volta digita a senha.
    if (temCaixa()) { pedirDeNovo(chave); return Promise.resolve(); }
    const lib = lerLiberacao(chave);   // passou de 8 h → null
    if (!lib) { pedirDeNovo(chave); return Promise.resolve(); }
    p.conferindo = true;
    return conferirValida(lib, p.opc).then(r => {
      p.conferindo = false;
      if (tecladoAberto()) return;
      if (r === 'falha') { REFAZER.add(chave); return; }   // não se sabe: mantém e confere no próximo minuto
      if (r === 'nao' || temCaixa()) pedirDeNovo(chave);
    });
  }
  function reconferir() { return Promise.all(Object.keys(PEDIDOS).map(reconferirChave)); }
  function verificarTeto() {
    for (const chave of Object.keys(PEDIDOS)) {
      const p = PEDIDOS[chave];
      if (typeof p.opc.aindaValida !== 'function' || tecladoAberto()) continue;
      // Passou de 8 h: pede a senha mesmo com uma caixa sem resposta na tela.
      if (window.EKO_RESPONSAVEL && !lerLiberacao(chave)) { pedirDeNovo(chave); continue; }
      if (REFAZER.has(chave)) reconferirChave(chave);
    }
  }
  let timerTeto = null;

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
    // O teclado agora também abre com a tela em uso (voltar à aba, teto de 8 h):
    // tira o foco do campo onde a pessoa estava (ex.: peso bruto), senão os
    // números da senha ou de um bipe entravam também no campo (achado B5).
    try {
      const ativo = document.activeElement;
      if (ativo && ativo !== document.body && typeof ativo.blur === 'function') ativo.blur();
    } catch (e) {}
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
      // Ouve só o SEU teclado: depois de encerrar, monta-se outro, e este não
      // pode mandar a senha de novo (antes, a senha ia duas vezes ao servidor).
      if (!ov.isConnected) { document.removeEventListener('keydown', ouvir); return; }
      // A tecla é do teclado de senha: não vai para nenhum campo da tela (B5).
      if (ev.key && (ev.key.length === 1 || ev.key === 'Enter' || ev.key === 'Backspace')
          && typeof ev.preventDefault === 'function') ev.preventDefault();
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
  // Caixa de decisão (sessão de outro / confirmação). Registrada em DECISOES:
  // outra caixa no lugar, voltar à aba ou o teto de 8 h respondem 'cancelado'
  // à caixa velha — a promessa nunca fica sem resposta (achado B4: o leitor
  // ficava travado até recarregar). Abrir a caixa descobre a tela (película).
  function abrirDecisao(id, html, botoes) {
    return new Promise(resolve => {
      css();
      const fimVelho = DECISOES.get(id);
      if (fimVelho) fimVelho(CANCELADO);
      const velho = document.getElementById(id);
      if (velho) velho.remove();
      for (const descobrir of [...COBERTURAS]) descobrir();
      const ov = document.createElement('div');
      ov.id = id;
      ov.style.cssText = 'position:fixed; inset:0; z-index:99998; background:rgba(10,17,25,0.94);'
        + 'display:flex; align-items:center; justify-content:center; padding:20px;'
        + 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;';
      ov.innerHTML = html;
      document.body.appendChild(ov);
      const fim = valor => {
        if (DECISOES.get(id) !== fim) return;   // já respondida
        DECISOES.delete(id);
        ov.remove();
        resolve(valor);
      };
      DECISOES.set(id, fim);
      for (const [sel, valor] of botoes) ov.querySelector(sel).onclick = () => fim(valor);
    });
  }

  // Resolve 'encerrar' | 'continuar' | 'cancelado' (descartada: ver abrirDecisao).
  function perguntarSessaoDeOutro(info) {
      const desde = info.desde ? new Date(info.desde) : null;
      const quando = desde && !isNaN(desde)
        ? desde.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
      const itens = Number(info.itens) || 0;
      const html =
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
      return abrirDecisao('eko-outro', html, [['#eko-outro-encerrar', 'encerrar'], ['#eko-outro-continuar', 'continuar']]);
  }

  // Confirmação antes de encerrar a sessão de OUTRA pessoa (16/11/2026,
  // Gustavo, achado F6: no Recebimento/Retorno um toque em "Encerrar a de X"
  // mandava ao Bling, sem perguntar, o recebimento pela metade de outro; a
  // Retirada já confirmava). Resolve true só no botão de confirmar, false no
  // "Voltar" e 'cancelado' quando a caixa é descartada.
  function confirmar(info) {
    const html =
        '<div style="width:100%; max-width:440px; background:#0f1626; border:1px solid #ef4444; border-radius:18px; padding:26px 24px; text-align:center; color:#eef4fb;">' +
          '<div style="font-size:40px; line-height:1; margin-bottom:8px;">📤</div>' +
          '<div style="font-size:19px; font-weight:900; margin-bottom:8px;">' + escHtml(info.titulo) + '</div>' +
          '<div style="font-size:14px; color:#94a8c4; line-height:1.5; margin-bottom:18px;">' + escHtml(info.texto) + '</div>' +
          '<button id="eko-confirma-sim" style="width:100%; padding:15px; border:none; border-radius:12px; background:#ef4444; color:#fff; font-size:15px; font-weight:900; cursor:pointer; margin-bottom:10px;">' + escHtml(info.botao || 'Confirmar') + '</button>' +
          '<button id="eko-confirma-nao" style="width:100%; padding:13px; border:1.5px solid #2a3a52; border-radius:12px; background:#131f30; color:#cbd5e8; font-size:14px; font-weight:800; cursor:pointer;">Voltar</button>' +
        '</div>';
    return abrirDecisao('eko-confirma', html, [['#eko-confirma-sim', true], ['#eko-confirma-nao', false]]);
  }

  window.EkoAcesso = {
    // Exige login antes de liberar a tela. Chama aoEntrar(nome) quando validado.
    // opc.chave: onde a liberação fica guardada (padrão = tela); opc.nomeTela:
    // título do teclado. A permissão conferida no servidor é sempre `tela`.
    exigir(tela, aoEntrar, opc) {
      opc = opc || {};
      const chave = opc.chave || tela;
      PEDIDOS[chave] = { tela, aoEntrar, opc };
      if (typeof opc.aindaValida === 'function' && !timerTeto && typeof setInterval === 'function')
        timerTeto = setInterval(verificarTeto, 60 * 1000);
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
      // quem chega depois entra no nome dela. Erro na conferência (a tela
      // acabou de abrir, não se sabe quem está ali) = pede a senha também, mas
      // a liberação fica: se for a mesma pessoa, segue a sessão que continuava.
      if (typeof opc.aindaValida !== 'function') return seguir();
      conferirValida(lib, opc).then(r => {
        if (r === 'vale') seguir();
        else { if (r === 'nao') window.EkoAcesso.sair(chave); pedirSenha(); }
      });
    },
    // Teclado de senha, caixa de decisão, conferência ou restauração em curso:
    // a tela não deve aceitar bipe nem abrir sessão.
    bloqueando() { return tecladoAberto() || temCaixa() || conferindo > 0 || segurando > 0; },
    // Segura o leitor até a promessa terminar (16/11/2026, achado F5): entre a
    // senha aceita e a caixa "sessão de outro", a tela ainda está restaurando a
    // sessão aberta; um bipe nesse intervalo abria uma sessão nova no nome de
    // quem entrou. As telas passam aqui o "restaurar + conferir sessão de outro".
    // Teto (B4): servidor que aceita e não responde não trava o leitor — solta
    // em tetoMs(); com caixa de decisão aberta, a própria caixa segura e o teto
    // espera ela fechar. A película cobre a tela só até a caixa abrir.
    segurar(promessa) {
      segurando++; cobrindo++; pelicula();
      let solto = false, descoberto = false, teto = null;
      const descobrir = () => {
        if (descoberto) return;
        descoberto = true; cobrindo--; COBERTURAS.delete(descobrir); pelicula();
      };
      COBERTURAS.add(descobrir);
      const soltar = () => {
        if (solto) return;
        solto = true; clearTimeout(teto); segurando--; descobrir();
      };
      const armar = () => { teto = setTimeout(() => { if (DECISOES.size) armar(); else soltar(); }, tetoMs()); };
      armar();
      return Promise.resolve(promessa).then(v => { soltar(); return v; }, e => { soltar(); throw e; });
    },
    CANCELADO,
    reconferir,
    verificarTeto,
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
      descartarDecisoes();   // caixa vencida não fica por baixo do teclado (B4)
      this.sair(chave);
      const p = PEDIDOS[chave];
      if (p) montar(p.tela, p.aoEntrar, p.opc);
    },
    liberado(chave) { return !!lerLiberacao(chave); },
    // Escolheu "Continuar no nome de X": guarda o id da sessão continuada.
    continuar(chave, sessaoId) { marcarContinuada(chave, sessaoId); },
    // Id (texto) da sessão de outro que esta liberação continua, ou null.
    continuada(chave) {
      const lib = lerLiberacao(chave);
      return lib && lib.continuada != null ? String(lib.continuada) : null;
    },
    // Nome do responsável logado (para mandar como `operador` na sessão).
    responsavel() { return window.EKO_RESPONSAVEL || null; },
    perguntarSessaoDeOutro,
    confirmar,
  };
})();
