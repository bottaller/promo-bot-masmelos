# Conciliación de Tesorería — Plan

> Plan de la **conciliación diaria de caja/bancos** (área Tesorería). Documento vivo — se actualiza a
> medida que se construye. Última actualización: **2026-07-17**.

## 1. Objetivo

Cada día, comparar la **realidad** (los saldos de bancos, Mercado Pago, cheques y caja) contra los
**libros** (los movimientos del *"Diario de movimientos contables"* de Sigma), **cuenta por cuenta**,
para detectar diferencias y rastrearlas hasta que cierran.

Las diferencias son de dos tipos, y las dos importan:
- **Timing** — algo pasó en la realidad pero todavía no se asentó (un gasto con tarjeta, una transfe,
  la compra de Mercado Libre que se asienta cuando llega el producto). Se cierra sola cuando el asiento
  aparece.
- **Error** — una diferencia real (faltan $1.000 en una caja) que hay que encontrar/corregir.

## 2. La idea, en una cuenta

Por cada cuenta:

```
saldo_ayer + ingresos − egresos  =  saldo_hoy (teórico)
diferencia = saldo_real_hoy − saldo_teórico
```

- `saldo_ayer` sale de la base (el cierre del día anterior).
- `ingresos` / `egresos` salen del **libro diario** (los movimientos de esa cuenta).
- `saldo_real_hoy` es el que carga el tesorero (los saldos del día).
- **`acumulado` por cuenta** = suma corrida de las diferencias. Debe **tender a cero**:
  - `acumulado ≈ 0` → todo conciliado (el timing se cerró solo).
  - `acumulado que no baja` → mirar (hay un error o un asiento que nunca se hizo).

> El libro **no trae saldos absolutos** (Sigma no exporta saldos iniciales), solo **movimientos**. Por
> eso hace falta guardar los saldos día a día: para tener el `saldo_ayer` de cada cuenta.

## 3. Comandos

| Comando | Quién | Qué hace |
|---|---|---|
| **`/cierre`** | Tesorería | Cierre **diario**. Subís saldos + libro del día → guarda saldos (con control de cambios) → concilia → devuelve el reporte con las diferencias y el acumulado. Avisa a los admins si hay 🔴. Acepta días anteriores (usa la fecha del Excel). |
| **`/semanal`** | Tesorería | Cierre **semanal**. Subís el libro de la semana (los saldos ya están de los diarios) → concilia el período contra los saldos guardados. **No toca el diario.** |
| **`/mensual`** | Tesorería | Cierre **mensual** (el exhaustivo). Igual que el semanal, sobre el mes. |
| **`/reportecierre <fecha>`** | Admin | Recupera un cierre **pasado**: los saldos, movimientos y diferencias que quedaron registrados de esa fecha. |
| **`/mp`** | Tesorería | El **nivel de abajo** de este control, para Mercado Pago: aparea cada cobranza de la `422101014` con su cobro en la liquidación de MP y dice **cuál** es la que no cierra (no solo que la cuenta no cierra). Independiente: no toca la base ni los cierres. Ver [conciliacion-mp.md](conciliacion-mp.md). |

## 4. El flujo diario (`/cierre`)

1. Subís el Excel de **saldos** ("Existencias al cierre").
2. Subís el **libro diario** del día (export de Sigma).
3. El sistema:
   - **Guarda los saldos** en `tesoreria_saldos` (con control de cambios, ver §5).
   - **Guarda el libro** (por cuenta y día) en `tesoreria_movimientos`.
   - **Concilia** (la cuenta de §2), calcula el **acumulado** por cuenta y **registra el resultado** en
     `tesoreria_conciliacion`.
   - Deja un rastro de **auditoría** (`tesoreria_auditoria`) y devuelve el **reporte** (ver §8), avisando
     a los admins si alguna cuenta queda en 🔴.

### Cierres con hueco (findes / feriados)

El "ayer" de un cierre es **el último saldo cargado**, no el día calendario anterior. Así, el cierre del
**lunes** se compara contra el saldo del **viernes** (saldosAnteriores). Para ese cierre, el libro que
subís tiene que **cubrir todo el hueco**: del sábado (o viernes) al lunes — así entran los movimientos
del finde. El sistema usa solo el tramo `(último saldo, hoy]` del libro, así que si el export incluye
también el viernes, **no lo doble-cuenta**. (El 9/7 fue feriado: por eso ese día no tiene libro y el
cierre del 10 abarca 8→10.)

