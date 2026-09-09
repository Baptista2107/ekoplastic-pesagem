# ════════════════════════════════════════════════════════════════════
#  ALOCADOR DE SEPARAÇÃO — Ekoplastic
#  ------------------------------------------------------------------
#  Dado (a) a guia de separação já conferida, com os pedidos na ORDEM
#  DE CARREGAMENTO definida pelo gestor, e (b) as gaiolas endereçadas
#  no galpão, decide DE QUAL ENDEREÇO tirar cada fardo.
#
#  O QUE ELE OTIMIZA, NESTA ORDEM
#   1. SOBRA ZERO. Antes de qualquer coisa, procura um conjunto de
#      gaiolas cuja soma dê EXATAMENTE a demanda do SKU na carga
#      inteira. Quando existe, nenhuma gaiola fica pela metade: todos
#      os endereços são liberados e não há reetiquetagem nenhuma.
#      É um subset-sum resolvido por programação dinâmica — os números
#      aqui são pequenos (dezenas de gaiolas, centenas de fardos),
#      então roda instantâneo.
#   2. Se soma exata não existe, MENOR SOBRA POSSÍVEL, e ela fica
#      concentrada em UMA ÚNICA gaiola — nunca espalhada em várias.
#      É exatamente o acúmulo de gaiolas com pouco produto que o
#      processo de hoje gera e que se quer eliminar.
#   3. Menos gaiolas abertas.
#   4. FIFO: consome as mais antigas por inteiro e deixa a MAIS NOVA
#      como parcial. Assim o estoque gira e a sobra é sempre a
#      mercadoria que entrou por último.
#
#  A demanda é somada da CARGA INTEIRA antes de alocar — é isso que
#  faz uma mesma gaiola servir o pedido de agora e o de depois, em vez
#  de abrir uma gaiola nova para cada pedido.
# ════════════════════════════════════════════════════════════════════
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class Gaiola:
    id: str
    posicao: str            # '01-02-007'
    cor: str                # 'BC'
    formato: str            # '50x60'
    fardos: int
    entrada: str            # ISO — usado para FIFO

    @property
    def sku(self):
        return (self.cor, self.formato)

    @property
    def rua(self):
        return int(self.posicao.split('-')[0])

    @property
    def nivel(self):
        return int(self.posicao.split('-')[1])

    @property
    def vao(self):
        return int(self.posicao.split('-')[2])


@dataclass
class ItemPedido:
    cor: str
    formato: str
    fardos: int

    @property
    def sku(self):
        return (self.cor, self.formato)


@dataclass
class Pedido:
    ordem: int              # ordem de CARREGAMENTO, definida pelo gestor
    cliente: str
    cidade: str
    itens: list


@dataclass
class Coleta:
    """Uma ida ao endereço. `fardos_por_pedido` diz quanto vai para cada
    pedido — é a informação que evita abrir gaiola nova no pedido seguinte."""
    gaiola: str
    posicao: str
    cor: str
    formato: str
    fardos_na_gaiola: int
    fardos_por_pedido: dict = field(default_factory=dict)
    sobra: int = 0

    @property
    def compartilhada(self):
        return len(self.fardos_por_pedido) > 1

    @property
    def usada_100(self):
        return self.sobra == 0


def escolher_gaiolas(gaiolas, demanda):
    """Escolhe o conjunto de gaiolas para cobrir `demanda` fardos.

    Devolve (escolhidas, sobra, deficit). A lista já vem na ordem de
    consumo: as que serão usadas por inteiro primeiro, a parcial (se
    houver) por último.

    Critério, em ordem: menor sobra · menos gaiolas · mais antigas.
    """
    if demanda <= 0:
        return [], 0, 0

    total = sum(g.fardos for g in gaiolas)
    if total < demanda:
        # Não há produto suficiente endereçado. Leva tudo e reporta o
        # que falta — quem decide o que fazer é o gestor, não o sistema.
        ordenadas = sorted(gaiolas, key=lambda g: (g.entrada, g.rua, g.vao))
        return ordenadas, 0, demanda - total

    # FIFO: quanto mais antiga, mais cedo deve ser consumida por inteiro.
    # O índice na lista ordenada vira o "custo de antiguidade" do DP.
    ordenadas = sorted(gaiolas, key=lambda g: (g.entrada, g.rua, g.nivel, g.vao))
    n = len(ordenadas)
    teto = total

    # DP EM CAMADAS: uma camada por gaiola. Cada soma alcançável guarda
    # (nº de gaiolas, soma dos índices, quais índices) — minimizar a soma
    # dos índices é preferir as mais antigas.
    #
    # A camada importa: montar a camada nova SEMPRE a partir da anterior
    # é o que garante que cada gaiola entre no máximo uma vez. Uma versão
    # com um único vetor de "pai" parece equivalente e não é — ela pode
    # reconstruir um caminho que usa a mesma gaiola duas vezes, e aí o
    # sistema acha que tem mais fardos do que existe e manda separar
    # menos do que o pedido pede. Aconteceu, e o teste [5] pegou.
    melhor = {0: (0, 0, ())}
    for i, g in enumerate(ordenadas):
        nova = dict(melhor)
        for s, (cnt, soma_idx, escolhidos) in melhor.items():
            ns = s + g.fardos
            if ns > teto:
                continue
            cand = (cnt + 1, soma_idx + i, escolhidos + (i,))
            if ns not in nova or cand[:2] < nova[ns][:2]:
                nova[ns] = cand
        melhor = nova

    # A melhor soma é a menor >= demanda; entre as de mesma sobra, a que
    # o DP já classificou como melhor (menos gaiolas, mais antigas).
    alvo = None
    for s in range(demanda, teto + 1):
        if s in melhor:
            alvo = s
            break
    if alvo is None:                       # não deveria acontecer
        return ordenadas, total - demanda, 0

    idxs = melhor[alvo][2]
    assert len(set(idxs)) == len(idxs), 'gaiola escolhida duas vezes'
    escolhidas = [ordenadas[i] for i in sorted(idxs)]
    sobra = alvo - demanda

    if sobra:
        # A parcial tem que ser a ÚLTIMA consumida, e a escolhida é a
        # MAIS NOVA do conjunto — as antigas saem inteiras (FIFO).
        # Entre as que comportam a sobra, pega a de entrada mais recente.
        candidatas = [g for g in escolhidas if g.fardos > sobra]
        parcial = max(candidatas or escolhidas, key=lambda g: g.entrada)
        escolhidas = [g for g in escolhidas if g.id != parcial.id] + [parcial]

    return escolhidas, sobra, 0


