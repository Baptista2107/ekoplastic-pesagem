package br.com.ekoplastic.coletor;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslCertificate;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.text.InputType;
import android.view.KeyEvent;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/**
 * Ekoplastic Coletor — o sistema de pesagem do Mini PC numa janela só.
 *
 * O app NÃO tem regra de negócio: a tela vem do Mini PC e cada leitura é
 * gravada lá. O que ele acrescenta ao navegador:
 *
 *  1. Certificado. O Mini PC usa certificado próprio (auto-assinado). Em vez
 *     de "aceitar qualquer certificado", o app guarda a impressão digital
 *     SHA-256 do primeiro que vê, depois de o operador confirmar, e daí em
 *     diante só aceita aquele (confiança no primeiro uso). Se mudar, avisa.
 *
 *  2. Leitor embutido do coletor. Coletores entregam o código de dois jeitos:
 *     "teclado" (digita o código e dá Enter) ou "broadcast" (aviso interno do
 *     Android, com nome que muda por fabricante). O app escuta os dois e
 *     entrega o código à tela chamando a mesma função da câmera, onLeu().
 *     A marca do coletor (CMX Supply) não foi identificada até 28/09/2026,
 *     por isso a lista de avisos cobre os fabricantes mais comuns, mais um
 *     avulso configurável. A tela de configuração mostra o último código
 *     recebido e por onde chegou — é o diagnóstico na primeira bipada.
 *
 *  3. Endereço configurável. Toque longo (2 s) no título da tela, ou o botão
 *     da página de erro, abre a configuração: endereço do Mini PC, página
 *     inicial, aviso avulso do leitor e o certificado confiado.
 */
public class MainActivity extends Activity {

    static final String URL_PADRAO = "https://192.168.3.43:3443";

    // ── Variante do app (v1.6, 28/09/2026) ──
    // O MESMO código gera dois apps (build.sh VARIANTE=bobinas|inventario).
    // O que muda vem do <meta-data> do manifesto:
    //   pagina          página inicial no Mini PC;
    //   leitura_estrita true = só etiqueta exata (letra + 7 dígitos) — bobinas;
    //                   false = entrega o texto lido e a PÁGINA valida (a do
    //                   inventário lê QR de gaiola "EKOPA|id|formato|…");
    //   travar_pagina   true = não sai da página (bobinas); false = navega
    //                   dentro do Mini PC e o Voltar volta (inventário).
    String PAGINA_PADRAO = "/retirada-bobinas.html";
    boolean LEITURA_ESTRITA = true, TRAVAR_PAGINA = true;

    void lerVariante() {
        try {
            Bundle m = getPackageManager().getApplicationInfo(getPackageName(),
                    PackageManager.GET_META_DATA).metaData;
            if (m != null) {
                PAGINA_PADRAO = m.getString("pagina", PAGINA_PADRAO);
                LEITURA_ESTRITA = m.getBoolean("leitura_estrita", true);
                TRAVAR_PAGINA = m.getBoolean("travar_pagina", true);
            }
        } catch (Exception ignore) {}
    }
    static final String ACAO_PROPRIA = "br.com.ekoplastic.coletor.SCAN";

