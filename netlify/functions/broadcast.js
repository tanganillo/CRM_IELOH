/**
 * Función programada: se ejecuta todos los días a las 8am (Argentina)
 * Configurado en netlify.toml: schedule = "0 11 * * *" (UTC = 8am ART)
 *
 * También puede dispararse manualmente via POST /api/broadcast
 */
const { getClientsWithoutRecentOrder } = require("../../lib/supabase");
const { broadcastText } = require("../../lib/whatsapp");

const MESSAGES = [
  "¡Hola {nombre}! 👋 Hace unos días que no te vemos por acá. ¿Necesitás hielo? Escribinos y te lo llevamos enseguida. 🧊 — *IELOH*",
  "¡Buen día {nombre}! ☀️ ¿Se te terminó el hielo? Tenemos stock disponible para entrega hoy. Escribí *pedido* para pedir. — *IELOH*",
  "¡Hola {nombre}! ¿Cómo andás? Recordá que en *IELOH* tenemos hielo fresco todos los días. ¡Pedí ahora y te lo llevamos! 🧊",
];

exports.handler = async (event) => {
  // Soporte para disparo manual desde el dashboard
  if (event.httpMethod === "POST") {
    const body = event.body ? JSON.parse(event.body) : {};
    const daysThreshold = body.days || 7;
    return runBroadcast(daysThreshold);
  }

  // Disparo automático por cron (event.httpMethod es undefined en scheduled functions)
  return runBroadcast(7);
};

async function runBroadcast(days = 7) {
  let clients;
  try {
    clients = await getClientsWithoutRecentOrder(days);
  } catch (err) {
    console.error("Error obteniendo clientes:", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }

  if (!clients.length) {
    console.log("Broadcast: No hay clientes sin pedido reciente.");
    return { statusCode: 200, body: JSON.stringify({ sent: 0, message: "No hay destinatarios" }) };
  }

  const phones = clients.map((c) => c.telefono);
  const msgTemplate = MESSAGES[new Date().getDay() % MESSAGES.length];

  // Personalizar y enviar uno a uno
  const results = [];
  for (const client of clients) {
    const text = msgTemplate.replace("{nombre}", client.nombre || "");
    try {
      const { broadcastText: bt } = require("../../lib/whatsapp");
      const r = await bt([client.telefono], text);
      results.push(...r);
    } catch (err) {
      results.push({ phone: client.telefono, ok: false, error: err.message });
    }
  }

  const sent = results.filter((r) => r.ok).length;
  console.log(`Broadcast completado: ${sent}/${clients.length} enviados`);

  return {
    statusCode: 200,
    body: JSON.stringify({ sent, total: clients.length, results }),
  };
}
