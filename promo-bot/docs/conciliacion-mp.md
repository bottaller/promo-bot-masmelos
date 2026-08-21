# Arqueo de cobros — operación por operación (MP + Talo)

> El control fino de las plataformas de cobro: aparea **cada cobranza del sistema con su cobro en la
> plataforma** (Mercado Pago, Talo) y marca las que no cierran. **Es automático** (barrido de las
> 08:00), no un comando; el resultado le llega a **Tesorería + Caja Central**
> ([areas/caja-central.md](areas/caja-central.md)). Documento vivo. Última actualización: **2026-07-25**.

## 1. Qué resuelve (y por qué no alcanza con `/cierre`)

[`conciliacion.md`](conciliacion.md) concilia **saldos**: dice *"Mercado Pago no cierra por $1,7M"*.
Es el control de arriba y sirve para saber **que** hay un problema, pero no **cuál**: la cuenta cierra
o no cierra como un bloque.

El arqueo de cobros es el nivel de abajo: agarra los ~100 renglones diarios de la cuenta de cada
plataforma y los aparea uno a uno contra la liquidación que ésta emite. Responde la pregunta que
`/cierre` no puede: **qué venta puntual falta**. Los dos se complementan y son independientes: el
arqueo no toca la base de los cierres.

> **Antes era un comando (`/mp`) y ahora es automático.** Hasta el 17/07/2026 el control se corría a
> mano con `/mp`, que pedía los dos archivos en el chat. El núcleo del cálculo se extrajo a
> `src/lib/arqueo.js` (`arquearDia`, puro y sin Telegram) y hoy lo dispara el **barrido de las 08:00**
> (`src/entrega-arqueo.js`) sobre las liquidaciones que el admin sube de noche con `/carga`. La
> **lógica de apareo, alcance y rastreo de este documento sigue valiendo igual**: solo cambió cuándo y
> quién la corre, y que ahora arquea **varias plataformas** (MP y Talo) en la misma pasada. Ver §7.

Lo que caza:

| | Qué es | Nivel |
|---|---|:--:|
| **Cobró MP y no está asentado** | Entró plata y nadie la registró. Es el agujero que importa. | 🔴 |
| **Asentado y MP no lo tiene** | Un asiento de más, o un importe tipeado mal (aparece de los dos lados con importes distintos). | 🔴 |
| **Diferencia de centavos** | Sigma redondea distinto que MP. Aparea igual, se avisa. | 🟡 |
| **La hora no coincide** | El importe coincide pero el asiento se cargó a más de 30 min del cobro. | 🟡 |

## 2. El alcance: solo QR / transferencia  [validado]

**La cuenta `422101014` (MERCADO PAGO MORENO) recibe EXACTAMENTE las operaciones que la liquidación
marca con `SUB UNIT = 'QR Code'`.**

Ese canal ya contiene los dos medios que pide el negocio: **todas** las operaciones por transferencia
entran escaneando el QR, así que *"QR o transferencia"* == canal QR. Adentro conviven cuatro
**instrumentos** (dinero en cuenta, transferencia, crédito y débito): **manda el canal, no el
instrumento** — un crédito cobrado por QR **sí** entra.

**Cómo se validó** (día 16/07/2026, datos reales): filtrando por canal QR salen **108 operaciones**
contra los **108 asientos** del Mayor, y los totales dan **$32.334.504,52** (sistema) vs
**$32.334.504,56** (MP) — 4 centavos de diferencia, repartidos en 3 asientos donde Sigma redondeó
distinto. Las tasas efectivas por instrumento confirman el tarifario (0,97% dinero en cuenta y
transferencia, 1,63% débito, 7,25% crédito por QR).

**Lo que queda afuera** (se lista con el motivo, nunca se descarta en silencio):

- **Point** (terminal física): liquida en las cuentas de **tarjetas** (`111301002` y cía., ver el
  mapeo de [conciliacion.md](conciliacion.md) §10), no en esta cuenta. El 16/07: 14 ops, $3.486.856.
