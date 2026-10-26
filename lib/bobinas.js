// ════════════════════════════════════════════════════════════════════
//  RETIRADA DE BOBINA PARA A SACOLEIRA (coletor)
// ════════════════════════════════════════════════════════════════════

const { PA_CORES, PA_FORMATOS_POR_MAQUINA, PORT } = require('./config');
const { logE, logI, logW } = require('./log');
const { configGet, configSet, db, dbStmts, makeTransaction } = require('./db');
const { gerarEPL, imprimir } = require('./impressao');

// ══════════════════════════════════════════════════════════════════
//  RETIRADA DE BOBINA PARA A SACOLEIRA  (28/09/2026, VPS)
// ══════════════════════════════════════════════════════════════════
// A bobina entra na sacoleira pela tela Retirada de Bobinas. Cada sacoleira
// tem no máximo UMA bobina aberta: bipar a próxima encerra a anterior e
// exige quantos fardos ela deu. Sem bobina nova no lugar (máquina parou,
// acabou o pedido), o "Finalizar" da sacoleira fecha a aberta com os fardos.
// É isso que liga bobina → fardo sem bipar o fardo.
//
// NÃO depende de turno (Frederico, 28/09/2026): a bobina atravessa a troca
// de turno, então "fardos por turno" não existe para ela. A 1ª versão desta
// tela pedia os fardos só dentro do mesmo turno e tinha "Encerrar turno" —
// saiu. O turno só é pedido se o Bling for religado, porque lá ele é o
// cliente da venda.
// 30/09/2026: a bobina continua atravessando o turno, mas agora o fim do
// turno do corte registra quanto ela deu naquele turno — ver bobina_parciais.

// Liga/desliga o pedido de venda no Bling a cada baixa. Padrão DESLIGADO.
function baixaBobinaNoBling() {
  return configGet('baixa_bobina_bling', '0') === '1';
}

// Turnos da tela. Com o Bling ligado, só os do mapa (precisam do contato).
// Desligado, o mapa vale se existir; senão, A e C (os da escala 12/36).
function turnosBaixaBobina(bling) {
  let mapa = {};
  try { mapa = JSON.parse(configGet('mapa_turno_bobina', '{}')); } catch(e) {}
  const turnos = Object.entries(mapa).map(([codigo, t]) => ({ codigo, label: t.label || codigo, contatoId: t.contatoId }));
  if (!turnos.length && !bling) return [{ codigo: 'A', label: 'Turno A' }, { codigo: 'C', label: 'Turno C' }];
  return turnos;
}

// 'Sacoleira P1' / 'p1' / 'P1' → 'P1'. Qualquer outra coisa → null.
function normalizarDestinoBobina(v) {
  const m = String(v || '').toUpperCase().match(/\bP\s*([12])\b/);
  return m ? 'P' + m[1] : null;
}

// A bobina aberta numa sacoleira (a mais recente sem encerramento).
function bobinaAbertaNa(destino) {
  return db.prepare(
    `SELECT * FROM etiquetas WHERE tipo = 'extrusao' AND status = 'consumida'
        AND destino = ? AND encerrada_em IS NULL ORDER BY baixa_em DESC LIMIT 1`).get(destino) || null;
}

// Fardos informados pelo operador: inteiro de 0 a 999, senão null.
function lerFardos(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return (Number.isInteger(n) && n >= 0 && n <= 999) ? n : null;
}

// ── PACOTES SOLTOS (30/09/2026, Gustavo) ────────────────────────────────
// Fardo = 5 pacotes de 5 kg. A bobina (ou o turno) pode acabar no meio de
// um fardo, e o fardo é completado pela bobina seguinte. O operador informa
// só o que vê: FARDOS FECHADOS desde o início da parte (contando o fardo
// misto que ela completou) e PACOTES SOLTOS agora no fardo aberto (0 a 4).
// A produção da parte, em pacotes, o sistema calcula:
//     fechados × 5 + soltos agora − soltos no início
// "Soltos no início" é o que a parte anterior da MESMA máquina deixou.
// Ex.: A acaba com 3 fechados e 2 soltos → 17 pacotes. B completa o fardo e
// fecha mais 4 (5 fechados), 1 solto no fim → 5×5 + 1 − 2 = 24 pacotes.
const PACOTES_POR_FARDO = 5;

function lerSoltos(v) {
  if (v === null || v === undefined || v === '') return 0;   // tela antiga: sem soltos
  const n = Number(v);
  return (Number.isInteger(n) && n >= 0 && n < PACOTES_POR_FARDO) ? n : null;
}

// Os soltos que uma parte deixou no fardo aberto passam para a parte seguinte
// da mesma máquina SÓ se der para fechar o fardo com eles:
//   · depois de uma TROCA DE FORMATO (parte 'setup') não (Gustavo, 02/10/2026);
//   · bobina de OUTRA COR não (Gustavo, 09/10/2026: "não pode aproveitar
//     pacotes de tamanhos diferentes e cores diferentes para a próxima
//     bobina"; "só não pode aproveitar 30x45 no 50x60, não tem lógica");
//   · OUTRO FORMATO não, quando os dois formatos são conhecidos.
// Os soltos continuam na produção da bobina que os fez (vão para o estoque
// sem rastreio — "isso não é problema"); só não são descontados da seguinte.
// `ant` e `seg`: { momento, formato, cor } (cor da etiqueta da bobina).
function herdaSoltos(ant, seg) {
  if (!ant || ant.momento === 'setup') return false;
  const nc = (c) => String(c || '').trim().toUpperCase();
  if (nc(ant.cor) && nc(seg.cor) && nc(ant.cor) !== nc(seg.cor)) return false;
  if (ant.formato && seg.formato && ant.formato !== seg.formato) return false;
  return true;
}

