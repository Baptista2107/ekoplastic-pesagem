// ════════════════════════════════════════════════════════════════════
//  OUTRAS PESAGENS no coletor: o bloco de estilo do TC60 casa com o <body>
//  (25/11/2026)
//  ------------------------------------------------------------------
//  O bloco <style id="estilo-coletor"> de public/outras-pesagens.html prendia
//  cada regra ao NOME MOSTRADO da tela (body[data-tela="Resíduos"]). O main
//  renomeou a tela para "Outras Pesagens", o merge entrou limpo e o layout
//  do coletor sumiu calado (54 falhas no residuos_tc60.py). Agora o bloco usa
//  um gancho que não muda com o nome: <body data-pagina="outras">.
//
//  Sem navegador e sem servidor, lendo o arquivo:
//   [1] o <body> tem data-pagina="outras";
//   [2] toda regra dentro do @media do bloco começa por
//       body[data-pagina="outras"] (nenhuma vaza para outra tela nem
//       depende do nome mostrado);
//   [3] todo atributo body[...] usado no bloco existe no <body> com o mesmo
//       valor (pega o "renomeou e ninguém viu");
//   e fora do @media o bloco só esconde as peças do coletor (display: none):
//   qualquer outra regra ali valeria no monitor do Mini PC.
//  (O celular.css já é conferido em bobina-alta-densidade.js [10]: todo
//  data-tela dele existe numa tela.)
//
//  O celular.css (compartilhado) ainda prende as regras estruturais desta
//  tela ao data-tela="Outras Pesagens": renomear a tela de novo exige mudar
//  lá também.
// ════════════════════════════════════════════════════════════════════
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'outras-pesagens.html'), 'utf8');
let passou = 0, falhou = 0;
function ok(cond, msg, extra) {
  if (cond) { passou++; console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
  else { falhou++; console.log(`  \x1b[31m✗\x1b[0m ${msg}` + (extra !== undefined ? `  [${typeof extra === 'string' ? extra : JSON.stringify(extra)}]` : '')); }
}

// Atributos do <body> de verdade.
const tagBody = (html.match(/<body\b[^>]*>/) || [''])[0];
const attrsBody = {};
for (const m of tagBody.matchAll(/([\w-]+)="([^"]*)"/g)) attrsBody[m[1]] = m[2];

// Bloco do coletor e o @media de dentro dele (até a chave que fecha).
// Comentários fora antes de tudo: uma chave dentro de comentário cortaria o @media.
const bloco = ((html.match(/<style id="estilo-coletor">([\s\S]*?)<\/style>/) || [, ''])[1]).replace(/\/\*[\s\S]*?\*\//g, '');
function partesDoMedia(css) {
  const i = css.indexOf('@media');
  if (i < 0) return ['', css];
  let n = 0, ini = css.indexOf('{', i);
  for (let k = ini; k < css.length; k++) {
    if (css[k] === '{') n++;
    else if (css[k] === '}' && --n === 0) return [css.slice(ini + 1, k), css.slice(0, i) + css.slice(k + 1)];
  }
  return ['', css];
}
function corpoDoMedia(css) { return partesDoMedia(css)[0]; }
// Seletores das regras (comentários fora; cada regra = "seletores { ... }").
function seletores(css) {
  const limpo = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  for (const m of limpo.matchAll(/([^{}]+)\{[^{}]*\}/g))
    for (const s of dividir(m[1])) if (s.trim()) out.push(s.trim().replace(/\s+/g, ' '));
  return out;
}
// Vírgula de lista de seletores, não a de dentro de :has(a, b) / :is(...).
function dividir(lista) {
  const out = []; let nivel = 0, atual = '';
  for (const ch of lista) {
    if (ch === '(') nivel++;
    else if (ch === ')') nivel--;
    if (ch === ',' && nivel === 0) { out.push(atual); atual = ''; } else atual += ch;
  }
  out.push(atual);
  return out;
}

console.log('\n[1] <body> com o gancho estável');
ok(attrsBody['data-pagina'] === 'outras', '<body data-pagina="outras">', tagBody);

console.log('\n[2] Regras do coletor presas ao gancho');
const media = corpoDoMedia(bloco);
ok(bloco && media, 'bloco <style id="estilo-coletor"> com @media achado');
const sels = seletores(media);
// Todo "body[" do bloco tem de estar num seletor lido: nada truncado nem perdido.
const nBody = (media.match(/body\[/g) || []).length;
ok(sels.length > 50 && sels.length === nBody, `${sels.length} seletores no @media do bloco (= ${nBody} "body[")`);
const fora = sels.filter(s => !s.startsWith('body[data-pagina="outras"]'));
ok(fora.length === 0, 'todo seletor começa por body[data-pagina="outras"]', fora.slice(0, 5));
ok(!sels.some(s => /data-tela/.test(s)), 'nenhum seletor depende do nome mostrado (data-tela)',
   sels.filter(s => /data-tela/.test(s)).slice(0, 3));

// Fora do @media o bloco vale no monitor do Mini PC: só pode esconder as
// peças que existem só no coletor.
const resto = seletores(partesDoMedia(bloco)[1]);
const PERMITIDO = ['.ultima-etq', '.peso-item', '.peso-liq'];
const regrasFora = [...partesDoMedia(bloco)[1].matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => [m[1].trim(), m[2].trim()]);
ok(resto.every(s => PERMITIDO.includes(s)) && regrasFora.every(([, d]) => /^display:\s*none;?$/.test(d)),
   'fora do @media só "display: none" das peças do coletor (o monitor não muda)', regrasFora);

console.log('\n[3] Atributos do body usados no bloco existem no <body>');
const usados = new Set();
for (const s of seletores(bloco))
  for (const m of s.matchAll(/body\[([\w-]+)="([^"]*)"\]/g)) usados.add(`${m[1]}=${m[2]}`);
ok(usados.size > 0, 'o bloco usa atributo do body', [...usados]);
for (const u of usados) {
  const [k, v] = u.split('=');
  ok(attrsBody[k] === v, `body tem ${k}="${v}"`, `body: ${k}=${JSON.stringify(attrsBody[k])}`);
}

console.log(`\n${passou} passaram, ${falhou} falharam`);
process.exit(falhou ? 1 : 0);
