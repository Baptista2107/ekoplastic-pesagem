"""Gera o PDF A4 do POP a partir do pop.html desta pasta.
Uso: python3 gerar_pdf.py <saida.pdf>
Usa o Chromium do Playwright com as libs de ~/bling-claude/.chrome-libs."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path.home() / "bling-claude"))
from playwright.sync_api import sync_playwright
from recorte_extrusao_operador import _navegador

AQUI = Path(__file__).resolve().parent
saida = Path(sys.argv[1])
with sync_playwright() as pw:
    br = _navegador(pw)
    pg = br.new_page()
    pg.goto((AQUI / "pop.html").as_uri())
    pg.wait_for_load_state("networkidle")
    pg.pdf(path=str(saida), format="A4", print_background=True, prefer_css_page_size=True)
    br.close()
print(saida)
