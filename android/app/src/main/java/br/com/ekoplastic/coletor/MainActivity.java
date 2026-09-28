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
    static final String PAGINA_PADRAO = "/retirada-bobinas.html";
    static final String ACAO_PROPRIA = "br.com.ekoplastic.coletor.SCAN";

    /** Avisos (broadcast) dos leitores mais comuns. Ação → nome do dado. */
    static final String[][] AVISOS = {
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
    static final String[] CHAVES = {"barcode_string", "scannerdata", "value", "SCAN_BARCODE1", "data",
        "barcodeData", "barcode", "decode_data", "scan_data", "com.symbol.datawedge.data_string", "barocode"};

    /** Etiqueta do sistema: uma letra e 7 dígitos (E0001669). */
    static final Pattern ETIQUETA = Pattern.compile("^[A-Z]\\d{5,9}$");

    WebView web;
    SharedPreferences prefs;
    final Handler ui = new Handler(Looper.getMainLooper());
    PermissionRequest pedidoCamera;

    // leitor em modo teclado
    final StringBuilder buf = new StringBuilder();
    long bufInicio, bufUltima;
    final Runnable fechaBufSemEnter = () -> tentarEntregarBuffer("teclado (sem Enter)");

    // diagnóstico
    String ultimoCodigo = "—", ultimaOrigem = "—";

    BroadcastReceiver receptor = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent it) {
            String cod = extrairCodigo(it);
            if (cod != null) entregar(cod, "aviso " + it.getAction());
            else { ultimaOrigem = "aviso " + it.getAction() + " (sem código reconhecido: " + chavesDe(it) + ")"; }
        }
    };

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        prefs = getSharedPreferences("coletor", MODE_PRIVATE);
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
                if (url.startsWith("https://")) injetarAtalhos();
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
        if (web.canGoBack()) web.goBack(); else super.onBackPressed();
    }

    /** Toque longo de 2 s no título da página abre a configuração do app. */
    void injetarAtalhos() {
        web.evaluateJavascript(
            "(function(){if(window.__ekoApp)return;window.__ekoApp=1;" +
            "var h=document.querySelector('header h1')||document.querySelector('h1');if(!h)return;var t=null;" +
            "function ini(){t=setTimeout(function(){t=null;EkoApp.configurar();},2000);}" +
            "function fim(){if(t){clearTimeout(t);t=null;}}" +
            "h.addEventListener('touchstart',ini,{passive:true});h.addEventListener('touchend',fim);" +
            "h.addEventListener('touchmove',fim);h.addEventListener('mousedown',ini);h.addEventListener('mouseup',fim);})()",
            null);
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
     * que alguns leitores põem na frente (]C1 = Code 128) e, se sobrar texto
     * a mais, fica com a etiqueta de dentro dele. Só números vira E + 7 dígitos.
     */
    static String normalizar(String s) {
        String t = s == null ? "" : s.trim().toUpperCase();
        t = t.replaceFirst("^\\][A-Z0-9][0-9]", "");
        String c = t.replaceAll("[^A-Z0-9]", "");
        if (c.matches("^\\d{1,7}$")) return "E" + String.format("%7s", c).replace(' ', '0');
        java.util.regex.Matcher m = Pattern.compile("[A-Z]\\d{7}").matcher(c);
        String ultima = null;
        while (m.find()) ultima = m.group();
        return (ultima != null && !ETIQUETA.matcher(c).matches()) ? ultima : c;
    }

    /** Entrega o código à tela, pela mesma função que a câmera usa. */
    void entregar(String bruto, String origem) {
        final String cod = normalizar(bruto);
        ultimoCodigo = cod; ultimaOrigem = origem;
        if (!ETIQUETA.matcher(cod).matches()) { toast("Código não reconhecido: " + cod); return; }
        ui.post(() -> web.evaluateJavascript(
            "(function(c){try{if(typeof onLeu==='function'){onLeu(c);return 'ok';}return 'sem-tela';}catch(e){return 'erro';}})('" + cod + "')",
            r -> { if (r != null && r.contains("sem-tela")) toast("Abra a tela Bobina na Sacoleira para ler " + cod); }));
    }

    void toast(String m) { ui.post(() -> Toast.makeText(this, m, Toast.LENGTH_LONG).show()); }

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
    }
}
