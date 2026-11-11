// ════════════════════════════════════════════════════════════════════
//  VARREDURA NO PESO DO RECEBIMENTO — Ekoplastic (11/11/2026)
//  Gustavo: "passe os campos onde fica o peso, o conectar balança e o
//  simular peso para a esquerda, um abaixo do outro; o zerar balança sai;
//  um botão com altura do peso até o simular escrito VARREDURA, que será
//  adicionado essa nota à pesagem pra saber que se trata de varredura".
//
//   A) Etiqueta de recebimento com sub_tipo 'varredura' grava a nota no
//      banco e sai com "VARREDURA" impresso; sem a nota, não sai.
//   B) O corpo não escolhe outro sub_tipo para o recebimento ('capa' é ignorado).
//   C) Observação do Bling: linha VARREDURA com kg e etiquetas; o total e o
//      material continuam somando a varredura (é nota, não outro produto).
//   D) Tela (estático): peso/conectar/simular na coluna da esquerda, botão
//      VARREDURA ao lado, sem "Zerar Balança"; a nota vai no POST e o botão
//      apaga depois de imprimir.
//
//  Como rodar:   node testes/varredura-no-peso.js
// ════════════════════════════════════════════════════════════════════

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');

const ROOT     = path.join(__dirname, '..');
const SERVER   = path.join(ROOT, 'server.js');
const PORT     = 13975;
const PORT_CB  = 18975;
const BASE     = `http://localhost:${PORT}`;
const CARIMBO  = Date.now();
const TMP_DB   = path.join(os.tmpdir(), `eko_varrpeso_${CARIMBO}.db`);
const TMP_LOGS = path.join(os.tmpdir(), `eko_varrpeso_logs_${CARIMBO}`);
const DIR_EPL  = path.join(TMP_LOGS, 'print-simulado');

