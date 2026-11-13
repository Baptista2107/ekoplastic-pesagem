"""Teste de navegador: operadores da extrusão vêm do SERVIDOR (13/11/2026).

Na queda de energia de 13/11 a tela abriu num perfil de navegador novo e a
extrusão ficou sem nomes ("Cadastre operadores em Configurações"), porque a
lista morava só no localStorage. Agora mora no servidor.

Sobe o server.js de verdade com banco temporário e abre a tela num navegador
com localStorage VAZIO (como o perfil novo de 13/11). Confere: os 5 nomes
aparecem na aba Bobinas sem cadastrar nada e a tela não manda para
Configurações; adicionar e remover pela aba Configurações gravam no servidor;
um 2º navegador (outro perfil) vê a mesma lista. Não entra no rodar-todos.js
(o Mini PC não tem navegador de teste).

    cd ~/bling-claude && venv/bin/python <repo pesagem>/testes/navegador/operadores_extrusao.py <repo pesagem>

Sai 1 se falhar."""
import json, os, shutil, subprocess, sys, tempfile, time, urllib.request
from pathlib import Path
sys.path.insert(0, "/home/ekoplastic/bling-claude")
from playwright.sync_api import sync_playwright
from recorte_extrusao_operador import _navegador

REPO = Path(sys.argv[1])
PADRAO = ["DAVI", "MARLITO", "WALLISON", "ALEXANDRO", "WILLIAN"]
falhas = []

def ok(cond, msg):
    print(("  ✓ " if cond else "  ✗ ") + msg)
    if not cond: falhas.append(msg)

def api(base, metodo, rota, corpo=None):
    dados = json.dumps(corpo).encode() if corpo is not None else None
    rq = urllib.request.Request(base + rota, data=dados, method=metodo, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(rq, timeout=10) as r: return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b"null")

def main():
    porta = 13970
    tmp = Path(tempfile.mkdtemp(prefix="eko_opx_nav_"))
    base = f"http://localhost:{porta}"
    env = {**os.environ, "EKO_PORT": str(porta), "EKO_PORT_CB": str(porta + 1000), "EKO_PORT_HTTPS": str(porta + 2000),
           "EKO_DB_FILE": str(tmp / "t.db"), "EKO_LOG_DIR": str(tmp / "logs"), "TZ": "America/Sao_Paulo", "EKO_PRINT_SIMULAR": "1"}
    srv = subprocess.Popen(["node", str(REPO / "server.js")], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(75):
            try:
                if api(base, "GET", "/healthcheck")[0] == 200: break
            except Exception: pass
            time.sleep(0.2)
        with sync_playwright() as pw:
            br = _navegador(pw)
            pg = br.new_context(viewport={"width": 1280, "height": 800}).new_page()
            pg.set_default_timeout(5000)
            # a tela da extrusão abre dentro do iframe do menu (aberta direto, ela volta ao menu)
            pg.goto(base + "/?tela=/etiqueta-producao.html"); pg.wait_for_timeout(2500)
            f = pg.frame_locator("#eko-frame")
            nomes = [t.strip() for t in f.locator("#grid-operadores .touch-btn").all_inner_texts()]
            ok(nomes == PADRAO, f"perfil novo (localStorage vazio): aba Bobinas mostra {PADRAO} — viu {nomes}")
            ativa = f.locator(".tab.active").get_attribute("data-aba")
            ok(ativa == "emissao", f"não manda para Configurações (aba ativa: {ativa})")

            f.locator(".tab[data-aba='config']").click()
            f.locator("#novo-operador").fill("joão pedro"); f.locator("text=ADICIONAR").click(); pg.wait_for_timeout(800)
            s, d = api(base, "GET", "/extrusao/operadores")
            ok(d["operadores"] == PADRAO + ["JOÃO PEDRO"], f"ADICIONAR gravou no servidor — {d['operadores']}")
            f.locator("#op-list-config .op-pill", has_text="WILLIAN").locator(".x").click(); pg.wait_for_timeout(800)
            s, d = api(base, "GET", "/extrusao/operadores")
            ok("WILLIAN" not in d["operadores"] and len(d["operadores"]) == 5, f"× removeu no servidor — {d['operadores']}")

            pg2 = br.new_context(viewport={"width": 1280, "height": 800}).new_page()
            pg2.goto(base + "/?tela=/etiqueta-producao.html"); pg2.wait_for_timeout(2500)
            nomes2 = [t.strip() for t in pg2.frame_locator("#eko-frame").locator("#grid-operadores .touch-btn").all_inner_texts()]
            ok(nomes2 == d["operadores"], f"outro navegador vê a mesma lista — {nomes2}")
            br.close()
    finally:
        srv.kill(); srv.wait(timeout=10)
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"\n{'FALHOU: ' + str(len(falhas)) if falhas else 'tudo ok'}")
    sys.exit(1 if falhas else 0)

main()
