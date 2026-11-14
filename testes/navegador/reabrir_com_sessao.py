"""Teste de navegador: a tela que reabre com sessão em andamento vai direto
para ela (13/11/2026).

Na queda de energia e na atualização de 13/11 a tela do Mini PC reabriu no
MENU com a sessão da extrusão aberta (EXT-C1, "Alexandro"), e ficou parecendo
que a sessão tinha sumido. Gustavo: "quando abrir, traz a sessão pra aparecer
na tela, não só abre ela".

Sobe o server.js de verdade com banco temporário. Confere:
  1. sem sessão aberta: fica no menu
  2. sessão de extrusão aberta mas vazia: fica no menu (badge também ignora)
  3. sessão de extrusão com bobina, operador digitado "Alexandro": o menu abre
     a Extrusão sozinho, a sessão aparece (bobina no histórico) e o botão
     ALEXANDRO fica marcado, sem trocar o nome da sessão
  4. extrusão e PA abertas: abre a da etiqueta mais recente (PA)
  5. toque DENTRO da tela aberta sozinha liga a tela cheia do shell (sem isso
     a trava de saída fica sem efeito — revisor do 2930b7a)
  6. aparelho da rede (celular/coletor pelo IP no HTTPS) fica no menu
  7. sessão esquecida (última etiqueta há 13 h) não abre sozinha
Não entra no rodar-todos.js (o Mini PC não tem navegador de teste).

    cd ~/bling-claude && venv/bin/python <repo pesagem>/testes/navegador/reabrir_com_sessao.py <repo pesagem>

Sai 1 se falhar."""
import json, os, shutil, socket, sqlite3, subprocess, sys, tempfile, time, urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
sys.path.insert(0, "/home/ekoplastic/bling-claude")
from playwright.sync_api import sync_playwright
from recorte_extrusao_operador import _navegador

REPO = Path(sys.argv[1])
falhas = []

def ok(cond, msg):
    print(("  ✓ " if cond else "  ✗ ") + msg)
    if not cond: falhas.append(msg)

def get(base, rota):
    with urllib.request.urlopen(base + rota, timeout=10) as r: return json.loads(r.read())

def iso(min_atras):
    return (datetime.now(timezone.utc) - timedelta(minutes=min_atras)).isoformat().replace("+00:00", "Z")

def sessao(db, tipo, operador, turno, etiqueta=None, min_atras=10):
    c = sqlite3.connect(db)
    cur = c.execute("INSERT INTO sessoes (tipo, inicio, operador, maquina, turno_codigo) VALUES (?, ?, ?, 'C2', ?)",
                    (tipo, iso(min_atras + 5), operador, turno))
    sid = cur.lastrowid
    if etiqueta:
        c.execute("""INSERT INTO etiquetas (id, seq, tipo, material_key, fornecedor, lote, peso, codigo, sku, status,
                     hora_impressao, cor, largura, tipo_bobina, maquina, operador, sessao_id)
                     VALUES (?, ?, ?, 'BOBINA', '-', '-', 461.5, ?, 'BOB-TESTE', 'aguardando_bipe', ?, 'BRANCO', '1,60', 'LISA', 'C2', ?, ?)""",
                  (etiqueta, int(etiqueta[1:]), tipo, etiqueta, iso(min_atras), operador, sid))
    c.commit(); c.close()
    return sid

def iframe_src(pg):
    return pg.evaluate("document.getElementById('eko-frame').getAttribute('src') || ''")

