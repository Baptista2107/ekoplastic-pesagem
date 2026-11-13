"""Prints do POP Operação Sacoleiras: server.js de verdade, banco temporário,
CLP falso. Nada do Mini PC. Uso: prints.py <repo pesagem> <pasta saída>
Precisa de um fonts.conf ao lado com a fonte Noto Color Emoji (pacote
fonts-noto-color-emoji extraído com dpkg -x, sem instalar), senão os emojis
da tela saem em branco."""
import json, os, shutil, sqlite3, subprocess, sys, tempfile, threading, time, urllib.request
from datetime import datetime, timezone, timedelta
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
sys.path.insert(0, "/home/ekoplastic/bling-claude")
os.environ["FONTCONFIG_FILE"] = str(Path(__file__).parent / "fonts.conf")
from playwright.sync_api import sync_playwright
from recorte_extrusao_operador import _navegador

REPO = Path(sys.argv[1]); OUT = Path(sys.argv[2]); OUT.mkdir(parents=True, exist_ok=True)
PORTA, PCLP = 14710, 14790
MM = {"P1": 500, "P2": 450}

class CLP(BaseHTTPRequestHandler):
    def do_GET(self):
        t = (datetime.utcnow() - timedelta(hours=3)).strftime("%Y-%m-%dT%H:%M:%S")
        b = json.dumps({"ok": True, "sacoleiras": {m: {"comprimento_mm": v, "operando": True, "tempo": t} for m, v in MM.items()}}).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(b)
    def log_message(self, *a): pass
threading.Thread(target=HTTPServer(("127.0.0.1", PCLP), CLP).serve_forever, daemon=True).start()

