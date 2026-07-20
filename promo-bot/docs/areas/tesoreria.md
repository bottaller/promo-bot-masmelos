# Área Tesorería

> Un doc por área. Este cubre **Tesorería**: los comandos `/flujos` y `/cierre`, el puente al motor
> Python y la copia vendoreada del motor. Última actualización: **2026-07-12**.

## Qué hace

El **flujo del dinero**: cada mañana el tesorero exporta de **Sigma** (el ERP de escritorio, offline)
el reporte *"Diario de movimientos contables"* y lo procesa para ver **cómo se movió la plata** —
qué entró a cada caja, qué salió del circuito de custodia, y qué diferencias hubo. El bot recibe ese
Excel y devuelve un **dashboard HTML** (el "Control 2 — Seguí la plata") listo para abrir en el navegador.

## Comando

| Comando | Qué hace |
|---------|----------|
| `/libro` | (**admin**) Carga el *"Diario de movimientos"* del día **una sola vez**, para que lo consuman todos los demás comandos. Guarda los movimientos parseados **y** el `.xlsx` crudo. Ver §Libro diario centralizado. |
| `/flujos` | Pide el Excel del *"Diario de movimientos contables"* de Sigma (`.xlsx`), lo procesa y devuelve el HTML del flujo. Si el archivo no es un export válido, responde el mensaje de error de Sigma. |
| `/cierre` | Cierre **diario**: pide los saldos (*"Existencias al cierre"*) **y** el libro del día, concilia realidad vs libro por cuenta, guarda todo y devuelve el reporte con las diferencias y el acumulado. Avisa a los admins si hay una cuenta en 🔴. |
| `/semanal` | Control **semanal**: mandás el libro de la semana (los saldos ya están de los cierres diarios), concilia el período. **No modifica** los cierres diarios. |
| `/mensual` | Control **mensual**: ídem, sobre el mes. |
| `/reportecierre <fecha>` | (**admin**) Recupera un cierre guardado de esa fecha, con el acumulado a esa fecha. |

**Flujo de uso (`/flujos`):** `/flujos` → el bot pide el archivo → mandás el `.xlsx` como documento →
te devuelve `flujo_<desde>_<hasta>.html` (el nombre lleva el período, según
[convenciones.md](../convenciones.md)).

## Libro diario centralizado (`/libro`)

Antes, **cada** comando pedía el mismo Excel de Sigma: `/cierre`, `/semanal`, `/mensual`, `/flujos` y
`/mp`. Ahora el admin lo carga **una vez por día** con `/libro` y todos lo consumen.

Qué guarda (migración **016**, tabla `bot.libro_diario`), y por qué las dos cosas:
- **Los movimientos parseados** → van a `bot.tesoreria_movimientos` con la misma función que usa
  `/cierre` (borra y reinserta por día: re-subir corrige, no duplica). Es lo que consumen `/cierre`,
  `/arqueo` y los controles de período.
- **El `.xlsx` crudo** (`bytea`, ~280 KB/día) → porque a algunos no les alcanza con los datos:
  `/flujos` se lo pasa **por ruta** al motor Python, y `/mp` lo parsea con **otro** parser
  (`mayor-excel`). Va en la base y no en disco porque el filesystem de Railway es efímero.

Detalles operativos:
- Es **admin-only**: si cada área pudiera pisarlo, dos personas podrían mirar reportes armados sobre
  exports distintos del mismo día.
- La **jornada** es el último día que trae el export (a la noche se sube el que termina hoy). El export
  puede abarcar un rango (13→17) y `libroQueCubre()` lo resuelve.
- Re-subir la misma jornada la **pisa** y el bot avisa que reemplazó (un export incompleto no debe
  sustituir al bueno en silencio).
- **21:00 (hora Argentina)**: si no se cargó el libro del día, el bot les avisa a los admins
  (`src/aviso-libro.js`). Hora configurable con `LIBRO_HORA_UTC` (default `0` UTC = 21:00 ART).
- **Para automatizar la carga** (exportar de Sigma con un robot), la lógica vive fuera del wizard:
  `src/lib/registrar-libro.js`. Se invoca sin Telegram con
  `node src/db/cargar-libro.js "<ruta.xlsx>" [DD/MM/AAAA]`.

## Conciliación diaria (`/cierre`) — control, seguridad y auditoría

