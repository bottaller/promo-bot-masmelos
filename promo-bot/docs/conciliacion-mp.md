# Conciliación de Mercado Pago — operación por operación (`/mp`)

> El control fino de Mercado Pago: aparea **cada cobranza del sistema con su cobro en MP** y marca
> las que no cierran. Es el comando del área **Caja Central** ([areas/caja-central.md](areas/caja-central.md)).
> Documento vivo. Última actualización: **2026-07-17**.

## 1. Qué resuelve (y por qué no alcanza con `/cierre`)

[`conciliacion.md`](conciliacion.md) concilia **saldos**: dice *"Mercado Pago no cierra por $1,7M"*.
Es el control de arriba y sirve para saber **que** hay un problema, pero no **cuál**: la cuenta cierra
o no cierra como un bloque.

`/mp` es el nivel de abajo: agarra los ~100 renglones diarios de la cuenta MP y los aparea uno a uno
contra la liquidación que emite Mercado Pago. Responde la pregunta que `/cierre` no puede:
**qué venta puntual falta**. Los dos se complementan y son independientes: `/mp` no toca la base ni
los cierres.

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
| **Sistema** | *"Diario de movimientos contables"* **o** *"Mayor de cuenta"* de la `422101014` | Export de Sigma |
| **MP** | `settlement_v2-<id>-<fecha>.xlsx` | Panel de Mercado Pago |

Se acepta **cualquiera de los dos exports de Sigma** y se distinguen solo por su fila de encabezados
(`Mov.` vs `Cuenta`). El **Diario es el mismo archivo que ya se sube para `/cierre`**, así que en el
día a día no hay que exportar nada nuevo; el Mayor tiene la ventaja de traer el **comprobante
relacionado** (`REC8 …`), que el Diario no.

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

### ⏰ El huso horario (la trampa)

**La liquidación de MP viene en UTC-4 y Sigma escribe la hora local argentina (UTC-3).** Sin
convertir, el match por hora se corre **60 minutos**. Se normaliza todo a hora de pared argentina con
`isoAHoraArg()` ([`fechas.js`](../src/lib/fechas.js)), que lee el offset del propio texto (no lo asume)
y hace la aritmética sobre `Date.UTC`/`getUTC*` → independiente del TZ del proceso (Railway = UTC).
Es la misma disciplina de "reloj de pared" del corte por hora del `/cierre`.

## 5. La salida

**Solo un mensaje de Telegram** (no devuelve archivo — decisión de Caja Central, jul-2026): primero lo
que está mal, después lo sano (mismo criterio que `reporte-cierre.js`). Es una lectura de un vistazo:

- Los 🔴 (sin aparear) se listan; las listas se cortan a **8 ítems** (el tope de Telegram son 4096
  caracteres) y se dice cuántos más hubo. El titular ya trae el total, y el dato crudo está en la
  liquidación que se subió. ⚠️ En un día con **más de 8** de un mismo tipo, el detalle del resto no se
  ve en el chat (ya no hay Excel de respaldo) — si eso pasara seguido, conviene partir el mensaje en
  varios (como `avisos.js`) o subir el corte.
- Las **diferencias de redondeo** se resumen en una línea (total), no una por una.
- Las **salidas de dinero** (Mercado Libre, devoluciones, Haber del sistema) **no se muestran**: no son
  ventas por QR. Se filtran por signo (importe < 0) y por ser Haber.

El mensaje muestra además **qué acredita MP**: bruto − comisión − impuestos = neto. El sistema asienta
el **bruto** y MP deposita el **neto**; la brecha (el 16/07: $646.151) se registra después con la
factura mensual de MP.

## 6. Quién lo usa

Es el comando del rol **Caja Central** (`cajacentral`, migración **014**) — no de Tesorería. Se asigna
con `/usuarios agregar <telegram_id> cajacentral`. Los **admins** lo ven igual (acceso total). Detalle
del rol en [areas/caja-central.md](areas/caja-central.md).

> **Un comando pertenece a UNA sola área** (D9 de [arquitectura.md](arquitectura.md)): si dos la
> registraran, `bot.command('mp', …)` correría dos veces y el wizard se abriría duplicado. Por eso
> `/mp` **salió** de Tesorería al mudarse acá. Hay un test que lo fija.

## 7. Archivos

```
src/areas/cajacentral/index.js  el área/rol: registra el comando
db/migrations/014_caja_central.sql  siembra el rol en bot.areas
src/scenes/mp.js             el wizard (dice qué recibe, pide los 2 archivos, chequea rangos, responde)
src/lib/mayor-excel.js       parser del export de Sigma (Diario o Mayor), renglón por renglón
src/lib/liquidacion-excel.js parser de la liquidación de MP (columnas por NOMBRE, importes US, UTC-4)
src/lib/conciliacion-mp.js   el motor: alcance + apareo + resumen  (puro, sin I/O)
src/lib/reporte-mp.js        arma el mensaje de Telegram (sin archivo)
src/lib/sigma-celdas.js      primitivos de parseo compartidos con libro-excel.js
test/tesoreria-mp.test.js    42 tests (sin DB ni archivos)
```

## 8. Estado

**✅ Hecho (en `dev`):** todo lo de arriba. Validado contra los archivos reales del 16/07/2026
(108 ↔ 108, 0 huérfanas) y contra errores **inyectados** sobre esos mismos datos (venta sin asentar,
asiento fantasma, importe tipeado mal, salida al banco): los caza a los cuatro. Los 42 tests nuevos y
los 23 que ya existían, en verde.

**⚠️ Para que ande hay que correr la migración 014** en Supabase (si no, el rol no existe y
`/usuarios agregar … cajacentral` responde `area_inexistente`). El menú `/` de Telegram se publica al
arrancar: después de asignar el rol hay que **reiniciar el bot** para que le aparezca el comando.

**⬜ Pendiente:**
- **Probar el ida y vuelta real por Telegram.**
- Preguntar a MP **qué es la fila sin unidad** de las 06:16 (§2).
- **Point**: hoy se lista pero no se concilia. Se podría aparear contra las cuentas de tarjetas, pero
  eso **no está validado** (liquidan con lag y las cuentas son a cobrar) — es un trabajo aparte.
- No persiste nada: los dos archivos son la fuente de verdad y el control se rehace entero cada vez.
  Si se quisiera historia/auditoría (como `/cierre`), habría que sumar tabla + migración.
- Natural: **colgarlo del `/cierre`** — ya recibe el Diario, así que podría correr esto solo y explicar
  el residuo de MP sin pedir un archivo más (solo faltaría la liquidación).
