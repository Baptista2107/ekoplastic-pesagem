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

- **Tara = tubete (Vinicius 24/11, cálculo aproximado):** 1,52 → 3,3 kg; 1,16 → 2,5 kg. O SERVIDOR desconta pelo catálogo (a tara mandada pela tela é ignorada); a tela mostra "balança − tubete". O líquido tem de ficar entre 20 e 1.500 kg, como na bobina recuperada (decidido sem perguntar: abaixo de 20 é tubete vazio; acima de 1.500 é peso digitado errado).
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

## Revisores (24/11, 2 rodadas)

**1ª rodada (1917b24): consertado em commit próprio, com teste vermelho sem o conserto.**
- O celular.css estava preso a `data-tela="Resíduos"`.
- Uma apara misturada passava calada no pedido da IKATUPLAST.
- Uma etiqueta O excluída voltava a 'bipada' pelo leitor.
- O texto largo da etiqueta foi cortado em 27 caracteres.

**Achado no caminho: o pre-push saindo de um worktree exporta GIT_DIR.** O `testes/commit-atual.js` herdou essa variável e fez dois estragos:
- commitou 3 commits vazios no ramo;
- deixou `core.bare=true` no clone `~/dev/ekoplastic-pesagem`.

O conserto (teste + hook) já está no main desde 6b0e0d3.

**Sobras, sem conserto (baixo):**
- O catálogo está espelhado no HTML, e os 4 botões são fixos. O certo é servir o catálogo e gerar os botões a partir dele.
- A regra do fornecedor aparece em 3 formas (`fornecedorOutras`, `grupoFornecedor` na tela e `contatoNome` na rota).
- O `gerarEPLOutras` tem dois layouts na mesma função (o certo é separar um `gerarEPLBobinaAD`), e "MILHEIRO" está fixo no código.
- O `tokenPendente` não é zerado ao trocar de item. Se uma resposta se perde e o operador troca de item, a tela pode gravar o item errado (vem de antes).
- No reenvio forçado com erro, o `bling_id` antigo é zerado (padrão de antes).
- O `/consumir` da retirada aceita etiqueta O, então uma bobina AD poderia ser "retirada" como MP (vem de antes).
- Bipar de novo uma O já bipada regrava a hora e duplica a linha no CSV (vem de antes).
- Uma R cancelada em sessão aberta volta a 'bipada' pelo servidor (vem de antes).
- O papel do resumo continua dizendo "Inventario / Residuos".
- Faltam testes de:
  - reimpressão da bobina;
  - resumo do dia com a bobina;
  - modo simulação;
  - bobina sem `id_ekoplastic_bling`;
  - cancelar a sessão inteira e depois bipar;
  - o próprio hook num repo descartável.

## Revisores do tubete (24/11, 2 rodadas: 4149ab2 e 0d37b1e)

**Consertado**, sempre com teste vermelho antes do conserto:
- A prévia mostrava peso negativo.
- Não havia mínimo nem teto de peso.
- Repetida pelo `clientToken`, a tela mostrava o item e o peso da tela, não os gravados, e dizia "impressa" sem ter impresso.
- O peso de cada caso ficou escrito no contrato.
- O tubete e os limites da tela agora são conferidos contra os do servidor.
- O teste abria o `etiquetas.db` da raiz.

**Sobrou (baixo, sem 3ª rodada):**
- A resposta do POST numa repetição traz `item` do pedido atual e `sku` do gravado. A tela usa o `sku`.
- As validações de fornecedor e de peso rodam antes da idempotência. Repetir o mesmo token com outro item ou peso dá 400/409, não a etiqueta gravada.
- Se a etiqueta foi cancelada entre o envio e a repetição, ela volta à lista como "aguardando bipe".
- O servidor continua sem validar peso NaN, zero ou negativo para apara e resíduo (era assim antes).
