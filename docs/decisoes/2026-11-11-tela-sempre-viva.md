# Servidor sempre ligado e tela que volta sozinha no Mini PC — 11/11/2026

**Pedido (Gustavo):** "cara isso nao pode acontecer esse servidor nao pode ficar
fechado de jeito algum".

**RAMO DE TESTE** `tela-sempre-viva-teste`. Não vai para o main nem para o Mini PC
sem o "pode ativar" do Gustavo.

## O que aconteceu em 11/11 (medido no Mini PC, só leitura)
- **08h14:** alguém usou a senha de saída e o botão "Fechar agora". O
  `POST /sistema/encerrar` gravava `eko-encerrar.flag`, fechava o Chrome e
  encerrava o node, e o INICIAR.bat, ao ver a bandeira, não religava. A pesagem
  ficou fora até 08h45.
- **08h45:** o servidor foi religado pela VPS (`Win32_Process Create`). O
  INICIAR.bat subiu certo, mas na **sessão 0** do Windows (a dos serviços), e o
  Chrome abriu lá, onde o monitor não mostra nada.
- **10h39:** a atualização remota rodou dentro desse INICIAR da sessão 0. O
  `taskkill chrome` fechou a tela do monitor e o `:abrir` abriu outra na sessão
  0, invisível. Às 10h49 alguém abriu o Chrome na mão.
- Conferido às 10h53: o node (PID 13088) estava na sessão 0, filho do cmd 10952.
  A balança COM1 recebia e a Elgin imprimia normalmente (R0001175 a R0001177,
  10h51-10h52). **Node na sessão 0 funciona; o problema era só a tela.**

## Decisão
1. **"Fechar agora" fecha só o navegador.** O servidor continua ligado e não
   grava mais `eko-encerrar.flag`. Se uma bandeira dessas sobrar, o INICIAR.bat
   apaga e segue. A tela fica fechada por **10 min** e depois volta sozinha.
   Para abrir antes, basta abrir o INICIAR.bat. A rota só aceita pedido da
   própria máquina: um celular na rede não fecha a tela do monitor.
2. **Quem abre a tela é só o vigia** (`tela-vigia.ps1`, oculto). Ele sobe junto
   com o INICIAR.bat, roda na sessão de quem está no monitor e **não roda na
   sessão 0**. O INICIAR.bat não abre navegador nenhum. A cada 5 s o vigia
   confere se a tela está aberta e pergunta ao servidor
   (`GET /sistema/tela`), que responde com uma palavra: ABRIR, AGUARDAR,
   ABERTA, PAUSADA ou DESISTIU. Um vigia por máquina, garantido pelo mutex
   `Global\EkoplasticTelaVigia`.
3. **A tela abre num perfil próprio** (`navegador-eko`, que o ABRIR-TELA.bat já
   usava). Com isso dá para saber se ela está aberta: enquanto roda, o Chrome
   segura o `navegador-eko\lockfile`. Se o arquivo disser "fechada", o vigia
   confere pelos processos antes de abrir.
4. **Freio contra janela em dobro:** depois de um ABRIR, o vigia espera 30 s.
   Se mandar abrir 3 vezes seguidas e a tela nunca aparecer aberta, o servidor
   responde DESISTIU e o vigia para de abrir. O aviso aparece no `/healthcheck`
   (`tela.alerta`).
5. **Servidor sem dono:** se o servidor não responde por 30 s, nenhum
   `node server.js` nem INICIAR.bat está vivo e não há atualização nem
   manutenção em andamento (`eko-atualizando.flag`/`eko-manutencao.flag` com
   menos de 15 min), o vigia sobe `INICIAR.bat servidor`. O INICIAR.bat não
   sobe um segundo servidor se já há um respondendo, e a porta 3000 impede dois.
6. **Atualização remota:** o navegador só é fechado se houver vigia para reabrir.
   Sem vigia, a tela fica como está e o F5 mostra a versão nova. Tela velha é
   melhor que tela nenhuma.
