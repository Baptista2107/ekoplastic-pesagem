"""Teste de navegador do "Quem está bipando?" na Operação Sacoleiras (13/11/2026).

A pergunta saiu em 19/10/2026 (2e47a17, Vinicius) e voltou a pedido do
Gustavo: na bipagem da bobina, antes de montar na sacoleira, o operador escolhe
o nome (GISLENE, HOZANA, CARINE, ROMULO, HEIDIANE, GUERBY, ANDRÉ, ITALO).

Sobe o server.js de verdade com banco temporário (nada do Mini PC), cria duas
bobinas, abre o turno pela API e dirige a tela no Chromium da VPS. Não entra no
rodar-todos.js (o Mini PC não tem navegador de teste).

    cd ~/bling-claude && venv/bin/python <repo pesagem>/testes/navegador/quem-bipa_coletor.py \\
        <repo pesagem> /tmp/prints

Confere em 360x640 (TC60), 390x844 e 414x896: a lista na ordem certa, Cancelar
não monta, Continuar sem nome não monta, nome escolhido vai para baixa_operador,
aparece no topo e no card, o aparelho lembra o último nome na bipagem seguinte, e
a tela da operação segue sem rolar. Na tela de antes (sem a pergunta) falha já
no primeiro item. Sai 1 se falhar."""
import json, os, shutil, sqlite3, subprocess, sys, tempfile, time, urllib.request
from datetime import datetime, timezone
from pathlib import Path
sys.path.insert(0, "/home/ekoplastic/bling-claude")
from playwright.sync_api import sync_playwright
from recorte_extrusao_operador import _navegador

REPO = Path(sys.argv[1]); OUT = Path(sys.argv[2]); OUT.mkdir(parents=True, exist_ok=True)
NOMES = ["GISLENE", "HOZANA", "CARINE", "ROMULO", "HEIDIANE", "GUERBY", "ANDRÉ", "ITALO"]
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