## 5. Control de cambios (✅ hecho)

`/cierre` acepta saldos de **cualquier fecha** (usa la del Excel, no "hoy") — así podés cargar un día
que te olvidaste (ej.: hoy 11, mandás el del 8).

Si esa fecha **ya tenía saldos cargados y cambian**:
1. **Pide confirmación** al que lo sube, mostrando el diff (`viejo → nuevo` por cuenta).
2. Al confirmar, **avisa a los admins** con qué cambió y **quién** lo modificó.
3. Primera carga o recarga idéntica → no molesta.

## 6. Cierres de período (semanal / mensual)

Son la **misma cuenta** sobre un período más largo:

```
saldo_inicio_período + Σ movimientos_del_período  =  saldo_fin_período
```

Se apoyan en lo que ya quedó guardado por los `/cierre` diarios (saldos + movimientos), **pero
re-suben el libro del período** — porque los asientos se **ajustan retroactivamente** (ver §7) y una
re-exportación de la semana/mes trae las correcciones. A fin de mes casi todos los asientos ya
entraron: **si el mensual no cierra, es un problema de verdad.**

## 7. Ajustes retroactivos (importante)

El libro **no es inmutable**: un asiento se puede agregar tarde o corregir después del día. Por eso,
cada vez que se sube un libro, el sistema **actualiza los movimientos del período que cubre** (la
última versión pisa a la anterior para esos días). Así un ajuste retroactivo entra al re-subir.

> Es exactamente cómo ya piensa el **motor de `/flujos`**: su snapshot mergea por asiento *"porque los
> exports se solapan y las correcciones llegan hasta 3 días tarde"* (ver `config.py` del motor).

## 8. El Excel que devuelve (una fila por cuenta)

| Cuenta | Saldo ayer | Ingresos | Egresos | Saldo teórico | Saldo real | Diferencia | Acumulada | Estado |
|---|--:|--:|--:|--:|--:|--:|--:|:--|

- **Saldo teórico** = saldo ayer + ingresos − egresos.
- **Diferencia** = saldo real − saldo teórico.
- **Acumulada** = diferencia corrida por cuenta.
- **Estado** = OK (dif ≈ 0) / a revisar (dif grande o que no baja).
- Arriba, un resumen: fecha, total, cuántas cuentas cierran vs. no.
- La **Caja Dólar** se concilia aparte, en USD.

## 9. Modelo de datos (schema `bot`)

Las migraciones **008 a 011 y la 013 están aplicadas** en Supabase (verificado contra el schema el
17/07/2026). La 012 es de otra área (carrito web) y no está aplicada.

```
tesoreria_saldos       (fecha, empresa, cuenta, moneda, monto,                       -- ✅ 008 + 013
                        contado_en, cargado_por, cargado_en)
tesoreria_movimientos  (fecha, empresa, cuenta_id, cuenta, debe, haber,              -- ✅ 009 + 013
                        debe_nominal, haber_nominal, ingreso, cargado_por, cargado_en)
tesoreria_conciliacion (fecha, empresa, cuenta, moneda, saldo_ayer, ingresos,        -- ✅ 010
                        egresos, saldo_teorico, saldo_real, diferencia,
                        estado, nivel, generado_por, generado_en)
tesoreria_auditoria    (creado_en, usuario_id, usuario_txt, accion, empresa,         -- ✅ 011 (append-only)
                        fecha, periodo, nivel, detalle jsonb)
```

`contado_en` (momento del conteo) e `ingreso` (momento de cada movimiento) son las dos columnas del
corte por hora — ver §10. Las dos son `timestamp` SIN zona y admiten NULL: **NULL = "se cargó sin
hora"**, que el lector coalescea a `23:59:59` (modelo por día). Esa distinción es deliberada: permite
avisar en vez de degradar en silencio.

`tesoreria_movimientos` guarda el libro **crudo por cuenta contable de Sigma** (`cuenta_id`), no
pre-agregado a los 8 nombres de saldo. El mapeo cuenta→saldo y las sumas (la caja fuerte junta varias
cajas, §10) se resuelven **al conciliar** — así, si el mapeo se corrige, no hay que re-importar el
libro. `debe/haber` en ARS; `debe_nominal/haber_nominal` en USD (caja dólar).

`tesoreria_conciliacion` guarda el resultado de cada cierre para que `/reportecierre <fecha>` lo
recupere sin recalcular (y queda como registro de las diferencias). Se recalcula/actualiza cada vez
que se corre un cierre de esa fecha (upsert). La **`acumulada`** (diferencia corrida por cuenta) **no
se guarda**: se calcula al leer (suma de `diferencia` hasta esa fecha) — materializarla se rompería
con las cargas retroactivas.

