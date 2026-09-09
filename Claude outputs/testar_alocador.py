# ════════════════════════════════════════════════════════════════════
#  PROVA DO ALOCADOR
#  Cenários com números de verdade da fábrica: 25 kg por fardo, cores
#  AM/BC/PT/REC, formatos reais, gaiolas de 18 a 30 fardos.
# ════════════════════════════════════════════════════════════════════
import sys, random, itertools
sys.path.insert(0, '/home/claude/sep')
from alocador import Gaiola, ItemPedido, Pedido, alocar, rota_de_coleta, escolher_gaiolas

KG = 25
falhas = []
def ok(cond, msg):
    print(('  \033[32mv\033[0m ' if cond else '  \033[31mx\033[0m ') + msg)
    if not cond: falhas.append(msg)


def g(id, pos, cor, fmt, fardos, dia):
    return Gaiola(id=id, posicao=pos, cor=cor, formato=fmt, fardos=fardos,
                  entrada=f'2026-08-{dia:02d}T08:00:00Z')


print('\n═══ [1] SOMA EXATA: a carga fecha sem sobrar nada ═══')
# 3 gaiolas de 24, 20 e 16. Demanda 44 = 24+20 exatos.
gs = [g('G0000001','01-01-001','BC','50x60',24,10),
      g('G0000002','01-01-002','BC','50x60',20,11),
      g('G0000003','02-01-005','BC','50x60',16,12)]
peds = [Pedido(1,'CLIENTE A','Teresina',[ItemPedido('BC','50x60',30)]),
        Pedido(2,'CLIENTE B','Parnaiba',[ItemPedido('BC','50x60',14)])]
r = alocar(peds, gs)
usadas = {c.gaiola for c in r['coletas']}
ok(r['sobras'] == [], 'nenhuma sobra')
ok(usadas == {'G0000001','G0000002'}, f'usou as duas que somam exato: {sorted(usadas)}')
ok(all(c.usada_100 for c in r['coletas']), 'as duas saem 100% usadas -> os 2 enderecos ficam livres')
comp = [c for c in r['coletas'] if c.compartilhada]
ok(len(comp) == 1, f'exatamente 1 gaiola compartilhada entre pedidos: {len(comp)}')
ok(comp[0].fardos_por_pedido == {1: 6, 2: 14},
   f'a {comp[0].gaiola} se divide entre os pedidos numa ida so: {comp[0].fardos_por_pedido}')


print('\n═══ [2] SEM SOMA EXATA: a sobra fica numa gaiola so ═══')
gs = [g('G0000010','01-01-001','AM','30x40',30,10),
      g('G0000011','01-02-004','AM','30x40',30,11),
      g('G0000012','01-03-007','AM','30x40',30,12)]
peds = [Pedido(1,'A','X',[ItemPedido('AM','30x40',35)]),
        Pedido(2,'B','Y',[ItemPedido('AM','30x40',20)])]
r = alocar(peds, gs)
parciais = [c for c in r['coletas'] if c.sobra]
ok(len(parciais) == 1, f'exatamente 1 gaiola parcial (e nao varias): {len(parciais)}')
ok(parciais[0].sobra == 5, f'sobra minima possivel = 5 fardos (55 pedidos, gaiolas de 30): {parciais[0].sobra}')
ok(len(r['coletas']) == 2, f'abriu so 2 gaiolas: {len(r["coletas"])}')
ok(parciais[0].gaiola == 'G0000011', f'a parcial e a MAIS NOVA das usadas (FIFO): {parciais[0].gaiola}')
inteiras = [c for c in r['coletas'] if c.usada_100]
ok(inteiras[0].gaiola == 'G0000010', 'a mais antiga saiu inteira')


print('\n═══ [3] O PULO DO GATO: uma gaiola servindo 3 pedidos ═══')
gs = [g('G0000020','01-01-003','PT','40x50',28,10)]
peds = [Pedido(1,'A','X',[ItemPedido('PT','40x50',10)]),
        Pedido(2,'B','Y',[ItemPedido('PT','40x50',8)]),
        Pedido(3,'C','Z',[ItemPedido('PT','40x50',10)])]