// Soltos que a última parte registrada na máquina deixou no fardo aberto e
// que a parte que está fechando agora (a da bobina montada, no `formato`
// informado, se houver) aproveita — ver herdaSoltos.
function soltosNaMaquina(maq, formato) {
  const r = db.prepare(`SELECT p.soltos_fim, p.momento, p.formato, e.cor FROM bobina_parciais p
                          LEFT JOIN etiquetas e ON e.id = p.etiqueta_id
                         WHERE p.maquina = ? ORDER BY p.id DESC LIMIT 1`).get(maq);
  if (!r || !r.soltos_fim) return 0;
  const atual = bobinaAbertaNa(maq);
  return herdaSoltos(r, { cor: atual ? atual.cor : null, formato: formato || null }) ? r.soltos_fim : 0;
}

// Lê fechados + soltos do corpo e calcula a produção da parte em pacotes.
// `formato`: o formato desta parte, quando a tela o informa (herdaSoltos).
// Devolve { fechados, soltos, pacotes } ou { erro }.
function lerParte(maq, fechadosV, soltosV, formato) {
  const fechados = lerFardos(fechadosV);
  if (fechados === null) return { erro: 'Informe quantos fardos fecharam' };
  const soltos = lerSoltos(soltosV);
  if (soltos === null) return { erro: 'Pacotes soltos deve ser de 0 a 4' };
  const inicio = soltosNaMaquina(maq, formato);
  const pacotes = fechados * PACOTES_POR_FARDO + soltos - inicio;
  if (pacotes < 0) return { erro: `Havia ${inicio} pacote(s) solto(s) no início; com ${fechados} fardo(s) fechado(s) e ${soltos} solto(s) não fecha a conta. Confira.` };
  return { fechados, soltos, pacotes };
}

// Pacotes → "3 fardos +2 pc" (texto de log).
function txtPacotes(p) {
  const f = Math.floor(p / PACOTES_POR_FARDO), s = p % PACOTES_POR_FARDO;
  return `${f} fardo(s)` + (s ? ` +${s} pc` : '');
}

// `parte` = { fechados, soltos, pacotes } do ÚLTIMO trecho (desde o último
// fim de turno). O total da etiqueta soma as partes anteriores
// (bobina_parciais): etiquetas.pacotes é o exato; etiquetas.fardos é o
// mesmo total arredondado em fardos, para quem já lia essa coluna.
// Devolve o total em pacotes.
function encerrarBobina(id, parte, motivo, quando, formato, formatoOrigem, maq, operador) {
  const antes = pacotesMontagensAnteriores(id) + pacotesParciaisDe(id).pacotes;
  if (maq) registrarParcial(id, maq, parte, 'final', quando, operador, formato, formatoOrigem);
  const total = antes + parte.pacotes;
  db.prepare(`UPDATE etiquetas SET fardos = ?, pacotes = ?, encerrada_em = ?, encerrada_motivo = ?, alterado_em = ?,
                     formato_cortado = COALESCE(?, formato_cortado), formato_origem = COALESCE(?, formato_origem)
               WHERE id = ? AND encerrada_em IS NULL`)
    .run(Math.round(total / PACOTES_POR_FARDO), total, quando, motivo, quando,
         formato || null, formato ? (formatoOrigem || null) : null, id);
  return total;
}

// ── FORMATO QUE A SACOLEIRA ESTÁ CORTANDO (29/09/2026, VPS — Gustavo) ────
// Três fontes, nesta ordem de trava:
//   1. cada máquina só corta os formatos dela (PA_FORMATOS_POR_MAQUINA);
//   2. cada largura de bobina só roda certos formatos: FORMATOS_POR_BOBINA
//      (Gustavo, 29/09/2026), ajustável pelo config `formatos_por_bobina`
//      (JSON {"160": [...]}). Largura fora da tabela: esta trava não filtra.
//      As PISTAS do CLP não entram: o operador não atualiza quando muda;
//   3. o COMPRIMENTO que o CLP da sacoleira mostra escolhe entre os que sobram.
// O CLP chega pela VPS (EKOSERVER → SFTP → acumulador), com até ~15 min de
// atraso: serve para sugerir, nunca para decidir sozinho.
const PESO_FARDO_KG = 25;
// Comprimento típico (mm) por formato: o 2º número × 10, menos os que a
// fábrica mede diferente. 35x45 ≈ 460 mm (Gustavo, 29/09/2026). Ajustável sem
// código pelo config `sac_comprimento_formato` (JSON {"30x45": 452, ...}).
const SAC_COMPRIMENTO_PADRAO = { '35x45': 460 };
// Largura da bobina (cm) → formatos que ela atende (áudios do Gustavo, 29/09/2026).
const FORMATOS_POR_BOBINA = {
  '175': ['35x45'],
  '168': ['42x53'],
  '160': ['30x40', '33x46', '30x45', '40x50', '50x60'],
  '120': ['60x80'],
  '80':  ['80x100'],
};
// 30x45 ↔ 33x46 SÓ PELO COLETOR (26/10/2026, Vinicius): no CLP os dois ficam a
// 10 mm (450/460) e a P2 corta 30x45 a 455 — um ajuste fino de 1 mm na E0002156
// (455→456, tentativa de melhorar a sacola) virou "setup mudou para 33x46".
// Entre os dois a troca só vale quando o operador escolhe no coletor (✓ Bobina
// finalizou ou Trocar formato); o comprimento do CLP não troca um pelo outro.
const PARES_SO_PELO_COLETOR = [['30x45', '33x46']];
function trocaSoPeloColetor(a, b) {
  return !!a && !!b && a !== b && PARES_SO_PELO_COLETOR.some(p => p.includes(a) && p.includes(b));
}
// O CLP aponta o par do formato de referência (o vigente, o escolhido, o da
// troca ou o último cortado): vale a referência.
function manterPar(out, ref) {
  if (!out.pelo_comprimento || !trocaSoPeloColetor(out.sugerido, ref)) return out;
  return { ...out, sugerido: ref, motivo: `${ref} — troca para ${out.sugerido} só pelo coletor (${out.motivo})` };
}
function comprimentoFormato(f) {
  let custom = {}; try { custom = JSON.parse(configGet('sac_comprimento_formato', '{}')); } catch(e) {}
  return Number(custom[f]) || SAC_COMPRIMENTO_PADRAO[f] || Number(String(f).split('x')[1]) * 10;
}
// '1,60' → 160 (cm). Capa ('92 x 0,5') e texto estranho → null.
function larguraBobinaCm(txt) {
  const m = String(txt || '').trim().match(/^(\d+)[,.](\d{1,2})$/);
  return m ? Math.round(parseFloat(m[1] + '.' + m[2]) * 100) : null;
}
// A cor da bobina já usa os nomes do produto acabado (Preta, Branca…).
function corPaDaBobina(cor) {
  const c = String(cor || '').trim().toLowerCase();
  const k = Object.keys(PA_CORES).find(k => PA_CORES[k].nome.toLowerCase() === c);
  return k ? { key: k, nome: PA_CORES[k].nome } : null;
}
let _clpCache = { em: 0, dados: null, erro: null };
async function clpSacoleiras() {
  // EKO_CLP_CACHE_MS: só para teste (testes/troca-formato.js); padrão 60 s.
  if (Date.now() - _clpCache.em < (Number(process.env.EKO_CLP_CACHE_MS) || 60000)) return _clpCache;
  const url = configGet('vps_sacoleiras_url', 'http://100.107.130.114:8765/api/sacoleiras/agora');
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
    const d = await r.json();
    _clpCache = { em: Date.now(), dados: d.ok ? d.sacoleiras : null, erro: d.ok ? null : (d.erro || 'erro') };
  } catch (e) {
    _clpCache = { em: Date.now(), dados: null, erro: e.message };
  }
  return _clpCache;
}

