// ════════════════════════════════════════════════════════════════════
//  OPERADORES DA EXTRUSÃO — a lista da tela de pesagem de bobinas
//  ------------------------------------------------------------------
//  Até 13/11/2026 a lista morava só no localStorage do navegador da tela.
//  Na queda de energia de 13/11 a tela passou a abrir no perfil próprio
//  (navegador-eko, criado vazio às 19:12) e a extrusão ficou sem nomes.
//  Gustavo, 13/11: "pode, coloca a lista no servidor".
//
//  Fica no config `operadores_extrusao` (JSON ["NOME", ...]). Sem o config
//  (banco que nunca mexeu na lista) vale a lista do código: quem pesou na
//  extrusão desde ago/2026 (sessões) + WILLIAN, que estava na lista antiga do
//  navegador e pesou 3 turnos em set/2026. Lista gravada vazia continua vazia.
// ════════════════════════════════════════════════════════════════════

const { configGet, configSet } = require('./db');

const OPERADORES_EXTRUSAO_PADRAO = ['DAVI', 'MARLITO', 'WALLISON', 'ALEXANDRO', 'WILLIAN'];
const CHAVE = 'operadores_extrusao';
const MAX_OPERADORES = 40;

const semAcento = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

// Nome do jeito que fica gravado: MAIÚSCULO, espaços únicos, até 40.
// Só letras, números, espaço, ponto e hífen (o nome vai para HTML e onclick
// na tela). Menos de 2 letras ou não-texto → null.
function normalizarOperador(v) {
  if (typeof v !== 'string') return null;
  const n = v.replace(/\s+/g, ' ').trim().toUpperCase().slice(0, 40).trim();
  if (n.length < 2) return null;
  if (!/^[\p{L}0-9 .-]+$/u.test(n)) return null;
  if ((n.match(/\p{L}/gu) || []).length < 2) return null;
  return n;
}

function operadoresExtrusao() {
  const bruto = configGet(CHAVE, null);
  if (bruto == null) return OPERADORES_EXTRUSAO_PADRAO.slice();
  try {
    const c = JSON.parse(bruto);
    if (Array.isArray(c)) return c.map(normalizarOperador).filter(Boolean);
  } catch (e) {}
  return OPERADORES_EXTRUSAO_PADRAO.slice();
}

function gravar(lista) { configSet(CHAVE, JSON.stringify(lista)); }

// → { ok, operadores, nome?, erro?, status? }. Síncrono: o node não intercala
// duas requisições no meio do ler-mudar-gravar.
function adicionarOperadorExtrusao(v) {
  const nome = normalizarOperador(v);
  if (!nome) return { ok: false, status: 400, erro: 'Nome inválido: use só letras (mínimo 2), números, espaço, ponto ou hífen.' };
  const lista = operadoresExtrusao();
  const igual = lista.find(x => semAcento(x) === semAcento(nome));
  if (igual) return { ok: true, operadores: lista, nome: igual, ja_existia: true };
  if (lista.length >= MAX_OPERADORES) return { ok: false, status: 400, erro: `Lista cheia (${MAX_OPERADORES} nomes).` };
  lista.push(nome);
  gravar(lista);
  return { ok: true, operadores: lista, nome };
}

function removerOperadorExtrusao(v) {
  const nome = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().toUpperCase() : '';
  const lista = operadoresExtrusao();
  const nova = lista.filter(x => semAcento(x) !== semAcento(nome));
  if (nova.length === lista.length) return { ok: false, status: 404, erro: `"${nome}" não está na lista.`, operadores: lista };
  gravar(nova);
  return { ok: true, operadores: nova };
}

module.exports = {
  adicionarOperadorExtrusao, normalizarOperador, operadoresExtrusao, OPERADORES_EXTRUSAO_PADRAO,
  removerOperadorExtrusao,
};