- **Mercado Libre**: importe negativo y se libera un mes después. No es una venta por QR.
- **Filas sin unidad de negocio ni medio de pago**: el 16/07 apareció una de **$324.915,32 a las
  06:16**, sin comisión. **Sin identificar — hay que preguntarle a MP qué es.**
- **Los `Haber` de la cuenta** (sale plata de MP al banco): no son cobranzas. Si no se excluyeran,
  cada transferencia a Santander sería un 🔴 falso.

## 3. Los dos archivos

| | Archivo | De dónde sale |
|---|---|---|
| **Sistema** | *"Diario de movimientos contables"* **o** *"Mayor de cuenta"* de la cuenta de la plataforma | Export de Sigma |
| **MP** | reporte de **Cobros** (`collection-….xlsx`) **o** `settlement_v2-….xlsx` | Panel de Mercado Pago |
| **Talo** | `Movimientos_<desde>_<hasta>.xlsx` | Panel de Talo |

El lado **Sistema es el libro diario** que el admin ya sube de noche con `/carga`, así que en el flujo
automático no hay que exportar nada nuevo. `mayor-excel.js` acepta tanto el Diario como el Mayor y los
distingue por su fila de encabezados (`Mov.` vs `Cuenta`); el barrido siempre usa el **Diario** (el
libro), que además —al traer todas las cuentas— habilita el rastreo del contramovimiento (§5).

### MP: dos formatos de liquidación

El parser de MP (`src/lib/plataformas.js` `parsearMp`, un dispatcher) acepta **dos formatos** y los
distingue por sus encabezados; los dos producen **exactamente el mismo shape de operación**, así que
el motor de conciliación no cambia:

- **Cobros / "Collection"** (`src/lib/collection-excel.js`) — el que se usa hoy. Está disponible **el
  mismo día**, así que a la noche ya está para el arqueo de las 08:00. Su fecha (`date_created`) **ya
  viene en hora argentina** (verificado cruzando el 23/07 contra Sigma: coinciden al segundo), así que
  **no** pasa por la conversión de huso.
- **settlement_v2** (`src/lib/liquidacion-excel.js`) — el que se usaba antes. Se genera **a día
  vencido**, así que no está a la noche; queda como **respaldo**. Sus fechas venían en **UTC-4** y hay
  que sumarles 1 h (`isoAHoraArg()`, ver §4).

> El mapeo del vocabulario nuevo al viejo lo hace el parser de Cobros: `sub_unit 'QR' → canal 'QR
> Code'`, y **`status 'approved'` + un `operation_type` de cobro (`regular_payment`/`pos_payment`)
> → tipo 'Approved payment'** — una devolución/chargeback aprobada NO es cobro y queda afuera (ver el
> punto sobre "salidas de dinero" más abajo). Así el alcance de §2 (la cuenta `422101014` recibe solo
> el canal QR; Point va a tarjetas) vale sin tocar nada.

> ⭐ **Conviene el Diario.** Como trae **todas** las cuentas, habilita el **rastreo del
> contramovimiento** (§5): si algo no cierra, el bot puede decir *en qué otra cuenta quedó
> imputado*. Con el Mayor (una sola cuenta) eso es imposible y el bot lo avisa.

> ⚠️ **No se reusa `parsearLibro()`** (`libro-excel.js`): ese **agrega** por `(fecha, cuenta_id, ingreso)`
> sumando Debe/Haber, y eso rompe el apareo. Un mismo recibo puede tener **dos cobros de MP en el mismo
> segundo** (caso real del 16/07: `REC8 00002698` = $100.000 + $111.393,93, dos pagos distintos en la
> liquidación); si se suman, queda 1 renglón contra 2 operaciones y las dos caen como huérfanas.
> `mayor-excel.js` conserva cada renglón tal cual.

Los dos archivos tienen que ser **del mismo día**: si no se pisan, el bot los rechaza antes de
conciliar (si no, los días que están en uno y no en el otro caen como diferencias y tapan lo real).

## 4. Cómo aparea

