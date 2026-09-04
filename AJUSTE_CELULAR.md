# Ajuste automático de tela no celular

**Data:** 04/09/2026
**Arquivo novo:** `public/celular.css`
**Escopo combinado:** Menu, Resíduos, Produto Acabado, Manutenção (Opções) e Dashboard
**Regra combinada:** nada muda acima de 900 px de largura — a tela touch do Mini PC continua idêntica

---

## O problema

Todo mundo abre o sistema pelo celular, e cada um tem um aparelho de um
tamanho. As telas foram desenhadas para a tela touch do Mini PC, que é larga.
No celular três coisas quebravam ao mesmo tempo:

1. **O cabeçalho não quebrava linha.** Logo + relógio + status + botões
   somavam mais que a largura do aparelho e empurravam a página inteira para
   os lados. Era a causa principal: sozinho, ele estourava 104 px num celular
   de 375 px.
2. **Colunas de largura fixa.** Uma coluna de 340 px ao lado de outra não cabe
   em 375 px. E o estouro quase não mudava entre um celular pequeno e um
   grande — porque a largura era fixa, não proporcional.
3. **Altura travada.** `height: calc(100vh - 56px)` com `overflow:hidden`
   funciona no computador, onde tudo cabe. No celular, empilhado, não cabe — e
   sem rolagem o resto some.

Medido antes da mudança, abrindo o menu e tocando no cartão (o caminho real do
operador), a página precisava ser arrastada de lado:

| aparelho | largura | quanto estourava |
|---|---|---|
| pequeno  | 320 px | **159 px** |
| comum    | 375 px | **104 px** |
| grande   | 430 px | **49 px**  |

---

## Como está resolvido

Um arquivo só, `public/celular.css`, **inteiro dentro de uma regra**:

```css
@media (max-width: 900px) { ... }
```

Acima de 900 px nenhuma linha dele é aplicada. **Não há tamanho de celular
escrito no arquivo**: o layout se adapta pela largura disponível, então serve
para o aparelho de 320 px e para o de 430 px sem o sistema precisar saber o
modelo. Foi exatamente isso que foi pedido — a página lê sozinha o espaço que
tem e se ajusta.

### Medidas adotadas

* **Alvo de toque mínimo de 44 px** (guia da Apple e do Google). Importa mais
  ainda no galpão, onde se usa luva.
* **Texto mínimo de 12 px.**
* **`100dvh` em vez de `100vh`.** No celular a barra de endereço aparece e
  some, e o `vh` não conta isso — a última linha da tela ficava escondida
  atrás dela.
* `overflow-x:hidden` fica **só no `body`**, nunca no `html`, para não quebrar
  cabeçalho `position:sticky`.

### O que mudou em cada tela

As regras estruturais são presas ao `data-tela` do `<body>`, então uma tela que
o arquivo não conhece não tem o layout alterado — só ganha cabeçalho que quebra
linha, alvo de toque e texto mínimo.

| tela | `data-tela` | o que mudou |
|---|---|---|
| Menu | `Menu` | cartões viram um por linha abaixo de 400 px |
| Resíduos | `Resíduos` | as duas colunas (painel de toque + preview de 360 px fixos) viram uma, com o preview embaixo; o banner de turno quebra linha |
| Produto Acabado | `Produto Acabado` | as duas colunas viram uma que rola; a escolha de turno vira um cartão por linha; grade de cores em 2 colunas abaixo de 400 px |
| Manutenção | `Opções` | formulário de cadastro em uma coluna; botões de ação quebram linha |
| Dashboard | `Dashboard` | filtros em duas colunas; cartões deixam de exigir 320 px de largura mínima; tabela larga rola dentro do cartão, não empurra a página |
| Endereçamento, Inventário, Retirada de bobinas | — | já eram de celular; herdam só cabeçalho, alvo de toque e texto |

### Dois ajustes pontuais dentro das telas

* **Crachá do colaborador** (`👤 NOME`). É `position:fixed` no canto superior
  direito. Na tela larga cai em espaço vazio; no celular caía em cima do
  relógio e dos botões. Vai para o canto inferior **esquerdo** — o direito é
  do botão "Sair". Em `produto-acabado.html` o elemento ganhou a classe
  `eko-resp-tag` só para o CSS conseguir alcançá-lo; a classe não muda nada
  por si.
* **Overlay de escolha de turno** do Produto Acabado. Começava 56 px abaixo do
  topo — a altura do cabeçalho na tela larga. No celular o cabeçalho quebra em
  duas linhas e fica mais alto, e sobrava uma faixa da tela de baixo aparecendo
  acima dele. Agora o overlay cobre a tela inteira e o cabeçalho flutua por
  cima (`sticky`), de modo que os botões ⇄ e 🏠 continuam ao alcance durante a
  escolha do turno.

