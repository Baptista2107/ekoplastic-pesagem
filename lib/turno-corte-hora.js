'use strict';
// ══════════════════════════════════════════════════════════════════════
//  TURNO DO CORTE QUE PASSOU DA HORA  (17/11/2026, Gustavo: "sobre a bobina ok")
//
//  Em 17/11 o Turno C ficou aberto até 08:20 (só fechou na correção do
//  Gustavo): as bobinas do A entraram no C, e o aviso de fardos saiu errado.
//  A bobina que passa de turno é a que mais gera aviso falso
//  (docs/decisoes/2026-11-13-bobina-que-passa-de-turno.md, no bling-claude).
//  Daqui sai só o AVISO no coletor: nada fecha sozinho, porque encerrar o turno
//  pede os fardos da bobina montada e a senha do supervisor.
//
//  Hora de fim de cada turno, medida nos turnos_corte de 05 a 17/11/2026
//  (P1 e P2): A encerra 17:52-17:57 (sexta mais cedo, 16:01-16:55), EXTRA
//  21:59-22:21, C 05:56-06:04. A folga de 15 min deixa de fora todo
//  encerramento normal medido; só o EXTRA de 11/11 (22:21) teria visto o aviso.
//
//  Hora LOCAL do Mini PC (getHours/setHours), como o calcularLimiteAutoFim da
//  extrusão (lib/turnos.js).
//  Sem banco e sem require: o teste do Node carrega direto (testes/turno-corte-hora.js).
// ══════════════════════════════════════════════════════════════════════

const FIM_TURNO_CORTE_H = { A: 18, EXTRA: 22, C: 6 };
const TURNO_CORTE_FOLGA_MIN = 15;
// Duração máxima que faz sentido para cada turno (revisor 17/11): A 05:54-18:00
// ≈ 12 h, EXTRA 18:00-22:00 = 4 h, C 18:00-06:00 = 12 h no dia sem EXTRA
// (o mais cedo medido foi 20:35). Passou disso, o turno foi aberto DEPOIS da
// própria hora de fim (C aberto às 06:05, A às 18:20, EXTRA às 22:05 — turno
// errado ou reaberto): o fim é o do mesmo dia e o aviso sai já.
const DURACAO_MAX_TURNO_CORTE_H = { A: 14, EXTRA: 8, C: 14 };

// Quando o turno devia ter acabado: a 1ª vez que bate a hora de fim DEPOIS do
// início (C das 22:00 → 06:00 do dia seguinte; C aberto às 00:30 → 06:00 do
// mesmo dia), a não ser que isso passe da duração máxima (acima).
// Turno desconhecido ou início ilegível → null (sem aviso).
function fimPrevistoTurnoCorte(turno, inicioISO) {
  const h = FIM_TURNO_CORTE_H[turno];
  const ini = new Date(inicioISO);
  if (h == null || !inicioISO || isNaN(ini.getTime())) return null;
  const fim = new Date(ini);
  fim.setHours(h, 0, 0, 0);
  if (fim <= ini) {
    const seguinte = new Date(fim);
    seguinte.setDate(seguinte.getDate() + 1);
    if (seguinte - ini <= DURACAO_MAX_TURNO_CORTE_H[turno] * 3600000) return seguinte;
  }
  return fim;
}

const dois = n => String(n).padStart(2, '0');

// Turno ABERTO que passou do fim + folga → { fim_previsto (ISO), fim_hora
// ("06:00", hora do Mini PC), minutos }; senão null. `t` é a linha de
// turnos_corte ({ turno, inicio, fim }). A tela escreve com fim_hora e minutos
// (não com o relógio nem o fuso do coletor).
function turnoCorteAtrasado(t, agora = new Date(), folgaMin = TURNO_CORTE_FOLGA_MIN) {
  if (!t || t.fim) return null;
  const fim = fimPrevistoTurnoCorte(t.turno, t.inicio);
  if (!fim) return null;
  const minutos = Math.floor((new Date(agora).getTime() - fim.getTime()) / 60000);
  if (!(minutos >= folgaMin)) return null;
  return { fim_previsto: fim.toISOString(), fim_hora: dois(fim.getHours()) + ':' + dois(fim.getMinutes()), minutos };
}

module.exports = { DURACAO_MAX_TURNO_CORTE_H, FIM_TURNO_CORTE_H, TURNO_CORTE_FOLGA_MIN,
  fimPrevistoTurnoCorte, turnoCorteAtrasado };
