/* O que o botão VOLTAR do Android faz na página aberta (v2.0, 25/11/2026).
 *
 * O MainActivity lê este arquivo e o executa na página a cada Voltar. A
 * resposta (texto) diz o que aconteceu:
 *   'fechou' — fechou uma janela aberta por cima, ou voltou um passo dentro
 *              da própria tela (o "← Voltar" do inventário);
 *   'hub'    — não havia nada aberto: o app "Ekoplastic MP" volta ao hub.
 *              Os apps de uma tela só (Coletor e Inventário) ignoram.
 *
 * Fica num arquivo próprio para ser testado no Node (testes/hub-coletor.js)
 * com um documento de mentira. Não depende de nada da página: as janelas de
 * cada tela foram listadas uma a uma (classe e botão de fechar).
 */
(function (d, w) {
  // Confirmação do acesso-colaborador.js ("Encerrar a de X?"): Voltar é o
  // "Voltar" dela — fica na tela, nada é encerrado.
  var ec = d.getElementById('eko-confirma');
  if (ec) { var n = ec.querySelector('#eko-confirma-nao'); if (n) { n.click(); return 'fechou'; } }
  // Teclado da senha ou caixa "sessão de outro" do acesso-colaborador.js:
  // quem apertou Voltar não quer entrar nesta tela.
  if (d.getElementById('eko-acesso') || d.getElementById('eko-outro') || ec) return 'hub';

  // Botão de fechar de uma janela: o que diz Cancelar / Fechar / Voltar / ✕ / ←.
  // Nunca o de confirmar.
  function fechar(j) {
    var bs = j.querySelectorAll('button');
    for (var i = 0; i < bs.length; i++) {
      if (/^\s*(✕|×|←|cancelar|fechar|voltar)/i.test(bs[i].textContent || '')) { bs[i].click(); return true; }
    }
    return false;
  }

  // Caixa de diálogo do eko-dialogo.js e janelas da Retirada de Bobinas.
  var m = d.querySelector('.modal-fundo');
  if (m) {
    var c = m.querySelector('#md-cancelar');
    if (c) c.click(); else if (!fechar(m)) m.remove();
    return 'fechou';
  }

  // Janelas das telas da MP e do PA (a classe que as mostra muda por tela):
  //  .modal-overlay.ativo  Retirada de MP     .kp-overlay.ativo  teclado da Retirada
  //  .modal-overlay.on     Produto Acabado    .ov-correcao.on    correção da Entrada
  //  #rd-overlay.ativo     Resumo do dia (resumo-dia.js, Entrada e Retirada)
  var abertas = d.querySelectorAll('.modal-overlay.on, .modal-overlay.ativo, .kp-overlay.ativo, .ov-correcao.on, #rd-overlay.ativo');
  if (abertas.length) {
    var j = abertas[abertas.length - 1];
    if (!fechar(j)) { j.classList.remove('on'); j.classList.remove('ativo'); }
    return 'fechou';
  }

  // "← Voltar" da própria tela (inventário: volta à escolha do produto).
  var v = d.getElementById('btn-voltar');
  if (v && v.offsetParent !== null && w.getComputedStyle(v).display !== 'none') { v.click(); return 'fechou'; }

  // Retirada de Bobinas: fecha o cartão da bobina lida (como na v1.9).
  if (typeof w.cancelarLeitura === 'function') { w.cancelarLeitura(); return 'fechou'; }

  return 'hub';
})(document, window)
