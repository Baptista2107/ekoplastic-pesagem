// ════════════════════════════════════════════════════════════════════
//  LEITURA DA GUIA DE SEPARAÇÃO EM PDF
//  ------------------------------------------------------------------
//  O PDF da guia tem camada de texto. A tela extrai as linhas com o
//  pdf.js e o servidor as interpreta. Este teste exercita o servidor:
//  dá as linhas e confere que sai a carga certa.
//
//  O que mais importa aqui é a coluna EDITADO. Usar a ORIGINAL mandaria
//  separar o que o cliente não vai levar — e ninguém perceberia até o
//  caminhão estar carregado errado.
// ════════════════════════════════════════════════════════════════════
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');

const ROOT = path.join(__dirname, '..');
const PORT = 13907, PORT_CB = 18907;
const BASE = `http://localhost:${PORT}`;
const C = Date.now();
const TMP_DB   = path.join(os.tmpdir(), `eko_gp_${C}.db`);
const TMP_LOGS = path.join(os.tmpdir(), `eko_gp_${C}`);
const TMP_GUIA = path.join(os.tmpdir(), `eko_gpg_${C}`);

let passou = 0, falhou = 0, servidor;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function ok(cond, msg, extra) {
  if (cond) { passou++; console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
  else { falhou++; console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
         if (extra !== undefined) console.log('      →', JSON.stringify(extra).slice(0, 400)); }
}
async function req(metodo, rota, corpo) {
  const opc = { method: metodo, headers: {} };
  if (corpo !== undefined) { opc.body = JSON.stringify(corpo); opc.headers['Content-Type'] = 'application/json'; }
  const r = await fetch(BASE + rota, opc);
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, body: j };
}

// As linhas como o pdf.js as entrega: cada altura da página vira uma
// linha, os pedaços juntados pela ordem horizontal.
const GUIA = [
  'PEDIDOS DA SELECAO',
  'TOTAL EDITADO: 7.700 kg',
  '',
  'ILHA PLASTIC COMERCIO ATACADISTA DE EMBALAGENS LTDA',
  'Teresina - PI',
  'FORMATO PRODUTO ORIGINAL EDITADO',
  'BRANCA',
  'TAMANHO: 50x60 800 750',
  'TAMANHO: 40x50 300 250',
  'PRETA',
  'TAMANHO: 40x50 500 500',
  '',
  'EMBALO EMBALAGENS EIRELI',
  'Parnaiba - PI',
  'FORMATO PRODUTO ORIGINAL EDITADO',
  'COLORIDA',
  'TAMANHO: 30x40 1.200 1.000',
  'TAMANHO: 60x80 250 200',
  '',
  'A C M DA SILVA COMERCIO - ME',
  'Timon - MA',
  'FORMATO PRODUTO ORIGINAL EDITADO',
  'AMARELA',
  'TAMANHO: 30x45 500 500',
  'BRANCA',
  'TAMANHO: 80x100 100 100',
];

