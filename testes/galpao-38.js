// ════════════════════════════════════════════════════════════════════
//  GALPÃO ATÉ A POSIÇÃO 38 NAS DUAS RUAS — Ekoplastic (10/11/2026)
//
//  Pedido do Gustavo: "agora vai até a posição 38 dos dois lados" — rua 01
//  ia até 20 e rua 02 até 26. O caso que importa é o do Mini PC, que JÁ TEM
//  as 138 posições de antes, com gaiola morando e bloqueio feito à mão.
//  Na subida seguinte ele tem de GANHAR as novas sem tocar em nada que existe.
//
//  Prova:
//   · banco antigo (138 posições, 1 ocupada, 1 bloqueio do usuário) vira 228;
//   · a ocupação, o bloqueio do usuário e os 2 bloqueios fixos continuam;
//   · as novas nascem livres, com o tipo certo por nível, e nada passa de 38;
//   · subir de novo não muda nada (repetição).
//
//  Como rodar:  node testes/galpao-38.js
// ════════════════════════════════════════════════════════════════════

const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CARIMBO  = Date.now();
const TMP_DB   = path.join(os.tmpdir(), `eko_galpao38_${CARIMBO}.db`);
const TMP_LOGS = path.join(os.tmpdir(), `eko_galpao38_logs_${CARIMBO}`);
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
  console.log('\n[1] Mini PC com o banco de antes (138 posições, uma gaiola, um bloqueio à mão)');
  // Banco como o do Mini PC hoje: só as posições de 20 e 26 vãos.
  subir(`
    const tipo = { 1: 'GRANDE', 2: 'PEQUENA', 3: 'PEQUENA' };
    const ins = db.prepare('INSERT INTO posicoes (codigo, rua, nivel, posicao, tipo_gaiola, bloqueada, motivo) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const cod = (r, n, p) => String(r).padStart(2,'0') + '-' + String(n).padStart(2,'0') + '-' + String(p).padStart(3,'0');
    for (const [r, vaos] of [[1, 20], [2, 26]]) for (let n = 1; n <= 3; n++) for (let p = 1; p <= vaos; p++) {
      const c = cod(r, n, p);
      const fixo = { '01-01-005': 'HIDRANTE', '01-01-006': 'ESPACO DA INFORMACAO' }[c];
      ins.run(c, r, n, p, tipo[n], fixo ? 1 : 0, fixo || null);
    }
    db.prepare("UPDATE posicoes SET bloqueada = 1, motivo = 'PRATELEIRA TORTA' WHERE codigo = '02-03-010'").run();
    db.prepare("INSERT INTO ocupacoes (posicao, gaiola_id, entrada, formato, cor, fardos, kg, tipo_gaiola) VALUES ('02-01-026', 'G0000777', '2026-09-10T10:00:00.000Z', '30x45', 'AZUL', 12, 600, 'GRANDE')").run();
  `);

  console.log('\n[2] Sobe o código novo');
  const fotografar = `
    require(${ENDERECAMENTO});
    const d = {
      total: db.prepare('SELECT COUNT(*) n FROM posicoes').get().n,
      r1: db.prepare('SELECT COUNT(*) n, MAX(posicao) m FROM posicoes WHERE rua = 1').get(),
      r2: db.prepare('SELECT COUNT(*) n, MAX(posicao) m FROM posicoes WHERE rua = 2').get(),
      bloq: db.prepare('SELECT codigo, motivo FROM posicoes WHERE bloqueada = 1 ORDER BY codigo').all(),
      ocup: db.prepare('SELECT posicao, gaiola_id, saida FROM ocupacoes').all(),
      n38: db.prepare("SELECT codigo, tipo_gaiola, bloqueada FROM posicoes WHERE posicao = 38 ORDER BY codigo").all(),
      novas_ocupadas: db.prepare("SELECT COUNT(*) n FROM ocupacoes o JOIN posicoes p ON p.codigo = o.posicao WHERE (p.rua = 1 AND p.posicao > 20) OR (p.rua = 2 AND p.posicao > 26)").get().n,
    };
    console.log(JSON.stringify(d));`;
  const d = JSON.parse(subir(fotografar));
  eq(d.total, 228, '228 posições no total (38 vãos × 3 níveis × 2 ruas)');
  eq(d.r1.n, 114, 'rua 01 com 38 vãos × 3 níveis');
  eq(d.r2.n, 114, 'rua 02 com 38 vãos × 3 níveis');
  eq(d.r1.m, 38, 'rua 01 vai até a posição 38');
  eq(d.r2.m, 38, 'rua 02 vai até a posição 38');
  eq(JSON.stringify(d.bloq), JSON.stringify([
    { codigo: '01-01-005', motivo: 'HIDRANTE' },
    { codigo: '01-01-006', motivo: 'ESPACO DA INFORMACAO' },
    { codigo: '02-03-010', motivo: 'PRATELEIRA TORTA' },
  ]), 'os 2 bloqueios fixos e o bloqueio feito à mão continuam, e nenhum novo');
  eq(JSON.stringify(d.ocup), JSON.stringify([{ posicao: '02-01-026', gaiola_id: 'G0000777', saida: null }]),
     'a gaiola que morava em 02-01-026 continua lá');
  eq(d.novas_ocupadas, 0, 'as posições novas nascem livres');
  eq(JSON.stringify(d.n38.map(p => [p.codigo, p.tipo_gaiola, p.bloqueada])), JSON.stringify([
    ['01-01-038', 'GRANDE', 0], ['01-02-038', 'PEQUENA', 0], ['01-03-038', 'PEQUENA', 0],
    ['02-01-038', 'GRANDE', 0], ['02-02-038', 'PEQUENA', 0], ['02-03-038', 'PEQUENA', 0],
  ]), 'a posição 38 existe nos 3 níveis das 2 ruas, nível 01 para gaiola grande');

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