// BIPAGEM AO VIVO → VPS (14/10/2026, Gustavo: a troca da P1 das 07:26 não
// aparecia no acompanhamento por turno do painel — "resolva pra jamais
// acontecer de novo"). O exportador (C:\eko-push, tarefa de 2 em 2 min) manda
// tudo em lote por SFTP, e a troca chegava à VPS 4 min depois. Agora, a cada
// VIVO_CADA_MS, o servidor lê as MESMAS rotas que o exportador lê (mesmo
// formato de linha), só o que mudou nos últimos VIVO_JANELA_MIN, e se mudou
// algo desde o último envio manda ao painel da VPS (POST /api/coletor/vivo,
// mesma origem do vps_sacoleiras_url). Lá vira arquivo na entrada do ingestor
// e a ingestão roda na hora. O lote por SFTP continua igual: se este envio
// falhar, nada se perde — só volta o atraso de antes.
const VIVO_CADA_MS = 5000;
const VIVO_JANELA_MIN = 15;
let _vivo = { rodando: false, ultimo: '', falhas: 0 };
async function empurrarVivoVps() {
  if (_vivo.rodando) return;
  _vivo.rodando = true;
  try {
    const desde = new Date(Date.now() - VIVO_JANELA_MIN * 60000).toISOString();
    const local = (rota, q) => fetch(`http://127.0.0.1:${PORT}${rota}?${new URLSearchParams(q)}`,
                                     { signal: AbortSignal.timeout(10000) }).then(r => r.json());
    const [mv, bp, tc] = await Promise.all([
      local('/dashboard/movimentos', { alterados_desde: desde, limite: 1000 }),
      local('/dashboard/bobina-parciais', { desde }),
      local('/dashboard/turnos-corte', { desde }),
    ]);
    if (mv.filtro !== 'alterados_desde' || bp.filtro !== 'bobina_parciais' || tc.filtro !== 'turnos_corte') return;
    const corpo = { etiquetas: mv.linhas || [], parciais: bp.parciais || [], turnos: tc.turnos || [] };
    const assinatura = JSON.stringify(corpo);
    if (assinatura === _vivo.ultimo) return;
    const base = new URL(configGet('vps_sacoleiras_url', 'http://100.107.130.114:8765/api/sacoleiras/agora')).origin;
    const r = await fetch(base + '/api/coletor/vivo', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gerado_em: new Date().toISOString(), ...corpo }),
      signal: AbortSignal.timeout(15000) });
    const d = await r.json().catch(() => ({ ok: false, erro: 'HTTP ' + r.status }));
    if (!d.ok) throw new Error(d.erro || 'a VPS recusou');
    if (_vivo.falhas) logI('vivo', `envio ao vivo à VPS voltou depois de ${_vivo.falhas} falha(s)`);
    _vivo.ultimo = assinatura;
    _vivo.falhas = 0;
  } catch (e) {
    // 1 aviso na 1ª falha e depois a cada ~5 min, para não encher o log
    if (_vivo.falhas++ % 60 === 0) logW('vivo', 'envio ao vivo à VPS falhou (o lote por SFTP segue)', { erro: e.message });
  } finally {
    _vivo.rodando = false;
  }
}

