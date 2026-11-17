"""Teste de navegador do aviso "TURNO PASSOU DA HORA" na Operação Sacoleiras (17/11/2026).

Em 17/11 o Turno C ficou aberto até 08:20 e as bobinas do A entraram nele. Agora o
card do turno fica vermelho piscando com "‼️ TURNO C PASSOU DAS 06:00 (há …) —
ENCERRE O TURNO", e a bipagem mostra o mesmo aviso antes de escolher a sacoleira.
A regra (hora de fim + 15 min) é do servidor (lib/turno-corte-hora.js, testada no
Node em testes/turno-corte-hora.js); aqui só o que se vê e o toque.

Sobe o server.js de verdade com banco temporário (nada do Mini PC), abre o C nas
duas sacoleiras pela API, empurra o início para ONTEM 22:00 no banco e dirige a
tela no Chromium da VPS. Não entra no rodar-todos.js (o Mini PC não tem navegador
de teste).

    cd ~/bling-claude && venv/bin/python <repo pesagem>/testes/navegador/turno_atrasado_coletor.py \\
        <repo pesagem> /tmp/prints

Confere em 360x640 (TC60), 390x844 e 414x896: sem atraso o card é o de sempre;
com atraso o card pisca e diz o turno e a hora; a bipagem avisa e AINDA deixa
montar (aviso, não trava); encerrar o turno apaga o aviso; e a operação cabe sem
rolar. Sem o aviso (tela de antes) falha já no item 2. Sai 1 se falhar.
Não depende da hora em que roda: o turno "no horário" é o da hora de agora, e o
atrasado é um C aberto anteontem às 22:00."""
import json, os, shutil, sqlite3, subprocess, sys, tempfile, time, urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
sys.path.insert(0, "/home/ekoplastic/bling-claude")
from playwright.sync_api import sync_playwright
from recorte_extrusao_operador import _navegador

