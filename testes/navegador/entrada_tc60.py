"""Entrada (mp-recebimento-retorno.html) no coletor TC60 do Bruno (25/11/2026).

Gustavo: "não tá legal de ver no android do TC60" — "todas as telas merecem
atenção uma a uma". O TC60 é 720×1440 px com dpr 2: ~360×690 CSS, WebView sem
"viewport largo", user-agent do app "… EkoColetor/2.0".

Sobe o server.js de verdade (banco temporário, impressão simulada, balança
simulada pela rota /balanca/raw) e confere, a 360×690 com o UA do app:

  1. Em cada estado (início, escolha, peso chegando, etiqueta impressa, lista
     com 12 bags, Corrigir, Retorno com etiqueta lida, sem etiqueta, aditivos):
     · nada passa da largura (sem rolagem para o lado);
     · todo botão/campo/opção visível tem pelo menos 56×56 px;
     · todo texto visível tem pelo menos 16 px (fora a miniatura da etiqueta
       de 100 mm, que é o desenho dela).
  2. O principal sem rolar: com a página no topo, o peso que chega da balança
     (≥ 28 px), o IMPRIMIR e, depois de imprimir, a última etiqueta ficam
     inteiros dentro dos 690 px.
  3. Monitor do Mini PC (1366×768, no quadro e fora dele): a página é aberta
     de novo SEM o bloco de estilo do coletor e sem a linha "Última etiqueta",
     e a posição, o tamanho e o estilo de cada elemento têm de ser iguais.

Não entra no rodar-todos.js (o Mini PC não tem navegador de teste). Portas
14120/14121/14122.

    cd ~/bling-claude && timeout 400 venv/bin/python -I <repo pesagem>/testes/navegador/entrada_tc60.py <repo pesagem> [pasta-prints]

Sai 1 se falhar."""
import json, os, re, shutil, subprocess, sys, tempfile, time, urllib.request
from pathlib import Path
sys.path.insert(0, "/home/ekoplastic/bling-claude")
from playwright.sync_api import sync_playwright
from recorte_extrusao_operador import _navegador

REPO = Path(sys.argv[1])
PRINTS = Path(sys.argv[2]) if len(sys.argv) > 2 else None
if PRINTS: PRINTS.mkdir(parents=True, exist_ok=True)
PIN = "5823"
UA_APP = "Mozilla/5.0 (Linux; Android 14; TC60) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36 EkoColetor/2.0"
PORTA = 14120
BASE = f"http://127.0.0.1:{PORTA}"
W, H = 360, 690
TOQUE, FONTE = 56, 16
falhas = []


def ok(cond, msg, det=""):
    print(("  ✓ " if cond else "  ✗ ") + msg + ("" if cond or not det else f"  [{det}]"))
    if not cond: falhas.append(msg)


def req(rota, corpo=None):
    dados = json.dumps(corpo).encode() if corpo is not None else None
    r = urllib.request.Request(BASE + rota, data=dados, headers={"Content-Type": "application/json"} if dados else {})
    with urllib.request.urlopen(r, timeout=10) as x: return json.loads(x.read())


def senha(pg):
    pg.wait_for_timeout(700)
    if pg.locator("#eko-acesso").count() and pg.locator("#eko-acesso").is_visible():
        for ch in PIN: pg.locator("#eko-kb button", has_text=ch).first.click()
        pg.locator("#eko-kb button.ok").click(); pg.wait_for_timeout(1500)


# Mede a tela como está. Elemento invisível (display/visibility/opacity, ou
# fora da área por estar escondido atrás de overflow) não conta. A miniatura
# da etiqueta (#etiqueta) fica fora da regra de fonte: é o desenho de 100 mm.
MEDIR = """([TOQUE, FONTE]) => {
  const w = document.documentElement.clientWidth;
  const vis = e => { for (let x = e; x && x !== document.body; x = x.parentElement) {
      const cs = getComputedStyle(x); if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false; }
    const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
  const nome = e => (e.id ? '#' + e.id : e.tagName.toLowerCase() + (e.classList.length ? '.' + [...e.classList].join('.') : ''));
  const fora = [], peq = [], fonte = [];
  for (const e of document.querySelectorAll('body *')) {
    if (e.id === '__ekoScan' || e.closest('#eko-acesso') || !vis(e)) continue;
    const b = e.getBoundingClientRect();
    if (b.right > w + 1 || b.left < -1) fora.push(nome(e) + ' ' + Math.round(b.left) + '..' + Math.round(b.right));
    if (e.matches('button, select, .opt, .atalho, input:not([type=hidden]):not([type=checkbox]):not([type=radio])')
        && !e.closest('#etiqueta') && (b.height < TOQUE - 0.5 || b.width < TOQUE - 0.5))
      peq.push(nome(e) + ' ' + Math.round(b.width) + 'x' + Math.round(b.height));
    if (!e.closest('#etiqueta')) for (const n of e.childNodes)
      if (n.nodeType === 3 && n.textContent.trim()) { const fs = parseFloat(getComputedStyle(e).fontSize);
        if (fs < FONTE - 0.01) fonte.push(nome(e) + ' ' + fs + ' "' + n.textContent.trim().slice(0, 20) + '"'); break; }
  }
  return { sw: document.documentElement.scrollWidth, w, fora: fora.slice(0, 6), nFora: fora.length,
           peq: [...new Set(peq)].slice(0, 8), nPeq: peq.length, fonte: [...new Set(fonte)].slice(0, 8), nFonte: fonte.length };
}"""


