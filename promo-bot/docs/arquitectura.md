# Arquitectura — Bot Más Melos

> Documento de diseño y decisiones. Es la fuente de verdad de "hacia dónde va esto y por qué".
> Última actualización: **2026-07-10**.

---

## 1. Qué es el sistema

Un **bot de Telegram único para toda la empresa**, que funciona como **hub de datos multi-área**.
Cada área (Compras, Ventas, Calidad, Tesorería) ve y usa **solo sus comandos**. El bot recibe
datos por varias vías, los procesa (con scripts) y devuelve **reportes digeridos** (Excel/HTML)
por el mismo chat.

Hoy arranca cubriendo **Compras** (promociones por vencimiento, lo que ya existe) y **Tesorería**
(flujo del dinero). Las demás áreas se enchufan después, sin rehacer nada.

---

## 2. De dónde venimos

El bot nació como **bot de promociones por vencimiento** en Node/telegraf, con datos en **Google
Sheets** y **sin control de acceso** (cualquiera podía usarlo). Una revisión inicial encontró varios
bugs: tasa de descarte inflada, reporte por proveedor case-sensitive, wizards que se colgaban con
inputs no-texto.

De ahí arrancó la migración por fases (§12). **Hoy** el bot ya no usa Sheets, tiene control de acceso
y Compras corre en Postgres con esos bugs corregidos. El estado actualizado está en §12.

---

## 3. Decisiones tomadas (y por qué)

| # | Decisión | Por qué |
|---|----------|---------|
| D1 | **El bot se queda en Node.js** (no se reescribe a Python) | Funciona y es lo que se mantiene hoy. Reescribir no elimina ningún puente real. |
| D2 | **Los scripts pesados van en Python**, llamados por el bot | Ya existe el script de arqueo en Python (pandas/openpyxl). El bot Node lo ejecuta por debajo. |
| D3 | **Base de datos: Supabase (Postgres)**, **compartida con la landing** pero en un **schema `bot` propio** (no expuesto en la API) | No quedaban proyectos gratis. El schema `bot` aísla los datos del bot: la `anon key` pública de la web no lo puede ver. La landing queda en `public`. Bonus: como la landing está siempre activa, el proyecto no se pausa por inactividad. |
| D4 | **Salida = archivo por el chat** (Excel/HTML) | Cero infraestructura extra. La web de reportes queda como opción futura. |
| D5 | **Hosting: Railway**, sin PC en la oficina (por ahora) | Las fuentes de datos actuales (Excel subido + futuro BigQuery) se alcanzan desde la nube. |
| D6 | **Identidad de usuario = `telegram_id`** | Estable (el username cambia). Allowlist = fila activa en `usuarios`. |
| D7 | **Cola de trabajos (`jobs`) sí**, pero se usa recién cuando haga falta | Serializa corridas (protege el snapshot del arqueo) y habilita el worker on-prem del futuro. |
| D8 | **Google Sheets retirado** ✅ | Compras ya corre 100% en Postgres. Se borró `sheets.js` y la dependencia `googleapis`. Para "ver los datos" queda el editor de tablas de Supabase. |
| D9 | **El "rol" de una persona = las áreas a las que pertenece** (N:N en `usuario_area`) | YAGNI: no hace falta una tabla de roles aparte. Hoy hay 3 áreas reales (Compras, Calidad, Tesorería) y una persona puede tener varias. Los admins ven todo. |
| D10 | **Mantenimiento técnico: Renzo** | Stack elegido a conciencia para que lo sostenga 1 persona técnica. |
| D11 | **Maestro de artículos en la base** ✅ | `/actartic` (admin) sube el Excel de Sigma a `bot.articulos`; `/alta` lo consulta por EAN/código/nombre, para no cargar todo a mano. |

**Diferido a futuro (documentado, no construido):** conexión a **BigQuery**, **scraping de la app de
escritorio (Sigma)**, y **web de reportes**. Cada uno se suma como una pata nueva sin romper lo anterior.

---

## 4. Stack

- **Bot:** Node.js 20 + telegraf v4 (CommonJS).
- **Base:** Supabase / PostgreSQL, accedido con `pg` (node-postgres) y SQL directo (sin ORM pesado).
- **Scripts:** Python 3.11 (pandas, openpyxl, …) ejecutados como proceso aparte desde el bot.
- **Hosting:** Railway, imagen con **Node + Python juntos** (Dockerfile con ambos runtimes).
- **Cola:** tabla `jobs` en el mismo Postgres (nada de Redis).

---

## 5. Fuentes de datos

El bot es un hub: los datos entran por tres vías (dos futuras).

1. 📤 **Excel subido por el usuario** — *camino principal, ya implementado.*
   El **maestro de artículos** se sube con `/actartic` (Excel de Sigma → `bot.articulos`).
   El export del arqueo seguirá el mismo patrón (Fase 3).
