"""Teste de navegador: aditivo no Recebimento, contado OU pesado (16/11/2026).

Gustavo: o dessecante da Karina veio em bag de 3.023 kg e a tela só deixava
contar sacos de 25 kg (sessão #33288 saiu com 3.025 kg). Desde 196a614 o aditivo
tem "Contar sacos" × "Pesar na balança". Revisão do 196a614 (achados M1, M2, B3, B4):

  1. Contar sacos: a tela MANDA qtdSacos na impressão e o servidor grava
     qtd_sacos (antes nunca chegava: 241 R de aditivo com qtd_sacos vazio);
     SKU com o peso inteiro.
  2. Pesar na balança: o peso vem da balança (simulada aqui pela rota
     /balanca/raw), a prévia e o SKU levam 1 casa (3023.4, não "3023"), a
     impressão vai SEM qtdSacos e o servidor grava o kg quebrado.
  3. Bag ainda na balança depois de imprimir: trocar para "Contar sacos" é
     recusado (senão o mesmo bag sairia de novo como sacos); zerou a balança,
     a troca volta a valer.

Sobe o server.js de verdade com banco temporário (impressão simulada).
Não entra no rodar-todos.js (o Mini PC não tem navegador de teste).

    cd ~/bling-claude && timeout 180 venv/bin/python <repo pesagem>/testes/navegador/aditivo_balanca.py <repo pesagem>

Sai 1 se falhar."""
import json, os, shutil, subprocess, sys, tempfile, time, urllib.request
from pathlib import Path
sys.path.insert(0, "/home/ekoplastic/bling-claude")
from playwright.sync_api import sync_playwright
from recorte_extrusao_operador import _navegador

REPO = Path(sys.argv[1])
PIN = "4817"
falhas = []

def ok(cond, msg, det=""):
    print(("  ✓ " if cond else "  ✗ ") + msg + ("" if cond or not det else f"  [{det}]"))
    if not cond: falhas.append(msg)

def req(base, rota, corpo=None):
    dados = json.dumps(corpo).encode() if corpo is not None else None
    r = urllib.request.Request(base + rota, data=dados, headers={"Content-Type": "application/json"} if dados else {})
    with urllib.request.urlopen(r, timeout=10) as x: return json.loads(x.read())

# Banco novo só tem os códigos gravimétricos de fábrica: o Dessecante da
# Cristal Master (D1) tem; o da Karina mora no catálogo do Mini PC.
FORN = "Cristal Master"

def etiquetas_do_forn(base):
    s = [x for x in req(base, "/sessoes/abertas?tipo=recebimento")["sessoes"] if x.get("fornecedor") == FORN]
    return s[0]["etiquetas"] if s else []

