// ════════════════════════════════════════════════════════════════════
//  TELA DE RETIRADA — cartão do pedido do painel (10/11/2026, Gustavo)
//  ------------------------------------------------------------------
//  Roda o trecho <pedidos-render> do public/mp-retirada.html isolado
//  (node:vm, sem navegador) e confere o HTML de cada cartão:
//    · aberto  → no canto esquerdo o triângulo amarelo com "!";
//    · atendido → V verde;
//    · fornecedor, PESO (ou "qualquer") e lote em campos separados;
//    · texto que vem da VPS (fornecedor, lote, autor, endereço) não vira HTML.
// ════════════════════════════════════════════════════════════════════
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let passou = 0, falhou = 0;
function ok(cond, msg, extra) {
  if (cond) { passou++; console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
  else { falhou++; console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
         if (extra !== undefined) console.log('      →', String(extra).slice(0, 900)); }
}

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'mp-retirada.html'), 'utf8');
const ini = html.indexOf('/* <pedidos-render>'), fim = html.indexOf('/* </pedidos-render> */');
console.log('\n═══════════════════════════════════════════════════');
console.log(' TELA DE RETIRADA: cartão do pedido do painel');
console.log('═══════════════════════════════════════════════════\n');
ok(ini > 0 && fim > ini, 'o trecho <pedidos-render> existe na tela');
const T = vm.runInNewContext(html.slice(ini, fim) + '\n;({ htmlPedidos, htmlPedido })', {}, { timeout: 2000 });

const ped = (extra = {}) => ({
  id: 'RM-20261110-001', criado_em: '2026-11-10T13:57:40.510Z', autor_nome: 'Gustavo', material_key: 'GBD',
  cor: 'Amarelo', material_nome: 'AMARELO BAIXA DENSIDADE', fornecedor: 'Aliana', lote: '020926',
  lote_fmt: '02/09/26', peso: 614.5, bags_pedidos: 3, bags_atendidos: 0, status: 'aberto', ...extra });
