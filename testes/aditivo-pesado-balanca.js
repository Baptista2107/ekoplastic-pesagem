// ════════════════════════════════════════════════════════════════════
//  ADITIVO PESADO NA BALANÇA — Ekoplastic (16/11/2026)
//  Gustavo: "a bosta do bag tem um peso que eu não consigo lançar… eu
//  preciso pesar lá no mini pc no sistema de balança pra saber o peso real".
//  Dessecante da Karina veio em bag de 3.023 kg; a tela só deixava contar
//  sacos de 25 kg (sessão #33288 saiu com 3.025 kg).
//
//   A) Aditivo pesado (sem qtd_sacos): o kg decimal chega inteiro na
//      quantidade do Bling e a descrição não fala em sacos; o aditivo
//      contado continua com "N sacos × 25kg".
//   B) Etiqueta e resumo impressos mostram o kg pesado, sem "SACO".
//   D) Corrigir etiqueta: a contagem de sacos só fica se ainda fizer
//      sentido no material novo (por sacos e N × kg do saco = peso);
//      senão vira vazia — sem "40 sacos" num grão corrigido.
//   C) Tela (estático): escolha "Contar sacos" × "Pesar na balança" só no
//      aditivo, padrão sacos, volta ao padrão ao trocar de material; peso,
//      qtdSacos e etiqueta saem do jeito escolhido.
//
//  Como rodar:   node testes/aditivo-pesado-balanca.js
// ════════════════════════════════════════════════════════════════════

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');

const ROOT     = path.join(__dirname, '..');
const SERVER   = path.join(ROOT, 'server.js');
const PORT     = 13981;
const PORT_CB  = 18981;
const BASE     = `http://localhost:${PORT}`;
const CARIMBO  = Date.now();
const TMP_DB   = path.join(os.tmpdir(), `eko_aditpeso_${CARIMBO}.db`);
const TMP_LOGS = path.join(os.tmpdir(), `eko_aditpeso_logs_${CARIMBO}`);
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
    clientToken: `ap-${peso}-${CARIMBO}`, tipo: 'recebimento',
    materialKey: 'DESSEC', materialNomeEt: 'DESSECANTE', cor: null,
    fornecedor: 'Karina', peso, lote: '161126', codigo: 'D7',
    sku: `DESSEC.KARINA | ${Number(peso).toFixed(0)} | L161126`, sessao_id: sid, ...extra,
  });
  return r.json;
}