def alocar(pedidos, gaiolas):
    """Monta o plano de coleta da carga inteira.

    Devolve {'coletas': [...], 'sobras': [...], 'faltas': [...]}
    """
    # 1. Demanda somada da CARGA INTEIRA, por SKU. É o que permite uma
    #    gaiola atender mais de um pedido.
    demanda = {}
    for p in pedidos:
        for it in p.itens:
            demanda[it.sku] = demanda.get(it.sku, 0) + it.fardos

    estoque = {}
    for g in gaiolas:
        estoque.setdefault(g.sku, []).append(g)

    coletas, sobras, faltas = [], [], []

    for sku, d in sorted(demanda.items()):
        disponiveis = estoque.get(sku, [])
        escolhidas, sobra, deficit = escolher_gaiolas(disponiveis, d)
        if deficit:
            faltas.append({'cor': sku[0], 'formato': sku[1], 'faltam': deficit})

        # 2. Distribui as gaiolas escolhidas pelos pedidos, NA ORDEM DE
        #    CARREGAMENTO. Consumir em sequência é o que faz o corte cair
        #    entre pedidos VIZINHOS — a gaiola compartilhada fica na doca
        #    de um pedido para o seguinte, não para um lá do fim da fila.
        fila = list(escolhidas)
        restante_na_gaiola = {g.id: g.fardos for g in fila}
        i = 0
        por_gaiola = {}

        for p in sorted(pedidos, key=lambda x: x.ordem):
            preciso = sum(it.fardos for it in p.itens if it.sku == sku)
            while preciso > 0 and i < len(fila):
                g = fila[i]
                pega = min(preciso, restante_na_gaiola[g.id])
                if pega > 0:
                    por_gaiola.setdefault(g.id, {})[p.ordem] = \
                        por_gaiola.setdefault(g.id, {}).get(p.ordem, 0) + pega
                    restante_na_gaiola[g.id] -= pega
                    preciso -= pega
                if restante_na_gaiola[g.id] == 0:
                    i += 1

        for g in fila:
            reparticao = por_gaiola.get(g.id, {})
            if not reparticao:
                continue
            c = Coleta(gaiola=g.id, posicao=g.posicao, cor=g.cor, formato=g.formato,
                       fardos_na_gaiola=g.fardos, fardos_por_pedido=reparticao,
                       sobra=restante_na_gaiola[g.id])
            coletas.append(c)
            if c.sobra:
                sobras.append({'gaiola_origem': g.id, 'posicao_origem': g.posicao,
                               'cor': g.cor, 'formato': g.formato, 'fardos': c.sobra})

    return {'coletas': coletas, 'sobras': sobras, 'faltas': faltas}


def rota_de_coleta(coletas, pedidos):
    """Ordem de visita: pedido a pedido (é como a separação é feita), e
    dentro de cada pedido caminhando pelo galpão — rua, depois vão em
    ordem crescente, para não ir e voltar no corredor.

    Uma gaiola compartilhada só é buscada UMA vez, no primeiro pedido
    que a usa; nos seguintes ela já está na doca."""
    buscadas = set()
    rota = []
    for p in sorted(pedidos, key=lambda x: x.ordem):
        do_pedido = [c for c in coletas
                     if p.ordem in c.fardos_por_pedido and c.gaiola not in buscadas]
        do_pedido.sort(key=lambda c: (int(c.posicao.split('-')[0]),
                                      int(c.posicao.split('-')[2]),
                                      int(c.posicao.split('-')[1])))
        for c in do_pedido:
            buscadas.add(c.gaiola)
            rota.append((p.ordem, c))
        # o que já está na doca vindo de pedido anterior
        for c in coletas:
            if p.ordem in c.fardos_por_pedido and c.gaiola in buscadas \
               and not any(x[1].gaiola == c.gaiola and x[0] == p.ordem for x in rota):
                rota.append((p.ordem, c))
    return rota


def sugerir_endereco(sobra, posicoes_livres, preferir_nivel=1):
    """Onde endereçar a sobra. Prefere o nível do chão (mais acessível,
    e sobra costuma sair de novo em breve) e o vão de menor número, que
    é a ponta da rua mais perto da doca."""
    if not posicoes_livres:
        return None
    def chave(cod):
        rua, nivel, vao = (int(x) for x in cod.split('-'))
        return (0 if nivel == preferir_nivel else 1, rua, vao)
    return sorted(posicoes_livres, key=chave)[0]