2. 🔷 **BigQuery** — *futuro.* Parte de los datos ya viven ahí; se consultarán en modo lectura.
3. 🖥️ **Scraping de la app de escritorio (Sigma)** — *futuro / worst case.*
   Requiere worker on-prem + cola de jobs. Mientras tanto, el dato entra como Excel a mano (vía 1).

---

## 6. `/flujos` — el flujo del dinero (Tesorería) ✅

**El sistema (Sigma) es una app de escritorio offline.** El bot no puede sacar el dato solo:
un humano exporta de Sigma el reporte *"Diario de movimientos contables"* y le manda el `.xlsx`
al bot, en el área Tesorería. Detalle operativo en [areas/tesoreria.md](areas/tesoreria.md).

```
Humano exporta "Diario de movimientos" de Sigma
        │  /flujos → manda el .xlsx   (requiereArea('tesoreria') = admin o rol tesorería)
        ▼
Bot Node (src/scenes/flujos.js): baja el archivo a un temp
        ▼
spawn("python", ["arqueo/runner.py", ruta])          ← puente Node→Python (§9)
        ▼
Motor Python (masmelos, copia read-only): genera flujo_<desde>_<hasta>.html (+ el xlsx)
        ▼
runner.py imprime una línea JSON: {"ok":true,"html":"...","xlsx":"..."}
        ▼
Bot: lee el HTML y lo manda por el chat (o, si el export es inválido, el mensaje de error)
```

**Contrato Node↔motor** ✅ — el bot (`arqueo/runner.py`) ejecuta el **CLI del motor**
(`python -m masmelos.update_arqueo <excel> --sin-snapshot --json`), que imprime una **línea final
JSON** con las rutas (`{"ok":true,"html":"...","xlsx":"..."}`) o `{"ok":false,"error":"<mensaje al
usuario>"}` para errores esperables (export inválido). El Node lee la última línea de stdout; ante un
crash real, sale ≠ 0 con traceback por stderr. El bot **no depende de funciones internas del motor**
(solo del contrato `--json` del CLI), así los refactors del motor no lo rompen.

### Snapshot / estado persistente (diferido)

El motor **puede** acumular estado (snapshot `diario_contable.parquet` + logs), y **Railway borra el
disco en cada redeploy**. El MVP lo esquiva corriendo con **`sin_snapshot=True`**: cada arqueo procesa
solo el Excel que se manda, sin acumular; el HTML se manda y se descarta. Cuando el arqueo necesite
historia acumulativa: **volumen persistente de Railway** (montado en `arqueo/data` y `arqueo/reports`)
o mover el snapshot a Postgres. La **cola de `jobs`** (D7) serializaría las corridas para no pisar el
snapshot — innecesaria mientras sea `sin_snapshot`.

---

## 7. Modelo de datos

Las tablas del bot viven en el schema **`bot`** (separado de `public`, que es de la landing). El
schema `bot` **no** está en la lista de "Exposed schemas" de Supabase → la API pública / `anon key`
de la web no lo ve. El bot se conecta por **conexión directa de Postgres** (`pg` + connection string),
que sí llega a `bot`. **No** usamos la API REST / `supabase-js` para el bot (eso reexpondría el schema).

**Implementado (migraciones 001–010):**

```
-- 001 acceso
bot.areas          (id, codigo, nombre, activa, creado_en)
bot.usuarios       (id, telegram_id, nombre, activo, es_admin, creado_en, actualizado_en)
bot.usuario_area   (usuario_id, area_id, creado_en)      -- N:N, sin rol todavía
-- 002 maestro de artículos
bot.articulos      (codigo PK, nombre, ean_unidad, ean_display, ean_bulto,
                    rubro_cod, rubro, proveedor_cod, proveedor, actualizado_en)
-- 003+006 compras (promociones por vencimiento) — UNA fila = una "camada" en oferta.
-- La baja vive en la misma fila (relación 1:1): fecha_baja IS NULL = sigue en góndola.
bot.compras_altas  (id, fecha, usuario_id, articulo_codigo, ean, producto, proveedor,
                    lote, vencimiento, cantidad, motivo,
                    fecha_baja, cantidad_vendida, cantidad_remanente, motivo_baja,
                    aviso_vencimiento_fecha, aviso_vencido)   -- 005: avisos de vencimiento
-- 008–010 tesorería: conciliación diaria (saldos vs libro). Ver conciliacion.md.
bot.tesoreria_saldos        (fecha, empresa, cuenta, moneda, monto, cargado_por)        -- realidad (aplicada)
bot.tesoreria_movimientos   (fecha, empresa, cuenta_id, cuenta, debe, haber,           -- libro crudo (009, sin aplicar)
                             debe_nominal, haber_nominal, cargado_por)
bot.tesoreria_conciliacion  (fecha, empresa, cuenta, moneda, saldo_ayer, ingresos,     -- cruce (010, sin aplicar)
                             egresos, saldo_teorico, saldo_real, diferencia, generado_por)
```