def conferir(pg, nome):
    pg.wait_for_timeout(300)
    if PRINTS: pg.screenshot(path=str(PRINTS / f"{nome}.png"), full_page=True, timeout=40000)
    m = pg.evaluate(MEDIR, [TOQUE, FONTE])
    ok(m["sw"] <= W and m["nFora"] == 0, f"{nome}: nada passa da largura de {W} px", f"sw={m['sw']} {m['fora']}")
    ok(m["nPeq"] == 0, f"{nome}: botões e campos com pelo menos {TOQUE} px", f"{m['nPeq']}: {m['peq']}")
    ok(m["nFonte"] == 0, f"{nome}: texto com pelo menos {FONTE} px", f"{m['nFonte']}: {m['fonte']}")


def inteiro_na_tela(pg, sel):
    return pg.evaluate("""(s) => { const e = document.querySelector(s); if (!e) return null;
        const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden') return null;
        const b = e.getBoundingClientRect();
        return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right),
                 fs: parseFloat(cs.fontSize), txt: e.textContent.trim().slice(0, 60),
                 dentro: b.top >= 0 && b.bottom <= innerHeight && b.left >= 0 && b.right <= innerWidth && b.height > 0 }; }""", sel)


# Geometria + estilo de cada elemento visível, para comparar o monitor com e
# sem o estilo do coletor. O relógio e o status do servidor mudam sozinhos:
# entra só a caixa deles, não o texto.
FOTO_LAYOUT = """() => { const out = [];
  for (const e of document.querySelectorAll('body *')) {
    if (e.id === 'eko-resp-tag' || e.id === 'ultima-etq' || e.closest('.toast')) continue;
    const cs = getComputedStyle(e); const b = e.getBoundingClientRect();
    out.push([e.tagName, e.id, e.className && e.className.baseVal === undefined ? e.className : '',
      Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height),
      cs.display, cs.position, cs.fontSize, cs.color, cs.backgroundColor, cs.borderTopColor]);
  }
  return out; }"""


