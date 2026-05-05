const { getDailySummary, getAllOrders, supabase } = require("../../lib/supabase");

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const [summary, recentOrders, clientCount] = await Promise.all([
      getDailySummary(),
      getAllOrders({ limit: 10 }),
      getClientCount(),
    ]);

    const data = {
      today: summary,
      recentOrders,
      totalClients: clientCount,
      generatedAt: new Date().toISOString(),
    };

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify(data),
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

async function getClientCount() {
  const { count, error } = await supabase
    .from("clientes")
    .select("*", { count: "exact", head: true });
  if (error) throw error;
  return count;
}