7. **Passagem do INICIAR antigo:** o cmd lê o .bat pela posição em bytes, e o
   INICIAR antigo rodava o `git merge` numa linha sozinha (termina no byte 4115).
   O arquivo novo tem, dos bytes 912 a 4942, só linhas
   `goto atualizar_pos_merge`. O byte 4115 cai no meio de uma delas: o resto
   da linha dá "não é reconhecido" (inofensivo) e a linha seguinte manda o cmd
   antigo para o fim da atualização do código novo. Daqui para frente o
   merge e o goto ficam na mesma linha. O bloco pode sair quando nenhuma estação
   rodar mais o INICIAR antigo.
8. `/healthcheck` ganhou `tela`, que mostra a sessão do vigia, se a tela está
   aberta, há quanto tempo ele foi visto, a pausa e o alerta. É o jeito de
   conferir pela VPS se a sessão do monitor tem vigia.

## Opções consideradas
- **Tarefa agendada interativa ou serviço** para abrir a tela na sessão 1 pela
  VPS. Caiu porque o modo automático do Claude Code barra criar tarefa agendada
  ("Unauthorized Persistence"), e a regra é não contornar. Também seria mais uma
  peça fora do repositório.
- **Vigia em .bat com trava por redirecionamento (`9>arquivo`).** Caiu porque
  todo processo que o cmd abre dentro da trava herda o arquivo. O Chrome aberto
  pelo vigia seguraria a trava enquanto estivesse aberto, e a atualização
  acharia que há vigia quando não há, que é justamente o bug das 10h39. O mutex
  do PowerShell não é herdado.
- **A tela recarregar sozinha quando o commit muda,** sem fechar o Chrome.
  Ficou para depois: as telas abertas hoje não têm esse código, então não
  ajudaria na passagem.
- **Detectar a tela pelo perfil padrão do Chrome.** Não dá: o `--app` vira só
  mais uma janela do Chrome do usuário.

## O que acontece se repetir
- **Dois cliques no INICIAR:** o segundo vê o servidor respondendo, tira a pausa
  e sai. O segundo vigia não pega o mutex e sai. Se os dois chegarem antes de o
  servidor responder, os dois tentam subir o node, um perde a porta 3000, sai
  com erro e, na volta do laço, vê o servidor respondendo e fecha.
- **Duas atualizações seguidas:** a segunda só passa pela janela segura do
  servidor (já existia). Cada uma fecha a tela só se houver vigia, e o vigia
  reabre em 5 s depois de o servidor responder.
- **Operador fecha a tela pelo X:** volta em até 5 s, mais o tempo de abrir o
  Chrome. Se foi menos de 30 s depois de abrir, volta em até 30 s.
- **Fechar agora:** 10 min fechada e volta. O INICIAR à mão abre na hora.
- **Fechar a janela preta do servidor:** o vigia sobe de novo em cerca de 30 s.
  Para atualizar à mão, o ATUALIZAR.bat segura o vigia com
  `eko-manutencao.flag` (até 15 min).

## O que foi testado e o que ficou só por leitura
- `testes/tela-sempre-viva.js` (79 conferências). Contra o main de antes deu
  19 falhas: o servidor saía depois do POST e gravava a bandeira. Mutações numa
  cópia também ficaram vermelhas: sem o freio, sem o bloco de passagem, sem a
  pausa, sem a pausa firme dos 15 s, sem o del da bandeira numa saída do
  ATUALIZAR.bat e com o ABRIR-TELA.bat antigo.
- De verdade, no servidor real: a rota `/sistema/encerrar`, `/sistema/tela`,
  `/sistema/tela/abrir`, o `/healthcheck` e a decisão (`lib/tela.js`, com
  relógio injetado).
