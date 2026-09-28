#!/bin/bash
# Gera o APK do Ekoplastic Coletor SEM Gradle nem Android Studio: só as
# ferramentas do SDK (aapt2, javac, d8, zipalign, apksigner). O app não tem
# dependência externa — é uma WebView — então o Gradle seria só peso.
#
# Uso:
#   ./build.sh                       # os dois apps
#   VARIANTE=bobinas ./build.sh      # só "Ekoplastic Coletor" (bobina na sacoleira)
#   VARIANTE=inventario ./build.sh   # só "Ekoplastic Inventário" (MP e PA)
#
# O MESMO código gera os dois (v1.6, 28/09/2026): o manifesto é um modelo com
# @MARCADORES@ que este script preenche — pacote, nome, ícone, página inicial,
# leitura estrita e trava de página. O pacote do de bobinas continua
# br.com.ekoplastic.coletor, para a versão nova instalar por cima da antiga.
#
# Variáveis (com o padrão da VPS da Ekoplastic):
#   JAVA_HOME        JDK 17
#   ANDROID_SDK      com platforms;android-34 e build-tools;34.0.0
#   KEYSTORE         chave de assinatura (FORA do repositório)
#   KEYSTORE_SENHA   arquivo com a senha da chave (FORA do repositório)
#
# ⚠ A CHAVE DE ASSINATURA é o que permite atualizar o app sem desinstalar.
# Se ela se perder, a próxima versão só instala depois de desinstalar a
# anterior (o Android recusa assinatura diferente). Ela NUNCA entra no Git.
set -euo pipefail
AQUI="$(cd "$(dirname "$0")" && pwd)"
JAVA_HOME="${JAVA_HOME:-$(ls -d "$HOME"/ferramentas/jdk-17* 2>/dev/null | head -1)}"
ANDROID_SDK="${ANDROID_SDK:-$HOME/ferramentas/android-sdk}"
KEYSTORE="${KEYSTORE:-$HOME/.android-keys/ekoplastic-coletor.jks}"
KEYSTORE_SENHA="${KEYSTORE_SENHA:-$HOME/.android-keys/ekoplastic-coletor.senha}"
BT="$ANDROID_SDK/build-tools/34.0.0"
PLAT="$ANDROID_SDK/platforms/android-34/android.jar"
export PATH="$JAVA_HOME/bin:$PATH"

for f in "$BT/aapt2" "$BT/d8" "$BT/zipalign" "$BT/apksigner" "$PLAT" "$JAVA_HOME/bin/javac"; do
  [ -e "$f" ] || { echo "FALTA: $f"; exit 1; }
done
[ -f "$KEYSTORE" ] && [ -f "$KEYSTORE_SENHA" ] || { echo "FALTA a chave de assinatura: $KEYSTORE (+ senha)"; exit 1; }

SRC="$AQUI/app/src/main"
VERSAO=$(sed -n 's/.*android:versionName="\([^"]*\)".*/\1/p' "$SRC/AndroidManifest.xml")

if [ -z "${VARIANTE:-}" ]; then
  VARIANTE=bobinas "$0" && VARIANTE=inventario "$0"; exit $?
fi
case "$VARIANTE" in
  bobinas)    PACOTE=br.com.ekoplastic.coletor;    NOME="Ekoplastic Coletor";    ICONE=icone
              PAGINA=/retirada-bobinas.html;       ESTRITA=true;  TRAVAR=true;  ARQ=ekoplastic-coletor ;;
  inventario) PACOTE=br.com.ekoplastic.inventario; NOME="Ekoplastic Inventário"; ICONE=icone_inventario
              PAGINA=/inventario.html;             ESTRITA=false; TRAVAR=false; ARQ=ekoplastic-inventario ;;
  *) echo "VARIANTE desconhecida: $VARIANTE (bobinas | inventario)"; exit 1 ;;
esac
echo "=== $NOME ($PACOTE) · $PAGINA · v$VERSAO"

OUT="$AQUI/build/$VARIANTE"
rm -rf "$OUT"; mkdir -p "$OUT/res" "$OUT/classes" "$OUT/dex"
sed -e "s|@PACOTE@|$PACOTE|g" -e "s|@NOME@|$NOME|g" -e "s|@ICONE@|$ICONE|g" \
    -e "s|@PAGINA@|$PAGINA|g" -e "s|@ESTRITA@|$ESTRITA|g" -e "s|@TRAVAR@|$TRAVAR|g" \
    "$SRC/AndroidManifest.xml" > "$OUT/AndroidManifest.xml"
if grep -qE '@(PACOTE|NOME|ICONE|PAGINA|ESTRITA|TRAVAR)@' "$OUT/AndroidManifest.xml"; then echo "marcador sem valor no manifesto"; exit 1; fi

echo "1/5 recursos"
"$BT/aapt2" compile --dir "$SRC/res" -o "$OUT/res/res.zip"
"$BT/aapt2" link -o "$OUT/base.apk" -I "$PLAT" --manifest "$OUT/AndroidManifest.xml" \
  -A "$SRC/assets" --java "$OUT/gen" "$OUT/res/res.zip"

echo "2/5 java"
javac -encoding UTF-8 --release 8 -Xlint:-options -classpath "$PLAT" -d "$OUT/classes" \
  $(find "$SRC/java" "$OUT/gen" -name '*.java')

echo "3/5 dex"
"$BT/d8" --release --min-api 24 --lib "$PLAT" --output "$OUT/dex" $(find "$OUT/classes" -name '*.class')
# python3 no lugar do `zip`, que não vem instalado em toda máquina.
python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1],'a',zipfile.ZIP_DEFLATED).write(sys.argv[2],'classes.dex')" \
  "$OUT/base.apk" "$OUT/dex/classes.dex"

echo "4/5 alinhar"
"$BT/zipalign" -f -p 4 "$OUT/base.apk" "$OUT/alinhado.apk"

echo "5/5 assinar"
APK="$AQUI/build/$ARQ-$VERSAO.apk"
"$BT/apksigner" sign --ks "$KEYSTORE" --ks-pass "file:$KEYSTORE_SENHA" --out "$APK" "$OUT/alinhado.apk"
"$BT/apksigner" verify "$APK"
rm -f "$OUT/base.apk" "$OUT/alinhado.apk" "$APK.idsig"
echo "OK: $APK ($(du -h "$APK" | cut -f1))"
sha256sum "$APK"
