const { getAllOrders, updateOrderStatus, createOrder } = require("../../lib/supabase");

exports.handler = async (event) => {
  const method = event.httpMethod;
  const params = event.queryStringParameters || {};

  try {
    if (method === "GET") {
      const orders = await getAllOrders({
        limit: Number(params.limit) || 100,
        offset: Number(params.offset) || 0,
        estado: params.estado || undefined,
      });
      return ok(orders);
    }

    if (method === "POST") {
      const body = JSON.parse(event.body);
      const { cliente_id, items, total } = body;
      if (!cliente_id || !items) return bad("cliente_id e items son requeridos");
      const order = await createOrder({ cliente_id, items, total });
      return ok(order, 201);
    }

    if (method === "PATCH") {
      const body = JSON.parse(event.body);
      const { id, estado } = body;
      if (!id || !estado) return bad("id y estado son requeridos");
      const order = await updateOrderStatus(id, estado);
      return ok(order);
    }

    return { statusCode: 405, body: "Method Not Allowed" };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

function ok(data, status = 200) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(data),
  };
}

function bad(msg) {
  return { statusCode: 400, body: JSON.stringify({ error: msg }) };
}