## 10. Mapeo cuenta ↔ libro (validado con una semana real, 01–10/07/2026)

Los saldos usan nombres; el libro usa **códigos de cuenta de Sigma** (`cuenta_id`). Mapeo **confirmado
corriendo la conciliación contra una semana real**: cada cuenta cierra a residuos de timing (millones
sobre flujos de cientos de millones por cuenta).

| Cuenta del saldo | `cuenta_id` del libro | Residuo 01→10 |
|---|---|--:|
| Santander | `111201014` | −3,6M (timing) |
| Supervielle | `111201015` | −1,1M (timing) |
| Mercado Pago | `422101014` + tarjetas `111301002` `111304001` `111305001` `111302002` `111303001` | +1,7M ✅ |
| Caja Fuerte Moreno | `111101003` (sola) | +3,1M (timing) |
| Caja Dólar Tesorería | `111102006` **sola** (col *Nominal*, USD) | 0 ✅ |
| Cheques en Cartera A+B | `111401001` (grupo) | 0 ✅ |
| E-cheq en Cartera | `111401010` (ECHEQ HONRE) | timing propio (grumoso) |

- **Mercado Pago = MP + tarjetas del Point** (Visa Débito, Mastercard, Amex, Naranja, Cabal). **Visa
  Crédito (`111301001`) NO entra** (liquida a otro lado). Sumar las tarjetas bajó el desfase semanal de
  **+51,8M a +1,7M**.
- **Caja Fuerte = sola** (`111101003`): la cascada (buzón+puente+…) daba +13,7M; sola cierra.
- **Cheques**: A y B son una división manual de la única cartera de Sigma (`111401001`) → se concilian
  como **grupo** (suma A+B); B está siempre en 0. Falta la feature de "grupo" en el motor (hoy B queda
  `sin_mapeo`).
- **E-cheq** → `111401010` (ECHEQ HONRE): su neto semanal (4.801.078 − 2.501.439 = 2.299.639) es el
  saldo final. Es de bajo volumen y sus asientos son grumosos (a veces el libro los carga tarde) → puede
  mostrar timing propio. `111401008` ("ECHEQ" sin HONRE) es de otra empresa: NO entra.
- **Visa Crédito** (`111301001`): Debe en la semana, Haber 0 → es una **cuenta a cobrar** (Visa liquida
  a ~18 días). Bien afuera de MP; la plata todavía no llegó a ninguna caja/banco.
- **Caja Dólar Tesorería = SOLO la caja física del negocio (`111102006`)**. Hay una **segunda** caja
  dólar, `111102005` "Caja Dolares", adonde va la plata **cuando sale del negocio**: es otra caja real,
  con su propio dinero, y su saldo **no se carga** en el Excel. El mapeo original sumaba las dos (teoría:
  "el traspaso entre ellas es interno"), pero como el saldo solo cubre la 006, todo lo que se acumulaba en
  la 005 (**+US$51.100** en la semana real, solo Debe, nunca Haber) caía como diferencia. Sacada la 005,
  la caja física cierra en **$0 exacto todos los días** (13/07/2026). Si en el futuro se quiere controlar
  la 005, va como **cuenta de control propia**, con su propio renglón de saldo.
- **Signo**: las 8 cuentas son **deudoras** (el Debe las sube). Mercado Pago (`422…`) **confirmado
  deudor** por el Debe de las cobranzas.

### El acumulado y el timing (el corazón del control)

La **diferencia de un día** casi siempre es **timing** (un depósito/transferencia que en el banco ya
pasó pero se asienta 1-3 días después) y **se da vuelta sola**. Ejemplo real: el 3/7 una transferencia
Santander→Supervielle de 150M ya estaba en el banco pero se asentó el 6/7 → el 3/7 dio −150M y el 6/7
+150M, netos ≈ 0. Por eso lo que **alarma no es la diferencia del día sino el ACUMULADO por cuenta**:

- 🟢 `ok`: cierra. · 🟡 `timing`: hay diferencia pero el acumulado está sano (bajo umbral).
- 🟠 `revisar`: acumulado alto pero reciente → probable depósito/transferencia en tránsito.
- 🔴 `alerta`: acumulado alto y **persistente** (más de `DIAS_TOLERANCIA_TIMING` cierres) → no se
  resuelve solo, hay que perseguirlo. Se avisa a los admins.

