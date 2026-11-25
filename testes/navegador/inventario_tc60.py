"""Teste de navegador: tela INVENTÁRIO no coletor CMX TC60 (25/11/2026).

Gustavo, 25/11: "não tá legal de ver no android do TC60" / "todas as telas
merecem atenção uma a uma". O TC60 tem 720×1440 px com dpr 2: a WebView do app
"Ekoplastic MP" (sem "viewport largo") mostra ~360×690 CSS. O Bruno usa com
uma mão, às vezes de luva.

Sobe o server.js de verdade com banco temporário (portas 14150-14152) e
percorre a tela inteira como o app: escolha MP/PA, seleção, produto já
inventariado, lista longa de bags, Digitar, peso sem etiqueta, prévia,
comparativo com divergência, sacos, leitura livre, PA digitado e por QR,
Encerrar (janela e resultado). O que depende do Bling ou da VPS (etiqueta,
saldo, gaiola, envio do PDF) é respondido pelo próprio teste: nada sai daqui.

A 360×690, em cada estado:
  1. sem rolagem para o lado e nada passando da borda;
  2. todo botão, lista e campo visível com ≥ 56 px de altura e de largura,
     dentro da tela;
  3. todo texto visível com ≥ 16 px;
  4. na contagem: produto, contagem (bags e kg) e o último bag lido aparecem
     sem rolar.
Em tela larga (1280×800, o monitor do Mini PC, e 600×960) a posição, o
tamanho e a fonte de cada elemento visível têm de ser IGUAIS aos gravados de
antes da mudança (inventario_tc60_largo.json, gravada de 7b95b41: a tela
anterior ao layout do TC60, já com a correção do contador da leitura livre). Nada da regra de negócio é
olhado aqui: isso é do inventario_leitor.py.

Não entra no rodar-todos.js (o Mini PC não tem navegador de teste).

    cd ~/bling-claude && timeout 300 venv/bin/python -I <repo>/testes/navegador/inventario_tc60.py <repo> [--fotos PASTA --prefixo depois]

--gravar-largo ARQ regrava a referência de tela larga (só com a tela de ANTES
de uma mudança de layout de propósito). Sai 1 se falhar."""
import argparse, json, os, shutil, subprocess, sys, tempfile, time, urllib.parse, urllib.request
from pathlib import Path
sys.path.insert(0, "/home/ekoplastic/bling-claude")
from playwright.sync_api import sync_playwright
from recorte_extrusao_operador import _navegador

ap = argparse.ArgumentParser()
ap.add_argument("repo")
ap.add_argument("--fotos")
ap.add_argument("--prefixo", default="tela")
ap.add_argument("--gravar-largo")
ap.add_argument("--porta", type=int, default=14150)
A = ap.parse_args()
REPO = Path(A.repo)
FOTOS = Path(A.fotos) if A.fotos else None
if FOTOS: FOTOS.mkdir(parents=True, exist_ok=True)
REF = Path(__file__).with_name("inventario_tc60_largo.json")
UA_APP = "Mozilla/5.0 (Linux; Android 14; TC60) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36 EkoColetor/2.0"
# o que o app injeta em toda página (MainActivity.esconderSaidas + __ekoApp)
APP_JS = """window.__ekoApp = 1;
document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style');
  s.textContent = '.btn-sair,.rodape a[href="/"]{display:none!important}'; document.head.appendChild(s); });"""
W, H = 360, 690
MIN_TOQUE, MIN_FONTE = 56, 16
falhas = []


def ok(cond, msg, det=""):
    print(("  ✓ " if cond else "  ✗ ") + msg + ("" if cond or not det else f"  [{det}]"))
    if not cond: falhas.append(msg)


def req(base, rota, corpo=None):
    dados = json.dumps(corpo).encode() if corpo is not None else None
    r = urllib.request.Request(base + rota, data=dados, headers={"Content-Type": "application/json"} if dados else {})
    with urllib.request.urlopen(r, timeout=10) as x: return json.loads(x.read())


