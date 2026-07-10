"""Puente Node -> motor de arqueo. Entra la ruta de un Excel, sale una línea JSON.

Este archivo es PROPIO del repo promo-bot (no es parte del motor copiado, así que
sí se puede editar acá). El bot Node lo ejecuta con:

    python arqueo/runner.py <ruta_del_excel>

y lee la ÚLTIMA línea de stdout como JSON:
    {"ok": true,  "html": "<ruta>", "xlsx": "<ruta>"}
    {"ok": false, "error": "<mensaje para el usuario>"}   # export inválido / sin datos

Ante un error inesperado (bug real), NO imprime JSON: propaga el traceback por
stderr y sale con código != 0, para que el Node muestre un error genérico y quede
el log completo.
"""
import contextlib
import json
import os
import sys

# El paquete `masmelos` vive en arqueo/src/ (así config.py resuelve bien sus rutas
# con parents[2] = arqueo/, donde escribe data/ y reports/).
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "src"))


def main() -> int:
    if len(sys.argv) < 2 or not sys.argv[1].strip():
        print(json.dumps({"ok": False, "error": "Falta la ruta del Excel."}))
        return 0

    ruta = sys.argv[1]
    from masmelos.update_arqueo import correr_arqueo
    from masmelos.arqueo.parse import ArqueoUsuarioError

    try:
        # El motor loguea/imprime su resumen: lo mandamos a stderr para dejar
        # stdout limpio (solo la línea JSON del contrato).
        with contextlib.redirect_stdout(sys.stderr):
            res = correr_arqueo([ruta], sin_snapshot=True)
    except ArqueoUsuarioError as e:
        print(json.dumps({"ok": False, "error": str(e)}))
        return 0

    print(json.dumps({"ok": True, "html": str(res["html"]), "xlsx": str(res["xlsx"])}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