Umbrales calibrables en `conciliacion.js` (`UMBRAL_ACUMULADO`, `DIAS_TOLERANCIA_TIMING`).

### Corte por HORA — la ventana entre conteos (migración 013)

El tesorero cuenta los saldos a una hora (ej. 16:20) pero el negocio cierra más tarde (17:00).
Reconciliar por DÍA metía esa última hora en el cálculo aunque el conteo no la vio → diferencias
falsas. Por eso el corte es por **marca de tiempo**, no por día:

- El Excel de saldos lleva una fila **"Hora del conteo:"** (`contadoEn`); el libro trae la hora
  de cada movimiento en la columna **"Ingreso"** (antes se descartaba, `libro-excel.js`).
- La ventana es **semiabierta `(conteo_anterior, conteo_hoy]`** por `ingreso`. Cruza la
  medianoche sin caso especial → por eso el libro se pide de **ayer a hoy** (inclusive el día
  del conteo anterior, para su "cola" de la tarde).
- **Vivo == acumulado por construcción:** el cierre vivo guarda el libro y relee los movimientos
  de la DB con la MISMA función (`movimientosDeRango`) que el replay del acumulado
  (`historialDiferencias`) → el número de hoy y el acumulado de mañana salen del mismo dato.
- **Reloj de pared:** `contado_en` / `ingreso` son `timestamp` SIN zona; se guardan y comparan
  como el string canónico `AAAA-MM-DD HH:MM:SS` y se leen con `to_char()` — **nunca** como Date
  de JS (node-pg correría 3h en Railway/UTC). Disciplina de `fechas.js` (`tsCanonico`, `finDeDiaTs`).
- **Compatibilidad:** el modelo por día es el caso "contar a las 23:59:59". Dato viejo o Excel sin
  hora → 23:59:59 = comportamiento actual, y el bot **avisa** que cargó sin hora (no se degrada en
  silencio). `/semanal` y `/mensual` cortan por hora en los bordes del período.

⚠️ **Depende de que "Ingreso" ≈ el momento de la venta.** Validado sobre un día real (14/07): las
cobranzas se cargan repartidas 08-16h (tiempo real), no en tanda. Si algún día se cargaran en
tanda, el corte por hora empeoraría el bug; por eso el fallback a 23:59:59 + el aviso.

⚠️ **Las dos puntas migran juntas: nunca un `contado_en` real contra un libro sin horas.** El backfill
de la 013 deja todos los movimientos viejos en `23:59:59`. Si a un día así se le pone una hora de
conteo real (ej. 16:48), su ventana `(anterior, 16:48]` **excluye su propio libro entero** — porque
`23:59:59 > 16:48` — y ese libro cae en la ventana del día siguiente, que lo cuenta **dos veces**. O el
día tiene hora de conteo **y** su libro tiene horas reales, o no tiene ninguna de las dos; el modelo
por día (todo en 23:59:59) es consistente, y el híbrido no.

> No es hipotético: el 13/07 quedó con `contado_en=16:48` puesto **a mano por SQL** mientras su libro
> seguía en 23:59:59. El replay le vaciaba Caja Fuerte, Santander y Supervielle enteras (0 contra
> 102.667.630 / 33.982.521 / 17.648.357) y se las regalaba al 14. Se corrigió el **17/07/2026** dejando
> el `contado_en` del 13 en NULL; con eso los 7 cierres reproducen su conciliación guardada exacta
> (49 comparaciones sobre las 7 cuentas, 0 discrepancias).
>
> **Cómo detectarlo:** un `contado_en` seteado cuya fila NO tenga el `cargado_en` correspondiente es
> sospechoso — `guardarSaldos()` hace `contado_en = contadoEn || finDeDiaTs(fecha)` (nunca escribe NULL)
> y pisa `cargado_en = now()` en cada upsert. Si un día tiene hora de conteo pero otro **posterior** la
> tiene en NULL, la hora no salió del bot.

## 11. Estado

**✅ Hecho (ya mergeado en `main` — `origin/main..origin/dev` vuelve vacío al 17/07/2026):**
- `tesoreria_saldos` (migración 008, aplicada en Supabase).
- Parser del Excel de saldos con validación de fecha.
- Plantilla `docs/plantillas/plantilla_saldos_HONRE.xlsx`.
- `/cierre` fase saldos + **control de cambios** (confirmación + aviso a admins).
- **Formato del libro y fórmula de conciliación decodificados del motor de `/flujos`** (`parse.py` da
  las 18 columnas; `core.py::cascada_diaria` confirma `saldo = saldo_ayer + Σdebe − Σhaber`).
