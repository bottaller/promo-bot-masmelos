const { google } = require('googleapis');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;

const TABS = {
  ALTAS: 'ALTAS',
  BAJAS: 'BAJAS',
};

// Encabezados esperados en cada pestaña. Si la planilla esta vacia,
// se crean automaticamente al arrancar (ver ensureHeaders mas abajo).
const HEADERS = {
  ALTAS: ['id', 'fecha', 'usuario', 'sku', 'descripcion', 'categoria', 'lote', 'vencimiento', 'cantidad', 'motivo', 'estado'],
  BAJAS: ['id', 'fecha', 'alta_id', 'sku', 'cantidad_remanente', 'cantidad_vendida', 'motivo_baja'],
};

function getAuth() {
  const raw = Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64, 'base64').toString('utf8');
  const credentials = JSON.parse(raw);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

let sheetsClient = null;
async function getSheets() {
  if (sheetsClient) return sheetsClient;
  const auth = getAuth();
  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

async function appendRow(tab, rowArray) {
  const sheets = await getSheets();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A1`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [rowArray] },
  });
}

async function readAll(tab) {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A:Z`,
  });
  const rows = res.data.values || [];
  if (rows.length === 0) return { headers: HEADERS[tab], records: [] };
  const [headers, ...rest] = rows;
  const records = rest.map((r) => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = r[i] ?? ''; });
    return obj;
  });
  return { headers, records };
}

// Actualiza una celda puntual ubicando la fila por el valor de "id" en la columna id_col.
async function updateCellById(tab, idColName, idValue, targetColName, newValue) {
  const sheets = await getSheets();
  const { headers, records } = await readAll(tab);
  const rowIndex = records.findIndex((r) => String(r[idColName]) === String(idValue));
  if (rowIndex === -1) throw new Error(`No se encontro id ${idValue} en ${tab}`);
  const colIndex = headers.indexOf(targetColName);
  if (colIndex === -1) throw new Error(`Columna ${targetColName} no existe en ${tab}`);
  const colLetter = String.fromCharCode(65 + colIndex);
  const rowNumber = rowIndex + 2; // +1 por encabezado, +1 porque values.get es 1-indexado
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${tab}!${colLetter}${rowNumber}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[newValue]] },
  });
}

async function ensureHeaders() {
  const sheets = await getSheets();
  for (const tab of Object.values(TABS)) {
    const { records } = await readAll(tab).catch(() => ({ records: null }));
    if (records === null) continue; // la pestaña no existe todavia, se crea manualmente
    const check = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${tab}!A1:Z1` });
    if (!check.data.values || check.data.values.length === 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${tab}!A1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [HEADERS[tab]] },
      });
    }
  }
}

module.exports = { TABS, HEADERS, appendRow, readAll, updateCellById, ensureHeaders };
