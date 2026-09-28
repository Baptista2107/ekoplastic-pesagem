# Ekoplastic Coletor (app Android)

App para o coletor de dados (CMX Supply TC60, Android 14) abrir o sistema de pesagem do Mini PC
numa janela só, sem barra de navegador. Criado na VPS em 28/09/2026.

**O app fala só com o Mini PC** (`https://192.168.3.43:3443`, rede da fábrica).
A tela e as regras vêm do Mini PC, e cada leitura é gravada lá. O app não
guarda dado nem fala com a internet.

## Instalar no coletor

1. Copie o `ekoplastic-coletor-<versão>.apk` para o coletor (pelo Drive,
   `EKOPLASTIC/COLETOR/`, ou por cabo USB).
2. Abra o arquivo no coletor. Se pedir, permita "instalar apps de fonte
   desconhecida" para o gerenciador de arquivos.
3. Abra **Ekoplastic Coletor** e permita a **câmera**.
4. Na primeira conexão aparece **"Confiar no Mini PC?"** com a impressão
   digital do certificado. Toque em **Confiar**. Isso só aparece de novo se o
   certificado do Mini PC mudar.
5. Entre com o PIN do colaborador, como no celular.

## Leitor embutido do coletor

**No TC60 o código chega por broadcast** (v1.2): app *Scan Assist* →
Output Settings → Broadcast Output **ligado**, Broadcast Action
`com.service.scanner.data`, Code Data Label `ScanCode`. É o padrão de
fábrica, não precisa mexer. Se alguém mudar esses nomes, o gatilho para
de funcionar no app.

O app aceita os três jeitos que um leitor embutido entrega o código:

- **Preencher campo** (v1.1): o leitor escreve direto no campo de texto em
  foco. O app mantém um campo invisível em foco, sem abrir o teclado da
  tela. Foi o que faltou na v1.0: no TC60 o laser acendia e nada chegava.

- **Teclado** (o mais comum de fábrica): o leitor "digita" o código e dá
  Enter. Não precisa configurar nada.
- **Broadcast** (aviso interno do Android): o app já escuta os nomes de
  Urovo, iData, Seuic, Newland, Sunmi, Chainway, Kaicom e Zebra. Se o CMX usar
  outro, veja no app de configuração do leitor o nome da **ação** e do
  **dado** e preencha em *Configuração → Aviso avulso*. Outra saída: configurar
  o leitor para enviar a ação `br.com.ekoplastic.coletor.SCAN` com o dado
  `data`.

**Botão "Ler etiqueta" (v1.3; saiu da tela em 28/09 — só o gatilho lê)** acende o laser do coletor pelo aviso
`com.service.scanner.start.scanning` do TC60 (apaga sozinho em 6 s se nada
for lido). Para voltar a usar a câmera: *Configuração → desmarcar "Botão de
ler usa o laser"*.

⚠ Se o laser acende e NÃO lê nem no próprio Scan Assist, o problema é do
leitor, não do app: confira *Code Type Settings → Code 128 ligado* (a
etiqueta da bobina é Code 128) e teste um EAN de caixa num bloco de notas.

Aceita o prefixo de simbologia (`]C1`). **Leitura do leitor só vale completa**
(letra + 7 dígitos, v1.5): leitura pela metade dá "⚠ Leitura incompleta —
bipe de novo". Nunca completa sozinha (a v1.4 completava e uma etiqueta R…
lida pela metade virou a bobina E0001674). O "só número → E…" existe só no
botão Digitar da tela, onde é gente digitando.

## A tela não tem saída (v1.4)

No app, o operador não sai da tela definida: o ✕ do topo e o "voltar ao
menu" do PIN ficam escondidos, e qualquer navegação para outra página é
bloqueada. O Voltar do Android só fecha o que estiver aberto por cima. No
PC e no celular pelo navegador, nada muda.

Para travar também o botão Home, use a **fixação de tela** do Android
(Configurações → Segurança → Fixar app) com o app aberto.

## Configuração (escondida)

**Toque longo de 2 s no título da tela** (ou o botão da página de erro):

- endereço do Mini PC e página inicial;
- aviso avulso do leitor (ação e nome do dado);
- **diagnóstico**: último código lido e por onde chegou (campo, teclado ou
  qual aviso), quantas teclas e avisos o app recebeu. É a primeira coisa a olhar se a bipada não fizer nada;
- certificado confiado, com o botão *Esquecer certificado*.

## Gerar uma versão nova (na VPS)

```
cd android && ./build.sh
```

Sem Gradle nem Android Studio: usa só o JDK 17 e o Android SDK
(`~/ferramentas/` na VPS). Suba `android:versionCode` e `android:versionName`
no `AndroidManifest.xml` a cada versão, senão o coletor não atualiza.

⚠ **Chave de assinatura**: `~/.android-keys/ekoplastic-coletor.jks` (+ senha)
na VPS, **fora do Git**. É ela que permite instalar uma versão nova por cima
da antiga. Se ela se perder, a próxima versão só instala depois de
desinstalar a anterior.

## Validação

**28/09/2026, v1.3, CMX TC60 (Android 14): funcionou no aparelho**, segundo o
Frederico: gatilho, botão "Ler etiqueta" acendendo o laser, cartão da
bobina com P1/P2 e diagnóstico. Antes disso, o leitor não decodificava nem
no próprio Scan Assist, e foi acertado no aparelho (causa exata não
registrada).