Clave = **importe + hora**, con un greedy sobre los pares candidatos ordenados por
*(importe exacto primero → menor diferencia → menor distancia de hora)*.

- **Tolerancia de importe: `$0,05`.** Sigma redondea distinto en algunos asientos (3 de 108 el 16/07,
  siempre ≤ 4 centavos). Por encima **no aparea**: quedan los dos huérfanos, que es justo lo que hay
  que mirar (un importe tipeado mal aparece de los dos lados, a un minuto de distancia).
- **La hora desempata.** Con importes casi únicos el apareo sale solo; la hora resuelve los repetidos
  (el 16/07 hubo **dos ventas de $380** de cajas distintas) y evita aparear entre días.
- **Ventana máxima: 12 h.** El asiento se carga **después** del pago — el 16/07, entre **5 y 210
  segundos** (mediana 16). 12 h es holgadísimo para el día de trabajo y sirve de red.

### ⏰ El huso horario (la trampa) — solo el settlement

**El settlement de MP viene en UTC-4 y Sigma escribe la hora local argentina (UTC-3).** Sin convertir,
el match por hora se corre **60 minutos**. Se normaliza todo a hora de pared argentina con
`isoAHoraArg()` ([`fechas.js`](../src/lib/fechas.js)), que lee el offset del propio texto (no lo asume)
y hace la aritmética sobre `Date.UTC`/`getUTC*` → independiente del TZ del proceso (Railway = UTC).
Es la misma disciplina de "reloj de pared" del corte por hora del `/cierre`.

> El reporte de **Cobros (collection)** —el que se usa hoy— **ya trae la hora argentina**, así que su
> parser no aplica esta conversión (§3). La trampa del UTC-4 vale solo para el settlement de respaldo.
> Talo también trae su hora local.

## 5. Rastreo del contramovimiento: *dónde* quedó la plata  [validado con un caso real]

Que MP haya cobrado algo que no está asentado **no significa que falte la plata**: casi siempre está,
pero **imputada a otra cuenta**. Por eso, cuando se manda el **Diario** (todas las cuentas), por cada
huérfana el bot busca ese importe en el resto del libro y devuelve el **asiento completo**.

**El caso que lo motivó (11/07/2026, datos reales):**

| | |
|---|---|
| MP cobró (transferencia, 14:15) | **$152.577,45** — sin asentar en la cuenta MP |
| CAJA 4 MORENO (17:21) | **$152.577,45** al Haber — *"faltante caja 4 camila 11-7"* |
| Contrapartida | **DESVIO DE CAJA** (asiento 8299656, cargó LATERZAFLOR) |

Un cliente pagó por transferencia con QR, el cobro no se asentó como MP, y al cerrar **la caja 4 dio
ese faltante exacto**, que se registró como desvío. **No faltaba la plata: estaba en Mercado Pago.**
Sin el rastreo, el bot decía "faltan $152.577,45" y el faltante de caja quedaba como pérdida; con el
rastreo, dice dónde está y el diagnóstico sale solo:

```
🔴 Cobró MP y no está asentado — 1 · $152.577
• 14:15 · $152.577 · transferencia · id 167476058875
   ↳ aparece en: CAJA 4 MORENO → DESVIO DE CAJA · "faltante caja 4 camila 11-7" · 17:21 · LATERZAFLOR
```

**Cómo funciona y sus límites** (`conciliacion-mp.js::buscarContrapartidas`):

- Busca el importe (misma tolerancia de $0,05) en cualquier cuenta que **no** sea la de MP, en Debe o
  en Haber, **sin ventana horaria** (el ajuste de caja se carga al cierre, horas después del cobro).
- Agrupa por **asiento** y devuelve **todos** sus renglones, así se ve la partida doble entera. En el
  mensaje se ordena **Haber → Debe**: de dónde salió la plata y adónde fue.
- Es una **pista, no un veredicto**: dos movimientos del mismo importe pueden ser casualidad (con
  $152.577,45 es impensado; con un monto redondo tipo $100.000, no). Por eso se muestran cuenta,
  concepto, hora y usuario — para que lo juzgue una persona.
