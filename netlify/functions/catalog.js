const { supabase, getCatalog } = require("../../lib/supabase");

exports.handler = async (event) => {
  const method = event.httpMethod;
  const params = event.queryStringParameters || {};

  try {
    if (method === "GET") {
      const soloDisponible = params.all !== "true";
      const catalog = await getCatalog(soloDisponible);
      return ok(catalog);
    }

    if (method === "POST") {
      const body = JSON.parse(event.body);
      const { nombre, descripcion, precio, disponible = true } = body;
      if (!nombre || precio == null) return bad("nombre y precio son requeridos");
      const { data, error } = await supabase
        .from("catalogo")
        .insert({ nombre, descripcion, precio, disponible })
        .select()
        .single();
      if (error) throw error;
      return ok(data, 201);
    }

    if (method === "PATCH") {
      const body = JSON.parse(event.body);
      const { id, ...updates } = body;
      if (!id) return bad("id es requerido");
      const { data, error } = await supabase
        .from("catalogo")
        .update(updates)
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return ok(data);
    }

    if (method === "DELETE") {
      const id = params.id;
      if (!id) return bad("id es requerido");
      // Soft delete: marcar como no disponible
      const { data, error } = await supabase
        .from("catalogo")
        .update({ disponible: false })
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
