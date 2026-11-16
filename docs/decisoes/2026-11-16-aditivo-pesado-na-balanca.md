# Aditivo pesado na balança (16/11/2026)

**Pedido (Gustavo, 16/11):** o dessecante da Karina chegou em bag com 3.023 kg.
A tela só aceitava sacos de 25 kg, então a sessão #33288 saiu com 3.025 kg.

**Como ficou:** no aditivo, o Recebimento pergunta "Contar sacos" ou "Pesar na
balança". Sem escolha, fica em sacos. Pesando, o aditivo segue o mesmo caminho do
grão: peso lido da balança, espera estabilizar e só libera a próxima depois que o
bag sai de cima.

## Ajustes depois da revisão do 196a614

- **qtd_sacos passa a ser gravado.** No aditivo contado, a tela não mandava a
  quantidade de sacos ao imprimir: no pesagem.db, 241 R de aditivo estão com
  `qtd_sacos` vazio. Agora manda. Isso muda uma coisa só: a descrição do item na
  compra do Bling ganha "· N sacos × 25kg". Na VPS, `romaneio_compra.ler_descricao`
  já entendia esse trecho, e o parser de `snapshot_producao` lê o lote antes dele.
  `mp_pedido_retirada` só olha `qtd_sacos` nas S, não nas R. No aditivo pesado o
  campo continua vazio.
- **SKU com 1 casa no aditivo pesado** ("| 3023.4 |"), para bater com o PESO da
  etiqueta. Grão e aditivo contado continuam com o número inteiro. Na correção de
  etiqueta, o aditivo só conta como pesado quando o peso é quebrado, porque as
  etiquetas antigas não têm `qtd_sacos`.
- **Com o bag ainda na balança, não dá para trocar de jeito.** "Contar sacos" não
  espera a balança zerar, e trocar ali imprimiria o mesmo bag de novo. A tela
  recusa e pede para tirar o bag.
- **O aviso "RETIRE O BIG BAG / PALETE" volta a aparecer.** Depois de imprimir, o
  peso da tela zera e o aviso ficava escondido. Isso valia também para o grão.

## Ficou de fora (anotado, sem mudança)

- Trocar de **material** com o bag em cima da balança volta para "Contar sacos" e
  permite imprimir. Isso já acontecia antes, com grão → aditivo. Trocar de
  material é um ato deliberado, então ficou como está.
- O inventário de aditivo continua contando por sacos.
- A estabilidade pisca: a janela é de 2 s, a leitura vem a cada 0,5 s e o peso
  precisa ficar parado 1,5 s, então um atraso de leitura desmarca o "estável" por
  um instante. Apareceu no teste de navegador, que hoje clica no exato momento em
  que o botão libera. Não medi se isso atrapalha na fábrica.

Teste: `testes/navegador/aditivo_balanca.py` falha em 7 pontos no 196a614 e passa
no código atual (4 rodadas seguidas).
