const { google } = require("googleapis");

function getAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  return new google.auth.JWT(
    credentials.client_email,
    null,
    credentials.private_key,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
}

async function syncOrdersToSheet(orders) {
  const auth = getAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  // Cabecera + filas
  const header = [["ID", "Cliente", "Teléfono", "Items", "Total", "Estado", "Fecha"]];
  const rows = orders.map((o) => [
    o.id,
    o.clientes?.nombre || "",
    o.clientes?.telefono || "",
    formatItems(o.items),
    o.total,
    o.estado,
    new Date(o.created_at).toLocaleString("es-AR"),
  ]);

  // Limpiar hoja y reescribir
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: "Pedidos!A:G",
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: "Pedidos!A1",
    valueInputOption: "RAW",
    requestBody: { values: [...header, ...rows] },
  });

  return rows.length;
}

async function syncClientsToSheet(clients) {
  const auth = getAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  const header = [["ID", "Nombre", "Teléfono", "Dirección", "Registrado"]];
  const rows = clients.map((c) => [
    c.id,
    c.nombre,
    c.telefono,
    c.direccion || "",
    new Date(c.created_at).toLocaleString("es-AR"),
  ]);

  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: "Clientes!A:E",
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: "Clientes!A1",
    valueInputOption: "RAW",
    requestBody: { values: [...header, ...rows] },
  });

  return rows.length;
}

async function appendArchivedOrders(orders) {
  const auth = getAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  const rows = orders.map((o) => [
    o.id,
    o.clientes?.nombre || "",
    o.clientes?.telefono || "",
    formatItems(o.items),
    o.total,
    o.estado,
    new Date(o.created_at).toLocaleString("es-AR"),
    new Date().toLocaleString("es-AR"), // fecha de archivado
  ]);

  // Append (no sobreescribe, solo agrega al final)
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: "Archivo!A:H",
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: rows },
  });

  return rows.length;
}

function formatItems(items) {
  if (!items) return "";
  const list = Array.isArray(items) ? items : [items];
  return list.map((i) => `${i.cantidad}x ${i.nombre}`).join(", ");
}

module.exports = { syncOrdersToSheet, syncClientsToSheet, appendArchivedOrders };
