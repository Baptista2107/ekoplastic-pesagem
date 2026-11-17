/* ══════════════════════════════════════════════════════════════════
   TEXTO DO AVISO "TURNO PASSOU DA HORA"  (17/11/2026)
   ------------------------------------------------------------------
   O servidor decide quem está atrasado (lib/turno-corte-hora.js) e manda,
   em cada sacoleira do GET /bobinas/turno-corte, turno.atrasado =
   { fim_previsto, fim_hora: "06:00", minutos }. Daqui só sai o texto, com
   fim_hora e minutos do Mini PC (o relógio e o fuso do coletor não entram).

   Na tela:  <script src="/turno-atrasado.js"></script>
             textoTurnoAtrasado(TC, esc)           → card (todas as sacoleiras)
             textoTurnoAtrasado(TC, esc, ['P1'])   → só a P1 (bipagem)
   No Node:  require('../public/turno-atrasado.js')  (testes/turno-corte-hora.js)
   ══════════════════════════════════════════════════════════════════ */
(function (raiz) {
  'use strict';

  function haMin(m) {
    m = Math.max(0, Math.floor(Number(m) || 0));
    if (m < 60) return 'há ' + m + ' min';
    var h = Math.floor(m / 60), r = m % 60;
    return 'há ' + h + 'h' + (r ? (' ' + String(r).padStart(2, '0') + 'min') : '');
  }

  // "TURNO C PASSOU DAS 06:00 NA P1 E P2 (há 2h 20min)"; vários turnos
  // atrasados ao mesmo tempo, separados por " · ". Nenhum → ''.
  // tc = { sacoleiras: [{ sacoleira, turno }], turnos: [{ codigo, label }] }
  function textoTurnoAtrasado(tc, esc, so) {
    if (!tc || !Array.isArray(tc.sacoleiras)) return '';
    var lb = function (c) {
      var t = (tc.turnos || []).filter(function (x) { return x.codigo === c; })[0];
      return (t && t.label) || c;
    };
    var grupos = [], porChave = {};
    tc.sacoleiras.forEach(function (s) {
      var a = s && s.turno && s.turno.atrasado;
      if (!a || (so && so.indexOf(s.sacoleira) < 0)) return;
      var k = s.turno.turno + '|' + a.fim_hora;
      if (!porChave[k]) { porChave[k] = { turno: s.turno.turno, a: a, sacs: [] }; grupos.push(porChave[k]); }
      porChave[k].sacs.push(s.sacoleira);
      if (a.minutos > porChave[k].a.minutos) porChave[k].a = a;
    });
    return grupos.map(function (g) {
      return esc(String(lb(g.turno)).toUpperCase()) + ' PASSOU DAS ' + esc(g.a.fim_hora) +
        ' NA ' + g.sacs.map(esc).join(' E ') + ' (' + haMin(g.a.minutos) + ')';
    }).join(' · ');
  }

  var api = { textoTurnoAtrasado: textoTurnoAtrasado, haMin: haMin };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.textoTurnoAtrasado = textoTurnoAtrasado;
})(this);