r = alocar(peds, gs)
ok(len(r['coletas']) == 1, 'uma unica ida ao galpao atende os 3 pedidos')
c = r['coletas'][0]
ok(c.fardos_por_pedido == {1:10, 2:8, 3:10}, f'reparticao: {c.fardos_por_pedido}')
ok(c.sobra == 0, 'e ainda zera a gaiola -> endereco liberado')
rota = rota_de_coleta(r['coletas'], peds)
idas = len({x[1].gaiola for x in rota if x[0] == 1})
ok(idas == 1, 'a rota busca a gaiola so no primeiro pedido; nos outros ela ja esta na doca')


print('\n═══ [4] SEM O ALOCADOR x COM O ALOCADOR (carga real) ═══')
# Simula o jeito ingenuo: cada pedido resolve sozinho, pegando a
# primeira gaiola que der. E compara com o alocador.
random.seed(7)
CORES = ['AM','BC','PT','REC']
FMTS  = ['30x40','40x50','50x60','60x80']
gs, n = [], 0
for cor in CORES:
    for fmt in FMTS:
        for k in range(4):
            n += 1
            rua = 1 if n % 2 else 2
            gs.append(g(f'G{n:07d}', f'{rua:02d}-{(k%3)+1:02d}-{(n%20)+1:03d}',
                        cor, fmt, random.choice([20,24,25,28,30]), 10 + k))
peds = []
for i in range(1, 7):
    itens = [ItemPedido(random.choice(CORES), random.choice(FMTS), random.choice([8,12,15,20,25]))
             for _ in range(3)]
    peds.append(Pedido(i, f'CLIENTE {i}', 'CIDADE', itens))

def ingenuo(pedidos, gaiolas):
    """O processo de hoje, modelado: cada pedido e' separado por si.
    O separador vai ao galpao, pega gaiolas ate' fechar AQUELE item, e a
    gaiola que sobrou pela metade fica de lado - reetiquetada com nova
    quantidade e novo endereco. O pedido seguinte comeca do zero e
    abre gaiola nova.

    E' um MODELO do processo descrito, nao uma medicao de campo."""
    livres = {}
    for x in gaiolas:
        livres.setdefault(x.sku, []).append([x, x.fardos])
    for v in livres.values():
        v.sort(key=lambda par: par[0].entrada)      # FIFO
    abertas, sobras = set(), []
    for p in sorted(pedidos, key=lambda x: x.ordem):
        for it in p.itens:
            falta = it.fardos
            for par in livres.get(it.sku, []):
                if falta <= 0:
                    break
                if par[1] <= 0:
                    continue
                pega = min(falta, par[1])
                par[1] -= pega
                falta -= pega
                abertas.add(par[0].id)
                if par[1] > 0:
                    # sobrou nesta gaiola: sai de circulacao para
                    # reetiquetagem e o proximo pedido nao a enxerga
                    sobras.append((par[0].id, par[1]))
                    par[1] = 0
    return abertas, sobras

somaA = somaB = somaSA = somaSB = 0
for semente in range(60):
    random.seed(semente + 100)
    gs2, n2 = [], 0
    for cor in CORES:
        for fmt in FMTS:
            for k in range(4):
                n2 += 1
                rua = 1 if n2 % 2 else 2
                gs2.append(g(f'G{n2:07d}', f'{rua:02d}-{(k%3)+1:02d}-{(n2%20)+1:03d}',
                             cor, fmt, random.choice([20, 24, 25, 28, 30]), 10 + k))
    peds2 = [Pedido(i, f'CLIENTE {i}', 'CIDADE',
                    [ItemPedido(random.choice(CORES), random.choice(FMTS),
                                random.choice([8, 12, 15, 20, 25])) for _ in range(3)])
             for i in range(1, 7)]
    ab, sb = ingenuo(peds2, gs2)
    r2 = alocar(peds2, gs2)
    if r2['faltas']:
        continue
    somaA += len(ab);            somaSA += len(sb)
    somaB += len(r2['coletas']); somaSB += len(r2['sobras'])

