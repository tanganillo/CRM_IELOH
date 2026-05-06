const { getOrdersOlderThan, markOrdersAsArchived } = require("../../lib/supabase");
const { appendArchivedOrders } = require("../../lib/sheets");

const DAYS = 90;

exports.handler = async (event) => {
  // Permite invocación manual (POST) o programada (scheduled)
  if (event.httpMethod && !["POST", "GET"].includes(event.httpMethod)) {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const orders = await getOrdersOlderThan(DAYS);

    if (!orders.length) {
      console.log("archive-orders: sin pedidos para archivar");
      return { statusCode: 200, body: JSON.stringify({ archived: 0 }) };
    }

    // Guardar en hoja "Archivo" de Google Sheets
    await appendArchivedOrders(orders);

    // Marcar como archivados en Supabase (no se borran, quedan con archived=true)
    const ids = orders.map((o) => o.id);
    await markOrdersAsArchived(ids);

    console.log(`archive-orders: ${orders.length} pedidos archivados`);
    return { statusCode: 200, body: JSON.stringify({ archived: orders.length }) };
  } catch (err) {
    console.error("archive-orders error:", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
