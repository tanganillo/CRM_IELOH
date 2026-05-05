const { supabase, upsertClient } = require("../../lib/supabase");

exports.handler = async (event) => {
  const method = event.httpMethod;
  const params = event.queryStringParameters || {};

  try {
    if (method === "GET") {
      const { data, error } = await supabase
        .from("clientes")
        .select("*")
        .order("created_at", { ascending: false })
        .range(0, (Number(params.limit) || 100) - 1);
      if (error) throw error;
      return ok(data);
    }

    if (method === "POST") {
      const body = JSON.parse(event.body);
      const client = await upsertClient(body);
      return ok(client, 201);
    }

    if (method === "PATCH") {
      const body = JSON.parse(event.body);
      const { id, ...updates } = body;
      if (!id) return bad("id es requerido");
      const { data, error } = await supabase
        .from("clientes")
        .update(updates)
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return ok(data);
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