def main():
    tmp = Path(tempfile.mkdtemp(prefix="eko_entrada_tc60_"))
    env = {**os.environ, "EKO_PORT": str(PORTA), "EKO_PORT_CB": str(PORTA + 1), "EKO_PORT_HTTPS": str(PORTA + 2),
           "EKO_DB_FILE": str(tmp / "t.db"), "EKO_LOG_DIR": str(tmp / "logs"), "TZ": "America/Sao_Paulo",
           "EKO_PRINT_SIMULAR": "1", "EKO_FECHAR_TELA_SIMULAR": "1"}
    srv = subprocess.Popen(["node", str(REPO / "server.js")], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(300):
            try:
                if req("/healthcheck").get("ok"): break
            except Exception: pass
            time.sleep(0.2)
        # Nada deste banco de teste vai para a VPS de verdade.
        req("/config", {"vps_sacoleiras_url": "http://127.0.0.1:9/api/sacoleiras/agora"})
        req("/colaboradores/salvar", {"nome": "TESTE TC60", "pin": PIN, "telas": ["mp"]})
        bal = {"peso": 0.0}
        erros = []
        with sync_playwright() as pw:
            br = _navegador(pw)

            def contexto(w, h, ua=UA_APP, sem_coletor=False):
                ctx = br.new_context(viewport={"width": w, "height": h}, user_agent=ua, device_scale_factor=1)
                pg = ctx.new_page(); pg.set_default_timeout(8000)
                pg.on("pageerror", lambda e: erros.append(str(e)))
                pg.route("**/balanca/raw", lambda rota: rota.fulfill(status=200, content_type="application/json",
                         body=json.dumps({"portaAberta": True, "porta": "COM3", "peso": bal["peso"], "ultimoByteTs": int(time.time() * 1000)})))
                if sem_coletor:
                    def tirar(rota):
                        r = rota.fetch(); html = r.text()
                        html = re.sub(r'<style id="estilo-coletor">.*?</style>', '', html, flags=re.S)
                        html = re.sub(r'<div class="ultima-etq"[^>]*></div>', '', html)
                        rota.fulfill(response=r, body=html)
                    pg.route("**/mp-recebimento-retorno.html*", tirar)
                return ctx, pg

            def pesar(pg, kg, congelar=False):
                pg.locator("#bloco-peso button.btn-bal", has_text="Conectar").click(); pg.wait_for_timeout(400)
                bal["peso"] = kg; pg.wait_for_timeout(1500)
                estavel = "() => /estável/.test(document.getElementById('bal-status-txt').textContent)"
                pg.wait_for_function(estavel, timeout=10000)
                if congelar:   # o status oscila sob carga; para a leitura para comparar o monitor
                    pg.evaluate("clearInterval(bal_polling)"); pg.wait_for_timeout(600)
                    if not pg.evaluate(estavel):
                        pg.evaluate("bal_polling = setInterval(lerPeso, POLLING_MS)")
                        pg.wait_for_function(estavel, timeout=10000); pg.evaluate("clearInterval(bal_polling)")

            # ── 1/2. Coletor 360×690 ─────────────────────────────────
            print(f"\n[1] Coletor {W}×{H} (UA do app)")
            ctx, pg = contexto(W, H)
            pg.goto(BASE + "/mp-recebimento-retorno.html?aba=recebimento", wait_until="domcontentloaded", timeout=30000); pg.wait_for_timeout(1200); senha(pg)
            conferir(pg, "inicio")
            pg.locator("#grid-mat .opt", has_text="Grão Baixa").click(); pg.wait_for_timeout(300)
            conferir(pg, "fornecedores")
            pg.locator("#grid-forn .opt", has_text="Cedro").click(); pg.wait_for_timeout(300)
            pg.locator("#grid-cor .opt", has_text="Colorido").click(); pg.wait_for_timeout(300)
            pesar(pg, 812.4)
            conferir(pg, "peso-chegando")
            pg.evaluate("window.scrollTo(0, 0)"); pg.wait_for_timeout(300)
            print(f"\n[2] O principal sem rolar (página no topo)")
            pv = inteiro_na_tela(pg, ".liquido-display .val")
            ok(pv and pv["dentro"] and pv["fs"] >= 28 and "812.4" in pv["txt"], "peso da balança inteiro na tela, ≥ 28 px", pv)
            pi = inteiro_na_tela(pg, "#btn-imprimir")
            ok(pi and pi["dentro"], "IMPRIMIR inteiro na tela", pi)
            pg.wait_for_function("() => !document.getElementById('btn-imprimir').disabled", timeout=10000)
            pg.locator("#btn-imprimir").click(); pg.wait_for_timeout(2200)
            bal["peso"] = 0.0; pg.wait_for_timeout(1200)
            sess = req("/sessoes/abertas?tipo=recebimento")["sessoes"]
            etq = sess[0]["etiquetas"][0]["id"] if sess and sess[0]["etiquetas"] else "?"
            pg.evaluate("window.scrollTo(0, 0)"); pg.wait_for_timeout(300)
            pu = inteiro_na_tela(pg, "#ultima-etq")
            ok(pu and pu["dentro"] and etq in pu["txt"] and "BIPAR" in pu["txt"], f"última etiqueta ({etq}, falta bipar) na tela sem rolar", pu)
            conferir(pg, "etiqueta-impressa")
            pg.evaluate(f"onLeu({json.dumps(etq)})"); pg.wait_for_timeout(1500)
            pu = inteiro_na_tela(pg, "#ultima-etq")
            ok(pu and pu["dentro"] and "bipada" in pu["txt"], "depois do bipe a última etiqueta diz bipada", pu)

            # 12 bags na mesma sessão (11 pela API) e a tela retomando
            sid = sess[0]["id"]
            for i in range(11):
                req("/print/etiqueta", {"clientToken": f"tc60-{i}-{time.time_ns()}", "tipo": "recebimento", "materialKey": "GBD",
                    "materialNomeEt": "BAIXA DENSIDADE", "cor": "Colorido", "fornecedor": "Cedro", "peso": round(780 + i * 7.3, 1),
                    "lote": "251125", "codigo": "COL1", "sku": "GBD.COL.CEDRO | 800 | L251125", "qtdSacos": None, "sessao_id": sid})
            pg.reload(wait_until="domcontentloaded", timeout=30000); pg.wait_for_timeout(1200); senha(pg); pg.wait_for_timeout(1500)
            n = pg.locator("#hist-lista .item").count()
            ok(n == 12, "lista com 12 bags", n)
            conferir(pg, "lista-12-bags")
            pg.evaluate("abrirCorrecao()"); pg.wait_for_timeout(300)
            pg.fill("#corr-cod", etq); pg.locator(".corr-btn-buscar").click(); pg.wait_for_timeout(1200)
            conferir(pg, "corrigir")
            pg.evaluate("fecharCorrecao()")
            # Bipa os 12 e fecha o recebimento (o bag vai ao estoque e pode
            # voltar no Retorno, mais abaixo).
            for e in [x["id"] for x in req("/sessoes/abertas?tipo=recebimento")["sessoes"][0]["etiquetas"]]:
                pg.evaluate(f"onLeu({json.dumps(e)})"); pg.wait_for_timeout(250)
            pg.wait_for_timeout(800)
            req(f"/sessoes/{sid}/finalizar", {})
            ctx.close()

            ctx, pg = contexto(W, H)
            pg.goto(BASE + "/mp-recebimento-retorno.html?aba=recebimento", wait_until="domcontentloaded", timeout=30000); pg.wait_for_timeout(1200); senha(pg)
            pg.locator("#grid-mat .opt", has_text="Carbonato").click(); pg.wait_for_timeout(300)
            pg.locator("#grid-forn .opt").first.click(); pg.wait_for_timeout(300)
            pg.evaluate("setQtd(40)"); pg.wait_for_timeout(300)
            conferir(pg, "aditivo-sacos")
            pg.evaluate("window.scrollTo(0, 0)"); pg.wait_for_timeout(200)
            pq = inteiro_na_tela(pg, ".qtd-calc .val"); pi = inteiro_na_tela(pg, "#btn-imprimir")
            ok(pq and pq["dentro"] and "1000" in pq["txt"].replace(".", "").replace(",", "") and pi and pi["dentro"],
               "aditivo: total dos sacos e IMPRIMIR na tela sem rolar", f"{pq} {pi}")

            # ── Retorno ──
            pg.locator(".aba-modo[data-modo=retorno]").click(); pg.wait_for_timeout(1300); senha(pg); pg.wait_for_timeout(600)
            conferir(pg, "retorno-bipar")
            pg.evaluate(f"onLeu({json.dumps(etq)})"); pg.wait_for_timeout(1500)
            ok(pg.locator("#ret-etiqueta-card").is_visible(), "retorno: etiqueta lida pelo onLeu", etq)
            conferir(pg, "retorno-etiqueta-lida")
            pg.evaluate("setRetoOrigem('sem-etiqueta')"); pg.wait_for_timeout(400)
            conferir(pg, "retorno-sem-etiqueta")
            pg.evaluate("setRetoTipo('aditivos')"); pg.wait_for_timeout(400)
            conferir(pg, "retorno-aditivos")
            ctx.close()

            # ── 3. Monitor do Mini PC ──────────────────────────────────
            print("\n[3] Monitor do Mini PC 1366×768: igual com e sem o estilo do coletor")
            for nome, url in [("quadro", "/mp-recebimento-retorno.html?aba=recebimento&embed=1"),
                              ("fora do quadro", "/mp-recebimento-retorno.html?aba=recebimento"),
                              ("retorno", "/mp-recebimento-retorno.html?aba=retorno&embed=1")]:
                fotos = []
                for sem in (False, True):
                    ctx, pg = contexto(1366, 768, ua=None, sem_coletor=sem)
                    pg.goto(BASE + url, wait_until="domcontentloaded", timeout=30000); pg.wait_for_timeout(1000); senha(pg)
                    if "aba=recebimento" in url:
                        pg.locator("#grid-mat .opt", has_text="Grão Baixa").click(); pg.wait_for_timeout(200)
                        pg.locator("#grid-forn .opt", has_text="Cedro").click(); pg.wait_for_timeout(200)
                        pg.locator("#grid-cor .opt", has_text="Colorido").click(); pg.wait_for_timeout(200)
                        pesar(pg, 640.0, congelar=True)
                    pg.wait_for_timeout(500)
                    tem = pg.evaluate("!!document.getElementById('estilo-coletor')")
                    fotos.append((tem, pg.evaluate(FOTO_LAYOUT)))
                    if PRINTS: pg.screenshot(path=str(PRINTS / f"monitor-{nome.replace(' ', '-')}-{'sem' if sem else 'com'}.png"))
                    bal["peso"] = 0.0
                    ctx.close()
                (_, a), (tem_sem, b) = fotos
                dif = [f"{x[:3]} {x[3:7]}/{y[3:7]} {x[7:]}≠{y[7:]}" for x, y in zip(a, b) if x != y]
                ok(not tem_sem and len(a) == len(b) and not dif, f"monitor ({nome}): {len(a)} elementos na mesma posição e estilo",
                   f"{len(a)}≠{len(b)} " + "; ".join(dif[:4]))
            ok(not erros, "sem erro de JavaScript", "; ".join(erros)[:300])
            br.close()
    finally:
        srv.kill(); srv.wait(timeout=10)
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"\n{'FALHOU: ' + str(len(falhas)) if falhas else 'OK'}")
    sys.exit(1 if falhas else 0)


main()
