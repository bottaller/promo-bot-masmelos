"""Puente Node -> motor de arqueo. Llama al CLI del motor (su interfaz pública) con
--json y deja que emita la línea JSON del contrato.

Este archivo es PROPIO del repo promo-bot (sí se edita acá). El bot Node lo ejecuta con:

    python arqueo/runner.py <ruta_del_excel>

y lee la ÚLTIMA línea de stdout como JSON:
    {"ok": true,  "html": "<ruta>", "xlsx": "<ruta>"}
    {"ok": false, "error": "<mensaje para el usuario>"}   # export inválido

Ante un error inesperado (bug real), el motor propaga el traceback por stderr y sale
con código != 0; el bot muestra un error genérico.

NO importa funciones internas del motor: solo su CLI (`main` + `--json`). Así los
refactors del motor no rompen el bot mientras el CLI mantenga el contrato --json.
"""
import os
import sys

# El paquete `masmelos` vive en arqueo/src/ (config.py resuelve sus rutas con parents[2]).
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "src"))

from masmelos.update_arqueo import main  # noqa: E402 — después de armar el sys.path


def _main() -> int:
    if len(sys.argv) < 2 or not sys.argv[1].strip():
        print('{"ok": false, "error": "Falta la ruta del Excel."}')
        return 0
    # --sin-snapshot: no acumular (no dependemos del disco persistente de Railway).
    # --json: el motor imprime la línea JSON con las rutas; el resumen humano va a stderr.
    return main([sys.argv[1], "--sin-snapshot", "--json"])


if __name__ == "__main__":
    sys.exit(_main())