**Futuro (se define cuando toque cada fase):**

```
jobs           -- la cola: (id, tipo, area_id, solicitante, params, estado, resultado, ...)
ventas_* / calidad_*   -- NO se crean hasta tener un comando real
```

---

## 8. Multi-área y permisos

Un proceso, un `BOT_TOKEN`, ruteo interno. **Solo se chequea pertenencia a área** (sin roles finos).

- **Middleware de identidad** (corre antes de todo): busca el `telegram_id` en `usuarios`.
  Si no existe o está inactivo → *"No tenés acceso, pedile el alta al admin"* y corta.
- **Autorización por comando:** cada comando declara su área (`requiereArea('calidad')`).
  Áreas y sus comandos hoy:
  - **Calidad:** `/alta` (poner un producto en oferta por vencimiento), `/baja` (retirarlo), `/control` (Excel de lo que está en oferta por vencimiento).
  - **Compras:** `/reporte` (por proveedor, buscado por código de proveedor; histórico o por lapso de tiempo).
  - **Tesorería:** `/flujos` (recibe el Excel de Sigma y devuelve el HTML del flujo del dinero — corre el motor Python, ver §6 y [areas/tesoreria.md](areas/tesoreria.md)) y `/cierre` (cierre diario: carga los saldos del día; la conciliación saldos-vs-libro está en curso, ver [conciliacion.md](conciliacion.md)).
- **Menú dinámico:** cada usuario ve **solo los comandos de sus áreas**.
- **Comandos de admin:** `/usuarios` (dar de alta gente, asignar áreas/roles, hacer admin), `/actartic` (subir el maestro de artículos) y `/avisos` (disparar a mano el chequeo de vencimientos).
- **Avisos proactivos:** un scheduler diario avisa a Calidad de lo que vence mañana/hoy y al creador + admins de lo ya vencido (ver §14).
- **Registro por carpeta:** agregar un área = agregar una carpeta en `src/areas/`, sin tocar el núcleo.

---

## 9. Ejecución de scripts Python (el puente Node → Python) ✅

Implementado para el `/flujos` (`src/scenes/flujos.js` + `arqueo/runner.py`):

- El bot lanza el script como proceso aparte (`child_process.spawn`), con **timeout** (3 min) y captura de `stdout`.
- Le pasa el input por argumento (la ruta del Excel descargado a un temp).
- El script escribe su salida en archivos y **cierra con una línea JSON** con las rutas (ver §6).
- El bot lee esa línea, agarra el HTML y lo manda; si el script sale con código ≠ 0 o no hay JSON, avisa un error genérico.
- En Railway, Node y Python conviven en la misma imagen (**`Dockerfile`** con ambos runtimes) con `pip install -r arqueo/requirements.txt`.
- El motor Python vive **vendoreado** en `arqueo/src/masmelos/` (copia read-only de `masmelos-analytics`, ver [areas/tesoreria.md](areas/tesoreria.md) y `arqueo/COPIADO_DE.md`).

---

## 10. Hosting

- **Railway** corre el bot Node + los scripts Python en una sola imagen.
- **Volumen persistente** para el estado del arqueo (§6).
- Variables sensibles (connection string de Postgres, `service_role key`, `BOT_TOKEN`) en las
  **Variables de Railway** y en `.env` local — **nunca** commiteadas (`.env` está en `.gitignore`).
- **Futuro (solo si se activa el scraping de Sigma):** un **worker on-prem** en una PC/VM de la
  oficina que hace *polling* de la tabla `jobs` (solo conexión **saliente**, sin abrir puertos),
  corre el scraping por la LAN y sube el resultado. El bot sigue en Railway.

---

## 11. Cola de trabajos (`jobs`) — qué es y cuándo se usa

Una tabla que es una **lista de tareas pendientes**. En vez de hacer el trabajo pesado en el momento,
el bot anota el pedido y responde *"lo preparo y te aviso"*; un **worker** toma el pendiente, lo
resuelve, guarda el resultado y lo marca listo. Sirve para: (a) no colgar el bot, (b) reintentar sin
perder el pedido, (c) que el worker pueda correr en **otra máquina** (la PC de la oficina, en el futuro).

- **Hoy:** subir Excel y consultar BigQuery son de segundos → se pueden hacer **sincrónicos**.
- **La cola se justifica** para el arqueo (serializa corridas por el snapshot) y para el scraping on-prem futuro.

---

## 12. Plan por fases

