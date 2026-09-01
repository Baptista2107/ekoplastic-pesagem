/* ══════════════════════════════════════════════════════════════════
   RESUMO DO DIA  —  componente compartilhado          (01/09/2026)
   ------------------------------------------------------------------
   Retirada de MP, Retorno de MP e Resíduos deixaram de imprimir um
   resumo a cada operação finalizada. No lugar, cada uma dessas telas
   tem um botão que abre esta janela: escolhe o dia, mostra o que foi
   pesado e imprime UM resumo com o dia inteiro.

   Como usar numa tela:
     <script src="/resumo-dia.js"></script>
     <button onclick="abrirResumoDia('retirada')">📅 Resumo do dia</button>

   Tipos aceitos: 'retirada' | 'retorno' | 'outras'

   O componente é autossuficiente: injeta o próprio CSS e o próprio
   HTML na primeira abertura, usa as variáveis de cor da página (com
   valor de reserva) e não depende de nenhuma função da tela. Para os
   avisos, aproveita o showToast()/toast() da página se existir.
   ══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var TITULOS = {
    retirada: { nome: 'Retirada de Matéria-Prima', icone: '📤' },
    retorno:  { nome: 'Retorno de Matéria-Prima',  icone: '📥' },
    outras:   { nome: 'Resíduos e Aparas',         icone: '♻️' },
  };

  var estado = { tipo: null, data: null, previa: null, ocupado: false };
  var montado = false;

  // ── Avisos: usa o que a tela já tem, senão cai no alert ──────────
  function avisar(tipo, msg) {
    try {
      if (typeof window.showToast === 'function') {
        var ic = tipo === 'erro' ? '✗' : tipo === 'warn' ? '⚠' : '✓';
        window.showToast(tipo === 'erro' ? 'erro' : tipo === 'warn' ? 'warn' : 'sucesso', ic, msg);
        return;
      }
      if (typeof window.toast === 'function') {
        window.toast(msg, tipo === 'erro' ? 'error' : tipo === 'warn' ? 'warn' : 'success');
        return;
      }
    } catch (e) { /* segue pro alert */ }
    alert(msg);
  }

  function hojeISO() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function somarDias(iso, n) {
    var p = iso.split('-');
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    d.setDate(d.getDate() + n);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function brDia(iso) { var p = iso.split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }
  function fmtKg(kg) {
    return Number(kg || 0).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' kg';
  }
  function plural(n, um, muitos) { return n + ' ' + (n === 1 ? um : muitos); }

  // ── CSS + HTML, injetados uma única vez ─────────────────────────
  function montar() {
    if (montado) return;
    montado = true;

    var css = document.createElement('style');
    css.textContent = [
      '#rd-overlay{position:fixed;inset:0;background:rgba(0,0,0,.75);backdrop-filter:blur(3px);',
      '  display:none;align-items:center;justify-content:center;z-index:9000;padding:18px}',
      '#rd-overlay.ativo{display:flex}',
      '#rd-box{width:min(560px,96vw);max-height:92vh;overflow:auto;background:var(--surface,#161a23);',
      '  border:1px solid var(--border,#2a3045);border-radius:16px;padding:22px;',
      '  box-shadow:0 24px 64px rgba(0,0,0,.6);color:var(--text,#e8eaf0);font-family:inherit}',
      '#rd-box h2{font-size:19px;font-weight:800;letter-spacing:.3px;margin:0 0 2px}',
      '.rd-sub{font-size:12.5px;color:var(--muted,#6b7490);margin-bottom:16px}',
      '.rd-lb{font-size:11px;font-weight:800;letter-spacing:1.2px;color:var(--muted,#6b7490);margin-bottom:7px}',
      '.rd-datalinha{display:flex;gap:8px;align-items:stretch;margin-bottom:10px}',
      '.rd-seta{width:46px;flex:0 0 46px;font-size:20px;font-weight:800;background:var(--panel,#1e2330);',
      '  border:1px solid var(--border,#2a3045);border-radius:11px;color:var(--text,#e8eaf0);cursor:pointer}',
      '.rd-seta:hover{background:var(--panel-hi,#252b3d)}',
      '#rd-data{flex:1;min-width:0;font-family:inherit;font-size:17px;font-weight:700;text-align:center;',
      '  background:var(--panel,#1e2330);border:1px solid var(--border,#2a3045);border-radius:11px;',
      '  color:var(--text,#e8eaf0);padding:12px 8px;color-scheme:dark}',
      /* O <input type="date"> desenha a data no formato do NAVEGADOR (pode sair
         09/01/2026 pra 1º de setembro). Esta linha diz o dia por extenso, em
         português, pra não restar dúvida sobre o que vai ser impresso. */
      '.rd-diaext{text-align:center;font-size:13px;font-weight:700;color:var(--text,#e8eaf0);',
      '  margin:-2px 0 10px}',
      '.rd-atalhos{display:flex;gap:8px;margin-bottom:16px}',
      '.rd-atalho{flex:1;padding:9px;font-family:inherit;font-size:12.5px;font-weight:700;cursor:pointer;',
      '  background:transparent;border:1px solid var(--border,#2a3045);border-radius:9px;color:var(--muted,#6b7490)}',
      '.rd-atalho:hover{color:var(--text,#e8eaf0);background:var(--panel,#1e2330)}',
      '#rd-previa{background:var(--panel,#1e2330);border:1px solid var(--border,#2a3045);border-radius:12px;',
      '  padding:14px 16px;margin-bottom:16px;min-height:96px}',
      '.rd-total{font-size:26px;font-weight:800;line-height:1.15}',
      '.rd-total small{display:block;font-size:12.5px;font-weight:600;color:var(--muted,#6b7490);margin-top:3px}',
      '.rd-grupos{margin-top:12px;border-top:1px solid var(--border,#2a3045);padding-top:10px;',
      '  max-height:190px;overflow:auto}',
      '.rd-g{display:flex;justify-content:space-between;gap:12px;font-size:13px;padding:4px 0}',
      '.rd-g span:first-child{color:var(--text,#e8eaf0);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.rd-g span:last-child{color:var(--muted,#6b7490);font-weight:700;white-space:nowrap}',
      '.rd-vazio{color:var(--muted,#6b7490);font-size:14px;line-height:1.6;padding-top:6px}',
      '.rd-alerta{margin-top:10px;font-size:12px;color:var(--warn,#ffaa00);line-height:1.5}',
      '.rd-acoes{display:flex;gap:10px}',
      '.rd-btn{flex:1;padding:15px;font-family:inherit;font-size:14px;font-weight:800;letter-spacing:.5px;',
      '  border-radius:12px;cursor:pointer;border:1px solid var(--border,#2a3045);background:transparent;',
      '  color:var(--text,#e8eaf0)}',
      '.rd-btn:hover{background:var(--panel,#1e2330)}',
      '.rd-btn.ok{border:none;background:linear-gradient(135deg,#00d4ff,#00ff9d);color:#06121a}',
      '.rd-btn.ok:disabled{background:var(--panel,#1e2330);color:var(--muted,#6b7490);cursor:not-allowed}',
    ].join('\n');
    document.head.appendChild(css);

    var ov = document.createElement('div');
    ov.id = 'rd-overlay';
    ov.innerHTML = [
      '<div id="rd-box" role="dialog" aria-modal="true">',
      '  <h2 id="rd-titulo">Resumo do dia</h2>',
      '  <div class="rd-sub" id="rd-subtitulo"></div>',
      '  <div class="rd-lb">DIA</div>',
      '  <div class="rd-datalinha">',
      '    <button class="rd-seta" type="button" id="rd-ant" title="Dia anterior">‹</button>',
      '    <input type="date" id="rd-data">',
      '    <button class="rd-seta" type="button" id="rd-prox" title="Próximo dia">›</button>',
      '  </div>',
      '  <div class="rd-diaext" id="rd-diaext"></div>',
      '  <div class="rd-atalhos">',
      '    <button class="rd-atalho" type="button" id="rd-hoje">Hoje</button>',
      '    <button class="rd-atalho" type="button" id="rd-ontem">Ontem</button>',
      '  </div>',
      '  <div class="rd-lb">O QUE SERÁ IMPRESSO</div>',
      '  <div id="rd-previa"><div class="rd-vazio">Carregando...</div></div>',
      '  <div class="rd-acoes">',
      '    <button class="rd-btn" type="button" id="rd-fechar">← FECHAR</button>',
      '    <button class="rd-btn ok" type="button" id="rd-imprimir" disabled>🖨 IMPRIMIR</button>',
      '  </div>',
      '</div>',
    ].join('\n');
    document.body.appendChild(ov);

    document.getElementById('rd-fechar').addEventListener('click', fechar);
    document.getElementById('rd-imprimir').addEventListener('click', imprimir);
    document.getElementById('rd-ant').addEventListener('click', function () { irPara(somarDias(estado.data, -1)); });
    document.getElementById('rd-prox').addEventListener('click', function () { irPara(somarDias(estado.data, 1)); });
    document.getElementById('rd-hoje').addEventListener('click', function () { irPara(hojeISO()); });
    document.getElementById('rd-ontem').addEventListener('click', function () { irPara(somarDias(hojeISO(), -1)); });
    document.getElementById('rd-data').addEventListener('change', function (e) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) irPara(e.target.value);
      else e.target.value = estado.data;
    });
    ov.addEventListener('click', function (e) { if (e.target === ov) fechar(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && ov.classList.contains('ativo')) fechar();
    });
  }

  // ── Prévia: pergunta ao servidor o que existe naquele dia ───────
  function porExtenso(iso) {
    var p = iso.split('-');
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    var hoje = hojeISO();
    var etiqueta = iso === hoje ? ' (hoje)' : (iso === somarDias(hoje, -1) ? ' (ontem)' : '');
    try {
      var t = d.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
      return t.charAt(0).toUpperCase() + t.slice(1) + etiqueta;   // só a 1ª letra
    } catch (e) { return brDia(iso) + etiqueta; }
  }

  function irPara(dia) {
    estado.data = dia;
    document.getElementById('rd-data').value = dia;
    document.getElementById('rd-diaext').textContent = porExtenso(dia);
    carregarPrevia();
  }

  function carregarPrevia() {
    var alvo = document.getElementById('rd-previa');
    var btn  = document.getElementById('rd-imprimir');
    var dia  = estado.data, tipo = estado.tipo;
    alvo.innerHTML = '<div class="rd-vazio">Consultando...</div>';
    btn.disabled = true;
    estado.previa = null;

    fetch('/resumo-dia?tipo=' + encodeURIComponent(tipo) + '&data=' + encodeURIComponent(dia))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (estado.data !== dia || estado.tipo !== tipo) return;   // troquei de dia no meio
        if (!d || !d.ok) throw new Error((d && d.erro) || 'não consegui consultar');
        estado.previa = d;
        if (!d.itens) {
          alvo.innerHTML = '<div class="rd-vazio">Nada foi pesado em <b>' + brDia(dia) + '</b>.<br>'
                         + 'Escolha outro dia — ou é dia sem movimento mesmo.</div>';
          btn.disabled = true;
          return;
        }
        var html = '<div class="rd-total">' + fmtKg(d.total_kg)
                 + '<small>' + plural(d.itens, 'pesagem', 'pesagens') + ' · '
                 + plural(d.sessoes, 'operação finalizada', 'operações') + '</small></div>';
        if (d.grupos && d.grupos.length) {
          html += '<div class="rd-grupos">';
          d.grupos.forEach(function (g) {
            html += '<div class="rd-g"><span>' + escapar(g.label) + '</span><span>'
                 +  g.itens + ' · ' + fmtKg(g.kg) + '</span></div>';
          });
          html += '</div>';
        }
        if (d.abertas) {
          html += '<div class="rd-alerta">⚠ ' + plural(d.abertas, 'operação ainda está aberta', 'operações ainda estão abertas')
               +  ' e entra no total. Se ainda vão pesar hoje, imprima no fim do dia.</div>';
        }
        alvo.innerHTML = html;
        btn.disabled = false;
      })
      .catch(function (e) {
        if (estado.data !== dia) return;
        alvo.innerHTML = '<div class="rd-vazio">Não consegui consultar: ' + escapar(e.message) + '</div>';
        btn.disabled = true;
      });
  }

  function escapar(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
    });
  }

  // ── Impressão ───────────────────────────────────────────────────
  function imprimir() {
    if (estado.ocupado) return;
    var btn = document.getElementById('rd-imprimir');
    estado.ocupado = true;
    btn.disabled = true;
    btn.textContent = 'IMPRIMINDO...';

    fetch('/resumo-dia', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tipo: estado.tipo, data: estado.data }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok) throw new Error((d && d.erro) || 'falha ao imprimir');
        var r = d.resumo || {};
        avisar('ok', '🧾 Resumo de ' + brDia(estado.data) + ' impresso · '
                   + plural(r.itens || 0, 'pesagem', 'pesagens')
                   + (r.paginas > 1 ? ' · ' + r.paginas + ' etiquetas' : ''));
        fechar();
      })
      .catch(function (e) { avisar('erro', 'Não imprimiu: ' + e.message); })
      .finally(function () {
        estado.ocupado = false;
        btn.textContent = '🖨 IMPRIMIR';
        btn.disabled = false;
      });
  }

  function fechar() {
    var ov = document.getElementById('rd-overlay');
    if (ov) ov.classList.remove('ativo');
  }

  // ── Porta de entrada ────────────────────────────────────────────
  function abrirResumoDia(tipo, dia) {
    if (!TITULOS[tipo]) { avisar('erro', 'Resumo do dia não existe para "' + tipo + '"'); return; }
    montar();
    estado.tipo = tipo;
    estado.data = dia || hojeISO();
    var t = TITULOS[tipo];
    document.getElementById('rd-titulo').textContent = t.icone + '  Resumo do dia';
    document.getElementById('rd-subtitulo').textContent =
      t.nome + ' — imprime de uma vez tudo o que foi pesado no dia escolhido.';
    document.getElementById('rd-overlay').classList.add('ativo');
    irPara(estado.data);
  }

  window.abrirResumoDia = abrirResumoDia;
  window.EkoResumoDia = { abrir: abrirResumoDia, fechar: fechar };
})();
