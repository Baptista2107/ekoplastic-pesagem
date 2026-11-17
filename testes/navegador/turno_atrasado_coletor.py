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
Só faz sentido depois das 06:15 (hora local): antes disso o C de ontem ainda não
passou da folga — aí o teste diz e sai 0 sem conferir o aviso."""
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
        s, _ = api(base, "POST", "/bobinas/turno-corte/iniciar", {"turno": "C", "maquinas": ["P1", "P2"]})
        ok(s == 200, f"[{larg}] turno C aberto nas duas")

        br = _navegador(pw)
        pg = br.new_page(viewport={"width": larg, "height": alt})
        pg.set_default_timeout(5000)
        pg.add_init_script("try{ localStorage.setItem('eko_bipador_1311','GUERBY'); }catch(e){}")
        pg.goto(base + "/retirada-bobinas.html"); pg.wait_for_timeout(1200)
        tc = pg.locator("#turno-corte")
        # 1. C recém-aberto: card normal
        ok("atrasado" not in (tc.get_attribute("class") or "") and pg.locator(".tc-atraso").count() == 0,
           f"[{larg}] turno no horário: card sem aviso")

        # 2. o C passa a ter começado ontem 22:00 → depois das 06:15 está atrasado
        ontem22 = (datetime.now() - timedelta(days=1)).replace(hour=22, minute=0, second=0, microsecond=0)
        c = sqlite3.connect(db)
        c.execute("UPDATE turnos_corte SET inicio=? WHERE fim IS NULL",
                  (ontem22.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),))
        c.commit(); c.close()
        pg.evaluate("carregarTurnoCorte()"); pg.wait_for_timeout(800)
        aviso = pg.locator(".tc-atraso").inner_text() if pg.locator(".tc-atraso").count() else ""
        ok("atrasado" in (tc.get_attribute("class") or ""), f"[{larg}] card do turno ganha a classe atrasado (pisca)")
        ok("TURNO C PASSOU DAS 06:00" in aviso and "ENCERRE O TURNO" in aviso and "há " in aviso,
           f"[{larg}] aviso diz o turno, a hora e há quanto: {aviso[:90]!r}")
        anim = pg.evaluate("getComputedStyle(document.getElementById('turno-corte')).animationName")
        ok(anim == "tc-pisca", f"[{larg}] animação ligada: {anim}")
        rola = pg.evaluate("document.documentElement.scrollHeight - window.innerHeight")
        ok(rola <= 1, f"[{larg}] com o aviso, a operação segue sem rolar (sobra {rola}px)")
        pg.screenshot(path=str(OUT / f"turno_atrasado_{larg}x{alt}_card.png"))

        # 3. bipagem: avisa, mas deixa montar (aviso, não trava)
        pg.evaluate("onLeu('E9950001')"); pg.wait_for_timeout(700)
        la = pg.locator(".lida .l-atraso")
        ok(la.count() == 1 and "TURNO C PASSOU DAS 06:00" in la.inner_text(), f"[{larg}] bipagem mostra o aviso")
        b = pg.locator(".btn-destino[data-destino='P1']")
        ok(b.count() == 1 and b.is_enabled(), f"[{larg}] e a P1 continua liberada para montar")
        pg.screenshot(path=str(OUT / f"turno_atrasado_{larg}x{alt}_bipagem.png"))
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

if datetime.now() < datetime.now().replace(hour=6, minute=16, second=0, microsecond=0):
    print("antes das 06:16: o C de ontem 22:00 ainda está na folga — nada a conferir")
    sys.exit(0)
with sync_playwright() as pw:
    for i, (l, a) in enumerate(((360, 640), (390, 844), (414, 896))):
        print(f"\n— {l}x{a}")
        rodada(pw, l, a, 13990 + i * 3)

print(f"\n{'FALHOU: ' + str(len(falhas)) if falhas else 'OK'}")
sys.exit(1 if falhas else 0)