function sugerirFormato(maq, bobina, clp) {
  const permitidos = PA_FORMATOS_POR_MAQUINA[maq] || [];
  const out = { permitidos, candidatos: permitidos, sugerido: null, motivo: '',
                comprimento_mm: null, largura_bobina_cm: larguraBobinaCm(bobina && bobina.largura),
                clp_tempo: clp ? clp.tempo : null, clp_velho: false };
  if (clp && clp.tempo) {
    // hora LOCAL do EKOSERVER, sem fuso; mais de 60 min = não confia
    const idadeMin = (Date.now() - new Date(clp.tempo + '-03:00').getTime()) / 60000;
    out.clp_velho = !(idadeMin < 60);
  }
  const usaClp = clp && !out.clp_velho;
  out.comprimento_mm = usaClp && clp.comprimento_mm ? Number(clp.comprimento_mm) : null;
  let cabem = permitidos;
  let porBobina = FORMATOS_POR_BOBINA;
  try { const c = JSON.parse(configGet('formatos_por_bobina', '{}')); if (c && Object.keys(c).length) porBobina = c; } catch(e) {}
  const daBobina = out.largura_bobina_cm ? porBobina[String(out.largura_bobina_cm)] : null;
  if (Array.isArray(daBobina) && daBobina.length) {
    cabem = permitidos.filter(f => daBobina.includes(f));
    out.trava_bobina = true;
  }
  out.candidatos = cabem;
  if (out.comprimento_mm) {
    const tol = Number(configGet('sac_comprimento_tolerancia_mm', '15')) || 15;
    const dist = cabem.map(f => [f, Math.abs(comprimentoFormato(f) - out.comprimento_mm)])
                      .filter(([, d]) => d <= tol).sort((a, b) => a[1] - b[1]);
    if (dist.length) out.candidatos = dist.map(([f]) => f);
    // 01/10/2026 (Gustavo): o sistema DECIDE o formato — a máquina, a bobina e
    // o comprimento acertam quase sempre, e o operador só troca no "Outro".
    // Empate de comprimento fica com o mais perto.
    if (dist.length) {
      out.sugerido = dist[0][0];
      out.pelo_comprimento = true;
      out.motivo = `comprimento ${out.comprimento_mm} mm` + (dist.length > 1 && dist[1][1] - dist[0][1] < 5
        ? ` (mais perto que ${dist.slice(1).map(d => d[0]).join(', ')})` : '');
    } else {
      out.motivo = `comprimento ${out.comprimento_mm} mm não bate com nenhum formato da ${maq}`;
    }
  } else {
    out.motivo = clp ? (out.clp_velho ? 'leitura da sacoleira atrasada' : 'sacoleira sem comprimento')
                     : 'sem leitura da sacoleira';
  }
  // Sem comprimento que decida: a bobina sozinha (largura que só roda um
  // formato nesta máquina) ou, por último, o que esta sacoleira cortou da
  // última vez com uma bobina que permite o mesmo formato.
  if (!out.sugerido && cabem.length === 1) {
    out.sugerido = cabem[0];
    out.motivo = `bobina ${bobina && bobina.largura} só roda ${cabem[0]} na ${maq}`;
  }
  if (!out.sugerido) {
    const ult = ultimoFormatoNa(maq, cabem);
    if (ult) { out.sugerido = ult; out.motivo = `último formato cortado na ${maq} (${out.motivo})`; }
  }
  return out;
}
function ultimoFormatoNa(maq, permitidos) {
  if (!permitidos || !permitidos.length) return null;
  try {
    const r = db.prepare(`SELECT formato FROM bobina_parciais WHERE maquina = ? AND formato IS NOT NULL
                           AND formato IN (${permitidos.map(() => '?').join(',')})
                          ORDER BY registrado_em DESC, id DESC LIMIT 1`).get(maq, ...permitidos);
    return r ? r.formato : null;
  } catch (e) { return null; }
}
function lerFormatoDaMaquina(maq, v) {
  const f = String(v || '').trim().toLowerCase().replace(/\s/g, '');
  return (PA_FORMATOS_POR_MAQUINA[maq] || []).includes(f) ? f : null;
}
const TURNOS_CORTE = { A: 'Turno A', C: 'Turno C', EXTRA: 'Extra' };
const SQL_PACOTES_PARTE = `COALESCE(pacotes, fardos * 5)`;