---

## Como foi verificado

### 1. Medição em navegador de verdade — `testes/_medir-celular.js`

Abre cada tela num Chromium em cinco tamanhos de celular (320, 375, 390, 412,
430) e mede rolagem horizontal, conteúdo cortado, alvos menores que 44 px e
texto menor que 12 px.

**Resultado depois da mudança — 8 telas × 5 tamanhos:**

```
ROLAGEM HORIZONTAL ....... ok em todas as 40 combinações
ALVOS < 44 px ............ 0 em todas as telas
TEXTO < 12 px ............ 0 em todas as telas
CONTEÚDO CORTADO ......... 0 em todas as telas
```

### 2. Prova de que o Mini PC não mudou — `testes/_prova-tela-touch.js`

Esta é a prova que importa para a fábrica em operação. O script abre cada tela
em **901, 1024 e 1366 px de largura, duas vezes** — uma com o `celular.css` de
verdade e outra com ele vazio — e compara **elemento por elemento**: posição,
tamanho e os estilos que mexem em layout.

901 px é o primeiro pixel **fora** do `@media`: é o caso mais apertado
possível. Se alguma regra vazasse, vazaria ali.

A comparação não é de pixels de propósito: telas com animação (o
"DESCONECTADA" piscando, o aviso pulsando) nunca dão dois retratos iguais nem
quando nada mudou. Comparar geometria é estável e é exatamente o que o operador
enxerga como "a tela mudou".

```
RESULTADO: 24 idênticas, 0 mudaram
(126 a 421 elementos por tela — inclusive o conteúdo de dentro do iframe do casco)
```

> **Detalhe que quase passou batido:** na tela larga várias páginas se
> redirecionam para dentro do casco (`index.html` + `<iframe id="eko-frame">`).
> A primeira versão da prova media só o quadro principal — ou seja, media o
> casco (42 elementos) e não a tela. Corrigido: agora percorre todos os
> quadros. É por isso que a contagem pulou de 42 para 126–421.

### 3. Caminho real do operador

Abrir o menu no celular e **tocar no cartão** (não digitar o endereço da tela),
que é como o pessoal usa. A tela abre dentro do iframe do casco.

| aparelho | antes | depois |
|---|---|---|
| 320 px | estourava 159 px | **0** |
| 375 px | estourava 104 px | **0** |
| 430 px | estourava 49 px  | **0** |

### 4. As sete suítes de teste

Rodadas depois da mudança: **327 asserções, 0 falhas.**

```
piso-testes .......... 37 passou, 0 falhou
travas-extrusao ...... 26 passou, 0 falhou
janela-atualizacao ... 29 passou, 0 falhou
resumo-opcional ...... 58 passou, 0 falhou
catalogo-cores ....... 70 passou, 0 falhou
bling-endpoint ....... 28 passou, 0 falhou
enderecamento ........ 85 passou, 0 falhou
```

---

## Arquivos alterados

**Novo**

* `public/celular.css`
* `testes/_medir-celular.js` (ferramenta de medição)
* `testes/_prova-tela-touch.js` (prova de que o Mini PC não mudou)

**Uma linha a mais** — o `<link>` depois do `</style>` da própria página:

```html
<!-- Ajuste automatico para celular: so vale abaixo de 900px de largura -->
<link rel="stylesheet" href="/celular.css">
```

* `public/index.html`
* `public/outras-pesagens.html`
* `public/manutencao.html`
* `public/enderecamento.html`
* `public/inventario.html`
* `public/retirada-bobinas.html`

**Um pouco mais que uma linha**

* `public/dashboard.html` — o `<link>` e `data-tela="Dashboard"` no `<body>`
  (a tela não tinha esse atributo).
* `public/produto-acabado.html` — o `<link>` e `el.className = 'eko-resp-tag'`
  no crachá do colaborador.

Os dois scripts de teste começam com `_` como as outras ferramentas de prova
(`_prova-visual.js`, `_prova-cores.js`, `_prova-enderecamento.js`), e **não
entram na trava do `ENVIAR-ATUALIZACAO.bat`**: precisam de Playwright e levam
alguns minutos, o que atrasaria toda entrega. São para rodar à mão quando se
mexer em layout.

---

## Como usar numa tela nova

```html
<link rel="stylesheet" href="/celular.css">
```

depois do `<style>` da própria página. Se a tela tiver um layout próprio que
precise mudar no celular, dê a ela um `data-tela="..."` no `<body>` e escreva o
bloco correspondente no `celular.css`. Sem isso, ela ainda ganha cabeçalho que
quebra linha, alvo de toque de 44 px e texto de 12 px.

---

## Pendente

Nada é servidor: **é só arquivo estático**. O `server.js` não foi tocado, então
a atualização não mexe em pesagem, impressão nem no envio ao Bling.