- Migraciones **008/009/010/011** (saldos, movimientos, conciliación, auditoría) y **013** (corte por
  hora) **aplicadas en Supabase**.
- Parser del libro en Node (`src/lib/libro-excel.js`) — **endurecido con archivos reales**: acepta 16 y
  18 columnas y el título de empresa partido en varias filas (busca el header "Mov.").
- **Motor de conciliación** (`src/lib/conciliacion.js`): `conciliar()` (modelo de **cuentas de control**
  con grupos y cuentas compuestas), `acumularCuenta()` (acumulado + persistencia) y `evaluarCuenta()`
  (niveles ok/timing/revisar/alerta con tolerancia al timing).
- **Mapeo validado contra una semana real** (01–10/07/2026, §10): MP (=MP+tarjetas), caja fuerte (sola),
  USD (**solo la caja física 111102006**; la 005 "Caja Dolares" es plata que salió del negocio, aparte),
  cheques A+B (grupo), e-cheq (111401010). Visa Crédito confirmada afuera (a cobrar).
- **Orquestación** (`src/lib/control-tesoreria.js` `procesarCierre()`) + **reporte Telegram**
  (`src/lib/reporte-cierre.js`) + **capa de seguridad** (movimientos a cuentas sensibles: retiros de
  socios/gerencia, desvío de caja, reintegros inter-empresa).
- **Capa DB** (`src/db/tesoreria.js`): saldos, movimientos, conciliación, **historial para el acumulado**
  y **auditoría** (append-only). **Validada de punta a punta contra Postgres real** (tipos, upserts, FKs).
- **Comandos** (`src/areas/tesoreria/`): `/cierre` (diario: saldos + libro → concilia, guarda, avisa 🔴),
  `/semanal` y `/mensual` (solo libro, no tocan el diario), `/reportecierre <fecha>` (admin).
- **Tests**: `test/tesoreria-conciliacion.test.js` (16 casos, incl. la regresión del bug multi-día).
  Validado end-to-end simulando la semana real: todas las cuentas a timing salvo lo esperado.
- **Revisión adversarial multi-agente** (22 agentes): 10 hallazgos reales corregidos, entre ellos dos
  ALTA — (1) la carga **retroactiva/fuera de orden** corrompía el acumulado: ahora el acumulado se
  **re-encadena desde los saldos y movimientos guardados** (robusto al orden); (2) sobrescribir saldos
  ya cargados ahora **audita y avisa a los admins en el acto** (append-only), no diferido. También:
  tolerancia de timing a 3 días, cheques-grupo con fila faltante, período que puede llegar a 🔴,
  detección de ida-y-vuelta por flujo bruto, y auditoría de `/reportecierre`.

**⬜ Pendiente:**
- **Probar el CORTE POR HORA con datos reales** — es lo único del feature que nunca se ejerció. El ida y
  vuelta por Telegram ya se probó (cierres del 13 y del 14 subidos a `/cierre`, ver §12), pero **por
  día**: ningún libro cargado trae horas reales en `ingreso` y ningún saldo trae `contado_en`. Hace
  falta un `/cierre` con un Excel de saldos que traiga la "Hora del conteo" **y** un libro cuya columna
  "Ingreso" tenga horas de verdad.
- Confirmar con el tesorero el **e-cheq** grumoso y a dónde liquida **Visa Crédito** (detalles menores).
- Calibrar los **umbrales** (`UMBRAL_ACUMULADO`, `DIAS_TOLERANCIA_TIMING`) con más meses de datos.
- (Opcional) aviso "el libro no cubre el finde"; Excel de salida además del mensaje; `/semanal`/`/mensual`
  con varios libros por período; nota "se resolvió la diferencia de ayer"; materialidad para no mostrar
  centavos como 🟡.

## 12. Operación del día a día

- **Todos los días**: `/cierre` con los **saldos** ("Existencias al cierre") + el **libro** del día.
- **Findes/feriados**: el lunes el libro tiene que cubrir el hueco (sábado→lunes); el sistema compara
  contra el saldo del viernes (§4).
- **Semanal/mensual**: `/semanal` o `/mensual` con el libro del período — los saldos ya están.
- **Auditar**: `/reportecierre DD/MM/AAAA` (admin) para recuperar un cierre pasado.