# ── respostas no lugar do Bling e da VPS ─────────────────────────────
ETQ = {"2": ("GBD", "Colorido", "WT dos Santos"), "3": ("GBD", "Canela", "Cedro"), "4": ("EVOH", "Cristal", "Tallpack")}


def falso(route):
    u = urllib.parse.urlparse(route.request.url)
    p = urllib.parse.unquote(u.path)
    q = urllib.parse.parse_qs(u.query)
    js = lambda d, st=200: route.fulfill(status=st, content_type="application/json", body=json.dumps(d))
    if p.startswith("/etiqueta/"):
        i = p.rsplit("/", 1)[1]
        mat, cor, forn = ETQ.get(i[5:6], ETQ["2"])     # R0000[2]01 → produto 2
        return js({"etiqueta": {"id": i, "material_key": mat, "cor": cor, "fornecedor": forn, "peso": 1025.5}})
    if p == "/inventario/saldo":
        return js({"ok": True, "saldoFisico": 26000 if q.get("material") == ["GBD"] else 2051})
    if p == "/inventario/pa/saldo":
        return js({"ok": True, "saldoFisico": 3000})
    if p.startswith("/inventario/pa/gaiola/"):
        return js({"ok": True, "gaiola": {"fardos": 40}})
    if p == "/inventario/enviar-pdf":
        return js({"ok": True, "enviados": ["Bruno Augusto", "Vinicius"], "falhas": []})
    return route.continue_()


