# Conciliación de Tesorería — Plan

> Plan de la **conciliación diaria de caja/bancos** (área Tesorería). Documento vivo — se actualiza a
> medida que se construye. Última actualización: **2026-07-12**.

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

```
tesoreria_saldos       (fecha, empresa, cuenta, moneda, monto, cargado_por)          -- ✅ aplicada (008)
tesoreria_movimientos  (fecha, empresa, cuenta_id, cuenta, debe, haber,              -- 🟡 migración 009 (sin aplicar)
                        debe_nominal, haber_nominal, cargado_por)
tesoreria_conciliacion (fecha, empresa, cuenta, moneda, saldo_ayer, ingresos,        -- 🟡 migración 010 (sin aplicar)
                        egresos, saldo_teorico, saldo_real, diferencia, generado_por)
```

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
| Caja Dólar Tesorería | `111102005` + `111102006` (cols *Nominal*, USD) | ≈0 ✅ |
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

## 11. Estado

**✅ Hecho (en `dev`):**
- `tesoreria_saldos` (migración 008, aplicada en Supabase).
- Parser del Excel de saldos con validación de fecha.
- Plantilla `docs/plantillas/plantilla_saldos_HONRE.xlsx`.
- `/cierre` fase saldos + **control de cambios** (confirmación + aviso a admins).
- **Formato del libro y fórmula de conciliación decodificados del motor de `/flujos`** (`parse.py` da
  las 18 columnas; `core.py::cascada_diaria` confirma `saldo = saldo_ayer + Σdebe − Σhaber`).
- Migraciones **008/009/010/011** (saldos, movimientos, conciliación, auditoría) **aplicadas en Supabase**.
- Parser del libro en Node (`src/lib/libro-excel.js`) — **endurecido con archivos reales**: acepta 16 y
  18 columnas y el título de empresa partido en varias filas (busca el header "Mov.").
- **Motor de conciliación** (`src/lib/conciliacion.js`): `conciliar()` (modelo de **cuentas de control**
  con grupos y cuentas compuestas), `acumularCuenta()` (acumulado + persistencia) y `evaluarCuenta()`
  (niveles ok/timing/revisar/alerta con tolerancia al timing).
- **Mapeo validado contra una semana real** (01–10/07/2026, §10): MP (=MP+tarjetas), caja fuerte (sola),
  USD (dos cajas), cheques A+B (grupo), e-cheq (111401010). Visa Crédito confirmada afuera (a cobrar).
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
- **Probar el ida y vuelta real por Telegram** (subir saldos + libro a `/cierre` con un día real).
- **Mergear `dev` → `main`** para deployar (las migraciones ya están aplicadas, así que el merge es seguro).
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