// Pacotes já informados de uma bobina montada: fins de turno (partes 'turno')
// e trocas de formato (partes 'setup', 02/10/2026). Só da montagem ATUAL
// (registradas depois da baixa): bobina de refugo reaproveitada começa do zero
// aqui, e as montagens anteriores entram por pacotesMontagensAnteriores.
function pacotesParciaisDe(etiquetaId) {
  const r = db.prepare(`SELECT COALESCE(SUM(${SQL_PACOTES_PARTE}), 0) AS n, COUNT(*) AS partes
                          FROM bobina_parciais
                         WHERE etiqueta_id = ? AND momento IN ('turno', 'setup')
                           AND registrado_em >= COALESCE((SELECT baixa_em FROM etiquetas WHERE id = ?), '')`)
    .get(etiquetaId, etiquetaId);
  return { pacotes: (r && r.n) || 0, partes: (r && r.partes) || 0 };
}
// Só o setup da montagem ATUAL (pedido depois da baixa): uma bobina de refugo
// reaproveitada não herda a troca de formato da passagem anterior.
function setupDaBobina(etiquetaId) {
  return db.prepare(`SELECT s.* FROM bobina_setups s JOIN etiquetas e ON e.id = s.etiqueta_id
                      WHERE s.etiqueta_id = ? AND s.pedido_em >= COALESCE(e.baixa_em, '')
                      ORDER BY s.id DESC LIMIT 1`).get(etiquetaId) || null;
}
// Peso do eixo/tubete por largura — o MESMO mapa TARAS da tela de extrusão
// (public/etiqueta-producao.html). A bobina volta no eixo; o refugo é líquido.
const TARAS_EIXO = { '80': 4, '1,20': 6, '1,60': 8, '1,68': 8, '1,75': 9 };
// Etiqueta do refugo: a da bobina (gerarEPLBobina) com o peso do refugo.
function imprimirEtiquetaRefugo(etiquetaId, refugo, cb) {
  const e = dbStmts.getEtiqueta.get(etiquetaId);
  if (!e) return cb(false, 'etiqueta não encontrada');
  const epl = gerarEPL({ tipo: 'extrusao', sub_tipo: e.sub_tipo, seq: e.seq, cor: e.cor, tipo_bobina: e.tipo_bobina,
                         largura: e.largura, operador: e.operador, maquina: e.maquina, peso: refugo.peso,
                         refugo: { peso_original: e.peso, pesado_em: refugo.pesado_em } });
  imprimir(epl, null, (ok, out, err, printer) => {
    if (ok) logI('print', `Etiqueta de REFUGO ${etiquetaId} (${Number(refugo.peso).toFixed(1)} kg) em "${printer}"`);
    else logE('print', `Falha na etiqueta de REFUGO ${etiquetaId}`, { erro: err || out });
    cb(ok, ok ? printer : (err || out || 'impressora'));
  });
}
function refugoAbertoDe(etiquetaId) {
  return db.prepare(`SELECT * FROM bobina_refugos WHERE etiqueta_id = ? AND reaproveitado_em IS NULL
                        AND cancelado_em IS NULL ORDER BY id DESC LIMIT 1`).get(etiquetaId) || null;
}
// Pacotes das montagens ANTERIORES (bobina de refugo reaproveitada): o que a
// etiqueta tinha quando a montagem atual começou.
// ── HISTÓRICO: soltos descontados de bobina de outra cor/formato ──────────
// (09/10/2026, Gustavo: "se der pra atualizar isso no histórico também").
// Até a regra herdaSoltos, toda parte descontava os soltos da anterior da
// mesma máquina (menos depois de 'setup'), mesmo com cor ou formato
// diferentes — e aí a parte saiu MENOR pelo que não aproveitou. Aqui cada
// parte assim recebe de volta esses soltos (e o total da bobina, se ela já
// saiu). `editado_em` faz o exportador reenviar a parte e a etiqueta à VPS.
// Roda uma vez (config soltos_cor_formato_v1). Devolve as correções feitas.
function corrigirSoltosHistorico() {
  if (configGet('soltos_cor_formato_v1', '') === 'feito') return [];
  const partes = db.prepare(`SELECT p.*, e.cor FROM bobina_parciais p LEFT JOIN etiquetas e ON e.id = p.etiqueta_id
                              ORDER BY p.maquina, p.id`).all();
  const feitas = [];
  for (let i = 1; i < partes.length; i++) {
    const ant = partes[i - 1], seg = partes[i];
    if (ant.maquina !== seg.maquina || !ant.soltos_fim || ant.momento === 'setup') continue;
    if (herdaSoltos(ant, seg)) continue;
    feitas.push({ id: seg.id, etiqueta_id: seg.etiqueta_id, maquina: seg.maquina, soltos: ant.soltos_fim,
                  de: `${ant.etiqueta_id} ${ant.cor || '?'} ${ant.formato || '?'}`, para: `${seg.cor || '?'} ${seg.formato || '?'}` });
  }
  const agora = new Date().toISOString();
  makeTransaction(() => {
    for (const f of feitas) {
      db.prepare(`UPDATE bobina_parciais SET pacotes = ${SQL_PACOTES_PARTE} + ?, editado_em = ?,
                         editado_por = 'sistema: soltos de outra cor/formato devolvidos (09/10/2026)',
                         fardos_antes = COALESCE(fardos_antes, fardos) WHERE id = ?`).run(f.soltos, agora, f.id);
      db.prepare(`UPDATE etiquetas SET pacotes = pacotes + ?, fardos = CAST(ROUND((pacotes + ?) / 5.0) AS INTEGER),
                         alterado_em = ? WHERE id = ? AND encerrada_em IS NOT NULL AND pacotes IS NOT NULL`)
        .run(f.soltos, f.soltos, agora, f.etiqueta_id);
    }
    configSet('soltos_cor_formato_v1', 'feito');
  })();
  for (const f of feitas)
    logI('bobinas', `Soltos não aproveitáveis devolvidos: ${f.etiqueta_id} (${f.maquina}, ${f.para}) +${f.soltos} pc`
      + ` — vinham de ${f.de}`);
  return feitas;
}

