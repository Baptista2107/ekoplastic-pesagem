// ════════════════════════════════════════════════════════════════════
//  ATUALIZAÇÃO REMOTA — operações em voo e janela segura
// ════════════════════════════════════════════════════════════════════

const { db } = require('./db');

// ════════════════════════════════════════════════════════════════════
//  OPERAÇÕES EM VOO — usado só pela atualização remota
// ────────────────────────────────────────────────────────────────────
//  Conta quantas requisições de ESCRITA estão sendo atendidas neste
//  instante e quando terminou a última. Isso inclui o envio ao Bling,
//  porque ele acontece dentro do próprio POST /sessoes/:id/finalizar.
//  Nada disso altera o comportamento das rotas: é só um contador.
// ════════════════════════════════════════════════════════════════════
let OPS_EM_VOO   = 0;
let ULTIMA_OP_MS = 0;

// ════════════════════════════════════════════════════════════════════
//  JANELA SEGURA PARA ATUALIZAR   (usada por POST /sistema/atualizar)
// ────────────────────────────────────────────────────────────────────
//  A trava antiga era "nenhuma sessão aberta". Numa fábrica que roda
//  24h a Extrusão nunca fecha sessão, então aquilo era impossível de
//  satisfazer. O que precisa mesmo de proteção é outra coisa:
//
//   1. NADA IMPRESSO SEM BIPAR. Uma etiqueta em 'aguardando_bipe' é
//      uma bobina física esperando o operador. Reiniciar aí atrapalha
//      a operação.
//
//   2. A LIMPEZA DE STARTUP. limparSessoesOrfas(), ao subir, fecha
//      toda sessão aberta que NÃO tenha nenhuma etiqueta em
//      ('aguardando_bipe','bipada'). Por isso só liberamos a
//      atualização quando CADA sessão aberta já tem ao menos uma
//      etiqueta nesse conjunto: aí o NOT EXISTS dela dá falso e a
//      sessão atravessa o reinício inteira, com tudo que foi bipado.
//
//   3. SILÊNCIO. Nada impresso, bipado ou finalizado nos últimos
//      QUIETO_S segundos.
//
//   4. NADA EM VOO. Zero requisições de escrita sendo atendidas.
//
//  Falhando qualquer uma delas, devolve o motivo e NÃO atualiza.
//  Nenhuma etiqueta é apagada, cancelada ou perdida em nenhum caso:
//  esta função só LÊ o banco.
// ════════════════════════════════════════════════════════════════════
function avaliarJanelaAtualizacao(quietoS) {
  const agora = Date.now();

  const abertas = db.prepare(
    `SELECT id, tipo, turno_codigo, operador, maquina, inicio
       FROM sessoes WHERE fim IS NULL ORDER BY inicio`
  ).all();

  // ── 1 e 2: estado de cada sessão aberta ──
  //
  // Sessão VAZIA x sessão SEM BIPADA — a distinção que faltava (04/09/2026).
  // Uma sessão de Produto Acabado aberta e esquecida (o operador escolheu o
  // turno e foi almoçar) não tem etiqueta NENHUMA. O reinício fecha essa
  // sessão, sim — mas não há o que perder: nenhuma pesagem, nenhuma etiqueta,
  // nenhum lançamento. O operador só reescolhe o turno.
  //
  // Já uma sessão que TEM etiqueta e mesmo assim não tem nenhuma "viva" é
  // outra história. O caso perigoso: um recebimento cujos big bags já foram
  // TODOS retirados para a produção — eles ficam 'consumida', que não conta
  // como viva, e fechar a sessão perderia a ENTRADA no Bling. Essa continua
  // bloqueando.
  //
  // Antes desta distinção, uma sessão de PA vazia travava a atualização
  // indefinidamente: só saía do caminho quando alguém lançasse um fardo nela.
  const semBipada = [];   // tem conteúdo e fechar perderia algo → BLOQUEIA
  const vazias    = [];   // não tem etiqueta nenhuma → o reinício só fecha
  let aguardando  = 0;
  for (const s of abertas) {
    const c = db.prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'aguardando_bipe' THEN 1 ELSE 0 END) AS pendentes,
         SUM(CASE WHEN status IN ('aguardando_bipe','bipada') THEN 1 ELSE 0 END) AS vivas
       FROM etiquetas WHERE sessao_id = ?`
    ).get(s.id);
    aguardando += (c && c.pendentes) || 0;
    if (((c && c.vivas) || 0) === 0) {
      if (((c && c.total) || 0) === 0) vazias.push(s);
      else                            semBipada.push(s);
    }
  }

  if (aguardando > 0) {
    return { pode: false, regra: 'aguardando_bipe', abertas, sessoes_vazias: vazias,
      motivo: `Há ${aguardando} etiqueta(s) impressa(s) esperando bipe. Bipe ou cancele antes de atualizar.` };
  }
  if (semBipada.length) {
    return { pode: false, regra: 'sessao_sem_bipada', abertas, sessoes_sem_bipada: semBipada, sessoes_vazias: vazias,
      motivo: `Há ${semBipada.length} sessão(ões) aberta(s) com itens que o reinício perderia (etiquetas já retiradas ou canceladas). Finalize ou cancele essa(s) sessão(ões) antes de atualizar.` };
  }

  // ── 3: silêncio ──
  const u = db.prepare(`SELECT MAX(hora_impressao) AS imp, MAX(hora_bipagem) AS bip FROM etiquetas`).get();
  const f = db.prepare(`SELECT MAX(fim) AS fim FROM sessoes`).get();
  let ultimoMs = ULTIMA_OP_MS;
  for (const t of [u && u.imp, u && u.bip, f && f.fim]) {
    if (!t) continue;
    const ms = Date.parse(t);
    if (!isNaN(ms) && ms > ultimoMs) ultimoMs = ms;
  }
  const paradoS = ultimoMs ? Math.round((agora - ultimoMs) / 1000) : 999999;
  if (paradoS < quietoS) {
    return { pode: false, regra: 'movimento', abertas, sessoes_vazias: vazias, parado_s: paradoS, silencio_exigido_s: quietoS,
      motivo: `A estação teve movimento há ${paradoS}s. Preciso de ${quietoS}s de silêncio para atualizar com segurança.` };
  }

  // ── 4: nada em voo ──
  if (OPS_EM_VOO > 0) {
    return { pode: false, regra: 'em_voo', abertas, sessoes_vazias: vazias, em_voo: OPS_EM_VOO,
      motivo: `Há ${OPS_EM_VOO} operação(ões) sendo atendida(s) agora mesmo.` };
  }

  // Passou. Se houver sessão vazia, ela vai ser fechada pelo reinício —
  // isso vai junto na resposta e no log, para não acontecer calado.
  return { pode: true, regra: 'ok', abertas, parado_s: paradoS,
           sessoes_vazias: vazias,
           motivo: vazias.length
             ? `janela aberta — ${vazias.length} sessão(ões) vazia(s) será(ão) fechada(s) pelo reinício`
             : 'janela aberta' };
}

module.exports = { avaliarJanelaAtualizacao, };
Object.defineProperty(module.exports, 'OPS_EM_VOO', { enumerable: true, get: () => OPS_EM_VOO, set: v => { OPS_EM_VOO = v; } });
Object.defineProperty(module.exports, 'ULTIMA_OP_MS', { enumerable: true, get: () => ULTIMA_OP_MS, set: v => { ULTIMA_OP_MS = v; } });
