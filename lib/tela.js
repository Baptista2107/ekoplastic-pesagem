// ════════════════════════════════════════════════════════════════════
//  TELA DO QUIOSQUE — o que o VIGIA do INICIAR.bat deve fazer (11/11/2026)
// ────────────────────────────────────────────────────────────────────
//  Em 11/11/2026 a tela do Mini PC sumiu duas vezes:
//   - 08h14: "Fechar agora" desligou o servidor (31 min fora);
//   - 10h39: a atualização remota rodou num INICIAR da sessão 0 do
//     Windows (a dos serviços) e abriu o Chrome lá, onde ninguém vê.
//
//  Desde então quem abre a tela é só o VIGIA: um INICIAR.bat oculto,
//  rodando na sessão do monitor (sessão 1), que pergunta a cada 5 s
//  GET /sistema/tela?s=<sessão>&a=<1 se a tela está aberta, 0 se não>
//  e recebe UMA palavra, fácil de ler num .bat:
//
//    ABERTA    a tela está aberta: nada a fazer
//    ABRIR     abra a tela agora
//    AGUARDAR  acabou de mandar abrir: espere o Chrome subir
//    PAUSADA   alguém usou "Fechar agora" (senha do supervisor): a tela
//              fica fechada por PAUSA_MS e depois volta sozinha
//    DESISTIU  mandou abrir várias vezes e a tela nunca apareceu aberta:
//              a detecção falhou. Parar de abrir, senão a tela se enche
//              de janelas. Volta ao normal quando a tela aparece aberta
//              ou quando alguém abre o INICIAR.bat.
//
//  O estado fica só na memória: se o servidor reinicia, a pausa acaba e
//  a tela volta, que é o certo depois de um reinício.
//  A decisão é uma função pura (relógio injetado) para ser testada.
// ════════════════════════════════════════════════════════════════════

const PAUSA_MS          = 10 * 60 * 1000;  // "Fechar agora": tela fechada por 10 min
const ESPERA_ABRIR_MS   = 30 * 1000;       // entre um ABRIR e outro (o Chrome leva ~3 s)
const MAX_ABRIR_SEM_VER = 3;               // 3 ABRIR sem nunca ver a tela aberta = DESISTIU
// O taskkill do "Fechar agora" sai ~0,5 s depois da pausa. Uma pergunta do
// vigia nesse meio-tempo ainda vê a tela aberta e não pode desfazer a pausa
// (revisão de 11/11/2026: ~1 em 10 cliques). 15 s cobrem o taskkill com folga.
const PAUSA_FIRME_MS    = 15 * 1000;

function novoEstado() {
  return { pausadaAte: 0, pausadaEm: 0, ultimoAbrir: 0, abrirSemVer: 0, vigia: null, desistiuAvisado: false };
}
const estado = novoEstado();

// "Fechar agora": fecha a tela por PAUSA_MS.
function pausar(agora = Date.now(), e = estado) {
  e.pausadaEm = agora;
  e.pausadaAte = agora + PAUSA_MS;
  return e.pausadaAte;
}

// INICIAR.bat aberto à mão (ou ABRIR pedido): tira a pausa e a desistência.
function liberar(e = estado) {
  e.pausadaAte = 0;
  e.pausadaEm = 0;
  e.ultimoAbrir = 0;
  e.abrirSemVer = 0;
  e.desistiuAvisado = false;
}

// O vigia perguntou. aberta: a tela do quiosque está aberta na sessão dele.
function decidir({ sessao, aberta, agora = Date.now() }, e = estado) {
  e.vigia = { sessao: String(sessao == null ? '?' : sessao), aberta: !!aberta, visto: agora };
  if (aberta) {
    // Tela aberta: a detecção funciona e quem abriu (à mão ou o vigia)
    // vence a pausa. Fechar de novo pelo X faz a tela voltar. Nos primeiros
    // PAUSA_FIRME_MS a tela aberta é a que o "Fechar agora" ainda vai fechar.
    e.abrirSemVer = 0;
    e.desistiuAvisado = false;
    if (!(e.pausadaEm && agora - e.pausadaEm < PAUSA_FIRME_MS)) e.pausadaAte = 0;
    return 'ABERTA';
  }
  if (agora < e.pausadaAte) return 'PAUSADA';
  if (e.abrirSemVer >= MAX_ABRIR_SEM_VER) return 'DESISTIU';
  if (e.ultimoAbrir && agora - e.ultimoAbrir < ESPERA_ABRIR_MS) return 'AGUARDAR';
  e.ultimoAbrir = agora;
  e.abrirSemVer++;
  return 'ABRIR';
}

// Para o /healthcheck: dá para conferir da VPS se há vigia na sessão do monitor.
function resumoTela(agora = Date.now(), e = estado) {
  return {
    vigia: e.vigia ? {
      sessao: e.vigia.sessao,
      tela_aberta: e.vigia.aberta,
      visto_ha_s: Math.round((agora - e.vigia.visto) / 1000),
    } : null,
    pausada_ate: e.pausadaAte > agora ? new Date(e.pausadaAte).toISOString() : null,
    alerta: e.abrirSemVer >= MAX_ABRIR_SEM_VER
      ? `mandei abrir a tela ${e.abrirSemVer} vezes e ela nunca apareceu aberta: parei de abrir`
      : null,
  };
}

// Só a própria máquina: o botão "Fechar agora" e o vigia rodam no Mini PC.
// Um celular pela rede (HTTPS 3443) não fecha a tela do monitor.
function ehLocal(req) {
  const ip = String((req && req.socket && req.socket.remoteAddress) || '');
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

module.exports = {
  decidir, ehLocal, ESPERA_ABRIR_MS, estado, liberar, MAX_ABRIR_SEM_VER, novoEstado,
  PAUSA_FIRME_MS, PAUSA_MS, pausar, resumoTela,
};