function pacotesMontagensAnteriores(etiquetaId) {
  const r = db.prepare(`SELECT pacotes_antes FROM bobina_refugos WHERE etiqueta_id = ? AND reaproveitado_em IS NOT NULL
                           AND cancelado_em IS NULL ORDER BY reaproveitado_em DESC LIMIT 1`).get(etiquetaId);
  return (r && Number(r.pacotes_antes)) || 0;
}
// Todas as montagens da bobina (07/10/2026): as anteriores vêm do estado_antes
// de cada refugo reaproveitado, com o refugo que a encerrou; a atual é a da
// etiqueta (com o refugo aberto, se ela está no estoque como refugo agora).
function montagensDaBobina(etiquetaId) {
  const e = dbStmts.getEtiqueta.get(etiquetaId);
  if (!e) return [];
  const rs = db.prepare(`SELECT * FROM bobina_refugos WHERE etiqueta_id = ? AND cancelado_em IS NULL ORDER BY id`).all(etiquetaId);
  const out = [];
  for (const r of rs) {
    if (!r.reaproveitado_em) continue;
    let ant = null; try { ant = JSON.parse(r.estado_antes || 'null'); } catch (err) {}
    if (ant) out.push({ ...ant, refugo: r });
  }
  const aberto = rs.filter(r => !r.reaproveitado_em).pop() || null;
  out.push({ destino: e.destino, baixa_em: e.baixa_em, baixa_operador: e.baixa_operador,
             encerrada_em: e.encerrada_em, encerrada_motivo: e.encerrada_motivo,
             refugo: (aberto && e.encerrada_em && aberto.pesado_em >= e.encerrada_em) ? aberto : null });
  return out;
}
// O formato da bobina montada AGORA: a regra de sempre (sugerirFormato) com a
// troca de formato por cima. Pode gravar (define o formato novo da troca).
function formatoDaBobina(maq, bobina, clp) {
  const out = sugerirFormato(maq, bobina, clp);
  const st = bobina ? setupDaBobina(bobina.id) : null;
  if (!st) return detectarSetupSemAviso(maq, bobina, out);
  out.setup = { formato_antes: st.formato_antes, comprimento_antes_mm: st.comprimento_antes_mm,
                pedido_em: st.pedido_em, formato_novo: st.formato_novo, definido_em: st.definido_em };
  if (!st.definido_em) {
    const visto = out.pelo_comprimento && out.sugerido && out.sugerido !== st.formato_antes
                  && !trocaSoPeloColetor(out.sugerido, st.formato_antes) ? out.sugerido : null;
    const tempo = out.clp_tempo || null;
    if (visto && st.candidato === visto && st.candidato_tempo && tempo && tempo !== st.candidato_tempo) {
      const agora = new Date().toISOString();
      db.prepare(`UPDATE bobina_setups SET formato_novo = ?, comprimento_novo_mm = ?, definido_em = ? WHERE id = ?`)
        .run(visto, out.comprimento_mm, agora, st.id);
      logI('bobinas', `Sacoleira ${maq}: troca de formato da ${bobina.id} definida — ${st.formato_antes || '?'} → ${visto}`
        + ` (comprimento ${out.comprimento_mm} mm)`);
      out.setup.formato_novo = visto; out.setup.definido_em = agora;
      out.motivo = `formato novo da troca (${out.motivo})`;
      return out;
    }
    if (visto !== st.candidato)
      db.prepare(`UPDATE bobina_setups SET candidato = ?, candidato_tempo = ? WHERE id = ?`)
        .run(visto, visto ? tempo : null, st.id);
    const antes = st.comprimento_antes_mm != null ? `${Math.round(st.comprimento_antes_mm)} mm` : (st.formato_antes || '?');
    return { ...out, sugerido: null, aguardando_setup: true,
             motivo: `troca de formato: aguardando a ${maq} mudar o comprimento (estava ${antes}`
               + (st.formato_antes ? ` · ${st.formato_antes}` : '') + ')' };
  }
  // Troca já definida: sem comprimento que decida agora, vale o formato da
  // troca — o "último cortado na máquina" seria o antigo (a parte 'setup').
  if (!out.pelo_comprimento && st.formato_novo) {
    out.sugerido = st.formato_novo;
    out.motivo = `formato definido na troca (${st.formato_novo})`;
  }
  return detectarSetupSemAviso(maq, bobina, manterPar(out, st.formato_novo));
}

// SETUP MUDOU SEM NINGUÉM AVISAR (06/10/2026, Gustavo: "quero um alerta na
// tela pra quando houver mudança de setup pro operador marcar quanto rendeu
// de cada formato"). Caso real: P2, E0001823 — o comprimento foi de 451 para
// 500 mm às 09:47 e a bobina foi encerrada às 09:52 como 40x50, mas tinha
// cortado tudo a 451 (30x45). Guarda o formato que a bobina montada está
// cortando (config formato_vigente_<máquina>); quando o CLP mostra outro
// formato em 2 leituras seguidas (carimbos diferentes, como na troca), marca
// `setup_detectado` e segue SUGERINDO O FORMATO ANTIGO — é o que rodou até
// ali, então um encerramento antes de a operadora informar grava o certo. A
// tela mostra o alerta com o botão da troca de formato; registrar a troca
// (/bobinas/trocar-formato) limpa o vigente.
function detectarSetupSemAviso(maq, bobina, out) {
  if (!bobina) return out;
  const k = 'formato_vigente_' + maq;
  let v = null; try { v = JSON.parse(configGet(k, 'null')); } catch (e) {}
  const daBobina = v && v.etq === bobina.id && v.montagem === (bobina.baixa_em || null);
  if (daBobina && v.escolhido) return formatoEscolhido(maq, bobina, manterPar(out, v.formato), v, k);
  if (!out.pelo_comprimento || !out.sugerido) return out;
  out = manterPar(out, daBobina ? v.formato : ultimoFormatoNa(maq, PA_FORMATOS_POR_MAQUINA[maq]));
  if (!daBobina) {
    configSet(k, JSON.stringify({ etq: bobina.id, montagem: bobina.baixa_em || null,
                                  formato: out.sugerido, mm: out.comprimento_mm }));
    return out;
  }
  if (!v.detectado) {
    if (out.sugerido === v.formato) {
      if (v.candidato || v.mm !== out.comprimento_mm) {
        delete v.candidato; delete v.candidato_tempo; v.mm = out.comprimento_mm;
        configSet(k, JSON.stringify(v));
      }
      return out;
    }
    const tempo = out.clp_tempo || null;
    if (v.candidato === out.sugerido && v.candidato_tempo && tempo && tempo !== v.candidato_tempo
        && ajusteLogoAposBipe(v, tempo)) {
      // Bobina que entrou depois do ✓ Bobina finalizou e a máquina foi
      // ajustada logo em seguida: ela ainda não produziu no formato antigo,
      // então não há o que perguntar — vale o formato da máquina.
      logI('bobinas', `Sacoleira ${maq}: ${bobina.id} entrou como ${v.formato}; máquina ajustada logo depois do bipe`
        + ` para ${out.sugerido} (${v.mm || '?'} → ${out.comprimento_mm} mm) — vale o da máquina`);
      configSet(k, JSON.stringify({ etq: v.etq, montagem: v.montagem, formato: out.sugerido, mm: out.comprimento_mm,
                                    proxima: v.proxima, ajustado: true }));
      return { ...out, motivo: `ajustado logo depois do bipe (${out.motivo})` };
    }
    if (v.candidato === out.sugerido && v.candidato_tempo && tempo && tempo !== v.candidato_tempo) {
      v.detectado = { de: v.formato, para: out.sugerido, mm_antes: v.mm, mm_agora: out.comprimento_mm,
                      em: new Date().toISOString() };
      logW('bobinas', `Sacoleira ${maq}: SETUP MUDOU sem registro na ${bobina.id} — ${v.formato} → ${out.sugerido}`
        + ` (${v.mm || '?'} → ${out.comprimento_mm} mm) · alerta na tela`);
    } else if (v.candidato !== out.sugerido) {
      v.candidato = out.sugerido; v.candidato_tempo = tempo;
    }
    configSet(k, JSON.stringify(v));
    if (!v.detectado) return { ...out, sugerido: v.formato, motivo: `conferindo o comprimento (${out.motivo})` };
  }
  return { ...out, sugerido: v.formato, setup_detectado: v.detectado,
           motivo: `setup mudou: ${v.detectado.de} → ${v.detectado.para} — informe quanto rendeu o ${v.detectado.de}` };
}

