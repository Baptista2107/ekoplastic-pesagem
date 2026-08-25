/* ════════════════════════════════════════════════════════════════════
   TRAVA DE TELA CHEIA / SAÍDA POR SENHA  (seguranca-saida.js)  — v48
   Incluído em todas as telas: menu (shell), Matéria-Prima, Extrusão,
   Manutenção.

   ARQUITETURA (tela cheia 100% contínua):
   - O MENU (index.html) é o "shell": ele entra em tela cheia (Fullscreen
     API) no 1º toque e NUNCA mais recarrega. As telas de processo abrem
     dentro de um <iframe> do shell (window.ekoAbrirTela), então trocar de
     tela NÃO recarrega o shell e a tela cheia não cai. Navegação direta,
     sem nenhum "toque para continuar".
   - A tela cheia é controlada pelo shell (index.html). Este arquivo NÃO
     entra/sai de tela cheia por conta própria — ele delega ao shell.

   SENHA (somente nestes dois casos):
   - Entrar em MANUTENÇÃO  -> ekoEntrarProtegido() (abre no iframe do shell)
   - SAIR do sistema       -> cadeado/ESC -> o shell faz exitFullscreen() e
     a barra do Windows (X / minimizar) reaparece no topo.

   Alcance honesto: cobre a tela cheia contínua e a saída por senha.
   Alt+F4 / tecla Windows continuam sendo do SO (só Electron / Assigned
   Access bloqueiam de vez).
   ════════════════════════════════════════════════════════════════════ */