const sinalDe = h => { const m = h.match(/^\s*<div class="pp-item[^"]*"[^>]*>\s*<div class="pp-sinal ([a-z]+)" data-sinal="([a-z]+)"[^>]*>([^<]*)<\/div>/); return m && { cls: m[1], dado: m[2], txt: m[3] }; };

console.log('[1] Sinal no canto esquerdo');
const hA = T.htmlPedido(ped());
const sA = sinalDe(hA);
ok(sA && sA.cls === 'pendente' && sA.dado === 'pendente' && sA.txt === '!',
   'aberto: 1º elemento do cartão é o triângulo amarelo com "!"', hA);
const hM = T.htmlPedido(ped({ bags_atendidos: 1 }));
ok(sinalDe(hM)?.dado === 'pendente', 'saiu 1 de 3: continua "!" (ainda não foi feito)', hM);
const hF = T.htmlPedido(ped({ bags_atendidos: 3, status: 'atendido' }));
const sF = sinalDe(hF);
ok(sF && sF.cls === 'ok' && sF.dado === 'ok' && sF.txt === '✓', 'atendido: vira o V verde', hF);
ok(/\.pp-sinal\.pendente \{[^}]*background: #facc15[^}]*clip-path: polygon\(50% 0, 100% 100%, 0 100%\)/.test(html),
   'CSS: pendente = triângulo amarelo (#facc15)');
ok(/\.pp-sinal\.ok \{[^}]*color: #22c55e/.test(html), 'CSS: ok = verde (#22c55e)');

console.log('\n[2] Campos do cartão');
ok(/<i>Fornecedor<\/i>Aliana/.test(hA) && /<i>Peso<\/i>614,5 kg/.test(hA) && /<i>Lote<\/i>02\/09\/26/.test(hA),
   'fornecedor, peso (614,5 kg) e lote em campos separados', hA);
ok(/<b>0<\/b> de 3 bags/.test(hA), 'contagem "0 de 3 bags" no alto à direita', hA);
ok(/<i>Peso<\/i>qualquer/.test(T.htmlPedido(ped({ peso: null }))), 'pedido sem peso (de antes de 10/11): "qualquer"');
ok(!/AMARELO BAIXA DENSIDADE · Amarelo/.test(hA), 'a cor não se repete quando já está no nome do material', hA);
const r = T.htmlPedidos({ pedidos: [ped(), ped({ id: 'RM-2', status: 'atendido', bags_atendidos: 3 })] });
ok(r.conta === '1 aberto' && r.temAberto === true, 'contador do cabeçalho: "1 aberto"', r.conta);
ok(r.lista.indexOf('RM-20261110-001') < r.lista.indexOf('RM-2"'), 'abertos antes dos atendidos');
ok(T.htmlPedidos({ pedidos: [] }).lista.includes('Nenhum pedido aberto'), 'sem pedido: "Nenhum pedido aberto"');

console.log('\n[3] Texto de fora não vira HTML');
const mau = '<img src=x onerror=alert(1)>';
const hX = T.htmlPedido(ped({ fornecedor: mau, lote_fmt: mau, autor_nome: mau, material_nome: mau, cor: mau,
                              id: '"><script>x()</script>', enderecos: [mau] }));
ok(!/<img|<script/i.test(hX) && hX.includes('&lt;img'), 'fornecedor, lote, autor, id, cor e endereço escapados', hX);
ok(/<i>Peso<\/i>qualquer/.test(T.htmlPedido(ped({ peso: '<b>' }))), 'peso que não é número não entra no HTML');

console.log('\n[4] Pedido de produto por saco: em SACOS desde 13/11 (era kg)');
const T2 = vm.runInNewContext(html.slice(ini, fim) + '\n;({ htmlPedido, linhaPedido })', {}, { timeout: 2000 });
const pkg = (extra = {}) => ped({ material_key: 'PIG', cor: 'Amarelo', material_nome: 'PIGMENTO AMARELO',
  fornecedor: 'Cristal Master', lote: '', lote_fmt: '', peso: null, bags_pedidos: null, bags_atendidos: 0,
  unidade: 'kg', kg_pedidos: 200, kg_atendidos: 0, kg_saco: 25, ...extra });
const hK = T2.htmlPedido(pkg());
ok(/<b>0<\/b> de 8 sacos/.test(hK) && !/bag/i.test(hK.replace(/pp-bags?/g, '')),
   'saco: "0 de 8 sacos" no alto (200 kg ÷ 25), sem "bags" (nem "0 de 0")', hK);
ok(!/\bkg\b/.test(hK) && /<i>Lote<\/i>qualquer/.test(hK) && !/<i>Peso<\/i>/.test(hK),
   'saco: nenhum "kg" no cartão (Gustavo 13/11) e lote "qualquer" (sem chip de peso)', hK);
ok(/<b>3<\/b> de 16 sacos/.test(T2.htmlPedido(pkg({ kg_pedidos: 400, sacos_pedidos: 16, sacos_atendidos: 3 }))),
   'saco: usa sacos_pedidos/sacos_atendidos da VPS quando vêm');
ok(/pp-barra"><span style="width:0%">/.test(hK) && !/pp-bag[ "]/.test(hK), 'kg: barra no lugar dos quadradinhos de bag', hK);
const hK2 = T2.htmlPedido(pkg({ kg_pedidos: 1975, kg_atendidos: 987.5, kg_saco: 20 }));
ok(/<b>49<\/b> de 99 sacos/.test(hK2) && /width:50%/.test(hK2) && sinalDe(hK2)?.dado === 'pendente',
   'saco de 20 kg: 987,5 de 1.975 kg = 49 de 99 sacos, barra na metade (pelo peso) e ainda "!"', hK2);
ok(sinalDe(T2.htmlPedido(pkg({ kg_atendidos: 200, status: 'atendido' })))?.dado === 'ok', 'kg atendido: V verde');
ok(T2.linhaPedido(pkg({ kg_atendidos: 100 })) === 'PIGMENTO AMARELO · Amarelo · Cristal Master · 4 de 8 sacos',
   'modal: pedido por saco em sacos, não "(0 de 0)" nem kg', T2.linhaPedido(pkg({ kg_atendidos: 100 })));
ok(T2.linhaPedido(ped()) === 'AMARELO BAIXA DENSIDADE · Amarelo · Aliana · Lote 020926 · 614,5 kg (0 de 3)',
   'modal: pedido de bag continua igual', T2.linhaPedido(ped()));
const hKx = T2.htmlPedido(pkg({ fornecedor: mau, kg_saco: mau, kg_pedidos: mau }));
ok(!/<img/i.test(hKx) && T2.linhaPedido(pkg({ fornecedor: mau })).includes('&lt;img'), 'kg: texto de fora escapado', hKx);

console.log(`\n ${passou} passaram, ${falhou} falharam`);
process.exit(falhou ? 1 : 0);
