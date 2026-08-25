# v37 — Trava só pra sair pro Windows; navegação entre processos LIVRE

Ajuste sobre a v36. Corrige o escopo da trava conforme você pediu.
**Sem mudança de schema.**

## O que mudou em relação à v36

Na v36 os botões de voltar ao menu pediam senha — não era isso que você
queria. Agora:

- **Navegar entre menu ⇄ Matéria-Prima ⇄ Extrusão é LIVRE** (sem senha).
  Os botões de início/voltar funcionam direto, o tempo todo. O sistema
  se mantém em tela cheia ao trocar de tela.
- **A senha de supervisor só é pedida pra SAIR da tela cheia pro Windows**
  (o "X" do topo no Win11, Esc ou F11). É a única forma de "sair do
  sistema". Senha errada → continua preso + tentativa registrada no log.

## Como o sistema sabe a diferença

- Quando você **navega** entre as telas, a página é recarregada (ela
  "morre") — o pedido de senha tem um pequeno atraso e nem chega a
  aparecer. Navegação flui normal.
- Quando você clica no **X do topo** (sair da tela cheia), a página
  continua viva — aí o atraso dispara e a senha é exigida.

## Detalhe da experiência (tela cheia entre páginas)

Como cada tela é uma página separada, ao trocar de processo o navegador
sai da tela cheia por um instante. O sistema tenta voltar à tela cheia
sozinho; se o navegador exigir um gesto (comum no Chrome), aparece um
rodapé azul **"Toque para continuar em tela cheia"** — um toque e volta.
Não pede senha nesse caso; é só pra reativar a tela cheia.

> Se esse toque ocasional ao trocar de processo incomodar no dia a dia, a
> forma de eliminá-lo de vez é o modo quiosque (Electron), que mantém
> tela cheia contínua sem depender de gesto. Fica como evolução.

## Senha (igual v36)
- Inicial: **1234** — troque:
  ```
  curl -X POST http://localhost:3000/seguranca/definir-senha -H "Content-Type: application/json" -d "{\"senhaAtual\":\"1234\",\"novaSenha\":\"SUANOVA\"}"
  ```
- Tentativas erradas: `http://localhost:3000/seguranca/desvios`
  (arquivos em `logs/desvios-AAAA-MM.jsonl`).

## Alcance honesto (mantido)
Cobre a saída da TELA CHEIA (X do topo, Esc, F11). NÃO bloqueia Alt+Tab
nem a tecla Windows — isso só com Electron + Modo Quiosque do Windows
(ver PLANO-ELECTRON-QUIOSQUE.md).

## Conteúdo
```
v37/
├─ server.js                       (endpoints /seguranca/* — VERSION v37)
├─ public/
│  ├─ seguranca-saida.js           ★ navegação livre + senha só na saída da tela cheia
│  ├─ index.html                   ★ agora também em tela cheia + trava de saída
│  ├─ materia-prima.html           ★ botões de voltar LIVRES de novo
│  ├─ etiqueta-producao.html       ★ botões de voltar LIVRES de novo
│  └─ (demais sem mudança)
├─ INICIAR.bat / RODAR-TESTES.bat
├─ testes/piso-testes.js
└─ LEIA-ME.md
```

## Aplicar
1. Pare o servidor.
2. Substitua server.js, a pasta public\ (confirme o seguranca-saida.js) e testes\.
3. Rode RODAR-TESTES.bat → `v37` no topo e `34 passou`.
4. Inicie pelo INICIAR.bat e troque a senha inicial.

## Teste rápido na tela touch
1. No menu, toque pra entrar em tela cheia.
2. Entre em Matéria-Prima, volte ao menu, entre em Extrusão — deve fluir
   sem pedir senha (no máximo um "toque para continuar").
3. Vá ao topo central (aparece o X) e tente sair da tela cheia → deve
   pedir a senha. Errada = continua preso + registra; 1234 = sai.
