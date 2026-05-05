const { getAllOrders, supabase } = require("../../lib/supabase");
const { syncOrdersToSheet, syncClientsToSheet } = require("../../lib/sheets");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const [orders, { data: clients, error: cErr }] = await Promise.all([
      getAllOrders({ limit: 1000 }),
      supabase.from("clientes").select("*").order("created_at", { ascending: false }),
    ]);
    if (cErr) throw cErr;

    const [ordersCount, clientsCount] = await Promise.all([
      syncOrdersToSheet(orders),
      syncClientsToSheet(clients),
    ]);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        ok: true,
        orders: ordersCount,
        clients: clientsCount,
        syncedAt: new Date().toISOString(),
      }),
    };
  } catch (err) {
    console.error("Error sincronizando con Sheets:", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