async function testeServidor() {
  console.log('\n[A-B] servidor');
  const s = await req('POST', '/sessoes', { tipo: 'recebimento', operador: 'Recebedor', fornecedor: 'Karina' });
  const sid = s.json.sessao_id;
  const pesado  = await etiqueta(sid, 1208.5);                    // "Pesar na balança": sem qtd_sacos
  const contado = await etiqueta(sid, 1000, { qtdSacos: 40 });    // "Contar sacos"
  ok(pesado && pesado.ok && contado && contado.ok, 'duas etiquetas de dessecante impressas', JSON.stringify([pesado, contado]));

  // 25/11/2026: na etiqueta de MP com QR o número e o "KG" são textos
  // separados (peso à direita, KG embaixo): acha pelo número exato.
  const eP = eplDe('"1208.5"');
  ok(!!eP && /"KG"/.test(eP), 'B) etiqueta do bag pesado sai com 1208.5 KG');
  ok(eP && !/SACO/i.test(eP), 'B) etiqueta do bag pesado sem "SACO"', eP && eP.slice(0, 400));

  for (const id of [pesado.id, contado.id]) await req('POST', `/etiquetas/${id}/bipar`);
  const f = await req('POST', `/sessoes/${sid}/finalizar`);
  await sleep(500);
  const resumo = (fs.existsSync(DIR_EPL) ? fs.readdirSync(DIR_EPL).sort() : [])
    .map(x => fs.readFileSync(path.join(DIR_EPL, x), 'latin1')).filter(t => /RESUMO RECEBIMENTO/.test(t)).pop() || '';
  const linhas = [...resumo.matchAll(/^A50,\d+,0,2,1,1,N,"(.*)"$/gm)].map(m => m[1]);
  const lP = linhas.find(l => l.includes(pesado.id));
  ok(lP && /1208,5 kg/.test(lP) && !/SACO/i.test(lP), 'B) resumo impresso: linha do bag pesado com 1208,5 kg e sem sacos', JSON.stringify(linhas));
  ok(/TOTAL[^\n]*2208,5/.test(resumo) || /2208,5/.test(resumo), 'B) resumo soma o kg real (2208,5)', resumo.slice(-600));

  const p = f.json && f.json.bling && f.json.bling.payload ? f.json.bling.payload
          : (f.json && f.json.payload ? f.json.payload : null);
  ok(p && Array.isArray(p.itens), 'A) finalizar devolve o payload do Bling (simulação)', JSON.stringify(f.json).slice(0, 300));
  if (p && Array.isArray(p.itens)) {
    const iP = p.itens.find(i => (i.etiquetas_origem || []).includes(pesado.id));
    const iC = p.itens.find(i => (i.etiquetas_origem || []).includes(contado.id));
    ok(iP && iP.quantidade === 1208.5, 'A) bag pesado chega no Bling como 1208,5 kg', JSON.stringify(iP));
    ok(iP && !/saco/i.test(iP.descricao_local), 'A) descrição do bag pesado sem "sacos"', iP && iP.descricao_local);
    ok(iP && iP.produto && iP.produto.codigo_extrusao === 'D7' && /Lote: 161126/.test(iP.descricao_local),
       'A) código gravimétrico e lote seguem os mesmos', JSON.stringify(iP));
    ok(iC && iC.quantidade === 1000 && / · 40 sacos × 25kg/.test(iC.descricao_local), 'A) aditivo contado continua "40 sacos × 25kg"', JSON.stringify(iC));
    ok(/TOTAL: 2208,5 KG/.test(p.observacoes || ''), 'A) observação do Bling soma 2208,5 kg', p.observacoes);
  }
}

async function testeCorrecao() {
  console.log('\n[D] corrigir etiqueta: qtd_sacos acompanha o material novo');
  const s = await req('POST', '/sessoes', { tipo: 'recebimento', operador: 'Recebedor', fornecedor: 'Karina' });
  const sid = s.json.sessao_id;
  const corrigir = (id, materialKey, codigo, peso) => req('POST', `/etiquetas/${id}/corrigir`, {
    materialKey, materialNomeEt: materialKey, cor: null, fornecedor: 'Karina', codigo,
    sku: `${materialKey}.KARINA | ${peso} | L161126` });

  // 40 sacos de dessecante corrigidos para GRÃO: grão não é por sacos.
  const a = await etiqueta(sid, 1000, { qtdSacos: 40, clientToken: `apD1-${CARIMBO}` });
  const ca = await corrigir(a.id, 'GBD', 'PT1', 1000);
  ok(ca.json && ca.json.ok, 'D) correção para grão aceita', JSON.stringify(ca.json));
  ok(ca.json && ca.json.etiqueta && ca.json.etiqueta.qtd_sacos == null,
     'D) corrigida para grão: sem "40 sacos"', JSON.stringify(ca.json && ca.json.etiqueta));

  // 40 sacos de dessecante (25 kg) corrigidos para CARBONATO (25 kg): continua 40.
  const b = await etiqueta(sid, 1000, { qtdSacos: 40, clientToken: `apD2-${CARIMBO}` });
  const cb = await corrigir(b.id, 'CARBO', 'C1', 1000);
  ok(cb.json && cb.json.etiqueta && cb.json.etiqueta.qtd_sacos === 40,
     'D) corrigida para outro aditivo de 25 kg: continua 40 sacos', JSON.stringify(cb.json && cb.json.etiqueta));

  // Bag pesado (sem sacos) corrigido para outro aditivo: continua sem sacos.
  const c = await etiqueta(sid, 1208.5, { clientToken: `apD3-${CARIMBO}` });
  const cc = await corrigir(c.id, 'CARBO', 'C1', 1208.5);
  ok(cc.json && cc.json.etiqueta && cc.json.etiqueta.qtd_sacos == null,
     'D) bag pesado corrigido continua sem sacos', JSON.stringify(cc.json && cc.json.etiqueta));
}

