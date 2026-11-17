# Coletor avisa quando o turno do corte passa da hora sem "Encerrar turno" (17/11/2026)

## Decisão
Gustavo, 17/11, respondendo à recomendação sobre a bobina que passa de turno:
"sobre a bobina ok, se não subiu algo ainda pra produção esse é o momento".

A recomendação tinha 2 partes:
1. **Aviso no coletor quando o turno passa da hora sem "Encerrar turno"** — feito aqui.
2. **Nome do operador de volta na troca de bobina** — já estava feito em 13/11
   (118770a e d3c7d03, "Quem está bipando?" obrigatório). Medido na VPS
   (`bobina_parciais`): de 09 a 12/11, 100% dos fins de bobina e de turno vinham
   sem nome. De 14 a 17/11, 0 de 44 sem nome. Nada a fazer.

## Por quê
Em 17/11 o Turno C da P1 e da P2 ficou aberto até 08:20, e só fechou na correção
do Gustavo. As bobinas que o A montou depois das 06:00 entraram no C, e o aviso
de fardos saiu errado (E0002502). A bobina que passa de turno é a que mais gera
aviso falso: fora por 3+ fardos em 24% delas, contra 12% das de um turno só
(docs/decisoes/2026-11-13-bobina-que-passa-de-turno.md, no bling-claude).

## Como ficou
- O servidor do Mini PC (`lib/turno-corte-hora.js`) diz quando cada turno acaba:
  A 18:00, EXTRA 22:00, C 06:00 (o do dia seguinte, se abriu antes da meia-noite).
  `GET /bobinas/turno-corte` manda `atrasado: { fim_previsto, minutos }` no turno
  aberto que passou disso há 15 min ou mais. Antes disso, manda `null`.
- O card "Turno do corte" fica vermelho, piscando, com "‼️ TURNO C PASSOU DAS 06:00
  (há …) — ENCERRE O TURNO". A tela atualiza de minuto em minuto.
- Ao bipar uma bobina, o mesmo aviso aparece em cima dos botões P1/P2.
- **Só aviso.** Nada fecha sozinho e a bipagem não trava. Encerrar o turno pede os
  fardos da bobina montada e a senha do supervisor. Fechar sozinho gravaria 0
  fardos, e travar a bipagem pararia a máquina às 6h sem supervisor.

## Medido antes
Os horários vêm de `turnos_corte` (VPS), de 05 a 17/11/2026, P1:
- A encerra entre 17:52 e 17:57. Na sexta, mais cedo (16:01 e 16:55).
- EXTRA encerra entre 21:59 e 22:21.
- C encerra entre 05:56 e 06:04.

Com a folga de 15 min, nenhum encerramento normal teria visto o aviso. Só o EXTRA
de 11/11 (encerrado às 22:21) veria. O teste confere os 9 casos reais.

## Opções que ficaram de fora
- Fechar o "vão das 18h" (Encerrar 17:55 → Iniciar 18:07-18:24, a máquina corta e
  ninguém lança). Continua aberto. Não é o mesmo problema: lá o turno está fechado,
  e o card já mostra "Sem turno aberto" em âmbar.
- Aviso no Telegram para o encarregado. Não foi pedido; fica para se o aviso no
  coletor não bastar.

## Sem medir
- Se o aviso no coletor é visto às 6h. Medir: quantas vezes o turno passa da hora
  daqui em diante (`turnos_corte`, encerramento mais de 15 min depois do fim).
- A começa às 18:30 por engano: o fim previsto vira o dia seguinte às 18:00, e o
  aviso não sai. Nunca aconteceu nos dados medidos.
- Sábado sem A e domingo sem turno: o aviso só olha o turno aberto, então não muda nada.

## Testes
- `testes/turno-corte-hora.js` (Node, entra no rodar-todos): regra pura, os
  encerramentos reais, a rota no servidor real e o HTML. Fica vermelho com a rota
  sem o `atrasado` (mutação).
- `testes/navegador/turno_atrasado_coletor.py` (Chromium da VPS, fora do
  rodar-todos): card, bipagem e "encerrar apaga" em 360, 390 e 414 px, sem rolar.
  Fica vermelho com a tela de antes.