let servidor;
let passou = 0, falhou = 0;
const falhas = [];
function ok(cond, nome, detalhe = '') {
  if (cond) { passou++; console.log(`  \x1b[32m✓\x1b[0m ${nome}`); }
  else      { falhou++; falhas.push(nome); console.log(`  \x1b[31m✗ ${nome}\x1b[0m ${detalhe}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function req(metodo, caminho, corpo) {
  const r = await fetch(BASE + caminho, {
    method: metodo,
    headers: corpo ? { 'Content-Type': 'application/json' } : {},
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  let json = null; try { json = await r.json(); } catch (e) {}
  return { status: r.status, json };
}

async function subirServidor() {
  servidor = spawn('node', [SERVER], {
    env: { ...process.env, EKO_PORT: String(PORT), EKO_PORT_CB: String(PORT_CB),
           EKO_DB_FILE: TMP_DB, EKO_LOG_DIR: TMP_LOGS, TZ: 'America/Sao_Paulo',
           EKO_PRINT_SIMULAR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  servidor.stdout.on('data', () => {});
  servidor.stderr.on('data', d => { if (process.env.VERBOSE) process.stderr.write(d); });
  for (let i = 0; i < 75; i++) {
    try { const r = await fetch(BASE + '/healthcheck'); if (r.ok) return; } catch (e) {}
    await sleep(200);
  }
  throw new Error('Servidor não subiu em 15s');
}
function encerrar() {
  try { servidor && servidor.kill('SIGKILL'); } catch (e) {}
  for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.rmSync(f, { force: true }); } catch (e) {} }
  try { fs.rmSync(TMP_LOGS, { recursive: true, force: true }); } catch (e) {}
}
// Papel impresso (EPL) de uma etiqueta: o arquivo mais novo que cita o peso.
function eplDe(pesoStr) {
  if (!fs.existsSync(DIR_EPL)) return null;
  const t = fs.readdirSync(DIR_EPL).sort().map(f => fs.readFileSync(path.join(DIR_EPL, f), 'latin1'))
    .filter(x => x.includes(pesoStr));
  return t.length ? t[t.length - 1] : null;
}

async function etiqueta(sid, peso, extra = {}) {
  const r = await req('POST', '/print/etiqueta', {
    clientToken: `vp-${peso}-${CARIMBO}`, tipo: 'recebimento',
    materialKey: 'GBD', materialNomeEt: 'BAIXA DENSIDADE', cor: 'Canela',
    fornecedor: 'Piquiri', peso, lote: '7788', codigo: 'CAN1',
    sku: `GBD.CAN.PIQUIR | ${peso} | L7788`, sessao_id: sid, ...extra,
  });
  return r.json;
}

async function testeServidor() {
  console.log('\n[A-C] servidor');
  const s = await req('POST', '/sessoes', { tipo: 'recebimento', operador: 'Recebedor', fornecedor: 'Piquiri' });
  const sid = s.json.sessao_id;
  const normal = await etiqueta(sid, 1012.5);
  const varr   = await etiqueta(sid, 18.5, { sub_tipo: 'varredura' });
  const capa   = await etiqueta(sid, 7.5, { sub_tipo: 'capa' });
  ok(normal && normal.ok && varr && varr.ok && capa && capa.ok, 'três etiquetas impressas', JSON.stringify([normal, varr, capa]));

  const lista = (await req('GET', `/sessoes/abertas?tipo=recebimento`)).json.sessoes.find(x => x.id === sid);
  const porId = Object.fromEntries((lista.etiquetas || []).map(e => [e.id, e]));
  ok(porId[varr.id] && porId[varr.id].sub_tipo === 'varredura', 'A) a nota de varredura fica gravada na etiqueta');
  ok(porId[normal.id] && !porId[normal.id].sub_tipo, 'A) pesagem comum fica sem nota');
  ok(porId[capa.id] && !porId[capa.id].sub_tipo, 'B) recebimento não aceita outro sub_tipo vindo da tela ("capa" ignorado)');

  const eV = eplDe('18.5 KG'), eN = eplDe('1012.5 KG'), eC = eplDe('7.5 KG');
  ok(eV && /"VARREDURA"/.test(eV), 'A) etiqueta impressa da varredura traz VARREDURA');
  ok(eN && !/VARREDURA/.test(eN), 'A) etiqueta comum sem VARREDURA');
  ok(eC && !/VARREDURA/.test(eC), 'B) etiqueta com sub_tipo recusado sai comum');

  // Correção de etiqueta (troca a cor): o papel reimpresso continua VARREDURA.
  const antes = fs.existsSync(DIR_EPL) ? fs.readdirSync(DIR_EPL).length : 0;
  const corr = await req('POST', `/etiquetas/${varr.id}/corrigir`, {
    materialKey: 'GBD', materialNomeEt: 'BAIXA DENSIDADE', cor: 'Preto', fornecedor: 'Piquiri',
    codigo: 'PT1', sku: 'GBD.PRE.PIQUIR | 18.5 | L7788' });
  const novos = fs.existsSync(DIR_EPL) ? fs.readdirSync(DIR_EPL).sort().slice(antes) : [];
  const eCorr = novos.length ? fs.readFileSync(path.join(DIR_EPL, novos[novos.length - 1]), 'latin1') : '';
  ok(corr.json && corr.json.ok && /PRETO/.test(eCorr) && /"VARREDURA"/.test(eCorr), 'A) etiqueta corrigida sai de novo com VARREDURA', JSON.stringify(corr.json));

  for (const id of [normal.id, varr.id, capa.id]) await req('POST', `/etiquetas/${id}/bipar`);
  const f = await req('POST', `/sessoes/${sid}/finalizar`);
  const obs = f.json && f.json.bling && f.json.bling.payload ? f.json.bling.payload.observacoes
            : (f.json && f.json.payload ? f.json.payload.observacoes : null);
  ok(typeof obs === 'string', 'C) finalizar devolve a observação do Bling (simulação)', JSON.stringify(f.json).slice(0, 300));
  if (typeof obs === 'string') {
    ok(new RegExp(`VARRIDO NO RECEBIMENTO: 18,5 KG \\(${varr.id}\\)`).test(obs), 'C) linha da varredura com kg e etiqueta', obs);
    // Mesma regra do snapshot_producao.py da VPS (_RX_RESIDUO): se casar, a
    // COMPRA INTEIRA vira resíduo lá e o fornecedor some das entradas.
    ok(!/RES\.|RESIDUO|RESÍDUO|VARREDURA|BORRA/i.test(obs), 'C) observação sem palavra que a VPS lê como resíduo', obs);
    ok(/TOTAL: 1038,5 KG/.test(obs), 'C) total continua somando a varredura (é nota, não outro produto)', obs);
    ok((obs.match(/VARRIDO/g) || []).length === 1 && !obs.includes(normal.id), 'C) só a etiqueta marcada entra na linha de varredura', obs);
  }
}

function testeTela() {
  console.log('\n[D] tela do recebimento (estático)');
  const h = fs.readFileSync(path.join(ROOT, 'public', 'mp-recebimento-retorno.html'), 'utf8');
  const bloco = h.slice(h.indexOf('id="bloco-peso"'), h.indexOf('id="bloco-qtd"'));
  ok(!/onclick="balancaZerar\(\)"/.test(h) && !/id="bal-cmd-row"/.test(h) && !/getElementById\('bal-cmd-row'\)/.test(h),
     'o botão "Zerar Balança" saiu da tela');
  const col = bloco.slice(bloco.indexOf('class="peso-col"'), bloco.indexOf('id="btn-varredura"'));
  ok(/id="peso-bruto"/.test(col) && /conectarBalanca\(\)/.test(col) && /simularPeso\(\)/.test(col)
     && col.indexOf('peso-bruto') < col.indexOf('conectarBalanca') && col.indexOf('conectarBalanca') < col.indexOf('simularPeso'),
     'peso, Conectar e Simular na coluna da esquerda, nessa ordem');
  ok(/class="peso-grade"/.test(bloco) && /\.peso-grade \{ display: grid; grid-template-columns: 1fr 34%;[^}]*align-items: stretch/.test(h),
     'botão VARREDURA ao lado, esticado na altura da coluna');
  ok(/id="btn-varredura"[^>]*onclick="alternarVarredura\(\)"/.test(bloco) && />VARREDURA</.test(bloco), 'botão escrito VARREDURA');
  ok(/subTipo: \(!comp && estado\.varredura\) \? 'varredura' : null/.test(h), 'botão aceso marca a pesagem (não a contagem por sacos)');
  for (const fn of ['selMat', 'resetarRecebimento', 'trocarModo']) {
    const corpo = h.slice(h.indexOf(`function ${fn}(`), h.indexOf(`function ${fn}(`) + 300);
    ok(/marcarVarredura\(false\)/.test(corpo), `${fn}: o botão apaga (a nota não passa adiante)`);
  }
  ok(/sub_tipo: item\.subTipo === 'varredura' \? 'varredura' : undefined/.test(h), 'a nota vai ao servidor junto da etiqueta');
  ok(/if \(item\.subTipo === 'varredura'\) marcarVarredura\(false\);/.test(h), 'depois de imprimir, o botão apaga (um toque = uma pesagem)');
  ok(/tag-varr/.test(h) && /it\.subTipo === 'varredura' \? '<span class="tag-varr">VARREDURA<\/span>'/.test(h), 'lista da sessão mostra VARREDURA no item');
}

(async () => {
  try {
    await subirServidor();
    const h = await req('GET', '/healthcheck');
    if (!h.json || h.json.impressao_simulada_forcada !== true) throw new Error('ABORTADO: impressão não está travada em simulação');
    await testeServidor();
    testeTela();
    console.log('\n═══════════════════════════════════════════════════');
    console.log(` RESULTADO: ${passou} passaram, ${falhou} falharam`);
    if (falhou) { console.log(' FALHAS:'); falhas.forEach(f => console.log('   - ' + f)); }
    console.log('═══════════════════════════════════════════════════');
  } catch (e) {
    console.error('\nERRO FATAL:', e.message);
    falhou++;
  } finally {
    encerrar();
    setTimeout(() => process.exit(falhou ? 1 : 0), 200);
  }
})();