- Máximo **3 asientos** por huérfana (`MAX_CONTRAPARTIDAS`): si el importe pega en más, es poco
  distintivo y la pista no sirve.
- Con el **Mayor** no hay dónde buscar → el bot sugiere mandar el Diario.

## 6. La salida: un texto + un PDF por plataforma

**No devuelve el Excel de detalle** (decisión de Caja Central, jul-2026). El barrido de las 08:00 arma
y manda, a Tesorería + Caja Central (`src/entrega-arqueo.js` + `src/lib/arqueo.js`):

**1) Un texto de Telegram** — la vista rápida de todas las plataformas del día: primero lo que está
mal, después lo sano (mismo criterio que `reporte-cierre.js`; lo arma `src/lib/reporte-mp.js`
`formatearArqueo`). Los avisos que antes salían como mensajes sueltos (export multi-día recortado,
rangos que no se pisan del todo, libro cargado antes de terminar los cobros) se **pliegan dentro del
texto**: en un barrido automático no hay con quién chatear.

- Los 🔴 (sin aparear) se listan; las listas se cortan a **8 ítems** (el tope de Telegram son 4096
  caracteres) y se dice cuántos más hubo. El titular ya trae el total, y el dato crudo está en la
  liquidación que se subió. ⚠️ En un día con **más de 8** de un mismo tipo, el detalle del resto no se
  ve en el chat (ya no hay Excel de respaldo) — si eso pasara seguido, conviene partir el mensaje en
  varios (como `avisos.js`) o subir el corte.
- Las **diferencias de redondeo** se resumen en una línea (total), no una por una.
- Las **salidas de dinero** (Mercado Libre, devoluciones, chargebacks, Haber del sistema) **no se
  muestran**: no son ventas por QR. En el **settlement** se filtran por **signo** (importe < 0); en el
  reporte de **Cobros** el importe es el "Valor del producto" (positivo también en una devolución), así
  que ahí el filtro es por **`operation_type`** (solo `regular_payment`/`pos_payment` cuentan como
  cobro). Del lado del sistema se filtran por ser Haber.
- Muestra además **qué acredita cada plataforma**: bruto − comisión − impuestos = neto (el sistema
  asienta el bruto, la plataforma deposita el neto; la brecha del 16/07 en MP fue $646.151, que se
  registra con la factura mensual).

**2) Un PDF por plataforma** (`arqueo_<MP|Talo>_<AAAA-MM-DD>.pdf`) — el **comprobante** para
archivar/imprimir, **MP y Talo en archivos separados**. Cada uno es una hoja con el **veredicto** bien
arriba, en color: **CONTROL OK** (verde) si aparea todo, o **CONTROL CON DIFERENCIAS** (rojo) si hay
algo sin aparear. Lleva el **día conciliado** y el sello de **fecha + hora**, un resumen (apareadas /
sin aparear / totales) y, si hay diferencias, la lista de lo que no cierra. Lo arma
`src/lib/informe-mp-pdf.js` con **pdfkit** (fuentes estándar, sin emoji → el veredicto va por color).
El veredicto (`veredictoMP()`) es una función pura y testeada: **bien = 0 sin aparear** (las
diferencias de redondeo son avisos, no lo tumban). Si un PDF fallara, el control ya se comunicó por el
texto y el bot sigue (no se cae).

El resultado de cada plataforma se guarda en `bot.mp_conciliacion` (una fila por día y plataforma,
migración **018** + **021**) → lo consume el **resumen semanal** de los lunes.

## 7. Cómo se dispara (automático) y quién lo recibe

**Ya no es un comando.** El flujo completo:

1. **De noche — `/carga` (admin, Tesorería).** El admin sube el libro del día y la liquidación de
   MP; el bot reconoce cada archivo solo. **Talo la baja sola el barrido de las 21:00** (no se sube
   a mano, salvo fallback si la API falló). Las liquidaciones quedan en
   `bot.liquidaciones_pendientes` (migración **022**). Ver [areas/tesoreria.md](areas/tesoreria.md).
