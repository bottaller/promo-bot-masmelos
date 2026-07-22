# Cargar el libro diario a la DB (automatización)

Cómo un script que exporta el "Diario de movimientos contables" de Sigma lo deja cargado en
la base, para que lo consuman `/cierre`, `/mp` y `/flujos` sin que nadie lo suba a mano.

## Regla de oro: NO escribas en la DB directamente

Es tentador hacer un `INSERT` en `bot.libro_diario` y listo. **No lo hagas.** Cargar el libro
es más que guardar el archivo:

1. Se **parsea** el Excel de Sigma (valida que tenga la forma esperada).
2. Se guarda el **.xlsx crudo** en `bot.libro_diario` → lo usan `/flujos` (se lo pasa al motor
   Python) y `/mp` (lo re-parsea con otro parser).
3. Se guardan los **movimientos parseados** en `bot.tesoreria_movimientos` → los usa `/cierre`
   para conciliar y para el acumulado.
4. Se calcula el **rango REAL** de los datos (no el del título del export, que puede ser más
   ancho), se rechaza un export con fecha futura, y se hace todo **idempotente** (recargar el
   mismo día pisa en vez de duplicar).

Un `INSERT` a mano se saltea los pasos 1, 3 y 4: el `/cierre` no tendría con qué conciliar, y el
aviso de las 21:00 mentiría sobre qué días tenés. **Usá el CLI**, que hace todo eso en un solo
comando y es la MISMA lógica que corre el bot cuando cargás con `/libro`.

## El comando

```
node src/db/cargar-libro.js "<ruta-al-.xlsx>" [DD/MM/AAAA]
```

- **Corré desde la carpeta `promo-bot/`** (ahí está el `.env` con el `DATABASE_URL`, que el CLI
  lee solo). Si lo corrés desde otro lado, tenés que pasarle `DATABASE_URL` por variable de
  entorno vos.
- **Primer argumento (obligatorio):** la ruta al `.xlsx` que exportó Sigma. Poné comillas si
  tiene espacios.
- **Segundo argumento (opcional):** forzar la jornada. **Casi nunca hace falta** — si no lo
  ponés, la jornada es el último día que trae el export, que es lo normal. Usalo solo si el
  export trae varios días y querés archivarlo como uno puntual.

Ejemplos:

```powershell
# Lo habitual: la jornada la deduce del Excel
node src/db/cargar-libro.js "C:\ruta\Diario de movimientos.xlsx"

# Forzar la jornada (raro)
node src/db/cargar-libro.js "C:\ruta\Diario de movimientos.xlsx" 20/07/2026
```

## Cómo saber si salió bien

- **Éxito:** sale con **código 0** e imprime una línea como:
  `Libro cargado — jornada 20/07/2026 | export 18/07/2026→20/07/2026 | 1723 movimientos en 3 día(s)`
  (agrega `| REEMPLAZÓ al que ya estaba` si ese día ya tenía libro).
- **Falla:** sale con **código != 0** e imprime el error por `stderr`. Motivos posibles: no pudo
  leer el archivo, el Excel no es un "Diario de movimientos" válido, la fecha es futura, o la
  base no respondió.

Tu script tiene que **chequear el código de salida** y no dar por cargado el libro si falló.

## Ejemplo de automatización (PowerShell)

Después de que tu robot exporta el `.xlsx` de Sigma, encadená la carga:

```powershell
$repo   = "C:\Users\Renzo_Notebook\Desktop\GitHub\promo-bot-masmelos\promo-bot"
$export = "C:\ruta\Diario de movimientos.xlsx"   # lo que dejó Sigma

Push-Location $repo
try {
    node src/db/cargar-libro.js $export
    if ($LASTEXITCODE -ne 0) {
        # No cargó: dejá rastro y avisá (mail, log, reintento…). NO borres el export.
        Write-Error "La carga del libro diario falló (código $LASTEXITCODE)."
        # exit 1  / enviar alerta / reintentar
    } else {
        Write-Host "Libro diario cargado OK."
    }
} finally {
    Pop-Location
}
```

Para que corra solo todas las noches, programalo con el **Programador de tareas de Windows**
(Task Scheduler): una tarea diaria que primero dispare la exportación de Sigma y después este
script. Cargalo **a la misma hora o antes** del recordatorio de las 21:00, así el aviso "falta el
libro" no salta cuando en realidad ya lo cargaste.

## Detalles que conviene saber

- **Node ya está instalado** en esta notebook (v24).
- **El rango del export puede ser ancho.** El CLI guarda el rango REAL de los movimientos, no el
  del título, así que exportar "unos días para atrás" no molesta: cada día se archiva con sus
  datos.
- **Idempotente.** Si el mismo día se carga dos veces, la segunda pisa a la primera (borra e
  reinserta ese día). Cargar el lunes no toca el martes. Sirve para corregir un export
  incompleto: re-exportás y volvés a correr el CLI.
- **Una sola carga por día alcanza:** alimenta `/cierre`, `/mp` y `/flujos` de una.
- **La jornada sale del Excel, no del día en que se sube.** Si te olvidaste y el martes cargás el
  del lunes, queda archivado como lunes (lo único que se rechaza es un export que diga ser del
  futuro).

## Si necesitás llamarlo desde código Node (no por línea de comandos)

El núcleo vive en `src/lib/registrar-libro.js` y es agnóstico de Telegram:

```js
const { registrarLibro } = require('./src/lib/registrar-libro');
const fs = require('fs');

const res = await registrarLibro({
  buffer: fs.readFileSync('C:/ruta/Diario de movimientos.xlsx'),
  nombreArchivo: 'Diario de movimientos.xlsx',
  fecha: null,      // null = deducir del Excel; o un Date para forzar la jornada
  usuarioId: null,  // null = lo cargó un proceso, no una persona
});
// res = { jornada, desde, hasta, filas, dias, yaHabia, atrasado, huecos, ... }
```

Tira `LibroError` si el Excel no sirve (mensaje claro para mostrar); cualquier otro error es un
bug real. Acordate de cerrar el pool (`require('./src/db/pool').pool.end()`) al terminar si es un
proceso corto.