Cada fase deja el bot andando. Sin big-bang. La secuencia prioriza:
**cerrar el agujero de seguridad → migrar datos → sumar features**.

- **Fase 0 — Andamiaje.** ✅ Reordenar carpetas, crear el proyecto Supabase, esqueleto de `docs/`.
- **Fase 1 — Control de acceso + áreas.** ✅ Tablas `usuarios`/`areas`/`usuario_area`, middleware de
  identidad y autorización, comando `/usuarios` (con admin), admin sembrado. El bot dejó de estar abierto.
- **Maestro de artículos.** ✅ Tabla `bot.articulos`, comandos `/actartic` (subir Excel de Sigma) y `/buscar`.
- **Fase 2 — Migrar Compras a Postgres.** ✅ Tabla `compras_altas` (la baja vive en la misma fila desde la
  migración 006, ver §7), wizards reescritos, bugs de la revisión corregidos, Google Sheets eliminado.
  `/alta` busca en el maestro de artículos.
- **Área Calidad.** ✅ `/alta`, `/baja`, `/control` + avisos de vencimiento (§14). Revisada y endurecida
  (validación de fecha, anti doble-tap, avisos con reintento y recuperación) el 2026-07-10.
- **Fase 3 — `/flujos` real.** ✅ (MVP) `/flujos` en Tesorería recibe el Excel de Sigma, corre el motor
  Python (`arqueo/runner.py` → contrato JSON) y devuelve el HTML del flujo. Gated por `requiereArea('tesoreria')`.
  Deploy: `Dockerfile` con Node+Python. Corre **sincrónico y `sin_snapshot`** (sin cola ni volumen todavía).
  El motor vive en `arqueo/src/masmelos/` como copia read-only de `masmelos-analytics` (ver `arqueo/COPIADO_DE.md`).
  *Pendiente:* cola de `jobs` + volumen persistente para el snapshot acumulativo (§6), si el arqueo escala.
- **Fase 4 — Áreas nuevas.** Ventas cuando tenga proceso definido; rol "comprador" con reporte general.
- **Fase 5 — Fuentes futuras.** BigQuery (lectura) y, si hace falta, el worker on-prem para Sigma.
- **Fase 6 — Endurecer.** Heartbeat/alertas del worker, backups verificados, session store persistente si escala.

---

## 13. Decisiones pendientes

- **Ofertas de la landing vs. promociones del bot: son datos DISTINTOS** (resuelto).
  La landing (schema `public`) tiene contenido de marketing (`promociones`, `banners`,
  `productos_seleccion`…: título, imagen, orden). El bot maneja lo operativo (SKU, proveedor, vencimiento).
  **Oportunidad futura:** como comparten base, el bot podría **publicar** un producto en promoción a la
  web (insertar en `public.banners` / `public.promociones`) cuando se pasa a góndola. Se evalúa más adelante.
- **Detalle de las tablas de dominio** (compras, tesorería): se define en cada fase.
- **BigQuery:** qué datos viven ahí y cómo se dividen con lo que se sube por Excel (a definir cuando se encare la Fase 5).

---

## 14. Avisos de vencimiento (Calidad)

Un **scheduler diario** (`src/avisos.js`) corre a las **9:00 hora Argentina** (`AVISO_HORA_UTC=12`,
setTimeout auto-reprogramado) y avisa por mensaje directo:

- **Vence mañana / vence hoy** → a todos los del área **Calidad** (para que lo saquen a tiempo).
- **Ya vencido** (una sola vez) → al **creador del alta** + todos los **admins**.

Detalles de robustez (revisión 2026-07-10):

- **Fecha argentina, no UTC.** La categorización (mañana/hoy/vencido) y el flag de dedup usan el
  calendario de Argentina, no el `current_date` del server (que en Railway es UTC y de noche ya es "mañana").
- **Solo se marca lo entregado.** Si el envío a Telegram falla (usuario bloqueó al bot, corte), el aviso
  **no** se marca como hecho y se reintenta en la próxima corrida. Antes se marcaba aunque nadie lo recibiera.
- **Mensajes largos partidos.** Muchos vencidos juntos se parten en varios mensajes para no chocar con el
  tope de 4096 caracteres de Telegram.
- **Recuperación al iniciar.** Si el bot estaba caído a las 9:00 (deploy, crash), al levantarse corre el
  chequeo pendiente. Es idempotente (los flags de dedup evitan reenvíos).
- **Solo usuarios activos.** Un ex-empleado desactivado deja de recibir el detalle del stock.

Flags en `bot.compras_altas` (migración 005): `aviso_vencimiento_fecha` (date, por-vencer, se re-evalúa
cada día) y `aviso_vencido` (boolean, una sola vez). Se puede disparar a mano con `/avisos` (admin).
