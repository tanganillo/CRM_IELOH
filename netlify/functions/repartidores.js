const { getRepartidores, createRepartidor, updateRepartidor } = require("../../lib/supabase");

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "GET") {
      const data = await getRepartidores();
      return { statusCode: 200, body: JSON.stringify(data) };
    }

    if (event.httpMethod === "POST") {
      const { nombre, telefono, camioneta, turno, zona } = JSON.parse(event.body);
      if (!nombre || !telefono || !camioneta || !turno) {
        return { statusCode: 400, body: JSON.stringify({ error: "nombre, telefono, camioneta y turno son requeridos" }) };
      }
      const data = await createRepartidor({ nombre, telefono, camioneta, turno, zona });
      return { statusCode: 201, body: JSON.stringify(data) };
    }

    if (event.httpMethod === "PATCH") {
      const { id, ...fields } = JSON.parse(event.body);
      if (!id) return { statusCode: 400, body: JSON.stringify({ error: "id requerido" }) };
      const data = await updateRepartidor(id, fields);
      return { statusCode: 200, body: JSON.stringify(data) };
    }

    return { statusCode: 405, body: "Method Not Allowed" };
  } catch (err) {
    console.error("repartidores error:", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