Cada día compara la *realidad* (los saldos que carga el tesorero) contra el *libro* (los movimientos de
Sigma), cuenta por cuenta, con `saldo_teórico = saldo_ayer + ingresos − egresos`. La diferencia de un
día suele ser **timing** (algo que en el banco ya pasó pero se asienta 1-3 días después); lo que
importa y alarma es el **acumulado por cuenta** cuando **no se resuelve** en varios cierres. Además
marca los movimientos a **cuentas sensibles** (retiros de socios/gerencia, desvío de caja, reintegros
inter-empresa) y deja un **rastro de auditoría** de cada acción. **Detalle completo (fórmula, niveles,
mapeo cuenta↔libro validado, modelo de datos) en [conciliacion.md](../conciliacion.md).**

## El nivel de abajo de Mercado Pago vive en otra área

El `/cierre` concilia **saldos** y dice *"Mercado Pago no cierra por $X"*. **Cuál** es la venta que no
cierra lo responde **`/mp`**, que aparea los ~100 renglones diarios de la `422101014` uno a uno contra
la liquidación de MP. Ese comando es del área **[Caja Central](caja-central.md)** (es quien lo corre),
no de Tesorería — detalle en [conciliacion-mp.md](../conciliacion-mp.md).

## Acceso

`/flujos` está gated por `requiereArea('tesoreria')` = **admin o rol `tesoreria`** (la misma tabla
`bot.usuarios` / `bot.usuario_area` que todo el resto). No hay allowlist aparte. Para habilitar a
alguien: `/usuarios agregar <id> tesoreria`. El paso donde se recibe el documento **re-chequea** el
rol, por si se lo quitan a mitad de camino (es data financiera).

## El puente Node → Python

El motor del arqueo está en Python; el bot es Node. El comando ([`src/scenes/flujos.js`](../../src/scenes/flujos.js)):

1. Baja el Excel a un directorio temporal.
2. Ejecuta `spawn("python", ["arqueo/runner.py", <ruta>])` con timeout de 3 min.
3. Lee la **última línea de stdout** como JSON — el contrato:
   - `{"ok": true,  "html": "...", "xlsx": "..."}`
   - `{"ok": false, "error": "<mensaje al usuario>"}` (export inválido / sin datos)
4. Manda el HTML por el chat (o el mensaje de error). Ante un crash real, el runner sale ≠ 0 con
   traceback por stderr y el bot responde un error genérico.

`arqueo/runner.py` es **propio del repo** (sí se edita acá): ejecuta el **CLI del motor**
(`python -m masmelos.update_arqueo <excel> --sin-snapshot --json`), que ya emite esa línea JSON — no
importa funciones internas del motor. Ver §6 y §9 de [arquitectura.md](../arquitectura.md).

## El motor (copia vendoreada, read-only)

`arqueo/src/masmelos/` (10 archivos) es una **copia read-only** del motor real, que vive en el repo
`github.com/Renzoca6/masmelos-analytics`. **No se edita acá:** si el motor cambia, se arregla allá y se
re-copia. Detalle y regla en [`arqueo/COPIADO_DE.md`](../../flujos/COPIADO_DE.md).

Para mantener la copia sincronizada hay un script **local** (no corre en Railway):

```bash
bash arqueo/sync.sh check /ruta/a/masmelos-analytics   # ¿hay drift? (no toca nada)
bash arqueo/sync.sh sync  /ruta/a/masmelos-analytics   # re-copia + estampa el commit
```

## Deploy (Railway)

El motor necesita Python (pandas/numpy/openpyxl), así que el deploy usa un **`Dockerfile`** (en
`promo-bot/`) con Node **y** Python en la misma imagen. En Railway: **Root Directory = `promo-bot`** y
**Builder = Dockerfile**. La primera imagen tarda más (instala pandas). Variables: ninguna nueva
(`PYTHON_BIN` default `python`, que el Dockerfile provee).

## Pendientes

- **Probar el ida-y-vuelta real** por Telegram en Railway (local ya anda: Excel → HTML de ~57 KB en ~8s).
- **Snapshot acumulativo:** hoy corre `sin_snapshot` (no guarda historia). Para acumular haría falta un
  **volumen persistente** de Railway (la FS es efímera) + la **cola de `jobs`** para serializar corridas.
- El bot manda solo el **HTML**; el Excel (Control 1, 7 hojas) se genera pero no se envía — se puede sumar.