    /** Avisos (broadcast) dos leitores mais comuns. Ação → nome do dado. */
    static final String[][] AVISOS = {
        // CMX Supply TC60 (Android 14) — lido nos prints do app "Scan Assist"
        // do próprio coletor em 28/09/2026: Output Settings → Broadcast Action
        // = com.service.scanner.data, Code Data Label = ScanCode, Byte Data
        // Label = ScanCodeBytes. As v1.0 e v1.1 não tinham este nome e o
        // gatilho "não fazia nada".
        {"com.service.scanner.data", "ScanCode"},
        {"android.intent.ACTION_DECODE_DATA", "barcode_string"},          // Urovo
        {"com.android.server.scannerservice.broadcast", "scannerdata"},   // Seuic / genéricos
        {"android.intent.action.SCANRESULT", "value"},                    // iData
        {"nlscan.action.SCANNER_RESULT", "SCAN_BARCODE1"},                // Newland
        {"com.sunmi.scanner.ACTION_DATA_CODE_RECEIVED", "data"},          // Sunmi
        {"com.scanner.broadcast", "data"},                                // Chainway
        {"scan.rcv.message", "barocode"},                                 // Kaicom / genéricos (bytes)
        {"com.symbol.datawedge.api.RESULT_ACTION", "com.symbol.datawedge.data_string"}, // Zebra
        {ACAO_PROPRIA, "data"},                                           // configurado à mão
    };
    /** Nomes de dado tentados em qualquer aviso, depois do nome esperado. */
    static final String[] CHAVES = {"ScanCode", "ScanCodeBytes", "barcode_string", "scannerdata", "value", "SCAN_BARCODE1", "data",
        "barcodeData", "barcode", "decode_data", "scan_data", "com.symbol.datawedge.data_string", "barocode"};

    /** Etiqueta do sistema: uma letra e EXATAMENTE 7 dígitos (E0001669,
     *  R0000914, P0000760…). Conferido no banco em 28/09/2026: todas têm 8
     *  caracteres. Nada mais curto ou mais longo é etiqueta. */
    static final Pattern ETIQUETA = Pattern.compile("^[A-Z]\\d{7}$");

    WebView web;
    SharedPreferences prefs;
    final Handler ui = new Handler(Looper.getMainLooper());
    PermissionRequest pedidoCamera;

    // leitor em modo teclado
    final StringBuilder buf = new StringBuilder();
    long bufInicio, bufUltima;
    final Runnable fechaBufSemEnter = () -> tentarEntregarBuffer("teclado (sem Enter)");

    // diagnóstico
    String ultimoCodigo = "—", ultimaOrigem = "—", ultimasTeclas = "";
    int teclasVistas = 0, avisosVistos = 0, ignoradas = 0;
    /**
     * v1.9 (28/09/2026): o TC60 entrega cada leitura pelo AVISO (broadcast,
     * completo) e pelo TECLADO SIMULADO ao mesmo tempo. O teclado chega
     * picotado às vezes (intervalo entre teclas acima do limite), e o pedaço
     * gerava "leitura incompleta" com a leitura boa já entregue pelo aviso.
     * Depois que um aviso entrega um código nesta sessão, os caminhos de
     * teclado e de campo são cópia: ficam ignorados. Coletor que só tem
     * teclado nunca liga isto e continua como antes.
     */
    boolean avisoFunciona = false;
    String entregueCodigo = ""; long entregueEm = 0;

