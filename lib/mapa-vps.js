// ════════════════════════════════════════════════════════════════════
//  MAPA DO GALPÃO → VPS  (06/11/2026, Gustavo: aba "Mapa" no painel)
// ------------------------------------------------------------------
//  O endereçamento continua aqui (Mini PC/celular, leitor de QR, funciona
//  sem internet); o painel da VPS só MOSTRA. Como o Tailscale é direcional
//  (a VPS não abre porta do Mini PC), quem empurra é a fábrica — mesmo
//  caminho do envio ao vivo das bipagens (lib/bobinas.js).
//
//  · A cada MAPA_CADA_MS e logo depois de cada mudança (avisarMudanca), manda
//    o retrato inteiro (mapaGalpao: ~228 posições, poucos KB).
//  · Só manda quando o retrato MUDOU (assinatura sem o "dias", que muda
//    sozinho à meia-noite) — e de hora em hora mesmo sem mudança, para a VPS
//    saber que o Mini PC está vivo ("atualizado há X min").
//  · Só liga com o endereço da VPS CONFIGURADO de propósito
//    (vps_sacoleiras_url gravado no config): teste que sobe o servidor num
//    banco de mentira nunca manda retrato falso para a VPS de verdade.
//  · Falhou: tenta de novo no próximo ciclo; o retrato é sempre o inteiro,
//    então nada se perde.
// ════════════════════════════════════════════════════════════════════
// COMMIT_NO_AR: lida UMA vez, ao subir (lib/log), a mesma do /healthcheck.
const { COMMIT_NO_AR, logI, logW } = require('./log');
const { configGet } = require('./db');
const { mapaGalpao } = require('./enderecamento');

const MAPA_CADA_MS = Number(process.env.EKO_MAPA_VPS_MS) || 60000;
const MAPA_REENVIO_MS = 60 * 60 * 1000;
let _mapa = { rodando: false, assinatura: '', enviadoEm: 0, falhas: 0, pendente: null,
              ultimo: null, erro: null, avisouSemEndereco: false };

function assinaturaDe(retrato) {
  return JSON.stringify(retrato.posicoes.map(p => [p.codigo, p.bloqueada,
    p.gaiola ? [p.gaiola.id, p.gaiola.item, p.gaiola.entrada, p.gaiola.formato, p.gaiola.cor,
                p.gaiola.fardos, p.gaiola.kg, p.gaiola.material_key, p.gaiola.fornecedor, p.gaiola.lote] : null]));
}

function urlVps() {
  const base = configGet('vps_sacoleiras_url', null);
  if (!base) return null;
  try { return new URL(base).origin + '/api/coletor/mapa'; } catch (e) { return null; }
}

async function empurrarMapaVps() {
  if (_mapa.rodando) return { pulou: 'rodando' };
  const url = urlVps();
  if (!url) {
    // 19/11/2026: o Mini PC ficou 13 dias assim, calado, e a aba Mapa da VPS
    // só dizia "dashboard ainda não gerado". Agora avisa UMA vez no log e
    // aparece no /healthcheck (mapa_vps.ultimo = 'sem_endereco').
    _mapa.ultimo = 'sem_endereco';
    if (!_mapa.avisouSemEndereco) {
      _mapa.avisouSemEndereco = true;
      const gravado = configGet('vps_sacoleiras_url', null);
      logW('mapa', 'mapa do galpão NÃO vai à VPS: vps_sacoleiras_url ' +
                   (gravado ? 'gravado mas inválido' : 'não gravado') + ' no config ' +
                   '(POST /config {"vps_sacoleiras_url": "http://100.107.130.114:8765/api/sacoleiras/agora"})');
    }
    return { pulou: 'sem_endereco' };
  }
  _mapa.avisouSemEndereco = false;
  _mapa.rodando = true;
  try {
    const retrato = mapaGalpao();
    const assinatura = assinaturaDe(retrato);
    const velho = Date.now() - _mapa.enviadoEm > MAPA_REENVIO_MS;
    if (assinatura === _mapa.assinatura && !velho) return { pulou: 'igual' };
    const r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      // commit: a versão que roda aqui (23/11/2026). O vigia da VPS compara com
      // o GitHub — o Mini PC ficou 4 dias atrás (19→23/11) sem ninguém ver.
      body: JSON.stringify({ gerado_em: new Date().toISOString(), commit: COMMIT_NO_AR, ...retrato }),
      signal: AbortSignal.timeout(15000) });
    const d = await r.json().catch(() => ({ ok: false, erro: 'HTTP ' + r.status }));
    if (!d.ok) throw new Error(d.erro || 'a VPS recusou');
    if (_mapa.falhas) logI('mapa', `envio do mapa à VPS voltou depois de ${_mapa.falhas} falha(s)`);
    _mapa.assinatura = assinatura; _mapa.enviadoEm = Date.now(); _mapa.falhas = 0;
    _mapa.ultimo = 'enviado'; _mapa.erro = null;
    return { enviado: true };
  } catch (e) {
    _mapa.ultimo = 'erro'; _mapa.erro = String(e.message || e).slice(0, 200);
    if (_mapa.falhas++ % 30 === 0) logW('mapa', 'envio do mapa à VPS falhou (tenta de novo)', { erro: e.message });
    return { erro: e.message };
  } finally {
    _mapa.rodando = false;
  }
}

// Depois de ocupar/liberar/retirar: manda em ~2 s (junta leituras em rajada).
function avisarMudanca() {
  if (_mapa.pendente) return;
  _mapa.pendente = setTimeout(() => { _mapa.pendente = null; empurrarMapaVps().catch(() => {}); }, 2000);
}

// Para o /healthcheck: dá para ver de fora se o mapa está indo à VPS.
// ultimo: null (ainda não tentou) | 'enviado' | 'sem_endereco' | 'erro'.
// 'igual' (retrato sem mudança) não troca o último resultado.
function estadoMapaVps() {
  return {
    endereco_configurado: !!urlVps(),
    ultimo: _mapa.ultimo,
    enviado_em: _mapa.enviadoEm ? new Date(_mapa.enviadoEm).toISOString() : null,
    falhas_seguidas: _mapa.falhas,
    erro: _mapa.erro,
  };
}

module.exports = { assinaturaDe, avisarMudanca, empurrarMapaVps, estadoMapaVps, MAPA_CADA_MS };
