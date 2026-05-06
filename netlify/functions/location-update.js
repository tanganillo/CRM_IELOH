const { updateRepartidorLocation } = require("../../lib/supabase");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const { id, latitud, longitud } = JSON.parse(event.body);
    if (!id || latitud == null || longitud == null) {
      return { statusCode: 400, body: JSON.stringify({ error: "id, latitud y longitud son requeridos" }) };
    }
    const data = await updateRepartidorLocation(id, latitud, longitud);
    return { statusCode: 200, body: JSON.stringify(data) };
  } catch (err) {
    console.error("location-update error:", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
