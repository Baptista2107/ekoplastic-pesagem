#!/usr/bin/env node
'use strict';
/* ==========================================================================
 * Ekoplastic Pesagem - conferencia da troca de pastas
 * --------------------------------------------------------------------------
 * Compara o healthcheck gravado ANTES da troca, com o sistema ainda rodando
 * na pasta antiga, contra o healthcheck da pasta nova depois da copia.
 *
 * O que isso prova: que o banco veio inteiro. O etiquetas.db-wal guarda o que
 * ainda nao foi gravado dentro do .db, e o encerramento pela tela nao faz
 * checkpoint. Se alguem copiar so' o .db, as contagens despencam - e e' isso
 * que este script pega.
 *
 * Uso:  node comparar-troca.js _referencia-troca.txt http://localhost:3000/healthcheck
 * Codigo de saida: 0 = pode seguir, 1 = NAO troque as pastas.
 * ========================================================================== */
const fs = require('fs');

const [arqRef, url] = process.argv.slice(2);
if (!arqRef || !url) {
  console.log('uso: node comparar-troca.js <arquivo-referencia> <url-healthcheck>');
  process.exitCode = 1;
  return;
}

function contagens(obj) {
  const b = (obj && obj.banco) || {};
  return { etiquetas: Number(b.etiquetas), sessoes: Number(b.sessoes), versao: obj && obj.versao };
}

(async () => {
  let antes, depois;
  try {
    antes = contagens(JSON.parse(fs.readFileSync(arqRef, 'utf8')));
  } catch (e) {
    console.log('ERRO: nao consegui ler a referencia -> ' + e.message);
    process.exitCode = 1; return;
  }
  try {
    const r = await fetch(url);
    depois = contagens(await r.json());
  } catch (e) {
    console.log('ERRO: nao consegui ler o healthcheck da pasta nova -> ' + e.message);
    process.exitCode = 1; return;
  }

  const linha = (rot, a, b) => {
    const dif = b - a;
    const marca = dif < 0 ? '  <<< PERDEU DADO' : (dif === 0 ? '  igual' : '  +' + dif + ' durante a troca');
    console.log('  ' + rot.padEnd(12) + String(a).padStart(8) + ' -> ' + String(b).padStart(8) + marca);
  };

  console.log('');
  console.log('  ' + 'campo'.padEnd(12) + '   antes'.padStart(8) + '      depois');
  console.log('  ' + '-'.repeat(46));
  linha('etiquetas', antes.etiquetas, depois.etiquetas);
  linha('sessoes',   antes.sessoes,   depois.sessoes);
  console.log('');
  console.log('  versao antes .: ' + antes.versao);
  console.log('  versao depois : ' + depois.versao);
  console.log('');

  const perdeu = depois.etiquetas < antes.etiquetas || depois.sessoes < antes.sessoes;
  if (perdeu) {
    console.log('  RESULTADO: NAO TROQUE AS PASTAS.');
    console.log('  A pasta nova tem MENOS registros que a antiga tinha. O banco');
    console.log('  veio incompleto - provavelmente o etiquetas.db-wal ficou para');
    console.log('  tras. A pasta antiga continua intacta: feche o sistema desta');
    console.log('  pasta nova e volte a subir pela pasta antiga.');
    process.exitCode = 1;
  } else {
    console.log('  RESULTADO: banco veio inteiro. Pode seguir.');
    console.log('  Antes de liberar o turno: pese uma vez e imprima uma etiqueta.');
    process.exitCode = 0;
  }
})();
