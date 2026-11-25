// ════════════════════════════════════════════════════════════════════
//  HUB DO COLETOR "Ekoplastic MP" (25/11/2026, Gustavo)
//  ------------------------------------------------------------------
//  "pro coletor do Bruno vou precisar de um hub de aplicativos onde ele
//  consegue fazer entrada e retirada, mapeamento e inventário" (+ PA;
//  + Retorno e Resíduos no mesmo dia).
//
//  Sem navegador e sem servidor (node:vm + documento de mentira):
//   [1] public/hub-mp.js: os 7 botões, cada um numa tela que existe;
//       "em andamento" conta as sessões abertas certas.
//   [2] android/build.sh (VARIANTE=mp) abre exatamente o hub + as telas dele
//       — a lista do app e a do hub não podem divergir.
//   [3] android/app/src/main/assets/voltar.js: o Voltar do Android fecha a
//       janela aberta de cada tela; sem janela, pede o hub.
//   [4] seguranca-saida.js não joga a tela de PA para o menu dentro do app.
//   [5] Entrada lê a balança do MINI PC (endereço relativo, não localhost).
//   [6] Entrada e Retirada recebem o código do leitor pelo app (onLeu), com
//       as mesmas travas do leitor-teclado.
//   [7] Entrada e Retirada carregam o celular.css, com regra só < 900 px.
// ════════════════════════════════════════════════════════════════════
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const RAIZ = path.join(__dirname, '..');
const ler = p => fs.readFileSync(path.join(RAIZ, p), 'utf8');
let passou = 0, falhou = 0;
function ok(cond, msg, extra) {
  if (cond) { passou++; console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
  else { falhou++; console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
         if (extra !== undefined) console.log('      →', String(extra).slice(0, 600)); }
}
function tenta(msg, fn) { try { fn(); } catch (e) { ok(false, msg + ' (erro: ' + e.message + ')'); } }

console.log('\n═══════════════════════════════════════════════════');
console.log(' HUB DO COLETOR "Ekoplastic MP"');
console.log('═══════════════════════════════════════════════════');

// ── documento de mentira (sem jsdom: regra da casa) ──────────────────
function el(tag, o = {}) {
  const e = { tagName: tag.toUpperCase(), id: o.id || '', classes: new Set((o.cls || '').split(/\s+/).filter(Boolean)),
              textContent: o.txt || '', filhos: [], pai: null, cliques: 0, removido: false,
              offsetParent: o.oculto ? null : {}, display: o.oculto ? 'none' : 'block' };
  e.classList = { contains: c => e.classes.has(c), add: c => e.classes.add(c), remove: c => e.classes.delete(c) };
  e.click = () => { e.cliques++; if (o.aoClicar) o.aoClicar(e); };
  e.remove = () => { e.removido = true; if (e.pai) e.pai.filhos = e.pai.filhos.filter(f => f !== e); };
  e.add = (...fs) => { for (const f of fs) { f.pai = e; e.filhos.push(f); } return e; };
  e.todos = () => e.filhos.flatMap(f => [f, ...f.todos()]);
  e.querySelectorAll = sel => e.todos().filter(x => casa(x, sel));
  e.querySelector = sel => e.querySelectorAll(sel)[0] || null;
  return e;
}
function casa(x, sel) {
  return sel.split(',').some(s => {
    const m = s.trim().match(/^([a-z]+)?((?:[#.][\w-]+)*)$/i);
    if (!m) throw new Error('seletor não suportado: ' + s);
    if (m[1] && x.tagName !== m[1].toUpperCase()) return false;
    for (const p of (m[2].match(/[#.][\w-]+/g) || [])) {
      if (p[0] === '#' && x.id !== p.slice(1)) return false;
      if (p[0] === '.' && !x.classes.has(p.slice(1))) return false;
    }
    return true;
  });
}
function docCom(...filhos) {
  const body = el('body').add(...filhos);
  return {
    body, activeElement: body,
    getElementById: id => body.todos().find(x => x.id === id) || null,
    querySelector: s => body.querySelector(s), querySelectorAll: s => body.querySelectorAll(s),
  };
}

// ════════════════════════════════════════════════════════════════════
console.log('\n[1] Os botões do hub');
const Hub = require('../public/hub-mp.js');
tenta('hub-mp.js', () => {
  const ids = Hub.TELAS.map(t => t.id);
  // Gustavo 25/11: "retorno também" e "residuo" → 7 botões.
  ok(JSON.stringify(ids) === JSON.stringify(['entrada', 'retorno', 'retirada', 'residuos', 'mapeamento', 'inventario', 'pa']),
     '7 botões, na ordem: Entrada, Retorno, Retirada, Resíduos, Mapeamento, Inventário, Produto Acabado', ids);
  const esperado = { entrada: '/mp-recebimento-retorno.html', retorno: '/mp-recebimento-retorno.html',
                     retirada: '/mp-retirada.html', residuos: '/outras-pesagens.html',
                     mapeamento: '/enderecamento.html', inventario: '/inventario.html', pa: '/produto-acabado.html' };
  for (const t of Hub.TELAS) {
    ok(Hub.caminho(t.url) === esperado[t.id], `${t.nome} abre ${esperado[t.id]}`, t.url);
    ok(fs.existsSync(path.join(RAIZ, 'public', Hub.caminho(t.url))), `${Hub.caminho(t.url)} existe em public/`);
  }
  const porId = Object.fromEntries(Hub.TELAS.map(t => [t.id, t]));
  ok(/[?&]aba=recebimento(&|$)/.test(porId.entrada.url), 'Entrada abre na aba Recebimento', porId.entrada.url);
  ok(/[?&]aba=retorno(&|$)/.test(porId.retorno.url), 'Retorno abre na aba Retorno (a página lê ?aba=retorno)', porId.retorno.url);
  // A página escolhe aba e senha pelo ?aba= (ABA_PIN); se o nome mudar lá, o botão Retorno cai no Recebimento.
  ok(/get\('aba'\)\s*===\s*'retorno'/.test(ler('public/mp-recebimento-retorno.html')),
     "mp-recebimento-retorno.html ainda reconhece ?aba=retorno");
  ok(!/em andamento|Recebimento e retorno/.test(porId.entrada.sub), 'subtítulo da Entrada é só recebimento', porId.entrada.sub);
  const cores = Hub.TELAS.map(t => t.cor.toLowerCase());
  ok(new Set(cores).size === cores.length, 'uma cor por botão', cores);
  ok(fs.existsSync(path.join(RAIZ, 'public', 'hub-mp.html')), 'public/hub-mp.html existe');
  ok(/<script src="\/hub-mp\.js"><\/script>/.test(ler('public/hub-mp.html')), 'hub-mp.html carrega /hub-mp.js');
  ok(!/fetch\([^)]*method\s*:\s*['"](POST|PUT|PATCH|DELETE)/i.test(ler('public/hub-mp.js')),
     'o hub não grava nada (nenhum POST/PUT/PATCH/DELETE)');

  const c = Hub.abertasPorTela({ ok: true, sessoes: [
    { tipo: 'recebimento' }, { tipo: 'retorno' }, { tipo: 'retirada' }, { tipo: 'produto-acabado' }, { tipo: 'extrusao' }, null] });
  ok(c.entrada === 1 && c.retorno === 1 && c.retirada === 1 && c.residuos === 0 && c.pa === 1 && c.mapeamento === 0 && c.inventario === 0,
     'em andamento: recebimento na Entrada, retorno no Retorno, retirada na Retirada, PA no PA; extrusão em nenhum', JSON.stringify(c));
  const r2 = Hub.abertasPorTela({ ok: true, sessoes: [{ tipo: 'outras' }, { tipo: 'outras' }, { tipo: 'retorno' }] });
  ok(r2.residuos === 2 && r2.retorno === 1 && r2.entrada === 0, "em andamento: 'outras' acende Resíduos; retorno não acende a Entrada", JSON.stringify(r2));
  const z = Hub.abertasPorTela({ ok: false, erro: 'x' });
  ok(Object.values(z).every(n => n === 0), 'resposta com erro: nenhum botão acende');
  ok(Object.values(Hub.abertasPorTela(null)).every(n => n === 0), 'sem resposta: nenhum botão acende');
  ok(Hub.textoAberta(0) === '' && /1 em andamento/.test(Hub.textoAberta(1)) && /3 em andamento/.test(Hub.textoAberta(3)),
     'texto: vazio, "1 em andamento", "3 em andamento"');
});

// Status do hub: só diz "conectado" com resposta boa do Mini PC (revisor, 25/11).
async function statusCom(resp) {
  const st = { className: '', textContent: '' };
  const doc = { getElementById: id => (id === 'hub-status' ? st : null) };
  const antes = global.fetch;
  global.fetch = async () => { if (resp instanceof Error) throw resp; return { ok: resp.status === 200, status: resp.status, json: async () => resp.corpo }; };
  try { await Hub.atualizar(doc); } finally { global.fetch = antes; }
  return st.className;
}
const statusPromessa = (async () => {
  console.log('\n[1b] Status do hub');
  ok(await statusCom({ status: 200, corpo: { ok: true, sessoes: [] } }) === 'status on', 'resposta boa: "Mini PC conectado"');
  ok(await statusCom({ status: 500, corpo: { ok: false, erro: 'x' } }) === 'status off', 'erro 500: "Sem conexão", não "conectado"');
  ok(await statusCom({ status: 200, corpo: { ok: false } }) === 'status off', 'ok:false: "Sem conexão"');
  ok(await statusCom(new Error('rede')) === 'status off', 'sem rede: "Sem conexão"');
})();

// ════════════════════════════════════════════════════════════════════
console.log('\n[2] O app abre o hub e só as telas dele');
tenta('build.sh', () => {
  const sh = ler('android/build.sh');
  const bloco = (sh.match(/\n\s*mp\)([\s\S]*?);;/) || [])[1] || '';
  ok(!!bloco, 'build.sh tem a VARIANTE=mp');
  const v = k => ((bloco.match(new RegExp(k + '=([^;\\s]+)')) || [])[1] || '').replace(/"/g, '');
  ok(v('PACOTE') === 'br.com.ekoplastic.mp', 'pacote br.com.ekoplastic.mp (não instala por cima dos outros dois)', v('PACOTE'));
  ok(v('PAGINA') === Hub.HUB, 'página inicial é o hub', v('PAGINA'));
  ok(v('TRAVAR') === 'true', 'navegação presa');
  ok(v('ESTRITA') === 'false', 'leitura livre: a tela valida (bag R/T/S, endereço, gaiola EKOPA|…)');
  const doApp = v('PAGINAS').split(',').filter(Boolean).sort();
  const doHub = Hub.caminhosPermitidos().filter(p => p !== Hub.HUB).sort();
  ok(JSON.stringify(doApp) === JSON.stringify(doHub), 'páginas do app = telas do hub', `app ${doApp} · hub ${doHub}`);
  ok(/VARIANTE=bobinas "\$0" && VARIANTE=inventario "\$0" && VARIANTE=mp "\$0"/.test(sh), './build.sh sem variante gera os três');
  ok(/-e "s\|@PAGINAS@\|\$PAGINAS\|g"/.test(sh), 'o build preenche @PAGINAS@');
  const man = ler('android/app/src/main/AndroidManifest.xml');
  ok(/<meta-data android:name="paginas" android:value="@PAGINAS@"/.test(man), 'manifesto leva as páginas extras ao app');
  const java = ler('android/app/src/main/java/br/com/ekoplastic/coletor/MainActivity.java');
  ok(/getString\("paginas"/.test(java) && /open\("voltar\.js"\)/.test(java), 'o app lê "paginas" do manifesto e assets/voltar.js');
  ok(fs.existsSync(path.join(RAIZ, 'android/app/src/main/res/drawable/icone_mp.xml')), 'ícone icone_mp existe');
});

// ════════════════════════════════════════════════════════════════════
console.log('\n[3] Voltar do Android (assets/voltar.js)');
const VOLTAR = ler('android/app/src/main/assets/voltar.js');
function voltar(doc, win = {}) {
  win.getComputedStyle = x => ({ display: x.display });
  return vm.runInNewContext(VOLTAR, { document: doc, window: win }, { timeout: 2000 });
}
tenta('voltar.js', () => {
  ok(voltar(docCom(el('div', { id: 'qualquer' }))) === 'hub', 'nada aberto: volta ao hub');
  // Com a senha na frente, nada do que está atrás é acionado.
  const atras = el('button', { id: 'btn-voltar', txt: '← Voltar' });
  ok(voltar(docCom(el('div', { id: 'eko-acesso' }), atras)) === 'hub' && atras.cliques === 0,
     'teclado da senha aberto: volta ao hub sem tocar no que está atrás');
  const atras2 = el('button', { txt: 'Cancelar' });
  ok(voltar(docCom(el('div', { id: 'eko-outro' }), el('div', { cls: 'modal-overlay ativo' }).add(atras2))) === 'hub' && atras2.cliques === 0,
     'caixa "sessão de outro" aberta: volta ao hub sem responder');
  // "Encerrar a de X?" (eko-confirma): Voltar é o "Voltar" dela, fica na tela (revisor, 25/11).
  const sim = el('button', { id: 'eko-confirma-sim', txt: 'Encerrar' }), nao = el('button', { id: 'eko-confirma-nao', txt: 'Voltar' });
  ok(voltar(docCom(el('div', { id: 'eko-confirma' }).add(sim, nao))) === 'fechou' && nao.cliques === 1 && sim.cliques === 0,
     'confirmação "Encerrar a de X?": aperta Voltar dela, nunca Encerrar, e fica na tela');
  // Resumo do dia (resumo-dia.js) aberto na Entrada/Retirada: fecha, não sai da tela.
  const rdF = el('button', { id: 'rd-fechar', txt: '← FECHAR' }), rdI = el('button', { id: 'rd-imprimir', txt: '🖨 IMPRIMIR' });
  ok(voltar(docCom(el('div', { id: 'rd-overlay', cls: 'ativo' }).add(el('button', { txt: '‹' }), rdF, rdI))) === 'fechou'
     && rdF.cliques === 1 && rdI.cliques === 0, 'Resumo do dia aberto: ← FECHAR, não imprime e não sai da tela');

  const canc = el('button', { id: 'md-cancelar', txt: 'Cancelar' }), okb = el('button', { id: 'eko-dlg-ok', txt: 'Confirmar' });
  ok(voltar(docCom(el('div', { cls: 'eko-dlg modal-fundo' }).add(okb, canc))) === 'fechou' && canc.cliques === 1 && okb.cliques === 0,
     'caixa do eko-dialogo: aperta Cancelar, nunca Confirmar');
  const fundo = el('div', { cls: 'modal-fundo' });
  voltar(docCom(fundo));
  ok(fundo.removido, 'janela sem botão de cancelar (bobinas): é tirada da tela');

  // Retirada de MP: confirmação (← VOLTAR | CONFIRMAR) e motivo (CANCELAR · NÃO RETIRAR)
  const conf = el('button', { txt: 'CONFIRMAR' }), volt = el('button', { txt: '← VOLTAR' });
  ok(voltar(docCom(el('div', { cls: 'modal-overlay ativo', id: 'modal-confirmar' }).add(volt, conf))) === 'fechou'
     && volt.cliques === 1 && conf.cliques === 0, 'Retirada, confirmação: aperta ← VOLTAR, nunca CONFIRMAR');
  const motivo = el('button', { txt: 'Lote pedido acabou' }), naoRet = el('button', { txt: 'CANCELAR · NÃO RETIRAR' });
  voltar(docCom(el('div', { cls: 'modal-overlay ativo', id: 'modal-fora' }).add(motivo, naoRet)));
  ok(naoRet.cliques === 1 && motivo.cliques === 0, 'Retirada, motivo: CANCELAR · NÃO RETIRAR, nenhum motivo escolhido');
  const kc = el('button', { txt: 'Cancelar' }), kok = el('button', { txt: '✓ OK' });
  voltar(docCom(el('div', { cls: 'kp-overlay ativo' }).add(el('button', { txt: '7' }), kok, kc)));
  ok(kc.cliques === 1 && kok.cliques === 0, 'Retirada, teclado da tela: Cancelar, não OK');
  const fechada = el('button', { txt: 'Cancelar' });
  ok(voltar(docCom(el('div', { cls: 'modal-overlay' }).add(fechada))) === 'hub' && fechada.cliques === 0,
     'janela que existe mas está fechada não conta');

  // PA e Entrada
  const enviar = el('button', { txt: '✓ Confirmar e enviar' }), voltPa = el('button', { txt: '← Voltar' });
  voltar(docCom(el('div', { cls: 'modal-overlay on' }).add(voltPa, enviar)));
  ok(voltPa.cliques === 1 && enviar.cliques === 0, 'PA, confirmar envio ao Bling: ← Voltar, nunca enviar');
  const corrX = el('button', { txt: '✕' }), reimp = el('button', { txt: '🖨 Reimprimir corrigida' });
  voltar(docCom(el('div', { cls: 'ov-correcao on' }).add(reimp, corrX)));
  ok(corrX.cliques === 1 && reimp.cliques === 0, 'Entrada, correção de etiqueta: ✕, nunca reimprimir');
  const semBotao = el('div', { cls: 'modal-overlay on' });
  voltar(docCom(semBotao));
  ok(!semBotao.classes.has('on'), 'janela sem botão de fechar: some (tira o "on")');

  // Inventário: ← Voltar da própria tela; escondido não conta
  const bv = el('button', { id: 'btn-voltar', txt: '← Voltar' });
  ok(voltar(docCom(bv)) === 'fechou' && bv.cliques === 1, 'inventário: aciona o ← Voltar da tela');
  const bvOculto = el('button', { id: 'btn-voltar', oculto: true });
  ok(voltar(docCom(bvOculto)) === 'hub' && bvOculto.cliques === 0, 'inventário na 1ª tela (← Voltar escondido): volta ao hub');

  // Bobinas (app de antes): fecha o cartão da bobina, como na v1.9
  let fechou = 0;
  ok(voltar(docCom(), { cancelarLeitura: () => fechou++ }) === 'fechou' && fechou === 1, 'Retirada de Bobinas: fecha o cartão da bobina (como antes)');
});

// ════════════════════════════════════════════════════════════════════
console.log('\n[4] Produto Acabado dentro do app não pula para o menu');
tenta('seguranca-saida.js', () => {
  const SS = ler('public/seguranca-saida.js');
  function rodar(ua) {
    const trocas = [], ouvintes = [];
    const win = { location: { pathname: '/produto-acabado.html', origin: 'https://x', replace: u => trocas.push(u) },
                  addEventListener: (t) => ouvintes.push(t) };
    win.self = win; win.top = win;
    const ctx = { window: win, location: win.location, navigator: { userAgent: ua },
                  document: { body: { dataset: { tela: 'Produto Acabado' } }, readyState: 'loading', getElementById: () => null },
                  URLSearchParams, setTimeout, fetch: () => Promise.resolve() };
    vm.runInNewContext(SS, ctx, { timeout: 2000 });
    return { trocas, ouvintes };
  }
  const navegador = rodar('Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile');
  ok(navegador.trocas.length === 1 && navegador.trocas[0] === '/?tela=%2Fproduto-acabado.html',
     'no navegador (celular/PC) continua reabrindo pelo menu', navegador.trocas);
  const app = rodar('Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile EkoColetor/2.0');
  ok(app.trocas.length === 0, 'no app (EkoColetor/…) a tela fica aberta', app.trocas);
  ok(app.ouvintes.length === 0, 'no app: sem ESC/🔒 de sair do sistema (o app já é preso)', app.ouvintes);
});

// ════════════════════════════════════════════════════════════════════
console.log('\n[5] Entrada: peso da balança do Mini PC');
const RECEB = ler('public/mp-recebimento-retorno.html');
tenta('balança', () => {
  const urls = [...RECEB.matchAll(/const URL_BAL\w* *= *'([^']+)'/g)].map(m => m[1]);
  ok(urls.length === 3, 'as 3 URLs da balança estão na tela', urls);
  ok(urls.every(u => u.startsWith('/balanca/')), 'endereço relativo: no coletor é o Mini PC que responde', urls);
  ok(!/localhost:3000\/balanca/.test(RECEB), 'nenhum http://localhost:3000/balanca sobrou na tela');
});

// ════════════════════════════════════════════════════════════════════
console.log('\n[6] Leitor do coletor pelo app (onLeu)');
function trecho(html, nome) {
  const i = html.indexOf('/* <leitor-app> */'), f = html.indexOf('/* </leitor-app> */');
  if (i < 0 || f < i) throw new Error('trecho <leitor-app> não achado em ' + nome);
  return html.slice(i, f);
}
tenta('Entrada onLeu', () => {
  const lidos = [];
  const doc = { activeElement: { tagName: 'BODY', id: '' } };
  const ctx = { document: doc, processarBipeRaw: c => lidos.push(c) };
  ctx.window = ctx;   // no navegador window é o próprio global
  vm.runInNewContext(trecho(RECEB, 'Entrada') + ';this.onLeu = onLeu;', ctx, { timeout: 2000 });
  ctx.onLeu(' R0000123 ');
  ok(lidos.join() === 'R0000123', 'bipe chega ao processarBipeRaw (sem espaço)', lidos);
  doc.activeElement = { tagName: 'INPUT', id: '__ekoScan' };
  ctx.onLeu('T0000005');
  ok(lidos.join() === 'R0000123,T0000005', 'com o campo invisível do app em foco: lê', lidos);
  doc.activeElement = { tagName: 'INPUT', id: 'peso-bruto' };
  ctx.onLeu('R0000124');
  ok(lidos.length === 2, 'com o campo de peso em foco: não lê (igual ao leitor-teclado)', lidos);
  doc.activeElement = { tagName: 'BODY', id: '' };
  ctx.EkoAcesso = { bloqueando: () => true };
  ctx.onLeu('R0000125');
  ok(lidos.length === 2, 'teclado da senha na tela: não lê', lidos);
});
tenta('Retirada onLeu', () => {
  const RET = ler('public/mp-retirada.html');
  const bipes = [], toasts = [];
  let keypadAberto = false;
  const doc = { activeElement: { tagName: 'BODY', id: '' },
                getElementById: id => id === 'keypad-modal' ? { classList: { contains: c => c === 'ativo' && keypadAberto } } : null };
  const ctx = { document: doc, processarBipe: c => bipes.push(c), showToast: (...a) => toasts.push(a.join(' ')), beepErro: () => {} };
  ctx.window = ctx;
  vm.runInNewContext(trecho(RET, 'Retirada') + ';this.onLeu = onLeu;', ctx, { timeout: 2000 });
  ctx.onLeu('R0000101');
  ok(bipes.join() === 'R0000101', 'bipe chega ao processarBipe', bipes);
  ctx.onLeu('R0000102S0000007');
  ok(bipes.join() === 'R0000101,R0000102,S0000007', 'dois códigos colados: saem os dois, na ordem', bipes);
  keypadAberto = true;
  ctx.onLeu('R0000103');
  ok(bipes.length === 3 && toasts.some(t => /R0000103 NÃO saiu/.test(t)), 'teclado da tela aberto: não sai e avisa "NÃO saiu"', toasts);
  keypadAberto = false;
  doc.activeElement = { tagName: 'TEXTAREA', id: 'fora-outro' };
  ctx.onLeu('R0000104');
  ok(bipes.length === 3, 'caixa do motivo em foco: quem trata é o teclaDoLeitor (não sai 2×)', bipes);
  doc.activeElement = { tagName: 'INPUT', id: '__ekoScan' };
  ctx.EkoAcesso = { bloqueando: () => true };
  ctx.onLeu('R0000105');
  ok(bipes.length === 3, 'teclado da senha na tela: não lê', bipes);
});

// ════════════════════════════════════════════════════════════════════
console.log('\n[6b] Entrada: trocar para Retorno troca também a senha (revisor, 25/11)');
tenta('troca de aba', () => {
  ok(/data-modo="recebimento" onclick="trocarAba\('recebimento'\)"/.test(RECEB) && /data-modo="retorno" onclick="trocarAba\('retorno'\)"/.test(RECEB),
     'as abas RECEBIMENTO | RETORNO chamam trocarAba');
  const i = RECEB.indexOf('/* <troca-aba> */'), f = RECEB.indexOf('/* </troca-aba> */');
  ok(i > 0 && f > i, 'trecho <troca-aba> existe');
  function rodar(aba, url) {
    const trocas = [], modos = [];
    const u = new URL('https://minipc:3443' + url);
    const ctx = { ABA_PIN: aba, URLSearchParams, trocarModo: m => modos.push(m),
                  location: { search: u.search, pathname: u.pathname, replace: x => trocas.push(x) } };
    vm.runInNewContext(RECEB.slice(i, f) + ';this.trocarAba = trocarAba;', ctx, { timeout: 2000 });
    return { ctx, trocas, modos };
  }
  let r = rodar('recebimento', '/mp-recebimento-retorno.html?aba=recebimento');
  r.ctx.trocarAba('retorno');
  ok(r.trocas.join() === '/mp-recebimento-retorno.html?aba=retorno' && !r.modos.length,
     'no Recebimento, tocar RETORNO reabre com ?aba=retorno (senha e responsável do retorno)', r.trocas);
  r = rodar('retorno', '/mp-recebimento-retorno.html?aba=retorno');
  r.ctx.trocarAba('recebimento');
  ok(r.trocas.join() === '/mp-recebimento-retorno.html?aba=recebimento', 'no Retorno, tocar RECEBIMENTO reabre com ?aba=recebimento', r.trocas);
  r = rodar('retorno', '/mp-recebimento-retorno.html?aba=retorno');
  r.ctx.trocarAba('retorno');
  ok(!r.trocas.length && r.modos.join() === 'retorno', 'tocar a aba em que já está: não recarrega');
  r = rodar('recebimento', '/mp-recebimento-retorno.html?embed=1');
  r.ctx.trocarAba('retorno');
  ok(r.trocas.join() === '/mp-recebimento-retorno.html?embed=1&aba=retorno', 'mantém os outros parâmetros da URL', r.trocas);
});

// ════════════════════════════════════════════════════════════════════
console.log('\n[7] Entrada e Retirada cabem no coletor sem mudar o Mini PC');
tenta('celular.css', () => {
  const RET = ler('public/mp-retirada.html');
  ok(/<link rel="stylesheet" href="\/celular\.css">\s*<\/head>\s*<body data-tela="MP Recebimento">/.test(RECEB), 'Entrada carrega o celular.css (data-tela "MP Recebimento")');
  ok(/<link rel="stylesheet" href="\/celular\.css">\s*<\/head>\s*<body data-tela="MP Retirada">/.test(RET), 'Retirada carrega o celular.css (data-tela "MP Retirada")');
  const css = ler('public/celular.css');
  const ini = css.indexOf('@media (max-width: 900px) {');
  // fim do bloco: a chave que fecha o @media de 900 px
  let prof = 0, fim = -1;
  for (let i = css.indexOf('{', ini); i < css.length; i++) {
    if (css[i] === '{') prof++;
    else if (css[i] === '}' && --prof === 0) { fim = i; break; }
  }
  const usos = [...css.matchAll(/data-tela="MP (Recebimento|Retirada)"/g)].map(m => m.index);
  ok(usos.length >= 6, 'regras das duas telas no celular.css', usos.length);
  ok(ini >= 0 && usos.every(i => i > ini && i < fim), 'todas dentro do @media (max-width: 900px): o monitor do Mini PC não muda');
});

statusPromessa.catch(e => ok(false, 'status do hub (erro: ' + e.message + ')')).then(() => {
  console.log('\n═══════════════════════════════════════════════════');
  console.log(` ${passou} passaram, ${falhou} falharam`);
  console.log('═══════════════════════════════════════════════════');
  process.exit(falhou ? 1 : 0);
});