def subir_servidor(porta):
    tmp = Path(tempfile.mkdtemp(prefix="eko_inv_tc60_"))
    env = {**os.environ, "EKO_PORT": str(porta), "EKO_PORT_CB": str(porta + 1), "EKO_PORT_HTTPS": str(porta + 2),
           "EKO_DB_FILE": str(tmp / "t.db"), "EKO_LOG_DIR": str(tmp / "logs"), "TZ": "America/Sao_Paulo",
           "EKO_PRINT_SIMULAR": "1", "EKO_FECHAR_TELA_SIMULAR": "1"}
    srv = subprocess.Popen(["node", str(REPO / "server.js")], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = f"http://127.0.0.1:{porta}"
    for _ in range(75):
        try:
            if req(base, "/healthcheck").get("ok"): break
        except Exception: pass
        time.sleep(0.2)
    # Nada deste banco de teste vai para a VPS de verdade.
    req(base, "/config", {"vps_sacoleiras_url": "http://127.0.0.1:9/api/sacoleiras/agora"})
    # inventário já com 3 produtos: um diverge (24 bags), um bate, um sem saldo
    bags = [{"id": f"R00001{i:02d}", "peso": 1025.5} for i in range(24)]
    req(base, "/inventario/salvar", {"material": "GBD", "cor": "Colorido", "fornecedor": "WT dos Santos",
        "materialNome": "Grão Baixa Densidade", "leituras": bags, "somaLeitura": 24612, "saldoBling": 26000})
    req(base, "/inventario/salvar", {"material": "EVOH", "cor": "Cristal", "fornecedor": "Tallpack",
        "materialNome": "Resina EVOH", "leituras": [{"id": "R0000401", "peso": 1025.5}, {"id": "R0000402", "peso": 1025.5}],
        "somaLeitura": 2051, "saldoBling": 2051})
    req(base, "/inventario/salvar", {"material": "GBD", "cor": "Preto", "fornecedor": "Cedro",
        "materialNome": "Grão Baixa Densidade", "leituras": [{"id": "R0000501", "peso": 980}],
        "somaLeitura": 980, "saldoBling": None})
    return srv, tmp, base


# ── medidas ──────────────────────────────────────────────────────────
MEDIR = """([MIN_TOQUE, MIN_FONTE]) => {
  const w = document.documentElement.clientWidth, vis = e => { const cs = getComputedStyle(e);
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false;
    const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
  const nome = e => (e.id ? '#' + e.id : e.tagName.toLowerCase() + ([...e.classList].map(c => '.' + c).join('')))
                    + ' «' + (e.innerText || e.value || '').trim().slice(0, 18) + '»';
  const fora = [], pequenos = [], fonte = [];
  for (const e of document.querySelectorAll('body *')) {
    if (e.id === 'leitor-campo' || e.id === '__ekoScan' || e.closest('#toast') || e.closest('#reader')) continue;
    if (!vis(e)) continue;
    const b = e.getBoundingClientRect();
    if (b.right > w + 1 || b.left < -1) fora.push(nome(e) + ' ' + Math.round(b.left) + '→' + Math.round(b.right));
    const tag = e.tagName;
    const controle = tag === 'BUTTON' || tag === 'SELECT' || (tag === 'INPUT' && !['hidden', 'checkbox', 'radio'].includes(e.type))
                     || (tag === 'A' && e.getAttribute('href'));
    if (controle && (b.height < MIN_TOQUE - 0.5 || b.width < MIN_TOQUE - 0.5))
      pequenos.push(nome(e) + ' ' + Math.round(b.width) + '×' + Math.round(b.height));
    const temTexto = [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())
                     || (controle && (e.value || e.placeholder || e.innerText));
    const fs = parseFloat(getComputedStyle(e).fontSize);
    if (temTexto && fs < MIN_FONTE - 0.01) fonte.push(nome(e) + ' ' + fs + 'px');
  }
  return { sw: document.documentElement.scrollWidth, fora, pequenos, fonte };
}"""

VISIVEL_SEM_ROLAR = """(sels) => { scrollTo(0, 0); const h = innerHeight, r = {};
  for (const s of sels) { const e = document.querySelector(s);
    if (!e) { r[s] = 'não existe'; continue; }
    const b = e.getBoundingClientRect();
    r[s] = (b.height > 0 && b.top >= 0 && b.bottom <= h + 0.5) ? 'ok' : (Math.round(b.top) + '..' + Math.round(b.bottom)); }
  return r; }"""

ASSINATURA = """() => { const out = [];
  for (const e of document.querySelectorAll('body *')) {
    if (e.id === 'leitor-campo' || e.closest('#toast')) continue;
    const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const b = e.getBoundingClientRect(); if (!b.width || !b.height) continue;
    out.push([e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().replace(/\\s+/g, '.') : ''),
              Math.round(b.left + scrollX), Math.round(b.top + scrollY), Math.round(b.width), Math.round(b.height),
              cs.fontSize, cs.paddingTop, cs.paddingLeft]);
  }
  return out; }"""


def percorrer(pg, base, em_cada):
    """A tela inteira, estado por estado. em_cada(nome, principal) mede/fotografa."""
    clica = lambda s: (pg.locator(s).first.click(), pg.wait_for_timeout(350))
    janela = lambda: pg.wait_for_selector(".eko-dlg", timeout=15000)
    cancela = lambda: (pg.locator("#md-cancelar").click(), pg.wait_for_timeout(300))
    def ler(cod):
        pg.evaluate("c => onLeu(c)", cod); pg.wait_for_timeout(120)
    def escolher(sel, valor):
        pg.locator(sel).select_option(valor); pg.wait_for_timeout(150)

    pg.goto(base + "/inventario.html"); pg.wait_for_timeout(1200)
    pg.wait_for_function("FINALIZADOS.length === 3 && PRODUTOS.length > 0 && PA_PRODUTOS.length > 0", timeout=20000)
    em_cada("01-escolha-mp-pa")

    clica(".tipo-bt.mp")
    em_cada("02-selecao-mp")
    escolher("#sel-material", "GBD"); escolher("#sel-cor", "Colorido"); escolher("#sel-forn", "WT dos Santos")
    em_cada("03-selecao-mp-produto-escolhido")

    clica("#btn-iniciar"); janela()
    em_cada("04-janela-produto-ja-inventariado")
    cancela()                                  # "Manter o que já estava": volta com os 24 bags
    ler("R0000201")
    em_cada("05-contagem-lista-longa", ["#leit-prod", "#c-qtd", "#c-kg", "#lista-leituras .leitura-item"])

    clica("#btn-digitar"); janela()
    em_cada("06-janela-digitar")
    cancela()

    clica("#mp-chip-man"); pg.locator("#mp-man-kg").fill("1.234,5"); pg.wait_for_timeout(150)
    em_cada("07-peso-sem-etiqueta")
    clica("#mp-chip-qr")

    clica("#btn-previa"); pg.wait_for_selector("#painel-previa .previa-linha", timeout=15000); pg.wait_for_timeout(500)
    em_cada("08-previa-divergencia")
    clica("#painel-previa button")

    clica("#btn-finalizar-leitura"); pg.wait_for_selector("#comp-corpo .veredicto", timeout=15000)
    em_cada("09-comparativo-divergencia")
    clica("#comp-corpo .btn-verde"); pg.wait_for_selector("#tela-selecao:not(.oculto)", timeout=15000)

    escolher("#sel-material", "PIG"); escolher("#sel-cor", "Amarelo"); escolher("#sel-forn", "Cristal Master")
    clica("#btn-iniciar")
    clica("#bloco-manual .manual-op >> text=+10"); clica("#bloco-manual .manual-op >> text=+1")
    pg.locator("#man-sobra-kg").fill("12,5"); clica("#bloco-manual .sobras-bt")
    em_cada("10-contagem-por-sacos")
    clica("#btn-finalizar-leitura"); pg.wait_for_selector("#comp-corpo .veredicto", timeout=15000)
    em_cada("11-comparativo-sacos")
    clica("#comp-corpo .btn-verde"); pg.wait_for_selector("#tela-selecao:not(.oculto)", timeout=15000)

    clica("#bloco-mp >> text=LEITURA LIVRE")
    for c in ("R0000202", "R0000203", "R0000301", "R0000302", "R0000403"): ler(c)
    clica("#lista-livre .gl-ver")
    em_cada("12-leitura-livre", ["#leit-prod", "#c-qtd", "#c-kg", "#lista-livre .grupo-livre .gl-nome", "#lista-livre .grupo-livre .gl-kg"])
    clica("#btn-add-sacos")
    em_cada("13-livre-material-por-sacos")
    clica("#painel-sacos >> text=Cancelar")
    clica("#btn-finalizar-leitura"); pg.wait_for_selector("#comp-corpo .veredicto", timeout=15000)
    em_cada("14-comparativo-livre")
    clica("#comp-corpo .btn-verde"); pg.wait_for_selector("#tela-tipo:not(.oculto)", timeout=15000)

    clica(".tipo-bt.pa")
    escolher("#pa-formato", "30x40"); escolher("#pa-cor", "Amarela")
    em_cada("15-selecao-pa")
    clica("#pa-btn-iniciar")
    clica("#pa-chip-man"); clica("#bloco-pa-manual .manual-op >> text=+10"); clica("#bloco-pa-manual .manual-op >> text=+1")
    em_cada("16-pa-digitar-fardos")
    clica("#pa-man-add"); clica("#pa-chip-qr")
    ler("EKOPA|G0012|30x40|AM|40|1000")
    em_cada("17-pa-contagem", ["#leit-prod", "#c-qtd", "#c-kg", "#lista-leituras .leitura-item"])
    clica("#btn-finalizar-leitura"); pg.wait_for_selector("#comp-corpo .veredicto", timeout=15000)
    clica("#comp-corpo .btn-verde")
    pg.wait_for_function("document.querySelector('#lista-fim').innerText.includes('Amarela')", timeout=20000)
    em_cada("18-selecao-pa-inventariados")

    clica("#acoes-fim >> text=Encerrar"); janela()
    em_cada("19-janela-encerrar")
    pg.locator("#eko-dlg-ok").click()
    pg.wait_for_selector("#lista-fim .vazio", timeout=30000); pg.wait_for_timeout(300)
    em_cada("20-encerrado")


def main():
    ref = {} if A.gravar_largo else json.loads(REF.read_text(encoding="utf-8")) if REF.exists() else None
    with sync_playwright() as pw:
        br = _navegador(pw)
        # ── 360×690: o coletor ────────────────────────────────────────
        print(f"\n== coletor TC60 ({W}×{H}, app)")
        srv, tmp, base = subir_servidor(A.porta)
        try:
            ctx = br.new_context(viewport={"width": W, "height": H}, user_agent=UA_APP, device_scale_factor=2,
                                 is_mobile=True, has_touch=True)
            ctx.add_init_script(APP_JS)
            pg = ctx.new_page(); pg.set_default_timeout(20000)
            erros = []; pg.on("pageerror", lambda e: erros.append(str(e)))
            pg.route("**/*", falso)

            def medir(nome, principal=None):
                # o toast é passageiro e fica por cima: some antes de medir
                pg.evaluate("document.getElementById('toast').style.display='none'; 0")
                if FOTOS:
                    pg.screenshot(path=str(FOTOS / f"{A.prefixo}-{nome}.png"), timeout=30000)
                r = pg.evaluate(MEDIR, [MIN_TOQUE, MIN_FONTE])
                ok(r["sw"] <= W and not r["fora"], f"{nome}: nada para o lado", f"scrollWidth {r['sw']}; {r['fora'][:4]}")
                ok(not r["pequenos"], f"{nome}: toque ≥ {MIN_TOQUE} px", f"{len(r['pequenos'])}: {r['pequenos'][:5]}")
                ok(not r["fonte"], f"{nome}: texto ≥ {MIN_FONTE} px", f"{len(r['fonte'])}: {r['fonte'][:5]}")
                if principal:
                    v = pg.evaluate(VISIVEL_SEM_ROLAR, principal)
                    ok(all(x == "ok" for x in v.values()), f"{nome}: produto, contagem e último lido sem rolar",
                       json.dumps(v, ensure_ascii=False))
                if FOTOS and principal is None and pg.evaluate("document.documentElement.scrollHeight") > H + 20:
                    pg.screenshot(path=str(FOTOS / f"{A.prefixo}-{nome}-inteira.png"), full_page=True, timeout=30000)
            percorrer(pg, base, medir)
            ok(not erros, "sem erro de JS", erros[:2])
            ctx.close()
        finally:
            srv.terminate(); srv.wait(10); shutil.rmtree(tmp, ignore_errors=True)

        # ── tela larga: tem de ficar igual ────────────────────────────
        for nome_v, w, h in (("minipc-1280", 1280, 800), ("medio-600", 600, 960)):
            print(f"\n== {nome_v} ({w}×{h}): igual a antes")
            srv, tmp, base = subir_servidor(A.porta)
            try:
                ctx = br.new_context(viewport={"width": w, "height": h})
                pg = ctx.new_page(); pg.set_default_timeout(20000)
                pg.route("**/*", falso)
                def assinar(nome, principal=None):
                    pg.evaluate("document.getElementById('toast').style.display='none'; 0")
                    a = pg.evaluate(ASSINATURA)
                    chave = f"{nome_v}/{nome}"
                    if A.gravar_largo:
                        ref[chave] = a
                    elif ref is None:
                        ok(False, f"{chave}: falta a referência {REF.name}")
                    else:
                        antes = ref.get(chave)
                        dif = [] if antes == a else [
                            f"{x} ≠ {y}" for x, y in zip(antes or [], a) if x != y][:3] or [f"{len(antes or [])} vs {len(a)} elementos"]
                        ok(not dif, f"{chave}: igual a antes", "; ".join(map(str, dif)))
                percorrer(pg, base, assinar)
                ctx.close()
            finally:
                srv.terminate(); srv.wait(10); shutil.rmtree(tmp, ignore_errors=True)
        br.close()
    if A.gravar_largo:
        Path(A.gravar_largo).write_text(json.dumps(ref, ensure_ascii=False, indent=0), encoding="utf-8")
        print(f"referência gravada: {A.gravar_largo} ({len(ref)} estados)")


main()
print("\nFALHOU: " + str(len(falhas)) if falhas else "\nOK")
sys.exit(1 if falhas else 0)
