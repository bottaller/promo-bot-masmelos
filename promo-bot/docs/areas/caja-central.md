# Área Caja Central

> Un doc por área. Este cubre **Caja Central**: el rol y su comando `/mp`.
> Última actualización: **2026-07-17**.

## Qué hace

Caja Central es quien maneja la caja del negocio y controla que **lo que cobró Mercado Pago sea
exactamente lo que quedó asentado en el sistema**, venta por venta. Es un control de plata que entra:
si MP cobró algo que nadie registró, acá salta.

## Comando

| Comando | Qué hace |
|---------|----------|
| `/mp` | Conciliación de **Mercado Pago operación por operación**. Pide **2 archivos del mismo día**: el export de Sigma con los movimientos (el *"Diario de movimientos contables"* — el mismo del `/cierre` — **o** el *"Mayor de cuenta"* de la `422101014`) y la **liquidación de MP** (`settlement_v2-….xlsx` del panel). Aparea cada cobranza con su cobro y devuelve el **reporte en el chat** + un **informe PDF** (el comprobante: control OK/con diferencias, con fecha y hora). **No toca la base.** |

**Flujo de uso:** `/mp` → el bot **dice qué necesita** (los 2 archivos, de dónde salen y el alcance) →
mandás el export de Sigma → el bot te confirma **qué leyó y de qué día**, y te pide la liquidación **de
ese mismo día** → te devuelve el **mensaje** (vista rápida) y el **informe PDF** (`informe_mp_<fecha>.pdf`,
para archivar/imprimir: veredicto en color, día conciliado y fecha+hora del control).

Si los dos archivos no son del mismo día, **los rechaza antes de conciliar**: si no, los días que están
en uno y no en el otro caerían como diferencias y taparían lo real.

**Qué marca:** 🔴 lo que MP cobró y no está asentado (y al revés). Las diferencias de centavos por
**redondeo** se resumen en una línea (no una por una), y los avisos de **hora** (asiento cargado lejos
del cobro) se listan. Point y la fila sin identificar quedan aparte como "fuera de alcance"; las
**salidas de dinero** (Mercado Libre, devoluciones, `Haber`) no se muestran (no son ventas por QR).

**⭐ Mandá el "Diario", no el "Mayor".** Como el Diario trae todas las cuentas, cuando algo no cierra
el bot **rastrea dónde quedó imputado** ese importe. Caso real del 11/07: MP cobró $152.577,45 que no
se asentó, y el bot encontró que ese mismo importe figuraba como **faltante de la caja 4** contra
*desvío de caja* — o sea, no faltaba la plata, estaba mal imputada. Con el Mayor eso no se puede
rastrear y el bot lo avisa. Detalle en [conciliacion-mp.md](../conciliacion-mp.md) §5.

**Detalle completo** (alcance validado, cómo aparea, tolerancias, el huso horario de MP):
[conciliacion-mp.md](../conciliacion-mp.md).

## Se guarda cada día + resumen semanal automático

Cada corrida de `/mp` **guarda cómo salió el control del día** en `bot.mp_conciliacion` (migración
**018**): veredicto, totales, diferencia y las huérfanas con su rastreo. Re-correr el día lo pisa (la
última corrida es la verdad). El guardado es robusto: el reporte ya salió, si la base falla se loguea y
no rompe el comando.

**Los lunes a las 8:00 (hora Argentina)**, el bot arma un **resumen de la semana pasada** (lunes a
domingo) y se lo manda a los **admins + al rol Caja Central** (`src/aviso-mp-semanal.js`). Día por día:
si cerró, si tuvo diferencias (con el importe y dónde apareció) o **si no se corrió el control** — un
día saltado es en sí un hallazgo. Hora configurable con `RESUMEN_MP_HORA_UTC` (default `11` UTC = 8:00
ART). La parte que arma el texto (`src/lib/resumen-mp-semanal.js`) es pura y testeada
(`test/resumen-mp-semanal.test.js`).

## Acceso

`/mp` está gated por `requiereArea('cajacentral')` = **admin o rol `cajacentral`** (la misma tabla
`bot.usuarios` / `bot.usuario_area` que todo el resto). Para habilitar a alguien:
`/usuarios agregar <telegram_id> cajacentral`. El paso donde se recibe cada documento **re-chequea** el
rol, por si se lo quitan a mitad de camino (es data financiera).

El rol se siembra con la **migración 014** (`db/migrations/014_caja_central.sql`) — hay que correrla en
Supabase antes de poder asignarlo. Como el menú `/` de Telegram se publica **al arrancar**, después de
asignar el rol hay que **reiniciar el bot** para que el comando le aparezca en la lista.

## Por qué es un área propia y no un comando más de Tesorería

`/mp` **vivía en Tesorería** hasta el 17/07/2026. Se movió porque es Caja Central quien lo corre a
diario. **No quedó en las dos**: en este bot un comando pertenece a **una sola área** (D9 de
[arquitectura.md](../arquitectura.md) — el "rol" de una persona *son* sus áreas), y registrarlo desde
dos haría que `bot.command('mp', …)` se ejecute **dos veces** y el wizard se abra duplicado. Los admins
lo siguen viendo igual, porque tienen acceso total.