def main():
    porta = 13982
    tmp = Path(tempfile.mkdtemp(prefix="eko_aditbal_"))
    base = f"http://localhost:{porta}"
    env = {**os.environ, "EKO_PORT": str(porta), "EKO_PORT_CB": str(porta + 1000), "EKO_PORT_HTTPS": str(porta + 2000),
           "EKO_DB_FILE": str(tmp / "t.db"), "EKO_LOG_DIR": str(tmp / "logs"), "TZ": "America/Sao_Paulo",
           "EKO_PRINT_SIMULAR": "1", "EKO_FECHAR_TELA_SIMULAR": "1"}
    srv = subprocess.Popen(["node", str(REPO / "server.js")], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(75):
            try:
                if req(base, "/healthcheck").get("ok"): break
            except Exception: pass
            time.sleep(0.2)
        req(base, "/colaboradores/salvar", {"nome": "TESTE ADITIVO", "pin": PIN, "telas": ["mp"]})

        bal = {"peso": 0.0}
        impressoes = []
        with sync_playwright() as pw:
            br = _navegador(pw)
            pg = br.new_context(viewport={"width": 1366, "height": 768}).new_page()
            pg.set_default_timeout(6000)
            erros = []
            pg.on("pageerror", lambda e: erros.append(str(e)))
            pg.on("dialog", lambda d: d.accept())
            pg.on("request", lambda r: impressoes.append(json.loads(r.post_data or "{}"))
                  if r.method == "POST" and r.url.endswith("/print/etiqueta") else None)
            # A tela lê a balança em http://localhost:3000/balanca/raw: aqui responde o teste.
            pg.route("**/balanca/raw", lambda rota: rota.fulfill(status=200, content_type="application/json",
                     body=json.dumps({"portaAberta": True, "porta": "COM3", "peso": bal["peso"],
                                      "ultimoByteTs": int(time.time() * 1000)})))
            pg.goto(base + "/mp-recebimento-retorno.html?aba=recebimento&embed=1"); pg.wait_for_timeout(1500)
            if pg.locator("#eko-acesso").count() and pg.locator("#eko-acesso").is_visible():
                for ch in PIN: pg.locator("#eko-kb button", has_text=ch).first.click()
                pg.locator("#eko-kb button.ok").click(); pg.wait_for_timeout(1200)
            ok(not (pg.locator("#eko-acesso").count() and pg.locator("#eko-acesso").is_visible()), "senha aceita")
            # No frame (embed) o botão fica atrás do conteúdo; a tela já liga sozinha quando pode.
            pg.evaluate("() => { if (!bal_polling) return conectarBalanca(); }"); pg.wait_for_timeout(600)

            pg.locator("#grid-mat .opt", has_text="Dessecante").click(); pg.wait_for_timeout(200)
            pg.locator("#grid-forn .opt", has_text=FORN).click(); pg.wait_for_timeout(200)

            # ── 1. Contar sacos ─────────────────────────────────────────
            pg.locator("#qtd-input").fill("4"); pg.locator("#qtd-input").dispatch_event("input")
            pg.locator("#qtd-input").dispatch_event("change"); pg.wait_for_timeout(300)
            sku_prev = pg.locator("#et-sku").inner_text()
            ok("| 100 |" in sku_prev, "sacos: prévia do SKU com 100 kg inteiro", sku_prev)
            pg.locator("#btn-imprimir").click(); pg.wait_for_timeout(2000)
            b = impressoes[-1] if impressoes else {}
            ok(b.get("qtdSacos") == 4, "sacos: a tela manda qtdSacos 4 na impressão", str(b.get("qtdSacos")))
            e = (etiquetas_do_forn(base) or [{}])[-1]
            ok(e.get("qtd_sacos") == 4 and abs(float(e.get("peso") or 0) - 100) < 1e-9,
               "sacos: servidor gravou qtd_sacos 4 e 100 kg", f"{e.get('qtd_sacos')} / {e.get('peso')}")

            # ── 2. Pesar na balança ─────────────────────────────────────
            pg.locator("#cm-balanca").click(); pg.wait_for_timeout(200)
            bal["peso"] = 3023.4
            pg.wait_for_timeout(3500)   # leitura + 1,5 s parado = estável
            ok(pg.locator("#peso-bruto").input_value() == "3023.4", "pesado: o peso vem da balança",
               pg.locator("#peso-bruto").input_value())
            ok("3023.4 KG" in pg.locator("#et-peso").inner_text(), "pesado: prévia PESO 3023.4 KG")
            sku_prev = pg.locator("#et-sku").inner_text()
            ok("| 3023.4 |" in sku_prev, "pesado: prévia do SKU com 1 casa", sku_prev)
            ok(pg.locator("#btn-imprimir").is_enabled(), "pesado: IMPRIMIR liberado com peso estável",
               pg.locator("#btn-imprimir").inner_text())
            n = len(impressoes)
            # A estabilidade pisca (janela de 2 s, leitura a cada 0,5 s, precisa de 1,5 s):
            # clica no mesmo instante em que o botão está liberado.
            pg.wait_for_function("""() => { const b = document.getElementById('btn-imprimir');
                                     if (b.disabled) return false; b.click(); return true; }""", timeout=10000)
            pg.wait_for_timeout(2000)
            b = impressoes[-1] if len(impressoes) > n else {}
            ok(len(impressoes) > n and b.get("qtdSacos") is None and "| 3023.4 |" in (b.get("sku") or ""),
               "pesado: impressão sem qtdSacos e SKU com 3023.4", json.dumps(b)[:200])
            e = (etiquetas_do_forn(base) or [{}])[-1]
            ok(not e.get("qtd_sacos") and abs(float(e.get("peso") or 0) - 3023.4) < 1e-9,
               "pesado: servidor gravou 3023,4 kg sem qtd_sacos", f"{e.get('qtd_sacos')} / {e.get('peso')}")

            # ── 3. Bag ainda na balança: não troca o jeito ──────────────
            ok("RETIRE" in pg.locator("#btn-imprimir").inner_text(), "depois de imprimir: RETIRE O BIG BAG",
               pg.locator("#btn-imprimir").inner_text())
            pg.locator("#cm-sacos").click(); pg.wait_for_timeout(300)
            ok("sel" in (pg.locator("#cm-balanca").get_attribute("class") or "") and pg.locator("#bloco-peso").is_visible(),
               "bag na balança: trocar para Contar sacos é recusado")
            ok("RETIRE" in pg.locator("body").inner_text().upper(), "bag na balança: aviso para retirar o bag")
            bal["peso"] = 0.0
            pg.wait_for_timeout(1500)
            pg.locator("#cm-sacos").click(); pg.wait_for_timeout(300)
            ok("sel" in (pg.locator("#cm-sacos").get_attribute("class") or "") and pg.locator("#bloco-qtd").is_visible(),
               "balança zerada: trocar para Contar sacos volta a valer")
            ok(not erros, "sem erro de JavaScript", "; ".join(erros)[:300])
            br.close()
    finally:
        srv.kill(); srv.wait(timeout=10)
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"\n{'FALHOU: ' + str(len(falhas)) if falhas else 'OK'}")
    sys.exit(1 if falhas else 0)

main()