function testeTela() {
  console.log('\n[C] tela do recebimento (estático)');
  const h = fs.readFileSync(path.join(ROOT, 'public', 'mp-recebimento-retorno.html'), 'utf8');
  const cm = h.slice(h.indexOf('id="comp-modo"'), h.indexOf('id="bloco-peso"'));
  ok(/onclick="setCompPesar\(false\)"[^<]*Contar sacos/.test(cm) && /onclick="setCompPesar\(true\)"[^<]*Pesar na balança/.test(cm),
     'botões "Contar sacos" e "Pesar na balança"');
  ok(/id="cm-sacos"[^>]*class|class="cm-op sel" id="cm-sacos"/.test(cm), 'padrão aceso: Contar sacos');
  ok(/compPesar: false,/.test(h), 'estado começa em "Contar sacos"');
  ok(/const porSacosAgora = \(\) => isComposto\(estado\.material\) && !estado\.compPesar;/.test(h), 'regra única: por sacos = aditivo e não pesado');
  const fn = n => { const i = h.indexOf(`function ${n}(`); return h.slice(i, h.indexOf('\n}\n', i)); };
  ok(/const comp = porSacosAgora\(\);/.test(fn('alternarBlocoPesagem')) && /cm\.style\.display = aditivo \? 'flex' : 'none'/.test(fn('alternarBlocoPesagem')),
     'bloco do peso aparece quando pesado; seletor só no aditivo');
  ok(/const comp = porSacosAgora\(\);\s*const peso = comp \? estado\.qtdSacos \* kgSacoDe\(estado\.material\) : estado\.pesoBruto;/.test(h),
     'prévia da etiqueta usa o peso da balança quando pesado');
  const imp = h.slice(h.indexOf('dadosImpr = {\n      materialKey: estado.material'), h.indexOf('dadosImpr = {\n      materialKey: estado.material') + 700);
  const antesImp = h.slice(h.indexOf('dadosImpr = {\n      materialKey: estado.material') - 60, h.indexOf('dadosImpr = {\n      materialKey: estado.material'));
  ok(/const comp = porSacosAgora\(\);/.test(antesImp) && /qtdSacos: comp \? estado\.qtdSacos : null/.test(imp),
     'impressão: pesado vai sem qtdSacos e com o peso da balança');
  ok(/subTipo: \(!isComposto\(estado\.material\) && estado\.varredura\) \? 'varredura' : null/.test(imp), 'aditivo pesado nunca vira varredura');
  ok(/if \(k !== estado\.material\) estado\.compPesar = false;/.test(fn('selMat')) && /if \(porSacosAgora\(\)\)/.test(fn('selMat')),
     'trocar o material volta para "Contar sacos"');
  ok(/estado\.compPesar = false;/.test(fn('resetarRecebimento')), 'nova sessão volta para "Contar sacos"');
  const sc = fn('setCompPesar');
  ok(/estado\.qtdSacos = 0;/.test(sc) && /getElementById\('peso-bruto'\)\.value = '';/.test(sc), 'trocar o jeito zera o que estava digitado no outro');
}

(async () => {
  try {
    await subirServidor();
    const h = await req('GET', '/healthcheck');
    if (!h.json || h.json.impressao_simulada_forcada !== true) throw new Error('ABORTADO: impressão não está travada em simulação');
    await testeServidor();
    await testeCorrecao();
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
