// ════════════════════════════════════════════════════════════════════
//  A GUIA COM O NOME DO PRODUTO PARTIDO
//  ------------------------------------------------------------------
//  O mesmo documento do painel de carteira, exportado com a coluna do
//  produto mais estreita — foi o que aconteceu quando o Frederico
//  baixou a guia pelo CELULAR. O rótulo, que numa folha larga sai
//  inteiro numa linha só:
//
//      ↳ SACOLA RECICLADA COLORIDA (25KG)
//        TAMANHO:30X45
//
//  quebra em outro lugar e vira:
//
//      ↳ SACOLA RECICLADA COLORIDA
//        (25KG) TAMANHO:30X45          ← um pedaço de texto só
//
//  A diferença parece cosmética e não é: o leitor via "(25KG)", achava
//  que era um cabeçalho de produto novo, não reconhecia cor nenhuma
//  nele e APAGAVA a cor corrente — aí todos os itens caíam fora e a
//  tela dizia "o que está nela não é do galpão". A guia estava certa; a
//  régua é que estava errada.
//
//  Uso:  node testes/dados/gerar-guia-partida.js
// ════════════════════════════════════════════════════════════════════
const fs = require('node:fs');
const path = require('node:path');
const { pdfDeItens } = require('../_pdf-falso.js');

// Duas cargas, três produtos, com os totais impressos — para a
// conferência contra a própria guia também ser exercitada.
const itens = [
  { x:  34, y: 552, t: 'GUIA DE SEPARAÇÃO / CARREGAMENTO — 10/09/2026' },
  { x: 383, y: 517, t: 'CARGA 1 · Entrega #2' },
  { x: 495, y: 517, t: 'CARGA 2 · Entrega #1' },
  { x: 318, y: 509, t: 'TOTAL' },
  { x: 367, y: 509, t: 'PRIMEIRO CLIENTE LTDA |' },
  { x: 479, y: 509, t: 'SEGUNDO CLIENTE ME |' },
  { x:  40, y: 505, t: 'PRODUTO / FAMÍLIA' },
  { x: 249, y: 505, t: 'TOTAL kg' },
  { x: 319, y: 501, t: 'fardos' },
  { x: 401, y: 501, t: 'Ped.2201' },
  { x: 513, y: 501, t: 'Ped.2202' },
  { x: 395, y: 494, t: 'Imperatriz/MA' },
  { x: 507, y: 494, t: 'Teresina/PI' },

  // ── produto 1: o nome quebra ANTES do "(25KG)" ──
  { x:  40, y: 479, t: 'Sacola Reciclada Colorida' },
  { x:  47, y: 463, t: '↳' },
  { x:  53, y: 463, t: 'SACOLA RECICLADA COLORIDA' },
  { x:  47, y: 454, t: '(25KG) TAMANHO:30X45' },      // ← o pedaço que quebrava tudo
  { x: 409, y: 454, t: '24 frd' },
  { x: 521, y: 454, t: '16 frd' },

  { x:  53, y: 438, t: 'SACOLA RECICLADA COLORIDA' },
  { x:  47, y: 429, t: '(25KG) TAMANHO:40X50' },
  { x: 409, y: 429, t: '40 frd' },

  // ── produto 2: cor diferente, mesma quebra ──
  { x:  40, y: 410, t: 'Sacola Semi Virgem Branca' },
  { x:  53, y: 394, t: 'SACOLA SEMI-VIRGEM BRANCA' },
  { x:  47, y: 385, t: '(25KG) TAMANHO:50X60' },
  { x: 521, y: 385, t: '20 frd' },

  // ── rodapé: os totais que a própria guia imprime ──
  { x:  40, y: 350, t: 'TOTAL GERAL' },
  { x: 249, y: 350, t: '2.500' },
  { x: 319, y: 350, t: '100' },
  { x: 409, y: 330, t: '64 frd' },
  { x: 521, y: 330, t: '36 frd' },
];

const destino = path.join(__dirname, 'guia-nome-partido.pdf');
fs.writeFileSync(destino, pdfDeItens(itens));
console.log('gravado:', destino);