    BroadcastReceiver receptor = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent it) {
            avisosVistos++;
            String cod = extrairCodigo(it);
            if (cod != null) { avisoFunciona = true; entregar(cod, "aviso " + it.getAction()); }
            else { ultimaOrigem = "aviso " + it.getAction() + " (sem código reconhecido: " + chavesDe(it) + ")"; }
        }
    };

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        prefs = getSharedPreferences("coletor", MODE_PRIVATE);
        lerVariante();
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setStatusBarColor(Color.parseColor("#0A1119"));

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0A1119"));
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // a tela usa localStorage/sessionStorage
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUserAgentString(s.getUserAgentString() + " EkoColetor/" + versao());
        web.addJavascriptInterface(new Ponte(), "EkoApp");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedSslError(WebView v, SslErrorHandler h, SslError e) {
                decidirCertificado(h, e);
            }
            @Override
            public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (r.isForMainFrame()) mostrarErro(String.valueOf(e.getDescription()));
            }
            @Override
            public void onPageFinished(WebView v, String url) {
                if (url.startsWith("https://")) { if (TRAVAR_PAGINA) esconderSaidas(); injetarAtalhos(); }
            }
            @Override
            public void onPageCommitVisible(WebView v, String url) {
                if (url.startsWith("https://") && TRAVAR_PAGINA) esconderSaidas();
            }
            /**
             * v1.4 — o coletor NÃO sai da tela definida (Frederico,
             * 28/09/2026). Só navega para a página configurada no Mini PC;
             * clique no ✕, no "voltar ao menu" do PIN ou em qualquer link para
             * outra página é ignorado. No PC/celular pelo navegador nada muda.
             */
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl(), nosso = Uri.parse(base());
                boolean mesmoMiniPc = u.getHost() != null && u.getHost().equals(nosso.getHost())
                        && u.getPort() == nosso.getPort();
                // Inventário (v1.6): navega à vontade DENTRO do Mini PC — sair
                // para conferir outra tela e voltar; a contagem fica guardada
                // no aparelho e no Mini PC (rascunho). Nunca sai do Mini PC.
                if (!TRAVAR_PAGINA) return !mesmoMiniPc;
                return !(mesmoMiniPc && pagina().equals(u.getPath()));   // true = bloqueia
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest r) {
                ui.post(() -> {
                    if (temCamera()) concederCamera(r);
                    else { pedidoCamera = r; requestPermissions(new String[]{Manifest.permission.CAMERA}, 1); }
                });
            }
        });

        registrarAvisos();
        if (!temCamera()) requestPermissions(new String[]{Manifest.permission.CAMERA}, 1);
        abrir();
    }

    // ─────────────────────────── navegação ───────────────────────────

    String base() { return prefs.getString("base", URL_PADRAO).replaceAll("/+$", ""); }
    String pagina() { return prefs.getString("pagina", PAGINA_PADRAO); }

    void abrir() { web.loadUrl(base() + pagina()); }

    void mostrarErro(String detalhe) {
        web.loadUrl("file:///android_asset/erro.html?url=" + Uri.encode(base() + pagina())
                + "&erro=" + Uri.encode(detalhe == null ? "" : detalhe));
    }

    @Override
    public void onBackPressed() {
        // Sem trava (não usado hoje): volta à tela anterior, nunca fecha o app.
        if (!TRAVAR_PAGINA) { if (web.canGoBack()) web.goBack(); return; }
        // Travado (os dois apps, v1.7): o Voltar do Android não sai da tela nem
        // fecha o app. Em ordem: fecha a janela aberta por cima (fardos da
        // bobina); senão aciona o "← Voltar" DA PRÓPRIA TELA, se estiver à
        // vista (navegação interna do inventário); senão fecha o cartão da
        // bobina lida.
        web.evaluateJavascript("(function(){var m=document.querySelector('.modal-fundo');"
            + "if(m){var c=m.querySelector('#md-cancelar');if(c)c.click();else m.remove();return;}"
            + "var v=document.getElementById('btn-voltar');"
            + "if(v&&v.offsetParent!==null&&getComputedStyle(v).display!=='none'){v.click();return;}"
            + "if(typeof cancelarLeitura==='function')cancelarLeitura();})()", null);
    }

    /** Esconde as saídas da página (o ✕ do topo e o "voltar ao menu" do PIN). */
    void esconderSaidas() {
        web.evaluateJavascript("(function(){if(document.getElementById('__ekoSemSaida'))return;"
            + "var s=document.createElement('style');s.id='__ekoSemSaida';"
            + "s.textContent='.btn-sair,.rodape a[href=\"/\"]{display:none!important}';"
            + "(document.head||document.documentElement).appendChild(s);})()", null);
    }

    /**
     * Injetado em toda página do Mini PC (a página não precisa saber do app):
     *
     *  - toque longo de 2 s no título abre a configuração do app;
     *  - CAMPO INVISÍVEL DE LEITURA. v1.1 (28/09/2026): no primeiro teste no
     *    CMX o laser acendia e nada chegava. Leitores em modo "preencher
     *    campo" escrevem o código DIRETO no campo de texto em foco (sem gerar
     *    teclas), e a tela de bobinas não tem campo em foco. Este campo fica
     *    em foco sempre que nenhum outro estiver (o dos fardos continua
     *    recebendo o foco normalmente), com inputmode=none para o teclado da
     *    tela não abrir. O que cair nele vai para EkoApp.lido().
     */
    void injetarAtalhos() {
        web.evaluateJavascript(
            "(function(){if(window.__ekoApp)return;window.__ekoApp=1;" +
            "var h=document.querySelector('header h1')||document.querySelector('h1');if(h){var t=null;" +
            "function ini(){t=setTimeout(function(){t=null;EkoApp.configurar();},2000);}" +
            "function fim(){if(t){clearTimeout(t);t=null;}}" +
            "h.addEventListener('touchstart',ini,{passive:true});h.addEventListener('touchend',fim);" +
            "h.addEventListener('touchmove',fim);h.addEventListener('mousedown',ini);h.addEventListener('mouseup',fim);}" +
            // campo invisível de leitura
            "var c=document.createElement('input');c.id='__ekoScan';c.setAttribute('inputmode','none');" +
            "c.setAttribute('autocomplete','off');c.setAttribute('aria-hidden','true');" +
            "c.style.cssText='position:fixed;left:-200px;top:0;width:10px;height:10px;opacity:0;';" +
            "document.body.appendChild(c);var d=null;" +
            "function entrega(){if(d){clearTimeout(d);d=null;}var v=c.value;c.value='';if(v&&v.trim())EkoApp.lido(v);}" +
            "c.addEventListener('keydown',function(e){if(e.key==='Enter'||e.keyCode===13||e.key==='Tab'){e.preventDefault();entrega();}});" +
            "c.addEventListener('input',function(){if(d)clearTimeout(d);d=setTimeout(entrega,700);});" +
            "function foco(){var a=document.activeElement;if(!a||a===document.body||a===document.documentElement)c.focus({preventScroll:true});}" +
            "setInterval(foco,700);document.addEventListener('touchend',function(){setTimeout(foco,300);});foco();" +
            "window.__ekoLimpa=function(){c.value='';};" +
            // (v1.6: saiu o "botão de ler aciona o laser" — as duas telas não
            // têm mais botão de câmera; lê o gatilho. EkoApp.laser() ficou.)
            "})()",
            null);
    }

    // ─────────────────────────── laser por software ───────────────────────────

    // TC60 (Scan Assist → Code Scan Settings): "Broadcast for Starting Scan"
    // e "Stopping Scan". Lidos nos prints de 28/09/2026.
    static final String LASER_LIGA = "com.service.scanner.start.scanning";
    static final String LASER_DESLIGA = "com.service.scanner.stop.scanning";
    long laserEm = 0;

    /** Acende o laser. Se nada for lido em 6 s, apaga (o gatilho físico
     *  apaga sozinho ao soltar; o comando por software não tem "soltar"). */
    void laser() {
        final long meu = SystemClock.uptimeMillis();
        laserEm = meu;
        sendBroadcast(new Intent(LASER_LIGA));
        ui.postDelayed(() -> {
            if (laserEm == meu && entregueEm < meu) sendBroadcast(new Intent(LASER_DESLIGA));
        }, 6000);
    }

    // ─────────────────────────── certificado ───────────────────────────

    void decidirCertificado(SslErrorHandler h, SslError e) {
        Uri alvo = Uri.parse(e.getUrl()), nosso = Uri.parse(base());
        // Só o Mini PC configurado. Qualquer outro endereço com certificado
        // inválido é recusado sem perguntar.
        if (alvo.getHost() == null || !alvo.getHost().equals(nosso.getHost()) || alvo.getPort() != nosso.getPort()) {
            h.cancel();
            return;
        }
        String dig = digital(e.getCertificate());
        if (dig == null) { h.cancel(); mostrarErro("certificado ilegível"); return; }
        String chave = "cert_" + nosso.getHost() + "_" + nosso.getPort();
        String confiado = prefs.getString(chave, null);
        if (dig.equals(confiado)) { h.proceed(); return; }

        String titulo = confiado == null ? "Confiar no Mini PC?" : "⚠ O certificado do Mini PC MUDOU";
        String msg = (confiado == null
                ? "Primeira conexão com " + nosso.getHost() + ".\n\nConfira se é o Mini PC da pesagem.\n\n"
                : "Isso acontece quando o Mini PC troca de rede ou é reinstalado. Se não houve nada disso, chame a manutenção.\n\n")
                + "Impressão digital:\n" + dig;
        new AlertDialog.Builder(this).setTitle(titulo).setMessage(msg).setCancelable(false)
            .setPositiveButton("Confiar", (d, w) -> { prefs.edit().putString(chave, dig).apply(); h.proceed(); })
            .setNegativeButton("Cancelar", (d, w) -> { h.cancel(); mostrarErro("certificado não confirmado"); })
            .show();
    }

    static String digital(SslCertificate c) {
        try {
            byte[] der = SslCertificate.saveState(c).getByteArray("x509-certificate");
            if (der == null) return null;
            byte[] h = MessageDigest.getInstance("SHA-256").digest(der);
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < h.length; i++) { if (i > 0) sb.append(i % 8 == 0 ? "\n" : ":"); sb.append(String.format("%02X", h[i])); }
            return sb.toString();
        } catch (Exception ex) { return null; }
    }

    // ─────────────────────────── câmera ───────────────────────────

    boolean temCamera() { return checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED; }

    void concederCamera(PermissionRequest r) {
        List<String> ok = new ArrayList<>();
        for (String res : r.getResources()) if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(res)) ok.add(res);
        if (ok.isEmpty()) r.deny(); else r.grant(ok.toArray(new String[0]));
    }

    @Override
    public void onRequestPermissionsResult(int cod, String[] p, int[] res) {
        if (pedidoCamera != null) {
            if (temCamera()) concederCamera(pedidoCamera); else pedidoCamera.deny();
            pedidoCamera = null;
        }
    }

    // ─────────────────────────── leitor embutido ───────────────────────────

    void registrarAvisos() {
        IntentFilter f = new IntentFilter();
        for (String[] a : AVISOS) f.addAction(a[0]);
        String avulsa = prefs.getString("acao_avulsa", "").trim();
        if (!avulsa.isEmpty()) f.addAction(avulsa);
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(receptor, f, Context.RECEIVER_EXPORTED);
        else registerReceiver(receptor, f);
    }

    String extrairCodigo(Intent it) {
        Bundle ex = it.getExtras();
        if (ex == null) return null;
        List<String> chaves = new ArrayList<>();
        for (String[] a : AVISOS) if (a[0].equals(it.getAction())) chaves.add(a[1]);
        String avulsaChave = prefs.getString("chave_avulsa", "").trim();
        if (!avulsaChave.isEmpty()) chaves.add(avulsaChave);
        for (String k : CHAVES) chaves.add(k);
        for (String k : chaves) {
            Object v = ex.get(k);
            String s = null;
            if (v instanceof String) s = (String) v;
            else if (v instanceof byte[]) {
                byte[] bs = (byte[]) v;
                int n = ex.getInt("length", bs.length);
                s = new String(bs, 0, Math.min(Math.max(n, 0), bs.length));
            }
            if (s != null && !s.trim().isEmpty()) return s;
        }
        // Último recurso: qualquer texto do aviso que tenha cara de etiqueta.
        for (String k : ex.keySet()) {
            Object v = ex.get(k);
            if (v instanceof String && ETIQUETA.matcher(normalizar((String) v)).matches()) return (String) v;
        }
        return null;
    }

    static String chavesDe(Intent it) {
        Bundle ex = it.getExtras();
        return ex == null ? "nenhum dado" : String.valueOf(ex.keySet());
    }

    /**
     * Leitor em modo teclado: os caracteres chegam muito mais rápido do que
     * uma pessoa digita. Junta o que chegar com menos de 80 ms entre um e
     * outro; no Enter (ou 250 ms sem Enter), se tiver cara de etiqueta, entrega.
     * As teclas continuam indo para a página — o teclado do coletor segue
     * funcionando para digitar os fardos.
     */
    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        if (e.getAction() == KeyEvent.ACTION_DOWN) {
            long agora = SystemClock.uptimeMillis();
            int kc = e.getKeyCode();
            // diagnóstico: o que o aparelho está mandando como tecla
            teclasVistas++;
            ultimasTeclas = (ultimasTeclas + " " + KeyEvent.keyCodeToString(kc).replace("KEYCODE_", ""));
            if (ultimasTeclas.length() > 120) ultimasTeclas = ultimasTeclas.substring(ultimasTeclas.length() - 120);
            if (kc == KeyEvent.KEYCODE_ENTER || kc == KeyEvent.KEYCODE_NUMPAD_ENTER || kc == KeyEvent.KEYCODE_TAB) {
                if (tentarEntregarBuffer("teclado")) return true;
            } else {
                int ch = e.getUnicodeChar();
                if (ch > 32) {
                    if (buf.length() == 0 || agora - bufUltima > 80) { buf.setLength(0); bufInicio = agora; }
                    buf.append((char) ch);
                    bufUltima = agora;
                    ui.removeCallbacks(fechaBufSemEnter);
                    ui.postDelayed(fechaBufSemEnter, 250);
                }
            }
        }
        return super.dispatchKeyEvent(e);
    }

    boolean tentarEntregarBuffer(String origem) {
        ui.removeCallbacks(fechaBufSemEnter);
        String s = buf.toString();
        long dur = bufUltima - bufInicio;
        buf.setLength(0);
        String cod = normalizar(s);
        // Rápido demais para dedo: >= 6 caracteres em menos de 60 ms cada.
        if (ETIQUETA.matcher(cod).matches() && s.length() >= 6 && dur <= 60L * s.length()) {
            entregar(cod, origem);
            return true;
        }
        return false;
    }

    /**
     * Texto do leitor → código da etiqueta. Tira o prefixo de simbologia AIM
     * que alguns leitores põem na frente (]C1 = Code 128). O resto tem de ser
     * exatamente a etiqueta.
     *
     * v1.5 (28/09/2026): NÃO completa mais "só números" com E. O leitor leu
     * uma etiqueta R… pela metade, sobraram os dígitos, a v1.4 fez E + dígitos
     * e apontou OUTRA bobina que existia (E0001674 foi para a P1 por engano).
     * Leitura do leitor só vale completa: letra + 7 dígitos. O "só número"
     * continua existindo no botão Digitar da página, onde é gente digitando.
     */
    static String normalizar(String s) {
        String t = s == null ? "" : s.trim().toUpperCase();
        t = t.replaceFirst("^\\][A-Z0-9][0-9]", "");
        // Sem "achar a etiqueta dentro do texto": E00016690 (um dígito a mais,
        // leitura ruim) virava E0001669, outra bobina. Tem que ser exato.
        return t.replaceAll("[^A-Z0-9]", "");
    }

    /** Entrega o código à tela, pela mesma função que a câmera usa. */
    /** Descarta em silêncio (só conta no diagnóstico). */
    void ignorar(String bruto, String motivo) {
        ignoradas++;
        ultimaOrigem = "IGNORADA (" + motivo + "): \"" + String.valueOf(bruto).trim() + "\" · " + ignoradas + " no total";
    }

    void entregar(String bruto, String origem) {
        if (avisoFunciona && !origem.startsWith("aviso")) { ignorar(bruto, "cópia do teclado"); return; }
        if (!LEITURA_ESTRITA) { entregarLivre(bruto, origem); return; }
        final String cod = normalizar(bruto);
        // O TC60 vem com teclado simulado E broadcast ligados: a mesma bipada
        // pode chegar pelos dois caminhos. O mesmo código em menos de 1,5 s é
        // uma bipada só.
        long agora = SystemClock.uptimeMillis();
        if (cod.equals(entregueCodigo) && agora - entregueEm < 1500) return;
        entregueCodigo = cod; entregueEm = agora;
        ultimoCodigo = cod + "  (bruto: " + String.valueOf(bruto).trim() + ")"; ultimaOrigem = origem;
        if (!ETIQUETA.matcher(cod).matches()) {
            // Não adivinha e não avisa (v1.9, Frederico: a mensagem aparecia
            // em bipada normal — era o pedaço do teclado, com a leitura boa
            // já entregue). Descarta em silêncio; fica no diagnóstico.
            ignorar(bruto, "não é etiqueta completa");
            return;
        }
        // Se o código também caiu no campo invisível, limpa para não entregar 2×.
        ui.post(() -> web.evaluateJavascript("window.__ekoLimpa&&__ekoLimpa()", null));
        ui.post(() -> web.evaluateJavascript(
            "(function(c){try{if(typeof onLeu==='function'){onLeu(c);return 'ok';}return 'sem-tela';}catch(e){return 'erro';}})('" + cod + "')",
            r -> { if (r != null && r.contains("sem-tela")) toast("Abra a tela Bobina na Sacoleira para ler " + cod); }));
    }

    /**
     * Inventário: entrega o texto como o leitor mandou (sem o prefixo AIM e
     * sem espaços/controle nas pontas). Quem valida é a página: gaiola é
     * "EKOPA|id|formato|cor|fardos|kg", big bag é consultado no sistema.
     * Mesma trava de 1,5 s contra a leitura dupla (teclado + aviso).
     */
    void entregarLivre(String bruto, String origem) {
        if (avisoFunciona && !origem.startsWith("aviso")) { ignorar(bruto, "cópia do teclado"); return; }
        String t = String.valueOf(bruto).replaceAll("[\\p{Cntrl}]", "").trim();
        t = t.replaceFirst("^\\][A-Za-z0-9][0-9]", "");
        if (t.isEmpty()) return;
        long agora = SystemClock.uptimeMillis();
        if (t.equals(entregueCodigo) && agora - entregueEm < 1500) return;
        entregueCodigo = t; entregueEm = agora;
        ultimoCodigo = t; ultimaOrigem = origem;
        final String js = org.json.JSONObject.quote(t);
        ui.post(() -> web.evaluateJavascript("window.__ekoLimpa&&__ekoLimpa()", null));
        ui.post(() -> web.evaluateJavascript(
            "(function(c){try{if(typeof onLeu==='function'){onLeu(c);return 'ok';}return 'sem-tela';}catch(e){return 'erro';}})(" + js + ")",
            r -> { if (r != null && r.contains("sem-tela")) toast("Esta tela não recebe leitura: " + ultimoCodigo); }));
    }

    /**
     * Aviso ao operador. v1.8 (28/09/2026, Frederico: "nenhuma mensagem do
     * tipo sistema"): usa o aviso da PRÓPRIA página — as duas telas têm
     * toast(tipo, msg, ms) no visual da aplicação. O Toast do Android fica só
     * para quando a página não tem (página de erro, carregando).
     */
    void toast(String m) {
        final String js = "(function(m){if(typeof toast==='function'){toast('aviso',m,4500);return 'ok';}return 'nao';})("
                + org.json.JSONObject.quote(m) + ")";
        ui.post(() -> web.evaluateJavascript(js, r -> {
            if (r == null || !r.contains("ok")) Toast.makeText(this, m, Toast.LENGTH_LONG).show();
        }));
    }

    // ─────────────────────────── configuração ───────────────────────────

    void configurar() {
        LinearLayout l = new LinearLayout(this);
        l.setOrientation(LinearLayout.VERTICAL);
        int p = (int) (18 * getResources().getDisplayMetrics().density);
        l.setPadding(p, p / 2, p, 0);

        EditText eBase = campo(l, "Endereço do Mini PC", base(), InputType.TYPE_TEXT_VARIATION_URI);
        EditText ePag = campo(l, "Página inicial", pagina(), InputType.TYPE_TEXT_VARIATION_URI);
        EditText eAcao = campo(l, "Aviso avulso do leitor (ação) — opcional", prefs.getString("acao_avulsa", ""), InputType.TYPE_CLASS_TEXT);
        EditText eChave = campo(l, "Nome do dado no aviso avulso — opcional", prefs.getString("chave_avulsa", ""), InputType.TYPE_CLASS_TEXT);

        Uri nosso = Uri.parse(base());
        String chave = "cert_" + nosso.getHost() + "_" + nosso.getPort();
        TextView info = new TextView(this);
        info.setTextIsSelectable(true);
        info.setText("Versão do app: " + versao()
                + "\n\nÚltimo código lido: " + ultimoCodigo + "\nChegou por: " + ultimaOrigem
                + "\n\nTeclas recebidas: " + teclasVistas + (ultimasTeclas.isEmpty() ? "" : "\nÚltimas:" + ultimasTeclas)
                + "\nAvisos (broadcast) recebidos: " + avisosVistos
                + (avisoFunciona ? "  → teclado ignorado (é cópia)" : "")
                + "\nLeituras ignoradas: " + ignoradas
                + "\n\nCertificado confiado:\n" + prefs.getString(chave, "(nenhum ainda)"));
        info.setPadding(0, p / 2, 0, 0);
        l.addView(info);

        new AlertDialog.Builder(this).setTitle("Configuração do coletor").setView(l)
            .setPositiveButton("Salvar", (d, w) -> {
                String b = eBase.getText().toString().trim();
                if (!b.startsWith("https://")) { toast("O endereço precisa começar com https://"); return; }
                String pg = ePag.getText().toString().trim();
                prefs.edit().putString("base", b).putString("pagina", pg.startsWith("/") ? pg : "/" + pg)
                     .putString("acao_avulsa", eAcao.getText().toString().trim())
                     .putString("chave_avulsa", eChave.getText().toString().trim()).apply();
                try { unregisterReceiver(receptor); } catch (Exception ignore) {}
                registrarAvisos();
                abrir();
            })
            .setNeutralButton("Esquecer certificado", (d, w) -> {
                prefs.edit().remove(chave).apply();
                web.clearSslPreferences();
                toast("Certificado esquecido: vai perguntar de novo.");
                abrir();
            })
            .setNegativeButton("Fechar", null)
            .show();
    }

    EditText campo(LinearLayout l, String rotulo, String valor, int tipo) {
        TextView t = new TextView(this);
        t.setText(rotulo);
        t.setPadding(0, (int) (10 * getResources().getDisplayMetrics().density), 0, 0);
        l.addView(t);
        EditText e = new EditText(this);
        e.setSingleLine(true);
        e.setInputType(InputType.TYPE_CLASS_TEXT | tipo);
        e.setText(valor);
        l.addView(e);
        return e;
    }

    String versao() {
        try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; }
        catch (Exception e) { return "?"; }
    }

    @Override
    protected void onDestroy() {
        try { unregisterReceiver(receptor); } catch (Exception ignore) {}
        super.onDestroy();
    }

    /** Chamado pelas páginas (a do Mini PC e a de erro). */
    class Ponte {
        @JavascriptInterface public void configurar() { ui.post(MainActivity.this::configurar); }
        @JavascriptInterface public void tentarDeNovo() { ui.post(MainActivity.this::abrir); }
        @JavascriptInterface public String versao() { return MainActivity.this.versao(); }
        /** Texto que o leitor escreveu no campo invisível da página. */
        @JavascriptInterface public void lido(String texto) { entregar(texto, "campo (leitor em modo preencher)"); }
        @JavascriptInterface public void laser() { ui.post(MainActivity.this::laser); }
    }
}
