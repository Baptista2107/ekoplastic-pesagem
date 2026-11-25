/* App 2.2 (25/11/2026): o que MainActivity.injetarAlertaPedidos() roda no fim
   do carregamento de cada tela do hub. Põe /alerta-pedidos.js do Mini PC
   (a regra mora lá). O teste de navegador
   testes/navegador/alerta_pedidos_tc60.py roda ESTE arquivo. */
(function () {
  if (window.__ekoAlertaPedidos || document.getElementById('__ekoAlertaJs')) return;
  var s = document.createElement('script');
  s.id = '__ekoAlertaJs';
  s.src = '/alerta-pedidos.js';
  (document.head || document.documentElement).appendChild(s);
})();
