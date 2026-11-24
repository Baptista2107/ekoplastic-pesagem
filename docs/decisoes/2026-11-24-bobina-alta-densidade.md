# Bobina alta densidade em Outras Pesagens (24/11/2026)

Pedido do Vinicius:

1. O card RESÍDUOS da tela principal passa a se chamar OUTRAS PESAGENS.
2. Entra a BOBINA ALTA DENSIDADE - MILHEIRO. É comprada pronta da IKATUPLAST, não tem operador e vai para a sacola de milheiro, fora do blend de formatos da casa.
3. A etiqueta não mostra o fornecedor e diz para qual sacola a bobina serve.

## O que foi feito

- **Itens no catálogo** (`lib/config.js`, categoria `BOBINA_AD`). O ID de cada item é o da variação no Bling, lido pela API em 24/11, porque o pedido trazia o ID do produto pai (16739752334) para todos. No Bling a SKU é escrita com vírgula.

  | SKU | ID da variação | Sacola |
  |---|---|---|
  | BOB.VER.1,52 | 16739758321 | 38 x 48 |
  | BOB.PT.1,52 | 16739758326 | 38 x 48 |
  | BOB.VER.1,16 | 16739758324 | 29 x 39 |
  | BOB.PT.1,16 | 16739758328 | 29 x 39 |

- **Pedido de compra** com fornecedor IKATUPLAST (contato 18539284560), valor de R$ 1,00 por kg, igual às outras entradas. A observação começa com "BOBINA ALTA DENSIDADE - MILHEIRO" e não tem palavra que o `snapshot_producao.py` leia como resíduo.
- **Uma pesagem tem um fornecedor só.** Uma sessão vira um pedido no Bling, então bobina AD (IKATUPLAST) não se mistura com apara ou resíduo (EKOPLASTIC). A tela avisa, e o servidor recusa com 409 e `motivo: fornecedor_diferente`. Etiqueta cancelada não conta. Se a mistura entrar mesmo assim (banco mexido à mão), o envio para com erro e não manda pedido: assim a bobina não vira compra da EKOPLASTIC.
- **Etiqueta 100x150:**
  - título BOBINA ALTA DENSIDADE;
  - cor e largura em letra grande;
  - "SERVE PARA / SACOLA 38 X 48 - MILHEIRO";
  - peso, código de barras e data e hora numa linha pequena.

  O fornecedor fica só no banco (`etiquetas.fornecedor = 'IKATUPLAST'`) e no pedido do Bling. A etiqueta de apara e resíduo não mudou e continua com o título RESIDUOS.
- **Verde é Verde.** Na bobina AD o verde não é tratado como "Colorida", como o Vinicius pediu.

## O que foi decidido sem perguntar (dá para mudar)

- **Tara 0.** O peso da balança vai inteiro, como nas aparas. Se a bobina for pesada no eixo, falta descontar o peso dele (refugo e recuperada descontam pela largura).
- **Quatro botões diretos** (cor + metragem), cada um já dizendo a sacola, em vez de escolher a cor primeiro e a metragem depois. É menos toque no Mini PC.
- **O papel do "Resumo do dia" continua "RESUMO DO DIA - RESIDUOS".** A bobina AD entra nele como um grupo próprio, depois dos resíduos.

## O que NÃO foi feito (fica para decidir)

- **Efeito na VPS** (levantado em 24/11): o pedido de compra da IKATUPLAST com produto BOB.* entra
  - no `snapshot_producao.py` como "📥 Entrada MP", tipo "Outro (BOB…)";
  - no `entradas_fila.py` como classe "revisar", fora da fila de preço;
  - no CPV de MP como "NÃO CLASSIFICADO", a R$ 1,00 ou pelo último preço.

  O `dashboard_mp` ignora BOB.* (prefixo de PA). Falta decidir se a bobina comprada é custo de MP (entra no CPV com preço) ou fica fora do CPV, como a apara. Os pontos para mexer são `entradas_fila.py` (FAMILIAS_R1 / `_familia_por_codigo`) e `snapshot_producao.py` (`resolver_tipo_mp`).
- **Baixa na sacoleira:** a etiqueta é O, não E. O coletor e o estoque de bobinas da VPS só conhecem E, então a bobina AD não é "montada" numa sacoleira nem aparece no estoque de bobinas.
- **Unidade no Bling:** as 4 variações estão com a unidade vazia (a borra tem KG). Vale cadastrar KG.
- **Ligar na fábrica:** pela regra do Gustavo (06/11), muda o que o operador faz, então só vai ao Mini PC depois do "pode ativar" dele. O código está no ramo `bobina-alta-densidade`.