- **Só por leitura** (o .bat e o .ps1 não rodam no Linux): o teste confere
  rótulos, parênteses, a posição de passagem byte a byte, que o .bat não abre
  navegador, que o taskkill depende do mutex, e que nomes e palavras batem
  entre o .bat, o .ps1 e o servidor. **Não está medido:** se o Chrome desta
  versão segura mesmo o `lockfile` (sabido pelo código do Chrome, não
  conferido no Mini PC), se o mutex Global abre da sessão 0, o tempo real de
  reação e o consumo do vigia (estimado: ~60 MB de RAM, CPU desprezível). Tudo
  isso entra no ensaio num PC Windows de teste, nunca no Mini PC de produção.
- **O que se perde com o perfil novo:** o que estava salvo no navegador do
  quiosque (zoom do inventário, turno da retirada de bobinas, id do dispositivo
  do inventário) volta ao padrão uma vez. As sessões ficam no servidor e não se
  perdem.

## Revisto em 11/11/2026 (revisão do commit 15d15de)
Um revisor independente, só leitura, achou falhas. As corrigidas no commit
seguinte:
- **A pausa caía em ~1 de cada 10 cliques.** O taskkill sai ~0,5 s depois da
  pausa. Se o vigia perguntasse nesse intervalo, a tela ainda aparecia aberta e
  a pausa acabava. Agora, nos primeiros 15 s, tela aberta não desfaz a pausa.
- **ABRIR-TELA.bat abria o Chrome por conta própria** no perfil do quiosque.
  Rodado pela VPS (sessão 0), deixaria a tela invisível segurando o perfil, e o
  vigia diria "aberta" para sempre. Agora ele só pede a tela ao vigia
  (`INICIAR.bat abrir`). Para recarregar, basta fechar a janela, e o vigia
  reabre. E o vigia, uma vez por minuto, confere pelos processos que a tela
  está na sessão dele; tela do quiosque na sessão 0 é fechada.
- **Janela cmd /K parada contava como "alguém cuidando" do servidor.** O
  ATUALIZAR.bat abria o INICIAR com `start ""` (cmd /K). Agora abre com
  `cmd /c`, e o vigia só conta um INICIAR que tem node filho, que foi aberto há
  menos de 3 min ou o "INICIAR servidor" que ele mesmo subiu.
- **ATUALIZAR.bat podia trocar o código com o servidor no ar** se a
  confirmação (pause sem prazo) passasse dos 15 min da bandeira. Agora ele
  confere de novo depois da tecla e para se o servidor voltou.
- **O vigia nunca era atualizado.** Agora, uma vez por minuto, ele vê se o
  tela-vigia.ps1 mudou. Se mudou, sobe a versão nova e sai, e a nova espera
  até 15 s pelo mutex do antigo.

Ficaram em aberto, de propósito:
- **Na passagem não nasce vigia se o INICIAR está na sessão 0** (como estava
  hoje às 10h53). O vigia só existe na sessão do monitor, e da VPS não há como
  criá-lo lá sem tarefa agendada. Até alguém abrir o INICIAR no monitor (ou o
  Mini PC reiniciar), o "Fechar agora" fecha a tela e ela não volta sozinha.
  Conferir `tela.vigia` no `/healthcheck`: `null` = falta vigia.
- **Node travado** (respondendo nada, mas vivo) conta como "alguém cuidando":
  o vigia não mata node. Já era assim antes.
- **Servidor na sessão 0 não tem janela para fechar.** O ATUALIZAR.bat manual
  desiste em 3 min. O caminho é a atualização remota (o padrão desde 17/10).
- **INICIAR ou node rodando elevados ou como outro usuário:** o vigia não lê a
  linha de comando deles e pode subir um segundo laço. O perdedor sai pela
  porta 3000. Com a conta `usuario` comum, isso não acontece.
- **Conferências de texto do .bat e do .ps1** (sessão 0, mutex, taskkill)
  provam o que está escrito, não o que o Windows faz. Só o ensaio prova. O
  primeiro sinal é a linha "vigia iniciado" em `logs\tela-vigia.log`.
