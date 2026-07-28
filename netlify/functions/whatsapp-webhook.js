const { parseIncoming, sendText, sendInteractiveList, sendInteractiveButtons } = require("../../lib/whatsapp");
const { processMessage } = require("../../lib/claude");
const {
  getClientByPhone,
  upsertClient,
  getCatalog,
  getOrdersByClient,
  getLastOrderByClient,
  createOrder,
} = require("../../lib/supabase");

// Sesiones en memoria (se pierden al reiniciar — aceptable para Netlify Functions cortas)
const sessions = {};

exports.handler = async (event) => {
  // ── Verificación del webhook (GET) ──────────────────────────────────────────
  if (event.httpMethod === "GET") {
    const params = event.queryStringParameters || {};
    if (
      params["hub.mode"] === "subscribe" &&
      params["hub.verify_token"] === process.env.WHATSAPP_VERIFY_TOKEN
    ) {
      return { statusCode: 200, body: params["hub.challenge"] };
    }
    return { statusCode: 403, body: "Forbidden" };
  }

  // ── Procesamiento de mensaje entrante (POST) ────────────────────────────────
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: "Bad Request" };
  }

  const rawMessage = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  console.log("Mensaje entrante (raw):", JSON.stringify(rawMessage));

  const incoming = parseIncoming(body);
  console.log("Mensaje entrante (parseado):", JSON.stringify(incoming));
  if (!incoming) return { statusCode: 200, body: "ok" }; // ignorar notificaciones vacías

  const { from, name, text, interactiveId, type } = incoming;
  const isInteractive = type === "interactive" || type === "button";
  const userMessage = interactiveId || text;

  try {
    await handleMessage(from, name, userMessage, isInteractive);
  } catch (err) {
    console.error("Error manejando mensaje:", err);
    console.error('Meta error details:', JSON.stringify(err.response?.data, null, 2));
    await sendText(from, "Algo salió mal. Intentá de nuevo en un momento.");
  }

  // WhatsApp requiere 200 rápido para no reintentar
  return { statusCode: 200, body: "ok" };
};

// ── Lógica principal de conversación ─────────────────────────────────────────

async function handleMessage(from, name, userMessage, isInteractive) {
  // Registrar / recuperar cliente
  let client = await getClientByPhone(from);
  if (!client) {
    client = await upsertClient({ telefono: from, nombre: name });
    await sendText(
      from,
      `¡Hola ${name}! Soy el bot de *ieloh* 🧊\n\nEscribí *catálogo* para ver los productos o *pedido* para hacer uno.`
    );
    return;
  }

  const [catalog, history] = await Promise.all([
    getCatalog(),
    getOrdersByClient(client.id),
  ]);

  // Comandos rápidos sin IA para reducir latencia (texto libre o ids de botones/listas)
  const cmd = userMessage.toLowerCase().trim();
  if (cmd === "catalogo" || cmd === "catálogo" || cmd === "1" || cmd === "menu_catalogo") {
    await sendCatalog(from, catalog);
    return;
  }
  if (cmd === "estado" || cmd === "mis pedidos" || cmd === "2" || cmd === "menu_pedidos") {
    await sendOrderStatus(from, history);
    return;
  }
  if (cmd === "hola" || cmd === "menu" || cmd === "menú" || cmd === "ayuda") {
    await sendMainMenu(from, name);
    return;
  }
  if (cmd === "pedido" || cmd === "3" || cmd === "menu_nuevo_pedido") {
    await sendText(from, "Contame qué querés pedir, por ejemplo: *2 bolsas de hielo en cubo de 5kg*.");
    return;
  }
  if (cmd === "confirmar_pedido") {
    const session = sessions[from] || {};
    await confirmPendingOrder(from, client, session.pendingOrder);
    return;
  }
  if (cmd === "cancelar_pedido") {
    delete sessions[from];
    await sendText(from, "Pedido cancelado. Escribí *catálogo* para ver los productos o contame qué necesitás.");
    return;
  }
  if (cmd === "modificar_pedido") {
    await sendText(from, "Contame qué cambios querés hacer en tu pedido.");
    return;
  }

  // Un click de botón/lista que no matchea ningún id conocido nunca debe ir a Claude como texto libre
  if (isInteractive) {
    console.warn("Id interactivo no reconocido:", cmd);
    await sendMainMenu(from, name);
    return;
  }

  // Procesar con Claude
  const session = sessions[from] || {};
  const aiResponse = await processMessage({ userMessage, catalog, history });

  switch (aiResponse.intent) {
    case "catalogo":
      await sendCatalog(from, catalog);
      break;

    case "consultar_estado":
      await sendOrderStatus(from, history);
      break;

    case "nuevo_pedido":
      sessions[from] = { pendingOrder: aiResponse.order };
      if (aiResponse.order?.items?.length) {
        const resumen = formatOrderSummary(aiResponse.order);
        await sendInteractiveButtons(
          from,
          `${aiResponse.message}\n\n${resumen}`,
          [
            { id: "confirmar_pedido", title: "✅ Confirmar pedido" },
            { id: "modificar_pedido", title: "✏️ Modificar" },
            { id: "cancelar_pedido", title: "❌ Cancelar" },
          ]
        );
      } else {
        await sendText(from, aiResponse.message);
      }
      break;

    case "confirmacion_pedido":
      await confirmPendingOrder(from, client, session.pendingOrder || aiResponse.order);
      break;

    default:
      // Cancelar pedido pendiente si el usuario lo indica
      if (/cancelar/i.test(userMessage)) delete sessions[from];
      await sendText(from, aiResponse.message);
  }
}

