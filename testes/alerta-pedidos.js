// ════════════════════════════════════════════════════════════════════
//  ALERTA DE PEDIDO DE RETIRADA NO COLETOR (25/11/2026, Gustavo)
//  ------------------------------------------------------------------
//  "deixa um alerta de pedido de retirada no coletor da melhor forma
//  possível, pode fazer o coletor vibrar e colocar alerta na tela e um
//  botão de ver pedido direto na tela de retirada".
//
//  Sem navegador (a tela é conferida em testes/navegador/alerta_pedidos_tc60.py):
//   [1] public/alerta-pedidos.js: quais pedidos vibram, quais ficam na faixa,
//       o que o aparelho lembra entre uma tela e outra.
//   [2] O app (v2.2) carrega o arquivo em toda tela do hub, tem o
//       EkoApp.alertar() e a permissão de vibrar; o hub carrega sozinho.
//   [3] A faixa só existe no app: no monitor do Mini PC não faz nada.
// ════════════════════════════════════════════════════════════════════
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const RAIZ = path.join(__dirname, '..');
const ler = p => fs.readFileSync(path.join(RAIZ, p), 'utf8');
let passou = 0, falhou = 0;
function ok(cond, msg, extra) {
  if (cond) { passou++; console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
  else { falhou++; console.log(`  \x1b[31m✗\x1b[0m ${msg}`); if (extra !== undefined) console.log('      ', JSON.stringify(extra)); }
}
function tenta(nome, fn) {
  console.log(`\n[${nome}]`);
  try { fn(); } catch (e) { falhou++; console.log(`  \x1b[31m✗\x1b[0m ${nome} quebrou: ${e.stack}`); }
}

const A = require('../public/alerta-pedidos.js');
const ped = (id, extra) => Object.assign({ id, status: 'aberto', cancelado_em: null, unidade: 'bag', bags_pedidos: 2,
  material_nome: 'COLORIDO BAIXA DENSIDADE', fornecedor: 'Piquiri', lote_fmt: '', autor_nome: 'Willian' }, extra || {});
const resp = (...pedidos) => ({ ok: true, modo: 'teste', pedidos });
const VAZIO = { alertados: {}, vistos: {} };
const T0 = Date.parse('2026-11-25T15:00:00-03:00');

tenta('1 quais pedidos contam', () => {
  ok(A.abertos(resp(ped('a'), ped('b', { status: 'atendido' }), ped('c', { cancelado_em: 'x' }))).map(p => p.id).join() === 'a',
     'só o aberto e não cancelado');
  ok(A.abertos({ desligado: true, pedidos: [ped('a')] }).length === 0, 'pedidos desligados no Mini PC → nada');
  ok(A.abertos({ ok: false, erro: 'x' }).length === 0, 'resposta de erro → nada');
  ok(A.abertos(null).length === 0 && A.abertos({ ok: true }).length === 0, 'resposta vazia → nada');
  ok(A.abertos({ ok: true, pedidos: [null, {}, ped('a')] }).length === 1, 'item quebrado é ignorado');
  ok(A.abertos({ ok: true, desatualizado: true, idade_s: 120, pedidos: [ped('a')] }).length === 1, 'VPS fora há 2 min: a lista guardada vale');
  ok(A.abertos({ ok: true, desatualizado: true, idade_s: 3 * 3600, pedidos: [ped('a')] }).length === 0, 'VPS fora há 3 h: lista velha não alerta');
  ok(A.abertos({ ok: true, desatualizado: true, pedidos: [ped('a')] }).length === 0, 'desatualizada sem idade: não alerta');
});

tenta('1 texto', () => {
  ok(A.resumo(ped('a')) === '2 bags · COLORIDO BAIXA DENSIDADE · Piquiri', 'bags', A.resumo(ped('a')));
  ok(A.quantidade(ped('a', { bags_pedidos: 1 })) === '1 bag', '1 bag no singular');
  ok(A.quantidade(ped('a', { unidade: 'kg', kg_pedidos: 25, bags_pedidos: null })) === '25 kg', 'pedido em kg');
  ok(A.quantidade(ped('a', { unidade: 'kg', kg_pedidos: 12.5 })) === '12,5 kg', 'kg com vírgula');
  ok(A.resumo(ped('a', { lote_fmt: '0423' })).endsWith('· lote 0423'), 'com lote');
  // revisor 25/11: o que FALTA, não o total; nulo não vira "0"; KG maiúsculo
  ok(A.quantidade(ped('a', { bags_pedidos: 3, bags_atendidos: 2 })) === 'falta 1 de 3 bags', 'bags já começado: o que falta');
  ok(A.quantidade(ped('a', { unidade: 'kg', kg_pedidos: 200, kg_atendidos: 150 })) === 'falta 50 de 200 kg', 'kg já começado: o que falta');
  ok(A.quantidade(ped('a', { bags_pedidos: 3, bags_atendidos: 0 })) === '3 bags', 'nada tirado: o total');
  ok(A.quantidade(ped('a', { unidade: 'kg', kg_pedidos: null })) === 'kg', 'kg nulo não vira "0 kg"');
  ok(A.quantidade(ped('a', { bags_pedidos: null })) === 'bags', 'bags nulo não vira "0 bags"');
  ok(A.quantidade(ped('a', { unidade: 'KG', kg_pedidos: 25 })) === '25 kg', 'unidade "KG" (como o emKg da lib)');
  const um = A.textoFaixa([ped('a')]);
  ok(um.titulo === '📦 PEDIDO DE RETIRADA (Willian)' && um.botao === 'VER PEDIDO', 'um pedido', um);
  const tres = A.textoFaixa([ped('a'), ped('b'), ped('c')]);
  ok(tres.titulo === '📦 3 PEDIDOS DE RETIRADA' && tres.botao === 'VER PEDIDOS' && tres.linha.endsWith('· e mais 2'), 'três pedidos', tres);
  ok(A.textoFaixa([]) === null, 'sem pedido → sem faixa');
});

tenta('1 vibra uma vez por pedido', () => {
  let r = A.decidir(resp(ped('a')), VAZIO, T0, false);
  ok(r.vibrar && r.faixa.length === 1, 'pedido novo: vibra e mostra a faixa');
  r = A.decidir(resp(ped('a')), r.estado, T0 + 15000, false);
  ok(!r.vibrar && r.faixa.length === 1, 'mesmo pedido no giro seguinte: não vibra de novo, a faixa fica');
  // trocar de tela = estado relido do localStorage
  const relido = A.lerEstado(JSON.stringify(r.estado));
  r = A.decidir(resp(ped('a')), relido, T0 + 30000, false);
  ok(!r.vibrar && r.faixa.length === 1, 'outra tela (estado guardado): não vibra, a faixa continua');
  r = A.decidir(resp(ped('a'), ped('b')), r.estado, T0 + 45000, false);
  ok(r.vibrar && r.faixa.length === 2, 'chegou outro: vibra, a faixa mostra os dois');
});

tenta('1 VER / ✕ / tela de Retirada', () => {
  let r = A.decidir(resp(ped('a')), VAZIO, T0, false);
  const est = A.marcarVistos(r.estado, r.faixa, T0 + 1000);
  r = A.decidir(resp(ped('a')), est, T0 + 15000, false);
  ok(!r.vibrar && r.faixa.length === 0, 'depois do VER/✕ a faixa some (o pedido continua aberto)');
  r = A.decidir(resp(ped('a'), ped('b')), r.estado, T0 + 30000, false);
  ok(r.vibrar && r.faixa.map(p => p.id).join() === 'b', 'pedido novo depois do ✕: só ele na faixa');

  r = A.decidir(resp(ped('c')), VAZIO, T0, true);
  ok(r.vibrar && r.faixa.length === 0, 'na tela de Retirada: vibra, sem faixa');
  r = A.decidir(resp(ped('c')), r.estado, T0 + 15000, false);
  ok(!r.vibrar && r.faixa.length === 0, 'saiu da Retirada: o pedido que ela já mostrou não volta na faixa');

  r = A.decidir(resp(ped('e')), VAZIO, T0, true, false);
  ok(r.vibrar && r.faixa.length === 0, 'Retirada com o teclado da senha por cima: vibra, sem faixa');
  r = A.decidir(resp(ped('e')), r.estado, T0 + 15000, false);
  ok(r.faixa.length === 1, '…e não conta como visto: no hub a faixa aparece');

  r = A.decidir(resp(ped('d')), VAZIO, T0, false);
  r = A.decidir(resp(), r.estado, T0 + 15000, false);
  ok(r.faixa.length === 0, 'pedido atendido/cancelado sai da faixa');
});

tenta('1 memória do aparelho', () => {
  ok(JSON.stringify(A.lerEstado('lixo{')) === JSON.stringify(VAZIO), 'estado ilegível → vazio');
  ok(JSON.stringify(A.lerEstado(null)) === JSON.stringify(VAZIO), 'sem estado → vazio');
  ok(JSON.stringify(A.lerEstado('{"alertados":[1],"vistos":"x"}')) === JSON.stringify(VAZIO), 'estado torto → vazio');
  const velho = { alertados: { z: T0 - 8 * 24 * 3600e3, a: T0 - 3600e3 }, vistos: { z: T0 - 8 * 24 * 3600e3 } };
  const r = A.decidir(resp(), velho, T0, false);
  ok(!('z' in r.estado.alertados) && ('a' in r.estado.alertados) && !('z' in r.estado.vistos), 'esquece o que sumiu há mais de 7 dias');
  // revisor 25/11: pedido aberto há 8 dias, já visto, não vibra nem volta
  const oito = T0 - 8 * 24 * 3600e3;
  const r2 = A.decidir(resp(ped('z')), { alertados: { z: oito }, vistos: { z: oito } }, T0, false);
  ok(!r2.vibrar && r2.faixa.length === 0, 'pedido aberto há 8 dias já visto: não vibra nem volta à faixa');
  ok(A.GUARDA_MS === 7 * 24 * 3600e3, 'memória de 7 dias');
  // 2º revisor 25/11: lista some por um giro (VPS fora > 30 min, indisponível,
  // desligado) e volta — o pedido antigo não pode vibrar de novo.
  for (const ruim of [{ ok: true, desatualizado: true, idade_s: 1900, pedidos: [] }, { ok: true, indisponivel: true, pedidos: [] },
                      { desligado: true, pedidos: [] }, { ok: false }]) {
    let e = A.decidir(resp(ped('z')), { alertados: { z: oito }, vistos: { z: oito } }, T0, false).estado;
    const meio = A.decidir(ruim, e, T0 + 60e3, false);
    ok(meio.faixa === null && !meio.vibrar, 'resposta sem lista confiável: não mexe na faixa', ruim);
    const volta = A.decidir(resp(ped('z')), meio.estado, T0 + 120e3, false);
    ok(!volta.vibrar && volta.faixa.length === 0, 'lista volta: pedido antigo não vibra nem volta à faixa', ruim);
  }
  // Aberto há 10 dias, visto há 10: segue sem vibrar (carimbo = última vez na lista).
  let e10 = { alertados: { y: T0 - 10 * 864e5 }, vistos: { y: T0 - 10 * 864e5 } };
  for (let d = 0; d < 3; d++) e10 = A.decidir(resp(ped('y')), e10, T0 + d * 864e5, false).estado;
  const r10 = A.decidir(resp(ped('y')), e10, T0 + 9 * 864e5, false);
  ok(!r10.vibrar && r10.faixa.length === 0, 'pedido aberto por semanas: nunca vibra de novo');
});

tenta('2 app 2.2 e hub', () => {
  const java = ler('android/app/src/main/java/br/com/ekoplastic/coletor/MainActivity.java');
  const man = ler('android/app/src/main/AndroidManifest.xml');
  ok(/@JavascriptInterface public void alertar\(\)/.test(java), 'EkoApp.alertar() existe na ponte');
  ok(/createWaveform/.test(java) && /ToneGenerator/.test(java), 'alertar vibra e apita');
  ok(/if \(temHub\(\)\) injetarAlertaPedidos\(\);/.test(java), 'só o app do hub carrega o alerta nas telas');
  ok(/getAssets\(\)\.open\("injetar-alerta\.js"\)/.test(java), 'o app roda assets/injetar-alerta.js');
  ok(/s\.src = '\/alerta-pedidos\.js'/.test(ler('android/app/src/main/assets/injetar-alerta.js')), 'que carrega /alerta-pedidos.js do Mini PC');
  ok(/USAGE_ALARM/.test(java) && /STREAM_ALARM/.test(java), 'vibra e apita como alarme (não some com o volume de notificação)');
  ok(/android\.permission\.VIBRATE/.test(man), 'manifesto com permissão de vibrar');
  const v = /android:versionName="([\d.]+)"/.exec(man);
  ok(v && Number(v[1].split('.')[0]) * 100 + Number(v[1].split('.')[1]) >= 202, 'versão do app ≥ 2.2', v && v[1]);
  ok(/<script src="\/alerta-pedidos\.js"><\/script>/.test(ler('public/hub-mp.html')), 'hub carrega o alerta (vale também no app 2.1)');
  const hub = require('../public/hub-mp.js');
  ok(hub.caminhosPermitidos().includes(A.RETIRADA), 'VER PEDIDO abre uma tela que o app deixa abrir');
  ok(fs.existsSync(path.join(RAIZ, 'public', A.RETIRADA)), 'a tela de Retirada existe');
});

tenta('1 tela ocupada (VER PEDIDO pergunta antes de sair)', () => {
  const el = (o) => Object.assign({ getClientRects: () => [1], readOnly: false, disabled: false, type: 'text', value: '', defaultValue: '' }, o);
  const doc = (janelas, campos) => ({ defaultView: { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) },
    querySelectorAll: q => q.startsWith('input') ? campos : janelas });
  ok(!A.telaOcupada(doc([], [el({})])), 'campos vazios: sai direto');
  ok(A.telaOcupada(doc([], [el({ value: '512,3' })])), 'peso digitado: pergunta');
  ok(!A.telaOcupada(doc([], [el({ id: '__ekoScan', value: 'R0000001' })])), 'campo invisível do leitor não conta');
  ok(!A.telaOcupada(doc([], [el({ value: 'x', getClientRects: () => [] })])), 'campo escondido não conta');
  ok(!A.telaOcupada(doc([], [el({ type: 'hidden', value: 'x' })])), 'input hidden não conta');
  ok(A.telaOcupada(doc([el({})], [])), 'janela aberta: pergunta');
  ok(!A.telaOcupada(doc([], [el({ type: 'number', value: '0', defaultValue: '0' })])), 'contador "0" que a tela pôs: sai direto');
  ok(A.telaOcupada(doc([], [el({ type: 'number', value: '3', defaultValue: '0' })])), 'contador mudado: pergunta');
});

