// Escribe en la pestaña ALTURA de la planilla "INVENTARIO MAS MELOS V2" (auditoría de pallets
// en altura, /auditoria_altura del área Calidad). Las columnas Descripción, Cant. x Display,
// Cant. x Bulto y TOTAL unidades (D, H, I, J) están protegidas en la planilla: ya tienen fórmulas
// armadas ahí que se autocompletan solas apenas se carga el código escaneado en la columna C —
// el bot NUNCA escribe en esas columnas, solo en N° Pallet, Pasillo, Código escaneado, Unidades,
// Displays y Bultos (A, B, C, E, F, G).
const { google } = require('googleapis');

const SHEET_ID = process.env.GOOGLE_INVENTARIO_SHEET_ID;
const TAB = 'ALTURA';

function getAuth() {
  const raw = Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64, 'base64').toString('utf8');
  const credentials = JSON.parse(raw);
  return new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
}

let sheetsClient = null;
async function getSheets() {
  if (sheetsClient) return sheetsClient;
  const auth = getAuth();
  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

// Agrega una fila de conteo de un producto en un pallet. Devuelve el número de fila usada.
//
// No se puede usar values.append con INSERT_ROWS acá: la planilla ya tiene la grilla armada
// (999 filas) con las columnas D/H/I/J protegidas en TODAS esas filas para las fórmulas
// automáticas, e insertar una fila (aunque solo se le escriba a la columna A) es una operación
// estructural sobre la fila entera -> choca con esa protección. Por eso en cambio se busca la
// próxima fila libre por la columna A (no protegida) y se escribe directo ahí con update.
async function proximaFilaLibre(sheets) {
  const { data } = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${TAB}!A:A` });
  return (data.values || []).length + 1;
}

async function agregarConteo({ pallet, pasillo, codigo, unidades, displays, bultos }) {
  const sheets = await getSheets();
  const fila = await proximaFilaLibre(sheets);

  // El código escaneado va con un apóstrofo adelante para forzarlo como texto (igual que
  // tipearlo a mano en Sheets): sin esto, USER_ENTERED lo interpreta como número y un EAN que
  // arranca con 0 (común en UPC-A representado como EAN-13) pierde el cero y ya no matchea
  // contra MAESTRO.
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: [
        { range: `${TAB}!A${fila}:C${fila}`, values: [[pallet, pasillo, `'${codigo}`]] },
        { range: `${TAB}!E${fila}:G${fila}`, values: [[unidades, displays, bultos]] },
      ],
    },
  });
  return fila;
}

module.exports = { agregarConteo };