def rodada(pw, larg, alt, porta):
    tmp = Path(tempfile.mkdtemp(prefix="eko_quem_"))
    db = tmp / "t.db"; base = f"http://localhost:{porta}"
    env = {**os.environ, "EKO_PORT": str(porta), "EKO_PORT_CB": str(porta + 1000), "EKO_PORT_HTTPS": str(porta + 2000),
           "EKO_DB_FILE": str(db), "EKO_LOG_DIR": str(tmp / "logs"), "TZ": "America/Sao_Paulo", "EKO_PRINT_SIMULAR": "1"}
    srv = subprocess.Popen(["node", str(REPO / "server.js")], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(75):
            try:
                if api(base, "GET", "/healthcheck")[0] == 200: break
            except Exception: pass
            time.sleep(0.2)
        # CLP da VPS fora do ar no teste (responde na hora, sem esperar timeout)
        api(base, "POST", "/config", {"vps_sacoleiras_url": "http://127.0.0.1:9/x"})
        c = sqlite3.connect(db)
        agora = datetime.now(timezone.utc).isoformat()
        for i, bid in enumerate(("E9940001", "E9940002")):
            c.execute("""INSERT INTO etiquetas (id, seq, tipo, material_key, fornecedor, lote, peso, codigo, sku, status,
                         hora_impressao, cor, largura, tipo_bobina, maquina, operador)
                         VALUES (?, ?, 'extrusao', 'BOBINA', '-', '-', 400, ?, 'BOB-TESTE', 'bipada', ?, 'BRANCO', '1,60', 'LISA', 'E1', 'TESTE')""",
                      (bid, 9940001 + i, bid, agora))
        c.commit(); c.close()
        s, _ = api(base, "POST", "/bobinas/turno-corte/iniciar", {"turno": "A", "maquinas": ["P1", "P2"]})
        ok(s == 200, f"[{larg}] turno A aberto nas duas")

        br = _navegador(pw)
        pg = br.new_page(viewport={"width": larg, "height": alt})
        pg.set_default_timeout(5000)
        pg.goto(base + "/retirada-bobinas.html"); pg.wait_for_timeout(1200)
        quem = lambda: pg.locator("#quem").inner_text().strip() if pg.locator("#quem").count() else "(sem #quem)"
        ok(quem() == "", f"[{larg}] aparelho novo: topo sem nome")

        def bipar(bid, sac):
            pg.evaluate(f"onLeu('{bid}')"); pg.wait_for_timeout(600)
            b = pg.locator(f".btn-destino[data-destino='{sac}']")
            if b.count() and b.is_enabled(): b.click()
            pg.wait_for_timeout(400)

        def baixa_op(bid):
            c = sqlite3.connect(db)
            try: return c.execute("SELECT status, baixa_operador FROM etiquetas WHERE id=?", (bid,)).fetchone()
            finally: c.close()

        # 1. a pergunta aparece, com a lista certa
        bipar("E9940001", "P1")
        modal = pg.locator(".modal-fundo .modal")
        ok(modal.count() == 1 and "Quem está bipando?" in modal.inner_text(), f"[{larg}] bipagem pergunta quem está bipando")
        chips = [x.strip() for x in pg.locator(".modal .nomes .chip").all_inner_texts()]
        ok(chips == NOMES, f"[{larg}] lista na ordem: {chips}")
        pg.screenshot(path=str(OUT / f"quem_{larg}x{alt}_lista.png"))
        # 2. Cancelar não monta
        if pg.locator("#md-cancelar").count(): pg.locator("#md-cancelar").click(); pg.wait_for_timeout(300)
        ok(baixa_op("E9940001")[0] == "bipada", f"[{larg}] Cancelar não monta a bobina")
        # 3. Continuar sem nome não monta
        bipar("E9940001", "P1")
        if pg.locator("#md-ok").count(): pg.locator("#md-ok").click(); pg.wait_for_timeout(300)
        ok(pg.locator(".modal-fundo").count() == 1 and baixa_op("E9940001")[0] == "bipada",
           f"[{larg}] Continuar sem nome é barrado na tela")
        # 4. escolhe GUERBY → grava
        if pg.locator(".modal .nomes .chip[data-n='GUERBY']").count():
            pg.locator(".modal .nomes .chip[data-n='GUERBY']").click(); pg.locator("#md-ok").click()
        pg.wait_for_timeout(1500)
        ok(baixa_op("E9940001") == ("consumida", "GUERBY"), f"[{larg}] baixa_operador gravado: {baixa_op('E9940001')}")
        ok(quem() == "👤 GUERBY", f"[{larg}] topo mostra 👤 GUERBY")
        ok("GUERBY" in pg.locator("#sacs").inner_text(), f"[{larg}] card da P1 mostra GUERBY")
        rola = pg.evaluate("document.documentElement.scrollHeight - window.innerHeight")
        ok(rola <= 1, f"[{larg}] operação cabe sem rolar (sobra {rola}px)")
        pg.screenshot(path=str(OUT / f"quem_{larg}x{alt}_montada.png"))
        # 5. o aparelho lembra: próxima bipagem já vem com GUERBY marcado; troca por ANDRÉ
        pg.reload(); pg.wait_for_timeout(1200)
        ok(quem() == "👤 GUERBY", f"[{larg}] depois de recarregar, topo lembra GUERBY")
        bipar("E9940002", "P2")
        sel = pg.locator(".modal .nomes .chip.sel").all_inner_texts()
        ok(sel == ["GUERBY"], f"[{larg}] último nome já vem marcado: {sel}")
        if pg.locator(".modal .nomes .chip[data-n='ANDRÉ']").count():
            pg.locator(".modal .nomes .chip[data-n='ANDRÉ']").click(); pg.locator("#md-ok").click()
        pg.wait_for_timeout(1500)
        ok(baixa_op("E9940002") == ("consumida", "ANDRÉ"), f"[{larg}] P2 com ANDRÉ: {baixa_op('E9940002')}")
        br.close()
    finally:
        srv.kill(); srv.wait(timeout=10); shutil.rmtree(tmp, ignore_errors=True)

with sync_playwright() as pw:
    for i, (l, a) in enumerate(((360, 640), (390, 844), (414, 896))):
        print(f"\n— {l}x{a}")
        rodada(pw, l, a, 13980 + i * 3)

print(f"\n{'FALHOU: ' + str(len(falhas)) if falhas else 'OK'}")
sys.exit(1 if falhas else 0)
