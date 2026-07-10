# De dónde salió `src/masmelos/`

Los archivos de `src/masmelos/` son una **COPIA** del motor de arqueo, del repo:

- **Repo**: https://github.com/Renzoca6/masmelos-analytics
- **Rama**: `dev`
- **Commit**: `cfb48dd`

## ⚠️ Regla de una sola dirección

**No editar `src/masmelos/` acá.** La fuente de verdad es `masmelos-analytics`.
Si hay un bug o mejora en el motor, se arregla ALLÁ y se vuelve a copiar acá.
Editar la copia = dos versiones que divergen y nadie sabe cuál manda.

Lo que SÍ es propio de este repo (se edita acá): `runner.py`, `requirements.txt`,
este `COPIADO_DE.md`, y el bot Node que lo invoca (`../src/scenes/arqueo.js`).

## Cómo volver a copiar (cuando el motor cambie)

Desde `masmelos-analytics` (rama `dev`), copiar estos 10 archivos conservando la
estructura, sobre `promo-bot/arqueo/src/masmelos/`:

```
src/masmelos/__init__.py
src/masmelos/config.py
src/masmelos/update_arqueo.py
src/masmelos/arqueo/__init__.py
src/masmelos/arqueo/parse.py
src/masmelos/arqueo/core.py
src/masmelos/arqueo/alertas.py
src/masmelos/arqueo/excel.py
src/masmelos/arqueo/flujo.py
src/masmelos/arqueo/flujo_html.py
```

## Cómo se usa acá

El bot Node (`/arqueo`, área Tesorería) baja el Excel que manda el usuario y ejecuta:

```
python arqueo/runner.py <ruta_del_excel>
```

`runner.py` corre el motor con `sin_snapshot=True` (no acumula el snapshot local,
así no dependemos del disco persistente de Railway) y devuelve una línea JSON con
la ruta del HTML generado. El Node lo lee y lo manda por el chat.

## Prueba de humo local (sin Telegram)

```bash
pip install -r requirements.txt
python arqueo/runner.py "C:\Users\renzo\Documents\Diario de movimientos.xlsx"
# -> {"ok": true, "html": "...", "xlsx": "..."}
```