REPO = Path(sys.argv[1]); OUT = Path(sys.argv[2]); OUT.mkdir(parents=True, exist_ok=True)
os.environ["TZ"] = "America/Sao_Paulo"; time.tzset()
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
    tmp = Path(tempfile.mkdtemp(prefix="eko_tatr_"))
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
        api(base, "POST", "/config", {"vps_sacoleiras_url": "http://127.0.0.1:9/x"})
        c = sqlite3.connect(db)
        agora = datetime.now(timezone.utc).isoformat()
        c.execute("""INSERT INTO etiquetas (id, seq, tipo, material_key, fornecedor, lote, peso, codigo, sku, status,
                     hora_impressao, cor, largura, tipo_bobina, maquina, operador)
                     VALUES ('E9950001', 9950001, 'extrusao', 'BOBINA', '-', '-', 400, 'E9950001', 'BOB-TESTE', 'bipada', ?,
                             'BRANCO', '1,20', 'LISA', 'E1', 'TESTE')""", (agora,))
        c.commit(); c.close()
        # o turno CERTO para a hora de agora (o teste não depende de quando roda)
        h = datetime.now().hour
        turno_agora = "C" if h < 6 else "A" if h < 18 else "EXTRA" if h < 22 else "C"
        s, _ = api(base, "POST", "/bobinas/turno-corte/iniciar", {"turno": turno_agora, "maquinas": ["P1", "P2"]})
        ok(s == 200, f"[{larg}] turno {turno_agora} (o da hora) aberto nas duas")

        br = _navegador(pw)
        pg = br.new_page(viewport={"width": larg, "height": alt})
        pg.set_default_timeout(5000)
        pg.add_init_script("try{ localStorage.setItem('eko_bipador_1311','GUERBY'); }catch(e){}")
        pg.goto(base + "/retirada-bobinas.html"); pg.wait_for_timeout(1200)
        tc = pg.locator("#turno-corte")
        # 1. C recém-aberto: card normal
        ok("atrasado" not in (tc.get_attribute("class") or "") and pg.locator(".tc-atraso").count() == 0,
           f"[{larg}] turno no horário: card sem aviso")

        # 2. as duas viram um C aberto ANTEONTEM 22:00 → fim ontem 06:00, atrasado
        ini22 = (datetime.now() - timedelta(days=2)).replace(hour=22, minute=0, second=0, microsecond=0)
        iso = lambda d: d.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        c = sqlite3.connect(db)
        c.execute("UPDATE turnos_corte SET turno='C', inicio=? WHERE fim IS NULL", (iso(ini22),))
        c.commit(); c.close()
        pg.evaluate("carregarTurnoCorte()"); pg.wait_for_timeout(800)
        aviso = pg.locator(".tc-atraso").inner_text() if pg.locator(".tc-atraso").count() else ""
        ok("atrasado" in (tc.get_attribute("class") or ""), f"[{larg}] card do turno ganha a classe atrasado (pisca)")
        ok("TURNO C PASSOU DAS 06:00 NA P1 E P2" in aviso and "ENCERRE O TURNO" in aviso and "há " in aviso,
           f"[{larg}] aviso diz o turno, a hora e há quanto: {aviso[:90]!r}")
        anim = pg.evaluate("getComputedStyle(document.getElementById('turno-corte')).animationName")
        ok(anim == "tc-pisca", f"[{larg}] animação ligada: {anim}")
        rola = pg.evaluate("document.documentElement.scrollHeight - window.innerHeight")
        ok(rola <= 1, f"[{larg}] com o aviso, a operação segue sem rolar (sobra {rola}px)")
        pg.screenshot(path=str(OUT / f"turno_atrasado_{larg}x{alt}_card.png"))

        # 3. bipagem: avisa, mas deixa montar (aviso, não trava)
        pg.evaluate("onLeu('E9950001')"); pg.wait_for_timeout(700)
        la = pg.locator(".lida .l-atraso")
        ok(la.count() == 1 and "TURNO C PASSOU DAS 06:00 NA P1 E P2" in la.inner_text(), f"[{larg}] bipagem mostra o aviso")
        b = pg.locator(".btn-destino[data-destino='P1']")
        ok(b.count() == 1 and b.is_enabled(), f"[{larg}] e a P1 continua liberada para montar")
        pg.screenshot(path=str(OUT / f"turno_atrasado_{larg}x{alt}_bipagem.png"))
        pg.evaluate("cancelarLeitura()")

        # 3b. só a P1 atrasada (a P2 volta ao turno da hora): a bipagem avisa da P1,
        #     e o texto não fala da P2 (revisor 17/11)
        c = sqlite3.connect(db)
        c.execute("UPDATE turnos_corte SET turno=?, inicio=? WHERE fim IS NULL AND maquina='P2'",
                  (turno_agora, iso(datetime.now())))
        c.commit(); c.close()
        pg.evaluate("carregarTurnoCorte()"); pg.wait_for_timeout(800)
        aviso = pg.locator(".tc-atraso").inner_text() if pg.locator(".tc-atraso").count() else ""
        ok("NA P1 (" in aviso and "P2" not in aviso.split("—")[0], f"[{larg}] só a P1 atrasada: card diz NA P1: {aviso[:70]!r}")
        # mesma etiqueta de novo: limpa o anti-repetição da câmera (2,5 s), como a digitação manual
        pg.evaluate("delete ultimoBipe['E9950001']; onLeu('E9950001')"); pg.wait_for_timeout(700)
        la = pg.locator(".lida .l-atraso")
        ok(la.count() == 1 and "NA P1 (" in la.inner_text() and "P2" not in la.inner_text(),
           f"[{larg}] bipagem avisa só da P1")
        pg.evaluate("cancelarLeitura()")

        # 4. encerrar (sem bobina montada) apaga o aviso
        s, d = api(base, "POST", "/bobinas/turno-corte/encerrar", {"senha": "1234", "maquinas": ["P1", "P2"]})
        ok(s == 200, f"[{larg}] turno C encerrado pela API")
        pg.evaluate("carregarTurnoCorte()"); pg.wait_for_timeout(800)
        ok("atrasado" not in (tc.get_attribute("class") or "") and pg.locator(".tc-atraso").count() == 0,
           f"[{larg}] depois de encerrar o aviso some")
        br.close()
    finally:
        srv.kill(); srv.wait(timeout=10); shutil.rmtree(tmp, ignore_errors=True)

with sync_playwright() as pw:
    for i, (l, a) in enumerate(((360, 640), (390, 844), (414, 896))):
        print(f"\n— {l}x{a}")
        rodada(pw, l, a, 13990 + i * 3)

print(f"\n{'FALHOU: ' + str(len(falhas)) if falhas else 'OK'}")
sys.exit(1 if falhas else 0)