print(f'    Media de 60 cargas sorteadas (6 pedidos, 3 itens cada):')
print(f'      processo de hoje ... {somaA/60:5.1f} gaiolas abertas · {somaSA/60:5.1f} sobras para reetiquetar')
print(f'      com o alocador ..... {somaB/60:5.1f} gaiolas abertas · {somaSB/60:5.1f} sobras para reetiquetar')
print(f'      reducao de sobras .. {100*(1-somaSB/max(1,somaSA)):.0f}%')
ok(somaSB < somaSA, 'o alocador gera menos sobra que o processo de hoje')
ok(somaB <= somaA, 'e nao abre mais gaiolas')
r = alocar(peds, gs)
skus_pedidos = {it.sku for p in peds for it in p.itens}
ok(len(r['sobras']) <= len(skus_pedidos), 'no maximo 1 sobra por SKU, por construcao')


print('\n═══ [5] TUDO QUE FOI PEDIDO FOI ATENDIDO (invariante) ═══')
for teste in range(200):
    random.seed(teste)
    gs, n = [], 0
    for cor in CORES[:2]:
        for fmt in FMTS[:2]:
            for k in range(random.randint(2, 6)):
                n += 1
                gs.append(g(f'G{n:07d}', f'{(n%2)+1:02d}-{(k%3)+1:02d}-{(n%20)+1:03d}',
                            cor, fmt, random.randint(15, 30), 10 + k))
    peds = [Pedido(i, f'C{i}', 'X',
                   [ItemPedido(random.choice(CORES[:2]), random.choice(FMTS[:2]),
                               random.randint(3, 25)) for _ in range(2)])
            for i in range(1, 5)]
    r = alocar(peds, gs)
    if r['faltas']:
        continue
    # cada pedido recebeu exatamente o que pediu, por SKU
    for p in peds:
        pedido_sku = {}
        for it in p.itens:
            pedido_sku[it.sku] = pedido_sku.get(it.sku, 0) + it.fardos
        recebido = {}
        for c in r['coletas']:
            q = c.fardos_por_pedido.get(p.ordem, 0)
            if q: recebido[(c.cor, c.formato)] = recebido.get((c.cor, c.formato), 0) + q
        if pedido_sku != recebido:
            falhas.append(f'semente {teste}, pedido {p.ordem}: pediu {pedido_sku}, recebeu {recebido}')
            break
    # nenhuma gaiola entregou mais fardos do que tem
    for c in r['coletas']:
        if sum(c.fardos_por_pedido.values()) + c.sobra != c.fardos_na_gaiola:
            falhas.append(f'semente {teste}: gaiola {c.gaiola} nao fecha a conta')
    # no maximo 1 sobra por SKU
    por_sku = {}
    for s in r['sobras']:
        k = (s['cor'], s['formato'])
        por_sku[k] = por_sku.get(k, 0) + 1
    if any(v > 1 for v in por_sku.values()):
        falhas.append(f'semente {teste}: mais de uma sobra no mesmo SKU')
ok(True, '200 cargas sorteadas: conferido que cada pedido recebe o que pediu,')
print('       que nenhuma gaiola entrega mais do que tem, e que nao ha')
print('       duas sobras do mesmo produto.')


print('\n═══ [6] FALTA DE PRODUTO E REPORTADA, NAO ESCONDIDA ═══')
gs = [g('G0000090','01-01-001','REC','80x100',10,10)]
peds = [Pedido(1,'A','X',[ItemPedido('REC','80x100',25)])]
r = alocar(peds, gs)
ok(r['faltas'] and r['faltas'][0]['faltam'] == 15,
   f'avisa que faltam 15 fardos: {r["faltas"]}')


print('\n' + '═' * 55)
print(f' RESULTADO: {"TUDO CERTO" if not falhas else str(len(falhas)) + " FALHA(S)"}')
print('═' * 55)
for f in falhas[:10]: print('  x', f)
sys.exit(1 if falhas else 0)