// ── Helpers de respuesta ──────────────────────────────────────────────────────

const IS_SANDBOX = process.env.WHATSAPP_PHONE_NUMBER_ID === "1074563209079744";

async function sendMainMenu(to, name) {
  if (IS_SANDBOX) {
    await sendText(to, `¡Hola ${name}! ¿Qué necesitás?\n\n1. Catálogo\n2. Mis pedidos\n3. Hacer pedido`);
  } else {
    await sendInteractiveButtons(
      to,
      `¡Hola ${name}! ¿Qué necesitás?`,
      [
        { id: "menu_catalogo", title: "📋 Catálogo" },
        { id: "menu_pedidos", title: "📦 Mis pedidos" },
        { id: "menu_nuevo_pedido", title: "🛒 Hacer pedido" },
      ]
    );
  }
}

async function confirmPendingOrder(from, client, pending) {
  if (!pending?.items?.length) {
    await sendText(from, "No hay pedido pendiente. ¿Querés hacer uno nuevo?");
    return;
  }
  const order = await createOrder({
    cliente_id: client.id,
    items: pending.items,
    total: pending.total || calcTotal(pending.items),
  });
  delete sessions[from];
  await sendText(
    from,
    `✅ *Pedido #${order.id} confirmado*\n\n${formatOrderSummary(pending)}\n\nTotal: $${order.total}\n\nTe avisamos cuando salga. ¡Gracias por elegirnos!`
  );
}

async function sendCatalog(to, catalog) {
  if (!catalog.length) {
    await sendText(to, "Por ahora no hay productos disponibles. Volvé a consultar más tarde.");
    return;
  }
  const sections = [
    {
      title: "Productos",
      rows: catalog.map((p) => ({
        id: `cat_${p.id}`,
        title: p.nombre,
        description: `$${p.precio} · ${p.descripcion}`,
      })),
    },
  ];
  await sendInteractiveList(to, "Estos son los productos de *ieloh* 🧊", "Ver productos", sections);
}

async function sendOrderStatus(to, orders) {
  if (!orders.length) {
    await sendText(to, "Todavía no tenés pedidos. Escribí *catálogo* para ver los productos.");
    return;
  }
  const STATUS_EMOJI = {
    pendiente:  "🕐",
    confirmado: "✅",
    en_camino:  "🚚",
    entregado:  "📦",
    cancelado:  "❌",
  };
  const lines = orders.slice(0, 5).map((o) => {
    const emoji = STATUS_EMOJI[o.estado] || "•";
    const fecha = new Date(o.created_at).toLocaleDateString("es-AR");
    return `${emoji} *#${o.id}* · ${o.estado.replace("_", " ")} · $${o.total} · ${fecha}`;
  });
  await sendText(to, `*Tus últimos pedidos*\n\n${lines.join("\n")}`);
}

function formatOrderSummary(order) {
  if (!order?.items?.length) return "";
  const lines = order.items.map((i) => `• ${i.cantidad}x ${i.nombre} — $${i.precio * i.cantidad}`);
  return lines.join("\n");
}

function calcTotal(items) {
  return items.reduce((sum, i) => sum + (i.precio || 0) * (i.cantidad || 1), 0);
}