tenta('3 só no app', () => {
  ok(A.noApp('Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile EkoColetor/2.2'), 'UA do app → liga');
  ok(!A.noApp('Mozilla/5.0 (Windows NT 10.0) Chrome/120'), 'monitor do Mini PC → não liga');
  // No navegador sem o app, iniciar() não pergunta nada ao Mini PC.
  let perguntou = 0;
  const win = { document: { readyState: 'complete', addEventListener() {}, getElementById() { return null; } },
                navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120' },
                fetch() { perguntou++; return Promise.reject(new Error('x')); }, setInterval() {}, location: { pathname: '/hub-mp.html' } };
  vm.runInNewContext(ler('public/alerta-pedidos.js'), { window: win });
  ok(perguntou === 0 && win.__ekoAlertaPedidos === 1, 'fora do app: não consulta pedidos');
  // No app: consulta na hora, e uma vez só mesmo carregado duas vezes.
  const win2 = Object.assign({}, win, { __ekoAlertaPedidos: undefined, navigator: { userAgent: 'x EkoColetor/2.2' }, localStorage: { getItem() { return null; }, setItem() {} } });
  vm.runInNewContext(ler('public/alerta-pedidos.js'), { window: win2 });
  vm.runInNewContext(ler('public/alerta-pedidos.js'), { window: win2 });
  ok(perguntou === 1, 'no app: consulta já ao abrir, sem duplicar', perguntou);
});

console.log(`\n${passou} passaram, ${falhou} falharam`);
process.exit(falhou ? 1 : 0);