(async () => {
  try {
    console.log('\n═══════════════════════════════════════════════════');
    console.log(' GUIA DE SEPARAÇÃO EM PDF — Ekoplastic');
    console.log('═══════════════════════════════════════════════════\n');
    servidor = spawn('node', [path.join(ROOT, 'server.js')], {
      env: { ...process.env, EKO_PORT: String(PORT), EKO_PORT_CB: String(PORT_CB),
             EKO_DB_FILE: TMP_DB, EKO_LOG_DIR: TMP_LOGS, EKO_GUIAS_DIR: TMP_GUIA,
             TZ: 'America/Sao_Paulo', EKO_PRINT_SIMULAR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    servidor.stdout.on('data', () => {});
    for (let i = 0; i < 75; i++) {
      try { const r = await fetch(BASE + '/healthcheck'); if (r.ok) break; } catch (e) {}
      await sleep(200);
    }

    // ── [1] A LEITURA ───────────────────────────────────────────────
    console.log('[1] A guia inteira é lida do PDF, sem ninguém digitar');
    const pv = await req('POST', '/separacao/guia/previa', { linhas: GUIA });
    ok(pv.status === 200 && pv.body.pedidos.length === 3,
       `os 3 clientes da guia foram reconhecidos: ${pv.body.pedidos.length}`, pv.body);
    const p = pv.body.pedidos;
    ok(p[0].cliente.startsWith('ILHA PLASTIC'), `o nome sai inteiro: "${p[0].cliente}"`);
    ok(p[0].cidade === 'Teresina' && p[0].uf === 'PI', `cidade e UF: ${p[0].cidade}/${p[0].uf}`);
    ok(p[2].cliente === 'A C M DA SILVA COMERCIO - ME',
       'nome com hífen não é confundido com cidade');

    // ── [2] A COLUNA QUE VALE É A EDITADO ───────────────────────────
    console.log('\n[2] Vale a coluna EDITADO — a ORIGINAL é histórico');
    const i0 = p[0].itens[0];
    ok(i0.kg === 750, `50x60 BRANCA: leu 750 (EDITADO), não 800 (ORIGINAL): ${i0.kg}`);
    ok(i0.fardos === 30, `e converteu para 30 fardos de 25 kg: ${i0.fardos}`);
    const rec = p[1].itens[0];
    ok(rec.kg === 1000, `número com ponto de milhar: "1.200 1.000" → ${rec.kg}`);
    ok(pv.body.total_kg === 750 + 250 + 500 + 1000 + 200 + 500 + 100,
       `total confere com a guia: ${pv.body.total_kg} kg`);

    // ── [3] CORES E FORMATOS DO GALPÃO ──────────────────────────────
    console.log('\n[3] As cores da guia viram as chaves do galpão');
    ok(p[0].itens[0].cor_key === 'BC' && p[0].itens[2].cor_key === 'PT',
       'BRANCA→BC e PRETA→PT, com a cor valendo até a próxima');
    ok(p[1].itens[0].cor_key === 'REC', 'COLORIDA→REC');
    ok(p[2].itens[0].cor_key === 'AM' && p[2].itens[1].cor_key === 'BC',
       'AMARELA→AM e a BRANCA seguinte troca a cor corrente');
    ok(p[2].itens[1].formato === '80x100', 'formato de 3 dígitos (80x100) é lido certo');

    // ── [4] O QUE NÃO FOR ENTENDIDO NÃO SOME ────────────────────────
    console.log('\n[4] Linha não entendida é reportada, nunca descartada calada');
    const estranho = await req('POST', '/separacao/guia/previa', { linhas: [
      'CLIENTE TESTE LTDA', 'Teresina - PI', 'FORMATO PRODUTO ORIGINAL EDITADO',
      'BRANCA', 'TAMANHO: 50x60 800 750',
      'TAMANHO: 90x90 100 100',          // formato que a fábrica não faz
      'VERDE', 'TAMANHO: 30x40 200 200', // cor que não existe no galpão
    ]});
    const av = estranho.body.avisos;
    // três: o formato que a fábrica não faz, o cabeçalho VERDE, e o item
    // que ficou órfão de cor por causa dele.
    ok(av.length === 3, `as três linhas problemáticas foram reportadas: ${av.length}`, av);
    ok(av.every(a => a.cliente === 'CLIENTE TESTE LTDA'),
       'cada aviso diz de qual cliente é', av.map(a => a.cliente));
    ok(av.some(a => /cor "VERDE" não existe/.test(a.motivo)),
       'a cor desconhecida NÃO herda a anterior — seria produto errado no caminhão');
    ok(av.some(a => /90x90/.test(a.linha) && /não é do galpão/.test(a.motivo)),
       'formato que a fábrica não produz é apontado');
    ok(av.some(a => /30x40/.test(a.linha)), 'cor desconhecida também é apontada');
    ok(estranho.body.pedidos[0].itens.length === 1,
       'e só o item bom entra na carga — não entra lixo');

    // ── [5] PDF SEM TEXTO É RECUSADO COM CLAREZA ────────────────────
    console.log('\n[5] PDF que é imagem digitalizada é recusado explicando');
    const vazio = await req('POST', '/separacao/de-guia', { linhas: [] });
    ok(vazio.status === 400 && /imagem/.test(vazio.body.erro || ''),
       'diz que o PDF pode ser imagem em vez de dar erro genérico', vazio.body);
    const semAncora = await req('POST', '/separacao/de-guia', { linhas: ['bla', 'ble', 'bli'] });
    ok(semAncora.status === 422 && /FORMATO/.test(semAncora.body.erro || ''),
       'e diz qual cabeçalho procurou quando não achou nada', semAncora.body);

    // ── [6] DA GUIA AO PLANO, DIRETO ────────────────────────────────
    console.log('\n[6] Da guia ao plano de coleta, sem passo manual');
    const cri = await req('POST', '/separacao/de-guia', { linhas: GUIA, operador: 'FREDERICO' });
    ok(cri.status === 200 && cri.body.id, 'a carga nasceu do PDF', cri.body);
    const SEP = cri.body.id;
    ok(cri.body.status === 'conferida', 'já nasce conferida — o dado veio do documento');

    const est = await req('GET', `/separacao/${SEP}`);
    ok(est.body.pedidos.length === 3, 'três pedidos gravados');
    ok(est.body.pedidos[0].ordem === 1 && est.body.pedidos[0].cliente.startsWith('ILHA'),
       'a ordem de carregamento nasce igual à da guia — e dá para mudar depois');
    const totalFardos = est.body.pedidos.reduce(
      (a, x) => a + x.itens.reduce((s, i) => s + i.fardos, 0), 0);
    ok(totalFardos === 30 + 10 + 20 + 40 + 8 + 20 + 4, `total em fardos: ${totalFardos}`);

    // estoque parcial: o plano tem que sair mesmo faltando produção
    const g = await req('POST', '/produto-acabado/etiqueta-gaiola',
                        { corKey: 'BC', formato: '50x60', fardos: 30, tipo_gaiola: 'GRANDE' });
    await req('POST', '/enderecamento/ocupar',
              { posicao: '01-01-001', gaiola_id: g.body.id, tipo_gaiola: 'GRANDE' });
    const pl = await req('POST', `/separacao/${SEP}/planejar`);
    ok(pl.status === 200 && pl.body.coletas.length === 1, 'plano gerado com o que existe');
    ok(pl.body.falta.fardos > 0, `e aponta o que ainda está em produção: ${pl.body.falta.fardos} fardos`);
    ok(pl.body.falta.por_item.length >= 3, 'dizendo de quais pedidos, um a um');

    // ── [8] A GUIA DE VERDADE DA FÁBRICA ────────────────────────────
    // Este é o arquivo real: "Guia separação Imperatriz", 4 cargas,
    // 11.700 kg. A guia é uma MATRIZ — produtos nas linhas, cargas nas
    // colunas — e a coluna de cada quantidade é dada pela posição
    // horizontal. Ler como texto corrido perde de quem é cada número.
    console.log('\n[8] A guia real da fábrica (formato matriz)');
    const real = fs.readFileSync(path.join(__dirname, 'dados', 'guia-imperatriz.pdf'));
    const rp = await fetch(`${BASE}/separacao/guia/previa`,
      { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: real });
    const rj = await rp.json();
    ok(rp.status === 200 && rj.formato_lido === 'matriz',
       `reconheceu o formato matriz: ${rj.formato_lido}`, rj.erro);
    ok(rj.pedidos.length === 4, `as 4 cargas da guia: ${(rj.pedidos||[]).length}`);
    ok(rj.total_fardos === 468 && rj.total_kg === 11700,
       `total: ${rj.total_fardos} fardos · ${rj.total_kg} kg`);
    ok(rj.avisos.length === 0, 'nenhuma linha ficou sem entender', rj.avisos);

    const [cg1, cg2, cg3, cg4] = rj.pedidos;
    ok(cg1.cliente === 'F E A LIMA COMERCIO ME' && cg1.pedido_numero === '1063',
       `1ª carga: ${cg1.cliente} (Ped.${cg1.pedido_numero})`);
    ok(cg3.cliente === 'CASA DO TEMPERO LTDA' && cg3.cidade === 'Imperatriz' && cg3.uf === 'MA',
       `3ª carga: ${cg3.cliente} — ${cg3.cidade}/${cg3.uf}`);
    ok(cg1.cliente === cg2.cliente && cg1.pedido_numero !== cg2.pedido_numero,
       'o mesmo cliente em duas cargas continua sendo duas cargas separadas');
    const soma = p => p.itens.reduce((a, i) => a + i.fardos, 0);
    ok(soma(cg1) === 120 && soma(cg2) === 140 && soma(cg3) === 160 && soma(cg4) === 48,
       `fardos por carga: ${[cg1,cg2,cg3,cg4].map(soma).join(' · ')} (rodapé da guia: 120 · 140 · 160 · 48)`);
    ok(cg1.itens.every(i => i.cor_key === 'REC') && cg2.itens.every(i => i.cor_key === 'BC'),
       'as cores saem certas: 1ª carga toda Colorida, 2ª toda Branca');
    const i40 = cg1.itens.find(i => i.formato === '40x50');
    ok(i40 && i40.fardos === 80, `40x50 da 1ª carga: ${i40 && i40.fardos} fardos (2.000 kg)`);

    // ── [8b] A CONFERÊNCIA CONTRA A PRÓPRIA GUIA ────────────────────
    // A guia imprime os próprios totais. Comparar com eles é a única
    // checagem que não depende de eu ter entendido o layout: se um dia
    // o formato mudar e a leitura ficar torta, isto acusa na hora.
    console.log('\n[8b] A leitura é conferida contra os totais impressos na guia');
    ok(rj.conferencia && rj.conferencia.ok === true,
       'bate com o TOTAL GERAL e com o rodapé de cada carga', rj.conferencia);
    ok(rj.conferencia.guia_kg === 11700 && rj.conferencia.guia_fardos === 468,
       `leu os totais impressos: ${rj.conferencia.guia_kg} kg · ${rj.conferencia.guia_fardos} fardos`);

    const criR = await fetch(`${BASE}/separacao/de-guia`,
      { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: real });
    const cj = await criR.json();
    ok(criR.status === 200 && cj.id, 'a carga real é criada a partir do PDF', cj.erro);
    const estR = await req('GET', `/separacao/${cj.id}`);
    ok(estR.body.pedidos.length === 4 && estR.body.pedidos[0].ordem === 1,
       'e fica gravada com as 4 cargas na ordem das colunas');

    // ── [7a] LAYOUT DESCONHECIDO VIRA DIAGNÓSTICO, NÃO BECO SEM SAÍDA ──
    console.log('\n[7a] Guia de layout diferente devolve o que foi lido');
    const outro = await req('POST', '/separacao/de-guia', { linhas: [
      'RELATORIO DE CARGA', 'Cliente: FULANO LTDA', 'Item 1 .... 300 kg' ] });
    ok(outro.status === 422, 'recusa quando não reconhece o layout', outro.body && outro.body.erro);
    ok(Array.isArray(outro.body.linhas) && outro.body.linhas.length === 3,
       'e devolve as linhas que leu — é com elas que se descobre a diferença',
       outro.body.linhas);
    const pvOutro = await req('POST', '/separacao/guia/previa', { linhas: [
      'RELATORIO DE CARGA', 'Cliente: FULANO LTDA', 'Item 1 .... 300 kg' ] });
    ok(pvOutro.body.pedidos.length === 0 && pvOutro.body.linhas.length === 3,
       'a prévia também devolve as linhas, para a tela mostrar o diagnóstico');

    // ── [7b] O CAMINHO REAL: MANDAR O PDF, O SERVIDOR LÊ ────────────
    // É este o caminho que o celular usa. A primeira versão lia o PDF no
    // navegador com módulo ES e falhou no galpão; agora quem lê é o
    // servidor, que é sempre o mesmo Node.
    console.log('\n[7b] O servidor lê o PDF sozinho — o celular só envia o arquivo');
    const pdfReal = fs.readFileSync(path.join(__dirname, 'dados', 'guia-exemplo.pdf'));
    const pv2 = await fetch(`${BASE}/separacao/guia/previa`,
      { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: pdfReal });
    const j2 = await pv2.json();
    ok(pv2.status === 200 && j2.pedidos.length === 3,
       `o servidor extraiu o texto e achou os 3 clientes: ${(j2.pedidos||[]).length}`, j2.erro);
    ok(j2.total_fardos === 132, `mesma leitura do caminho por linhas: ${j2.total_fardos} fardos`);
    ok(Array.isArray(j2.linhas) && j2.linhas.some(l => /TAMANHO/.test(l)),
       'devolve as linhas cruas junto, para diagnosticar layout diferente');

    const cri2 = await fetch(`${BASE}/separacao/de-guia`,
      { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: pdfReal });
    const c2 = await cri2.json();
    ok(cri2.status === 200 && c2.id, 'e a carga é criada mandando só o arquivo', c2.erro);
    const g2 = await fetch(`${BASE}/separacao/${c2.id}/guia`);
    ok(g2.status === 200 && String(g2.headers.get('content-type')).includes('pdf'),
       'o PDF fica guardado sozinho, sem passo extra');

    const naoPdf = await fetch(`${BASE}/separacao/guia/previa`, {
      method: 'POST', headers: { 'Content-Type': 'application/pdf' },
      body: Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
                         11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
                         25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38,
                         39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52,
                         53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66,
                         67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80,
                         81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94,
                         95, 96, 97, 98, 99, 100, 101, 102]) });
    const nj = await naoPdf.json();
    ok(naoPdf.status === 415 && /não é um PDF/.test(nj.erro || ''),
       'mandar uma foto no lugar do PDF é recusado com clareza', nj);

    // ── [7] O PDF FICA GUARDADO COMO COMPROVANTE ────────────────────
    console.log('\n[7] O PDF fica anexado à carga');
    const pdfBytes = fs.readFileSync(path.join(__dirname, 'dados', 'guia-exemplo.pdf'));
    const anex = await fetch(`${BASE}/separacao/${SEP}/guia`,
      { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: pdfBytes });
    const aj = await anex.json();
    ok(anex.status === 200 && /\.pdf$/.test(aj.arquivo || ''), `guardado como ${aj.arquivo}`, aj);
    const volta = await fetch(`${BASE}/separacao/${SEP}/guia`);
    ok(volta.status === 200 && String(volta.headers.get('content-type')).includes('pdf'),
       'e volta como PDF, para conferir depois');

  } catch (e) {
    falhou++;
    console.error('\n\x1b[31mERRO NO TESTE:\x1b[0m', e.stack || e.message);
  } finally {
    console.log('\n═══════════════════════════════════════════════════');
    console.log(` RESULTADO: ${passou} passou, ${falhou} falhou`);
    console.log('═══════════════════════════════════════════════════\n');
    try { servidor && servidor.kill('SIGKILL'); } catch (e) {}
    for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.rmSync(f, { force: true }); } catch (e) {} }
    for (const d of [TMP_LOGS, TMP_GUIA]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }
    setTimeout(() => process.exit(falhou ? 1 : 0), 200);
  }
})();