2. **21:30 ART (`src/aviso-libro.js`).** Si falta el libro o alguna liquidación, se reclama a los admins.
3. **08:00 ART (`src/entrega-arqueo.js`).** El barrido cruza cada día pendiente contra su libro, arma
   el texto + los PDFs, y los manda a **Tesorería + Caja Central** (`telegramIdsPorRol`). Guarda el
   resultado, borra las liquidaciones procesadas, y —si falta el libro— no arquea y avisa a los admins.
   Es idempotente: lo entregado se borra de la espera, el resultado guardado se pisa al re-correr.

El rol **Caja Central** (`cajacentral`, migración **014**) es el canal de aviso, no de Tesorería. Se
asigna con `/usuarios agregar <telegram_id> cajacentral`. Detalle del rol en
[areas/caja-central.md](areas/caja-central.md).

## 8. Archivos

```
src/scenes/carga.js          el wizard /carga: recibe el libro + las liquidaciones y las guarda
src/entrega-arqueo.js        el barrido de las 08:00: cruza, entrega a los grupos, persiste, limpia
src/lib/arqueo.js            núcleo arquearDia(): arquea un día completo — PURO (sin Telegram/DB)
src/db/liquidaciones-pendientes.js  la lista de espera (bytea de cada liquidación)
src/lib/plataformas.js       las plataformas (MP, Talo): cuenta, parser, alcance, detección por encabezados
src/lib/mayor-excel.js       parser del libro de Sigma (Diario o Mayor), renglón por renglón
src/lib/collection-excel.js  parser del reporte de Cobros (collection) de MP — hora ARG, mismo shape
src/lib/liquidacion-excel.js parser del settlement de MP (columnas por NOMBRE, importes US, UTC-4)
src/lib/talo-excel.js        parser de los Movimientos de Talo
src/lib/conciliacion-mp.js   el motor: alcance + apareo + resumen  (puro, sin I/O)
src/lib/reporte-mp.js        arma el texto del arqueo
src/lib/informe-mp-pdf.js    arma el PDF por plataforma (veredicto + fecha/hora) con pdfkit
db/migrations/018_mp_conciliacion.sql   resultado del arqueo (+ 021: columna plataforma)
db/migrations/022_liquidaciones_pendientes.sql   la lista de espera
test/arqueo.test.js          el flujo de arqueo de un día (arquearDia)
test/collection.test.js      el parser del reporte de Cobros de MP
test/tesoreria-mp.test.js    el motor de conciliación (alcance/apareo/rastreo)
```

## 9. Estado

**✅ Hecho (en `dev`):** todo lo de arriba. El motor se validó contra los archivos reales del
16/07/2026 (108 ↔ 108, 0 huérfanas) y contra errores **inyectados** sobre esos mismos datos (venta sin
asentar, asiento fantasma, importe tipeado mal, salida al banco): los caza a los cuatro. El flujo del
arqueo automático y el parser de Cobros se cubren en `test/arqueo.test.js` y `test/collection.test.js`.

**⚠️ Para que ande hay que correr las migraciones 014, 018/021 y 022** en Supabase: la **014** siembra
el rol `cajacentral` (si no, `/usuarios agregar … cajacentral` responde `area_inexistente`), la
**018 + 021** crean `bot.mp_conciliacion` con su columna `plataforma`, y la **022**
`bot.liquidaciones_pendientes` (la lista de espera del arqueo).

**⬜ Pendiente:**
- **Probar el ida y vuelta real por Telegram** (subir con `/carga` y esperar la corrida de las 08:00).
- Preguntar a MP **qué es la fila sin unidad** de las 06:16 (§2).
- **Point**: hoy se lista pero no se concilia. Se podría aparear contra las cuentas de tarjetas, pero
  eso **no está validado** (liquidan con lag y las cuentas son a cobrar) — es un trabajo aparte.
- Sumar más plataformas es agregar una entrada en `src/lib/plataformas.js` + su parser; el motor y el
  barrido no cambian.
