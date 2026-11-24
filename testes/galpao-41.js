// ════════════════════════════════════════════════════════════════════
//  RUA 01 ATÉ A POSIÇÃO 41, RUA 02 FICA EM 38 — Ekoplastic (24/11/2026)
//
//  Decisão do Gustavo: "Só rua 01, aumentar o mapa". Ele cola as etiquetas
//  01-01-039..041, 01-02-039..041 e 01-03-039..041; a rua 02 continua em 38.
//  O caso que importa é o do Mini PC, que JÁ TEM as 228 posições de 10/11,
//  com gaiola morando e bloqueio feito à mão. Na subida seguinte ele tem de
//  ganhar as 9 novas sem tocar em nada que existe.
//
//  Prova:
//   · banco de 228 (38 + 38, 1 ocupada, 1 bloqueio do usuário) vira 237;
//   · as 9 novas são 01-0N-039..041, livres, com o tipo certo por nível;
//   · 01-01-042 e 02-0N-039 não existem (o leitor recusa endereço que não existe);
//   · a ocupação, o bloqueio do usuário e os 2 bloqueios fixos continuam;
//   · subir de novo não muda nada (repetição).
//
//  Como rodar:  node testes/galpao-41.js
// ════════════════════════════════════════════════════════════════════

const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CARIMBO  = Date.now();
const TMP_DB   = path.join(os.tmpdir(), `eko_galpao41_${CARIMBO}.db`);
const TMP_LOGS = path.join(os.tmpdir(), `eko_galpao41_logs_${CARIMBO}`);
const ROOT     = path.join(__dirname, '..');

let passou = 0, falhou = 0;
function ok(cond, nome, detalhe = '') {
  if (cond) { passou++; console.log(`  \x1b[32m✓\x1b[0m ${nome}`); }
  else      { falhou++; console.log(`  \x1b[31m✗ ${nome}\x1b[0m ${detalhe}`); }
}
function eq(a, b, nome) { ok(a === b, nome, `(esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`); }