def api(base, metodo, rota, corpo=None):
    d = json.dumps(corpo).encode() if corpo is not None else None
    rq = urllib.request.Request(base + rota, data=d, method=metodo, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(rq, timeout=10) as r: return json.loads(r.read() or b"null")

tmp = Path(tempfile.mkdtemp(prefix="eko_pop_")); db = tmp / "t.db"; base = f"http://localhost:{PORTA}"
env = {**os.environ, "EKO_PORT": str(PORTA), "EKO_PORT_CB": str(PORTA + 1000), "EKO_PORT_HTTPS": str(PORTA + 2000),
       "EKO_DB_FILE": str(db), "EKO_LOG_DIR": str(tmp / "logs"), "TZ": "America/Sao_Paulo", "EKO_PRINT_SIMULAR": "1",
       "EKO_CLP_CACHE_MS": "1"}
srv = subprocess.Popen(["node", str(REPO / "server.js")], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def sql(q, a=()):
    c = sqlite3.connect(db)
    try: c.execute(q, a); c.commit()
    finally: c.close()

try:
    for _ in range(75):
        try: api(base, "GET", "/healthcheck"); break
        except Exception: time.sleep(0.2)
    api(base, "POST", "/config", {"vps_sacoleiras_url": f"http://127.0.0.1:{PCLP}/api/sacoleiras/agora"})
    agora = datetime.now(timezone.utc).isoformat()
    for i, (bid, cor, peso) in enumerate((("E0002301", "BRANCO", 412), ("E0002302", "PRETO", 398),
                                          ("E0002303", "BRANCO", 405), ("E0002304", "BRANCO", 420))):
        sql("""INSERT INTO etiquetas (id, seq, tipo, material_key, fornecedor, lote, peso, codigo, sku, status,
               hora_impressao, cor, largura, tipo_bobina, maquina, operador)
               VALUES (?, ?, 'extrusao', 'BOBINA', '-', '-', ?, ?, 'BOB-TESTE', 'bipada', ?, ?, '1,60', 'LISA', 'C1', 'MARCOS')""",
            (bid, 2301 + i, peso, bid, agora, cor))

    def recuar(bid, horas):
        t = (datetime.now(timezone.utc) - timedelta(hours=horas)).isoformat().replace("+00:00", "Z")
        sql("UPDATE etiquetas SET baixa_em=? WHERE id=?", (t, bid))

    with sync_playwright() as pw:
        br = _navegador(pw)
        pg = br.new_page(viewport={"width": 360, "height": 720}, device_scale_factor=2, is_mobile=True, has_touch=True)
        pg.set_default_timeout(6000)
        pg.add_init_script("document.addEventListener('DOMContentLoaded',()=>{const st=document.createElement('style');st.textContent='#toast{display:none!important}';document.head.appendChild(st);})")
        def foto(n, sel=None):
            pg.wait_for_timeout(500)
            if sel == "modal":
                pg.set_viewport_size({"width": 360, "height": 1300}); pg.wait_for_timeout(400)
                pg.locator(".modal-fundo").last.locator(".modal").screenshot(path=str(OUT / f"{n}.png"))
                pg.set_viewport_size({"width": 360, "height": 720}); pg.wait_for_timeout(300)
            elif sel:
                pg.locator(sel).first.screenshot(path=str(OUT / f"{n}.png"))
            else:
                pg.screenshot(path=str(OUT / f"{n}.png"))
            print("foto", n)
        def montar(bid, sac, nome):
            pg.evaluate(f"onLeu('{bid}')"); pg.wait_for_timeout(700)
            pg.locator(f".btn-destino[data-destino='{sac}']").click(); pg.wait_for_timeout(500)
            pg.locator(f".modal .nomes .chip[data-n='{nome}']").click(); pg.locator("#md-ok").click()
            pg.wait_for_timeout(1300)

        pg.goto(base + "/retirada-bobinas.html"); pg.wait_for_timeout(1500)
        foto("01_sem_turno")
        pg.locator("button:has-text('Iniciar turno')").first.click(); pg.wait_for_timeout(400)
        pg.locator("#md-turnos .chip[data-t='A']").click()
        foto("02_iniciar_turno", "modal")
        pg.locator("#md-ok").click(); pg.wait_for_timeout(1500)
        foto("03_turno_aberto")
        pg.evaluate("onLeu('E0002301')"); pg.wait_for_timeout(900)
        foto("04_bipou")
        pg.locator(".btn-destino[data-destino='P1']").click(); pg.wait_for_timeout(600)
        pg.locator(".modal .nomes .chip[data-n='GISLENE']").click()
        foto("05_quem_bipa", "modal")
        pg.locator("#md-ok").click(); pg.wait_for_timeout(1300)
        montar("E0002302", "P2", "HOZANA")
        recuar("E0002301", 3.2); recuar("E0002302", 2.7)
        sql("UPDATE turnos_corte SET inicio=?", ((datetime.now(timezone.utc) - timedelta(hours=4)).isoformat().replace("+00:00", "Z"),))
        pg.reload(); pg.wait_for_timeout(1500)
        foto("06_montadas")
        # ✓ Bobina finalizou na P1
        pg.locator(".sac").nth(0).locator(".s-acabou").click(); pg.wait_for_timeout(500)
        pg.locator("#md-fardos").fill("14"); pg.locator(".soltos .chip[data-s='2']").click()
        foto("07_finalizou_fardos", "modal")
        pg.locator("#md-ok").click(); pg.wait_for_timeout(500)
        foto("08_proxima_formato", "modal")
        pg.locator("#md-ok").click(); pg.wait_for_timeout(1500)
        foto("09_bipe_a_proxima")
        # Trocar formato na P2 (só foto, volta)
        pg.locator(".sac").nth(1).locator("button:has-text('Trocar formato')").click(); pg.wait_for_timeout(500)
        pg.locator("#md-fardos").fill("6")
        foto("10_troca_formato_fardos", "modal")
        pg.locator("#md-ok").click(); pg.wait_for_timeout(500)
        pg.locator(".prox .chip[data-f='35x45']").click()
        foto("11_troca_formato_novo", "modal")
        pg.locator("#md-cancelar").click(); pg.wait_for_timeout(400)
        # REFUGO na P2 (só foto, cancela)
        pg.locator(".sac").nth(1).locator("button:has-text('REFUGO')").click(); pg.wait_for_timeout(500)
        pg.locator("#md-fardos").fill("4")
        foto("12_refugo", "modal")
        pg.locator("#md-cancelar").click(); pg.wait_for_timeout(400)
        # próxima bobina na P1
        montar("E0002303", "P1", "GISLENE")
        recuar("E0002303", 0.8)
        pg.reload(); pg.wait_for_timeout(1500)
        foto("13_p1_nova")
        # erro: bobina já usada
        pg.evaluate("onLeu('E0002301')"); pg.wait_for_timeout(900)
        foto("14_erro_ja_usada", ".lida.erro")
        pg.evaluate("cancelarLeitura()")
        # Encerrar turno
        pg.locator("button:has-text('Encerrar turno')").first.click(); pg.wait_for_timeout(400)
        pg.locator("#md-senha").fill("1234")
        foto("15_encerrar_senha", "modal")
        pg.locator(".modal-fundo").last.locator("#md-ok").click(); pg.wait_for_timeout(700)
        pg.locator(".modal-fundo").last.locator("#md-fardos").fill("3"); pg.locator(".modal-fundo").last.locator(".soltos .chip[data-s='1']").click()
        foto("16_fim_turno_fardos", "modal")
        pg.locator(".modal-fundo").last.locator("#md-ok").click(); pg.wait_for_timeout(700)
        pg.locator(".modal-fundo").last.locator("#md-fardos").fill("11")
        pg.locator(".modal-fundo").last.locator("#md-ok").click(); pg.wait_for_timeout(2500)
        foto("17_resumo_turno", "modal")
        br.close()
finally:
    srv.kill(); srv.wait(timeout=10); shutil.rmtree(tmp, ignore_errors=True)
