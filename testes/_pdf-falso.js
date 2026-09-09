// ════════════════════════════════════════════════════════════════════
//  UMA GUIA DE MENTIRA, COM COORDENADAS DE VERDADE
//  ------------------------------------------------------------------
//  A guia de separação real é uma MATRIZ: produtos nas linhas, cargas
//  nas colunas. Quem é o dono de um número é a POSIÇÃO HORIZONTAL dele,
//  não a ordem em que o texto aparece no arquivo. Um fixture montado
//  como lista de linhas não exercita essa regra — e é justamente ela
//  que decide de qual cliente é cada fardo.
//
//  Este gerador escreve um PDF de uma página colocando cada texto na
//  coordenada pedida. Com ele dá para fabricar os casos que a guia real
//  não tem: uma carga só, o número do pedido escrito de outro jeito, um
//  formato que a fábrica não produz.
// ════════════════════════════════════════════════════════════════════
function pdfDeItens(itens, largura = 842, altura = 595) {
  const escP = t => String(t).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const corpo = itens.map(i =>
    `BT /F1 ${i.tam || 9} Tf 1 0 0 1 ${i.x} ${i.y} Tm (${escP(i.t)}) Tj ET`).join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${largura} ${altura}] `
      + '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(corpo, 'latin1')} >>\nstream\n${corpo}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
       + offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')
       + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

module.exports = { pdfDeItens };
