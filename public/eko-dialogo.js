/*
 * eko-dialogo.js — janelas no visual do sistema, no lugar de confirm() e
 * prompt() do navegador (28/09/2026, VPS, pedido do Frederico: "nenhuma
 * mensagem do tipo sistema, todas no padrão da aplicação").
 *
 *   const sim  = await ekoConfirmar({ titulo, texto, ok, cancelar, perigo });
 *   const txt  = await ekoPerguntar({ titulo, texto, placeholder, valor, numerico, ok });
 *
 * ekoConfirmar resolve true/false; ekoPerguntar resolve o texto ou null.
 * `texto` é texto puro (escapado aqui); \n vira quebra de linha.
 *
 * A raiz usa a classe `modal-fundo` e o botão de cancelar o id `md-cancelar`:
 * é o que o app Android (Ekoplastic Coletor / Inventário) fecha no Voltar,
 * então o Voltar do coletor equivale a "Cancelar".
 * Cores: as variáveis da tela (--panel, --verde…), com valores de reserva.
 */
(function () {
  if (window.ekoConfirmar) return;

  const CSS = `
  .eko-dlg{position:fixed; inset:0; z-index:9000; display:flex; align-items:center; justify-content:center;
    padding:16px; background:rgba(0,0,0,.72);}
  .eko-dlg .eko-cx{background:var(--panel,#131f30); color:var(--txt,#eef4fb); border:2px solid var(--ambar,#ffc250);
    border-radius:18px; padding:20px; width:100%; max-width:440px; max-height:92dvh; overflow:auto;
    font-family:inherit; box-shadow:0 10px 40px rgba(0,0,0,.6);}
  .eko-dlg.perigo .eko-cx{border-color:var(--vermelho,#ff6b6b);}
  .eko-dlg h2{margin:0 0 8px; font-size:20px; line-height:1.25;}
  .eko-dlg .eko-tx{color:var(--muted,#94a8c4); font-size:15px; line-height:1.5; white-space:normal;}
  .eko-dlg input{width:100%; margin-top:14px; padding:12px; font-size:24px; font-weight:800; text-align:center;
    border-radius:12px; border:2px solid var(--border,#2a3a52); background:var(--bg,#0a1119); color:var(--txt,#eef4fb);
    font-family:inherit; box-sizing:border-box;}
  .eko-dlg input:focus{outline:none; border-color:var(--ambar,#ffc250);}
  .eko-dlg .eko-bt{display:block; width:100%; min-height:54px; margin-top:12px; border:none; border-radius:14px;
    font-size:17px; font-weight:800; font-family:inherit; cursor:pointer;}
  .eko-dlg .eko-ok{background:var(--verde,#00ff9d); color:#052916;}
  .eko-dlg.perigo .eko-ok{background:var(--vermelho,#ff6b6b); color:#2b0a0a;}
  .eko-dlg .eko-no{background:var(--panel-hi,#1d2c42); color:var(--txt,#eef4fb); border:1.5px solid var(--border,#2a3a52);}
  `;
  function estilo() {
    if (document.getElementById('eko-dlg-css')) return;
    const s = document.createElement('style');
    s.id = 'eko-dlg-css'; s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }
  function esc(t) {
    return String(t == null ? '' : t).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])).replace(/\n/g, '<br>');
  }

  function abrir(o, comCampo) {
    estilo();
    return new Promise(resolve => {
      const f = document.createElement('div');
      f.className = 'eko-dlg modal-fundo' + (o.perigo ? ' perigo' : '');
      f.innerHTML = '<div class="eko-cx" role="dialog" aria-modal="true">' +
        (o.titulo ? '<h2>' + esc(o.titulo) + '</h2>' : '') +
        (o.texto ? '<div class="eko-tx">' + esc(o.texto) + '</div>' : '') +
        (comCampo ? '<input id="eko-dlg-in" autocomplete="off"' +
          (o.numerico ? ' type="text" inputmode="numeric"' : ' type="text"') +
          ' placeholder="' + esc(o.placeholder || '') + '" value="' + esc(o.valor || '') + '">' : '') +
        '<button class="eko-bt eko-ok" id="eko-dlg-ok">' + esc(o.ok || 'Confirmar') + '</button>' +
        '<button class="eko-bt eko-no" id="md-cancelar">' + esc(o.cancelar || 'Cancelar') + '</button>' +
        '</div>';
      document.body.appendChild(f);
      const inp = f.querySelector('#eko-dlg-in');
      const fim = v => { document.removeEventListener('keydown', tecla, true); f.remove(); resolve(v); };
      const ok = () => fim(comCampo ? inp.value : true);
      const no = () => fim(comCampo ? null : false);
      function tecla(e) {
        if (e.key === 'Escape') { e.preventDefault(); no(); }
        else if (e.key === 'Enter' && (comCampo || document.activeElement === f.querySelector('#eko-dlg-ok'))) { e.preventDefault(); ok(); }
      }
      f.querySelector('#eko-dlg-ok').onclick = ok;
      f.querySelector('#md-cancelar').onclick = no;
      document.addEventListener('keydown', tecla, true);
      setTimeout(() => (inp || f.querySelector('#eko-dlg-ok')).focus(), 50);
    });
  }

  window.ekoConfirmar = o => abrir(o || {}, false);
  window.ekoPerguntar = o => abrir(o || {}, true);
})();