// ── FORMATO ESCOLHIDO PELO OPERADOR (20/10/2026, Gustavo) ───────────────
// O formato da PRÓXIMA bobina é escolhido no ✓ Bobina finalizou, e o formato
// novo da troca na mesma bobina, na hora da troca. Muitas vezes o operador
// escolhe ANTES de ajustar o parâmetro da máquina, e o CLP ainda mostra o
// comprimento antigo. Regra: se o CLP não bate com a escolha, a escolha vale
// até a máquina MUDAR de comprimento (mm0 = o comprimento na hora da escolha);
// quando mudar (2 leituras, como no resto), vale o que a máquina mostra.
// Se bate, segue o vigente normal (detectarSetupSemAviso).
// Grava o formato_vigente_<máquina> da bobina `etq` montada em `montagem`.
// `sug`: sugerirFormato da máquina agora. `extra`: campos a guardar junto.
function assumirFormatoEscolhido(maq, etq, montagem, formato, sug, extra) {
  const bate = sug && sug.pelo_comprimento && sug.sugerido === formato;
  const v = { etq, montagem: montagem || null, formato, mm: sug ? sug.comprimento_mm : null, ...(extra || {}) };
  if (!bate) v.escolhido = { mm0: sug ? sug.comprimento_mm : null, em: new Date().toISOString() };
  configSet('formato_vigente_' + maq, JSON.stringify(v));
  return v;
}
function formatoEscolhido(maq, bobina, out, v, k) {
  const mm = out.comprimento_mm, mm0 = v.escolhido.mm0;
  const vale = { ...out, sugerido: v.formato, escolhido: true,
                 motivo: `escolhido pelo operador (${v.formato}) · aguardando a ${maq} mudar o comprimento` };
  // Sem leitura que decida, ou a máquina ainda no comprimento de quando escolheram.
  if (!out.pelo_comprimento || !out.sugerido || (mm0 != null && mm === mm0)) {
    if (v.candidato) { delete v.candidato; delete v.candidato_tempo; configSet(k, JSON.stringify(v)); }
    return vale;
  }
  if (out.sugerido === v.formato) {   // a máquina chegou no formato escolhido
    delete v.escolhido; delete v.candidato; delete v.candidato_tempo; v.mm = mm; v.ajustado = true;
    configSet(k, JSON.stringify(v));
    return out;
  }
  const tempo = out.clp_tempo || null;
  if (v.candidato === out.sugerido && v.candidato_tempo && tempo && tempo !== v.candidato_tempo) {
    logW('bobinas', `Sacoleira ${maq}: ${bobina.id} escolhida ${v.formato}, mas a máquina foi para ${out.sugerido}`
      + ` (${mm0 != null ? mm0 : '?'} → ${mm} mm) — vale o da máquina`);
    const nv = { etq: v.etq, montagem: v.montagem, formato: out.sugerido, mm, ajustado: true,
                 ...(v.proxima ? { proxima: v.proxima } : {}) };
    configSet(k, JSON.stringify(nv));
    return { ...out, motivo: `a máquina foi para ${out.sugerido}, não ${v.formato} (${out.motivo})` };
  }
  if (v.candidato !== out.sugerido) {
    v.candidato = out.sugerido; v.candidato_tempo = tempo;
    configSet(k, JSON.stringify(v));
  }
  return vale;
}
// Bobina montada depois de um ✓ Bobina finalizou (v.proxima) cuja leitura do
// CLP é de até AJUSTE_POS_BIPE_MIN depois do bipe: mudança de comprimento aí é
// o ajuste da máquina para a bobina nova, não troca de formato no meio dela.
// Vale UMA vez (v.ajustado): a mudança seguinte já é troca de formato.
const AJUSTE_POS_BIPE_MIN = 20;
function ajusteLogoAposBipe(v, tempo) {
  if (!v.proxima || v.ajustado || !v.montagem || !tempo) return false;
  const lim = Number(configGet('sac_ajuste_pos_bipe_min', String(AJUSTE_POS_BIPE_MIN))) || AJUSTE_POS_BIPE_MIN;
  const dt = (new Date(tempo + '-03:00').getTime() - new Date(v.montagem).getTime()) / 60000;
  return dt <= lim;
}

