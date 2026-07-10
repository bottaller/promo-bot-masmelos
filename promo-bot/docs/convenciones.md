# Convenciones del proyecto

Reglas transversales que valen para todo el bot. Se agregan a medida que aparecen.

## Reportes

- **Todo reporte que genere el bot debe llevar la fecha de generación.**
  Aplica a cualquier salida: Excel, HTML o texto en el chat.
  - La fecha va **visible**: en el encabezado del archivo, o en una línea `Generado: DD/MM/AAAA`
    en el mensaje.
  - Siempre en **horario de Argentina** (`America/Argentina/Buenos_Aires`).
  - En los **nombres de archivo** se usa `AAAA-MM-DD` (ordenable), ej. `control_ofertas_2026-07-09.xlsx`.
  - Helpers disponibles: `fechaHoyArg()` (DD/MM/AAAA) y `fechaHoyArgISO()` (AAAA-MM-DD),
    en [`src/lib/fechas.js`](../src/lib/fechas.js).