(function () {
  const URL_BASE = window.location.origin;
  const TELA = (document.body && document.body.dataset && document.body.dataset.tela) ||
               (location.pathname.includes('producao') ? 'Extrusão' :
                location.pathname.includes('materia')  ? 'Matéria-Prima' :
                location.pathname.includes('manutencao')? 'Manutenção' : 'Menu');
  const NO_TOPO = (window.self === window.top);
  const EH_PROCESSO = (TELA !== 'Menu');
  const EMBUTIDO = !NO_TOPO;   // tela de processo rodando dentro do iframe do shell

  // 1) Tela de processo aberta DIRETO (fora do shell) -> reabre via shell.
  if (EH_PROCESSO && NO_TOPO) {
    try { location.replace('/?tela=' + encodeURIComponent(location.pathname)); } catch (e) {}
    return;
  }
  // 2) MENU carregado dentro do iframe -> o shell já tratou (bounce). Sai.
  if (!EH_PROCESSO && !NO_TOPO) { return; }

  let pin = '';
  let cbSucesso = null;

  // ───────────────────── SAIR DO SISTEMA ─────────────────────
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' || e.keyCode === 27) { e.preventDefault(); ekoSair(); }
  }, true);

  window.ekoSair = function () {
    abrirCaixaSenha({
      titulo: '🔒 Sair do sistema',
      subtitulo: 'Senha do supervisor para sair',
      onSucesso: function () {
        try {
          if (EMBUTIDO && window.parent && window.parent.ekoExitFS) window.parent.ekoExitFS();
          else if (window.ekoExitFS) window.ekoExitFS();
        } catch (e) {}
        setTimeout(mostrarPainelSaida, 250);   // painel SEMPRE aparece (no doc visível)
      }
    });
  };

  window.ekoEntrarProtegido = function (destino) {
    abrirCaixaSenha({
      titulo: '🔒 Área protegida',
      subtitulo: 'Senha do supervisor para entrar',
      onSucesso: function () {
        if (window.ekoAbrirTela) window.ekoAbrirTela(destino);   // abre no iframe do shell
        else location.href = destino;                            // fallback
      }
    });
  };

  function mostrarPainelSaida() {
    if (document.getElementById('eko-painel-saida')) return;
    const d = document.createElement('div');
    d.id = 'eko-painel-saida';
    Object.assign(d.style, {
      position: 'fixed', inset: '0', zIndex: '1000000',
      background: 'rgba(8,12,20,0.92)', display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'system-ui,-apple-system,sans-serif',
    });
    d.innerHTML =
      '<div style="background:#0f1626;border:1px solid #2a3550;border-radius:18px;padding:28px 26px;width:420px;max-width:92vw;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.5);">' +
        '<div style="font-size:46px;line-height:1;margin-bottom:10px;">✓</div>' +
        '<div style="color:#fff;font-size:20px;font-weight:800;margin-bottom:8px;">Tela liberada</div>' +
        '<div style="color:#9fb0d0;font-size:14px;line-height:1.5;margin-bottom:18px;">' +
          '<b>Fechar agora</b> encerra o sistema (fecha o navegador e o servidor). ' +
          '<b>Voltar ao sistema</b> retorna à tela cheia.' +
        '</div>' +
        '<button id="eko-fechar-janela" style="width:100%;padding:13px;border:none;border-radius:10px;background:#ef4444;color:#fff;font-size:15px;font-weight:800;cursor:pointer;margin-bottom:10px;">Fechar agora</button>' +
        '<button id="eko-voltar-sistema" style="width:100%;padding:12px;border:none;border-radius:10px;background:#1c2740;color:#cbd5e8;font-size:14px;font-weight:700;cursor:pointer;">Voltar ao sistema</button>' +
      '</div>';
    document.body.appendChild(d);
    document.getElementById('eko-fechar-janela').addEventListener('click', function () {
      const btn = this;
      btn.textContent = 'Encerrando…';
      btn.disabled = true;
      // window.close() não funciona em janela Chrome --app (não foi aberta por
      // script). O servidor fecha o navegador e a si mesmo de forma limpa.
      fetch(URL_BASE + '/sistema/encerrar', { method: 'POST' }).catch(function () {});
      // Se em 3s nada fechou (rodando fora do quiosque), reabilita o botão.
      setTimeout(function () { btn.disabled = false; btn.textContent = 'Fechar agora'; }, 3000);
    });
    document.getElementById('eko-voltar-sistema').addEventListener('click', function () {
      if (EMBUTIDO) { try { window.top.location.href = '/'; } catch (e) {} return; }
      window.__ekoSaindo = false; d.remove();
      if (window.ekoEntrarFS) window.ekoEntrarFS();
    });
  }

  // ───────────────────── CAIXA DE SENHA (teclado touch) ─────────────────────
  function abrirCaixaSenha(opc) {
    if (document.getElementById('overlay-senha-saida')) return;
    pin = '';
    cbSucesso = opc.onSucesso || null;
    const ov = document.createElement('div');
    ov.id = 'overlay-senha-saida';
    Object.assign(ov.style, {
      position: 'fixed', inset: '0', zIndex: '999999',
      background: 'rgba(8,12,20,0.93)', display: 'flex',
      alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(3px)',
    });
    ov.innerHTML =
      '<div style="background:#0f1626;border:1px solid #2a3550;border-radius:18px;padding:26px 24px;width:320px;max-width:92vw;box-shadow:0 20px 60px rgba(0,0,0,.5);font-family:system-ui,-apple-system,sans-serif;">' +
        '<div style="text-align:center;color:#fff;font-size:18px;font-weight:800;margin-bottom:4px;">' + (opc.titulo || '🔒 Senha') + '</div>' +
        '<div style="text-align:center;color:#8a99bd;font-size:13px;margin-bottom:16px;">' + (opc.subtitulo || 'Digite a senha do supervisor') + '</div>' +
        '<div id="pin-display" style="display:flex;justify-content:center;gap:10px;margin-bottom:8px;height:22px;"></div>' +
        '<div id="pin-erro" style="text-align:center;color:#ff6b6b;font-size:12px;height:16px;margin-bottom:10px;"></div>' +
        '<div id="pin-teclado" style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;"></div>' +
        '<button id="pin-cancelar" style="margin-top:14px;width:100%;padding:12px;border:none;border-radius:10px;background:#1c2740;color:#8a99bd;font-size:14px;font-weight:700;cursor:pointer;">Cancelar</button>' +
      '</div>';
    document.body.appendChild(ov);
    const teclado = ov.querySelector('#pin-teclado');
    ['1','2','3','4','5','6','7','8','9','limpar','0','ok'].forEach(function (t) {
      const b = document.createElement('button');
      b.textContent = t === 'limpar' ? '⌫' : t === 'ok' ? '✓' : t;
      Object.assign(b.style, {
        padding: '18px 0', fontSize: '22px', fontWeight: '800', cursor: 'pointer',
        border: 'none', borderRadius: '12px',
        background: t === 'ok' ? '#16a34a' : t === 'limpar' ? '#3a2330' : '#1c2740',
        color: t === 'ok' ? '#fff' : t === 'limpar' ? '#ff9b9b' : '#dbe4f5', userSelect: 'none',
      });
      b.addEventListener('click', function () { onTecla(t); });
      teclado.appendChild(b);
    });
    ov.querySelector('#pin-cancelar').addEventListener('click', fecharCaixa);
    renderPin();
  }
  function fecharCaixa() { const ov = document.getElementById('overlay-senha-saida'); if (ov) ov.remove(); pin = ''; }
  function renderPin() {
    const disp = document.getElementById('pin-display'); if (!disp) return;
    disp.innerHTML = '';
    for (let i = 0; i < Math.max(pin.length, 4); i++) {
      const dot = document.createElement('div'); const cheio = i < pin.length;
      Object.assign(dot.style, {
        width: '14px', height: '14px', borderRadius: '50%',
        background: cheio ? '#3b82f6' : 'transparent',
        border: '2px solid ' + (cheio ? '#3b82f6' : '#3a4660'),
      });
      disp.appendChild(dot);
    }
  }
  function onTecla(t) {
    const erro = document.getElementById('pin-erro'); if (erro) erro.textContent = '';
    if (t === 'limpar') { pin = pin.slice(0, -1); renderPin(); return; }
    if (t === 'ok') { confirmarSenha(); return; }
    if (pin.length < 8) { pin += t; renderPin(); }
    if (pin.length >= 8) confirmarSenha();
  }
  async function confirmarSenha() {
    const senha = pin; const erro = document.getElementById('pin-erro');
    try {
      const r = await fetch(URL_BASE + '/seguranca/validar-saida', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ senha: senha, tela: TELA }),
      });
      const d = await r.json();
      if (d && d.ok) { const cb = cbSucesso; fecharCaixa(); if (cb) cb(); return; }
    } catch (e) {}
    pin = ''; renderPin();
    if (erro) erro.textContent = 'Senha incorreta';
  }

  // ───────────────────── BOTÃO TOUCH DE SAÍDA (cadeado) ─────────────────────
  function criarBotaoSair() {
    if (document.getElementById('eko-btn-sair')) return;
    const btn = document.createElement('button');
    btn.id = 'eko-btn-sair';
    btn.type = 'button';
    btn.title = 'Sair do sistema (requer senha de supervisor)';
    btn.addEventListener('click', ekoSair);
    const home = document.querySelector('header .btn-icon');
    if (home && home.parentNode) {
      btn.className = home.className;
      btn.textContent = '🔒';
      home.parentNode.insertBefore(btn, home);
    } else {
      btn.textContent = '🔒 Sair';
      Object.assign(btn.style, {
        position: 'fixed', bottom: '16px', right: '16px', zIndex: '999998',
        padding: '12px 16px', borderRadius: '12px',
        border: '1px solid rgba(255,255,255,0.18)',
        background: 'rgba(20,28,44,0.78)', color: '#cbd5e8',
        fontSize: '15px', fontWeight: '700', cursor: 'pointer',
      });
      document.body.appendChild(btn);
    }
  }

  function iniciar() { criarBotaoSair(); }
  if (document.readyState !== 'loading') iniciar();
  else window.addEventListener('DOMContentLoaded', iniciar);
})();