// ── PRÓXIMA BOBINA (20/10/2026, Gustavo) ────────────────────────────────
// O ✓ Bobina finalizou grava o formato da próxima (config proxima_bobina_<máq>
// = { formato, de, em }). Enquanto ela existe e a máquina está vazia, a tela
// mostra "BIPE A PRÓXIMA BOBINA"; a baixa de qualquer bobina na máquina a
// consome (montarProximaBobina) e o formato escolhido vira o da bobina nova.
function proximaBobinaNa(maq) {
  try { return JSON.parse(configGet('proxima_bobina_' + maq, 'null')); } catch (e) { return null; }
}
function marcarProximaBobina(maq, formato, deId, quando) {
  configSet('proxima_bobina_' + maq, JSON.stringify({ formato, de: deId, em: quando }));
}
// Na baixa: consome o pedido da próxima e assume o formato escolhido.
// Guarda o pedido no vigente para o desfazer devolvê-lo.
function montarProximaBobina(maq, bobina, sug) {
  const px = proximaBobinaNa(maq);
  if (!px) return null;
  configSet('proxima_bobina_' + maq, 'null');
  if (px.formato) assumirFormatoEscolhido(maq, bobina.id, bobina.baixa_em, px.formato, sug, { proxima: px });
  return px;
}
// Desfazer a bobina recém-montada: a máquina volta a pedir o bipe.
function devolverProximaBobina(maq, bid) {
  let v = null; try { v = JSON.parse(configGet('formato_vigente_' + maq, 'null')); } catch (e) {}
  if (!v || v.etq !== bid || !v.proxima) return false;
  configSet('proxima_bobina_' + maq, JSON.stringify(v.proxima));
  configSet('formato_vigente_' + maq, 'null');
  return true;
}
// A máquina voltou a cortar com o pedido de bipe aberto: leitura do CLP de
// DEPOIS do finalizou (+2 min), não atrasada, operando e com sacos/min > 0.
function cortandoSemBobina(px, leitura) {
  if (!px || !leitura || !leitura.tempo || !leitura.operando) return false;
  if (leitura.sacos_min != null && !(Number(leitura.sacos_min) > 0)) return false;
  const t = new Date(leitura.tempo + '-03:00').getTime();
  return t > new Date(px.em).getTime() + 2 * 60000 && Date.now() - t < 60 * 60000;
}

// Grava uma parte, amarrada ao turno do corte aberto AGORA na máquina.
// Chamar ANTES de fechar o turno, senão a parte cai "fora de turno".
function registrarParcial(etiquetaId, maq, parte, momento, quando, operador, formato, formatoOrigem) {
  const t = turnoCorteAberto(maq);
  db.prepare(`INSERT INTO bobina_parciais (etiqueta_id, maquina, turno_corte_id, turno, fardos, pacotes, soltos_fim,
                                           formato, formato_origem, momento, registrado_em, operador)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(etiquetaId, maq, t ? t.id : null, t ? t.turno : null, parte.fechados, parte.pacotes, parte.soltos,
         formato || null, formato ? (formatoOrigem || null) : null, momento, quando, operador || null);
}

function turnoCorteAberto(maq) {
  return db.prepare(`SELECT * FROM turnos_corte WHERE maquina = ? AND fim IS NULL ORDER BY id DESC LIMIT 1`).get(maq) || null;
}

// Lista de sacoleiras do corpo do pedido; vazia ou inválida → null.
function lerMaquinasCorte(v) {
  const l = Array.isArray(v) ? v : [v];
  const maqs = [...new Set(l.map(x => normalizarDestinoBobina(x)).filter(Boolean))].sort();
  return maqs.length ? maqs : null;
}

function inventarioAberto() {
  return db.prepare(`SELECT * FROM inventario_bobinas WHERE fim IS NULL ORDER BY id DESC LIMIT 1`).get() || null;
}

// Situação que o sistema dá para a bobina: é o que o inventário confronta.
function situacaoBobina(e) {
  if (e.status === 'cancelada') return 'cancelada';
  if (e.status === 'consumida' && e.destino && !e.encerrada_em) return 'na_sacoleira';
  if (e.status === 'consumida' && e.id && refugoAbertoDe(e.id)) return 'refugo';   // voltou ao estoque
  if (e.status === 'consumida') return 'usada';
  return 'estoque';
}

function itensInventario(invId) {
  return db.prepare(
    `SELECT i.etiqueta_id AS id, i.lido_em, i.situacao, i.operador,
            e.cor, e.tipo_bobina, e.largura, e.peso, e.maquina, e.hora_impressao, e.destino
       FROM inventario_bobinas_itens i LEFT JOIN etiquetas e ON e.id = i.etiqueta_id
      WHERE i.inventario_id = ? ORDER BY i.lido_em DESC`).all(invId);
}

function resumoInventario(inv) {
  const itens = itensInventario(inv.id);
  const kg = itens.reduce((a, x) => a + (Number(x.peso) || 0), 0);
  const porSit = {};
  for (const x of itens) porSit[x.situacao] = (porSit[x.situacao] || 0) + 1;
  return { inventario: inv, itens, qtd: itens.length, kg: +kg.toFixed(1), por_situacao: porSit };
}

module.exports = { assumirFormatoEscolhido, baixaBobinaNoBling, bobinaAbertaNa, clpSacoleiras, corPaDaBobina,
  corrigirSoltosHistorico, cortandoSemBobina, devolverProximaBobina, empurrarVivoVps, encerrarBobina,
  formatoDaBobina, herdaSoltos,
  imprimirEtiquetaRefugo, inventarioAberto, lerFardos, lerFormatoDaMaquina, lerMaquinasCorte,
  lerParte, lerSoltos, marcarProximaBobina, montagensDaBobina, montarProximaBobina, normalizarDestinoBobina,
  PACOTES_POR_FARDO, pacotesParciaisDe, PESO_FARDO_KG, proximaBobinaNa, refugoAbertoDe, registrarParcial, resumoInventario,
  setupDaBobina, situacaoBobina, soltosNaMaquina, SQL_PACOTES_PARTE, sugerirFormato, TARAS_EIXO,
  turnoCorteAberto, TURNOS_CORTE, turnosBaixaBobina, txtPacotes, VIVO_CADA_MS, };
