const axios = require("axios");
const { supabase } = require("../../lib/supabase");
const { sendText } = require("../../lib/whatsapp");

const MAX_KM = 5;
const GPS_STALE_MINUTES = 15;

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const { pedido_id } = JSON.parse(event.body);

    // Obtener pedido con cliente
    const { data: order, error: orderErr } = await supabase
      .from("pedidos")
      .select("*, clientes(nombre, telefono, direccion)")
      .eq("id", pedido_id)
      .single();
    if (orderErr) throw orderErr;

    if (!order?.clientes?.direccion) {
      return { statusCode: 200, body: JSON.stringify({ found: false, reason: "El cliente no tiene dirección registrada" }) };
    }

    // Geocodificar dirección con Nominatim (OpenStreetMap)
    const geoRes = await axios.get("https://nominatim.openstreetmap.org/search", {
      params: { q: order.clientes.direccion, format: "json", limit: 1, countrycodes: "ar" },
      headers: { "User-Agent": "IELOH-CRM/1.0 tanganillo@gmail.com" },
      timeout: 5000,
    });

    if (!geoRes.data?.length) {
      return { statusCode: 200, body: JSON.stringify({ found: false, reason: "No se pudo geocodificar la dirección" }) };
    }

    const orderLat = parseFloat(geoRes.data[0].lat);
    const orderLon = parseFloat(geoRes.data[0].lon);

    // Buscar repartidores disponibles con GPS reciente
    const staleThreshold = new Date(Date.now() - GPS_STALE_MINUTES * 60 * 1000).toISOString();
    const { data: repartidores, error: repErr } = await supabase
      .from("repartidores")
      .select("*")
      .eq("disponible", true)
      .gte("ultima_actualizacion", staleThreshold)
      .not("latitud", "is", null);
    if (repErr) throw repErr;

    if (!repartidores?.length) {
      return { statusCode: 200, body: JSON.stringify({ found: false, reason: "No hay repartidores disponibles con GPS activo" }) };
    }

    // Ordenar por distancia
    const sorted = repartidores
      .map((r) => ({ ...r, distancia: haversine(orderLat, orderLon, r.latitud, r.longitud) }))
      .sort((a, b) => a.distancia - b.distancia);

    const nearest = sorted[0];
    if (nearest.distancia > MAX_KM) {
      return {
        statusCode: 200,
        body: JSON.stringify({ found: false, reason: `Repartidor más cercano a ${nearest.distancia.toFixed(1)} km (máx ${MAX_KM} km)` }),
      };
    }

    // Notificar por WhatsApp
    const items = Array.isArray(order.items) ? order.items : [];
    const resumen = items.map((i) => `• ${i.cantidad}x ${i.nombre}`).join("\n");
    const mapsLink = `https://maps.google.com/?q=${encodeURIComponent(order.clientes.direccion)}`;

    await sendText(
      nearest.telefono,
      `🚨 *Pedido no planificado cerca tuyo!*\n\n` +
        `*Pedido #${order.id}* — ${order.clientes.nombre}\n${resumen}\n` +
        `Total: $${order.total}\n\n` +
        `📍 ${order.clientes.direccion}\n🗺️ ${mapsLink}\n` +
        `📏 Distancia aprox: ${nearest.distancia.toFixed(1)} km`
    );

    return {
      statusCode: 200,
      body: JSON.stringify({ found: true, repartidor: nearest.nombre, distancia: nearest.distancia.toFixed(1) }),
    };
  } catch (err) {
    console.error("nearby-delivery error:", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