// Cada "subida" do Mini PC é um processo novo: o semear roda no require.
function subir(passo) {
  const r = spawnSync(process.execPath, ['-e', `
    const { db } = require(${JSON.stringify(path.join(ROOT, 'lib', 'db'))});
    ${passo}
  `], { env: { ...process.env, EKO_DB_FILE: TMP_DB, EKO_LOG_DIR: TMP_LOGS, TZ: 'America/Sao_Paulo' },
        encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0) throw new Error(`subida falhou: ${r.stderr || r.stdout}`);
  // o require do enderecamento loga a semeadura no stdout: o retrato é a última linha
  return r.stdout.trim().split('\n').pop();
}

const ENDERECAMENTO = JSON.stringify(path.join(ROOT, 'lib', 'enderecamento'));

function main() {
  console.log('\n[1] Mini PC com o banco de 10/11 (228 posições, uma gaiola, um bloqueio à mão)');
  subir(`
    const tipo = { 1: 'GRANDE', 2: 'PEQUENA', 3: 'PEQUENA' };
    const ins = db.prepare('INSERT INTO posicoes (codigo, rua, nivel, posicao, tipo_gaiola, bloqueada, motivo) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const cod = (r, n, p) => String(r).padStart(2,'0') + '-' + String(n).padStart(2,'0') + '-' + String(p).padStart(3,'0');
    for (const [r, vaos] of [[1, 38], [2, 38]]) for (let n = 1; n <= 3; n++) for (let p = 1; p <= vaos; p++) {
      const c = cod(r, n, p);
      const fixo = { '01-01-005': 'HIDRANTE', '01-01-006': 'ESPACO DA INFORMACAO' }[c];
      ins.run(c, r, n, p, tipo[n], fixo ? 1 : 0, fixo || null);
    }
    db.prepare("UPDATE posicoes SET bloqueada = 1, motivo = 'PRATELEIRA TORTA' WHERE codigo = '01-03-038'").run();
    db.prepare("INSERT INTO ocupacoes (posicao, gaiola_id, entrada, formato, cor, fardos, kg, tipo_gaiola) VALUES ('01-01-038', 'G0000888', '2026-11-20T10:00:00.000Z', '30x45', 'AZUL', 12, 600, 'GRANDE')").run();
  `);

  console.log('\n[2] Sobe o código novo');
  const fotografar = `
    require(${ENDERECAMENTO});
    const existe = c => !!db.prepare('SELECT 1 FROM posicoes WHERE codigo = ?').get(c);
    const d = {
      total: db.prepare('SELECT COUNT(*) n FROM posicoes').get().n,
      r1: db.prepare('SELECT COUNT(*) n, MAX(posicao) m FROM posicoes WHERE rua = 1').get(),
      r2: db.prepare('SELECT COUNT(*) n, MAX(posicao) m FROM posicoes WHERE rua = 2').get(),
      bloq: db.prepare('SELECT codigo, motivo FROM posicoes WHERE bloqueada = 1 ORDER BY codigo').all(),
      ocup: db.prepare('SELECT posicao, gaiola_id, saida FROM ocupacoes').all(),
      novas: db.prepare("SELECT codigo, tipo_gaiola, bloqueada FROM posicoes WHERE posicao > 38 ORDER BY codigo").all(),
      nao_existem: ['01-01-042', '01-03-042', '02-01-039', '02-02-039', '02-03-041'].filter(existe),
    };
    console.log(JSON.stringify(d));`;
  const d = JSON.parse(subir(fotografar));
  eq(d.total, 237, '237 posições no total ((41 + 38) vãos × 3 níveis)');
  eq(d.r1.n, 123, 'rua 01 com 41 vãos × 3 níveis');
  eq(d.r1.m, 41, 'rua 01 vai até a posição 41');
  eq(d.r2.n, 114, 'rua 02 continua com 38 vãos × 3 níveis');
  eq(d.r2.m, 38, 'rua 02 continua até a posição 38');
  eq(JSON.stringify(d.novas.map(p => [p.codigo, p.tipo_gaiola, p.bloqueada])), JSON.stringify([
    ['01-01-039', 'GRANDE', 0], ['01-01-040', 'GRANDE', 0], ['01-01-041', 'GRANDE', 0],
    ['01-02-039', 'PEQUENA', 0], ['01-02-040', 'PEQUENA', 0], ['01-02-041', 'PEQUENA', 0],
    ['01-03-039', 'PEQUENA', 0], ['01-03-040', 'PEQUENA', 0], ['01-03-041', 'PEQUENA', 0],
  ]), 'as 9 novas são 01-0N-039..041, livres, nível 01 para gaiola grande');
  eq(JSON.stringify(d.nao_existem), '[]', '01-0N-042 e 02-0N-039..041 não existem');
  eq(JSON.stringify(d.bloq), JSON.stringify([
    { codigo: '01-01-005', motivo: 'HIDRANTE' },
    { codigo: '01-01-006', motivo: 'ESPACO DA INFORMACAO' },
    { codigo: '01-03-038', motivo: 'PRATELEIRA TORTA' },
  ]), 'os 2 bloqueios fixos e o bloqueio feito à mão continuam, e nenhum novo');
  eq(JSON.stringify(d.ocup), JSON.stringify([{ posicao: '01-01-038', gaiola_id: 'G0000888', saida: null }]),
     'a gaiola que morava em 01-01-038 continua lá');

  console.log('\n[3] Sobe de novo (repetição): nada muda');
  const d2 = JSON.parse(subir(fotografar));
  eq(JSON.stringify(d2), JSON.stringify(d), 'segunda subida deixa o banco igual');
}

try { main(); }
catch (e) { falhou++; console.log(`  \x1b[31m✗ erro: ${e.message}\x1b[0m`); }
finally {
  for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.unlinkSync(f); } catch (e) {} }
  try { fs.rmSync(TMP_LOGS, { recursive: true, force: true }); } catch (e) {}
}
console.log(`\n${passou} ok, ${falhou} falha(s)`);
process.exit(falhou ? 1 : 0);
