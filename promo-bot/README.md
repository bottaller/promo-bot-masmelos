# Bot de promociones por vencimiento — Más Melos (nano repo)

Repo chico, autocontenido, pensado para clonarse como base de otros bots similares.
Un bot de Telegram, una planilla de Sheets, sin base de datos ni frameworks pesados.

```
promo-bot-masmelos/
├── config/
│   └── compradores.js   ← quién recibe cada notificación, por categoría
├── src/
│   ├── index.js          ← arranca el bot
│   ├── sheets.js          ← lectura/escritura a Google Sheets (ALTAS, BAJAS)
│   ├── notificar.js       ← envía mensajes a compradores
│   └── scenes/
│       ├── alta.js        ← wizard /alta
│       ├── baja.js        ← wizard /baja
│       └── reporte.js     ← comando /reporte
├── .env.example
├── .gitignore
└── package.json
```

3 dependencias en total: `telegraf`, `googleapis`, `dotenv`.

## Ya está resuelto

- La planilla ya existe, con las pestañas `ALTAS` y `BAJAS` creadas (vacías). El bot les
  agrega los encabezados solo la primera vez que corre.
- El `GOOGLE_SHEET_ID` ya está cargado en `.env.example`:
  `1G_f9l5cfM-IlaOZntNlWNpNVG0YYQZ8caSxSowLnx5c`

## Lo que falta para que ande

### 1. Crear el bot en Telegram
Hablar con [@BotFather](https://t.me/BotFather) → `/newbot` → guardar el token → va en `BOT_TOKEN`.

### 2. Cuenta de servicio de Google
1. En Google Cloud Console, crear (o reutilizar) un proyecto, habilitar la API de Sheets.
2. Crear una cuenta de servicio, generar una clave JSON.
3. Compartir la planilla (botón "Compartir") con el email de esa cuenta de servicio
   (termina en `...@....iam.gserviceaccount.com`), permiso Editor.
4. Convertir el JSON a base64 en una línea:
   - Mac/Linux: `base64 -w0 credenciales.json`
   - Windows (PowerShell): `[Convert]::ToBase64String([IO.File]::ReadAllBytes("credenciales.json"))`
5. Ese texto va en `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64`.

### 3. Compradores
Editar `config/compradores.js`: por cada categoría, poner el `chat_id` real de la persona
(reemplazar los `'PENDIENTE'`). El chat_id se consigue mandándole un mensaje a
[@userinfobot](https://t.me/userinfobot) desde la cuenta de esa persona.
Mientras diga `PENDIENTE`, el bot registra todo igual pero no manda la notificación
(avisa por consola, no se rompe).

### 4. Variables de entorno
```bash
cp .env.example .env
# completar BOT_TOKEN y GOOGLE_SERVICE_ACCOUNT_JSON_BASE64
```

### 5. Correr en local
```bash
npm install
npm start
```

### 6. Deploy en Railway
```bash
git remote add origin <URL del repo en GitHub, crear uno nuevo y vacío>
git push -u origin main
```
En Railway: proyecto nuevo (no como servicio dentro de otro proyecto existente) → conectar
ese repo → cargar las mismas variables de `.env` en la sección Variables → deploy.

## Cómo usar este repo como base para otro bot

1. Clonar/copiar la carpeta entera, cambiar el `name` en `package.json`.
2. Reemplazar `config/compradores.js` por el mapeo que corresponda (o borrarlo si el bot no
   notifica a nadie).
3. En `src/sheets.js`, cambiar `TABS` y `HEADERS` por las pestañas del nuevo caso de uso.
4. En `src/scenes/`, escribir los wizards nuevos siguiendo el mismo patrón (una función por
   paso, `ctx.wizard.state.data` para ir acumulando respuestas, `appendRow` al final).
5. Nuevo bot en BotFather, nueva planilla, nueva cuenta de servicio (o reutilizar la misma
   cuenta de servicio si vas a compartirle varias planillas — no hace falta una por bot).
6. Nuevo repo en GitHub, nuevo proyecto en Railway. Cada bot queda 100% independiente de
   los demás: si uno se cae o hay que tocarlo, no afecta al resto.

## Notas

- Un mismo SKU puede tener varias altas abiertas en simultáneo (distintos lotes); `/baja`
  deja elegir cuál cerrar si hay más de una.
- La tasa de descarte de `/reporte` es histórica acumulada. Para una ventana móvil de 3-6
  meses, se filtra por fecha en `src/scenes/reporte.js`.