def main():
    porta = 13980
    tmp = Path(tempfile.mkdtemp(prefix="eko_reabrir_"))
    db = tmp / "t.db"; base = f"http://localhost:{porta}"
    env = {**os.environ, "EKO_PORT": str(porta), "EKO_PORT_CB": str(porta + 1000), "EKO_PORT_HTTPS": str(porta + 2000),
           "EKO_DB_FILE": str(db), "EKO_LOG_DIR": str(tmp / "logs"), "TZ": "America/Sao_Paulo", "EKO_PRINT_SIMULAR": "1"}
    srv = subprocess.Popen(["node", str(REPO / "server.js")], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(75):
            try:
                if get(base, "/healthcheck").get("ok"): break
            except Exception: pass
            time.sleep(0.2)
        with sync_playwright() as pw:
            br = _navegador(pw)
            def abrir(url=None):
                pg = br.new_context(viewport={"width": 1280, "height": 800}, ignore_https_errors=True).new_page()
                pg.set_default_timeout(6000)
                pg.goto(url or (base + "/")); pg.wait_for_timeout(2500)
                return pg

            # 1
            pg = abrir()
            ok(iframe_src(pg) in ("", "about:blank"), f"sem sessão aberta: fica no menu (iframe '{iframe_src(pg)}')")
            pg.context.close()

            # 2
            vazia = sessao(db, "extrusao", "DAVI", "EXT-A1")
            pg = abrir()
            ok(iframe_src(pg) in ("", "about:blank"), f"sessão aberta VAZIA: fica no menu (iframe '{iframe_src(pg)}')")
            pg.context.close()
            c = sqlite3.connect(db); c.execute("UPDATE sessoes SET fim = ? WHERE id = ?", (iso(0), vazia)); c.commit(); c.close()

            # 7
            sessao(db, "outras", "DAVI", None, etiqueta="O9950001", min_atras=13 * 60)
            pg = abrir()
            ok(iframe_src(pg) in ("", "about:blank"), f"sessão esquecida (última etiqueta há 13 h): fica no menu (iframe '{iframe_src(pg)}')")
            pg.context.close()

            # 3
            sessao(db, "extrusao", "Alexandro", "EXT-C1", etiqueta="E9950001", min_atras=10)
            pg = abrir()
            ok(iframe_src(pg) == "/etiqueta-producao.html", f"sessão de extrusão com bobina: abre a Extrusão sozinho (iframe '{iframe_src(pg)}')")
            f = pg.frame_locator("#eko-frame")
            try:
                f.locator("#grid-operadores .touch-btn").first.wait_for()
                pg.wait_for_timeout(1000)
                hist = f.locator("body").inner_text()
                ok("E9950001" in hist, "a bobina da sessão aparece na tela")
                marcados = [t.strip() for t in f.locator("#grid-operadores .touch-btn.selected").all_inner_texts()]
                ok(marcados == ["ALEXANDRO"], f"operador 'Alexandro' da sessão marca o botão ALEXANDRO — marcados {marcados}")
                op = pg.frame(url=lambda u: u.endswith("/etiqueta-producao.html")).evaluate("state.operador")
                ok(op == "Alexandro", f"o nome da sessão não muda no meio do turno (state.operador = {op!r})")
                # 5: espiona o ekoEntrarFS do shell e toca dentro da tela
                # (termina em "0": string que acaba numa função, o Playwright a executa e contaria 1)
                pg.evaluate("window.__fs = 0; window.ekoEntrarFS = function(){ window.__fs++; }; 0")
                # toque em qualquer ponto (pode haver aviso por cima, como na fábrica)
                f.locator("body").click(position={"x": 640, "y": 400}, force=True)
                ok(pg.evaluate("window.__fs") > 0, f"toque dentro da tela aberta sozinha chama a tela cheia do shell ({pg.evaluate('window.__fs')}x)")
            except Exception as e:
                ok(False, f"tela da extrusão não carregou a sessão: {e}")
            pg.context.close()

            # 6: celular/coletor pela rede (HTTPS no IP da máquina, não localhost)
            s_ = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            try: s_.connect(("10.255.255.255", 1)); ip = s_.getsockname()[0]
            finally: s_.close()
            pg = abrir(f"https://{ip}:{porta + 2000}/")
            ok(pg.locator("#eko-frame").count() == 1 and iframe_src(pg) in ("", "about:blank"),
               f"aparelho da rede ({ip}) com sessão aberta: fica no menu (iframe '{iframe_src(pg)}')")
            pg.context.close()

            # 4
            sessao(db, "produto-acabado", "BRUNO", "A", etiqueta="P9950001", min_atras=2)
            pg = abrir()
            ok(iframe_src(pg) == "/produto-acabado.html", f"extrusão e PA abertas: abre a da etiqueta mais recente, PA (iframe '{iframe_src(pg)}')")
            pg.context.close()
            br.close()
    finally:
        srv.kill(); srv.wait(timeout=10)
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"\n{'FALHOU: ' + str(len(falhas)) if falhas else 'tudo ok'}")
    sys.exit(1 if falhas else 0)

main()
