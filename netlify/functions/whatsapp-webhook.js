const { parseIncoming, sendText, sendInteractiveList, sendInteractiveButtons } = require("../../lib/whatsapp");
const { processMessage } = require("../../lib/claude");
const {
  getClientByPhone,
  upsertClient,
  getCatalog,
  getOrdersByClient,
  getLastOrderByClient,
  createOrder,
  updateOrderItems,
  updateOrderStatus,
} = require("../../lib/supabase");

// Sesiones en memoria (se pierden al reiniciar — aceptable para Netlify Functions cortas)
const sessions = {};

// Estados de pedidos.estado que todavía no llegaron al cliente
const UNDELIVERED_STATES = new Set(["pendiente", "confirmado", "en_camino"]);
// Estados desde los que todavía tiene sentido cancelar un pedido
const CANCELABLE_STATES = new Set(["pendiente", "confirmado"]);

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

  const { from, name, text, interactiveId, interactiveKind, type } = incoming;
  const isInteractive = type === "interactive" || type === "button";
  const userMessage = interactiveId || text;

  try {
    await handleMessage(from, name, userMessage, isInteractive, interactiveKind);
  } catch (err) {
    console.error("Error manejando mensaje:", err);
    console.error('Meta error details:', JSON.stringify(err.response?.data, null, 2));
    await sendText(from, "Algo salió mal. Intentá de nuevo en un momento.");
  }

  // WhatsApp requiere 200 rápido para no reintentar
  return { statusCode: 200, body: "ok" };
};

// ── Lógica principal de conversación ─────────────────────────────────────────

async function handleMessage(from, name, userMessage, isInteractive, interactiveKind) {
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

  const cmd = userMessage.toLowerCase().trim();

  // Selección de un producto desde la lista interactiva del catálogo (list_reply, id "cat_<id>")
  if (cmd.startsWith("cat_")) {
    const productId = cmd.slice(4);
    const product = catalog.find((p) => String(p.id) === productId);
    console.log("Selección de lista (list_reply):", {
      id: cmd,
      kind: interactiveKind,
      matched: !!product,
      productId: product?.id,
      productName: product?.nombre,
    });
    if (!product) {
      console.warn("Producto no encontrado para id de lista:", cmd);
      await sendText(from, "Ese producto ya no está disponible. Volvé a mirar el catálogo.");
      await sendCatalog(from, catalog);
      return;
    }
    sessions[from] = { ...(sessions[from] || {}), awaitingQuantityFor: product, awaitingQuantityRetries: 0 };
    await sendText(
      from,
      `*${product.nombre}* — $${product.precio}\n${product.descripcion || ""}\n\n¿Cuántas unidades querés?`
    );
    return;
  }

  // Respuesta a "tenés un pedido sin entregar" — el usuario elige sumar a ese pedido
  if (cmd.startsWith("usar_pedido_")) {
    const orderId = cmd.slice("usar_pedido_".length);
    const candidate = sessions[from]?.pendingOrderCandidate;
    if (!candidate || String(candidate.id) !== orderId) {
      console.warn("Pedido candidato no coincide o ya no está disponible:", { orderId, candidateId: candidate?.id });
      await sendText(from, "Ese pedido ya no está disponible para modificar. Te muestro el catálogo para armar uno nuevo.");
      sessions[from] = { pendingOrder: { items: [] }, orderFlowResolved: true };
      await sendCatalog(from, catalog);
      return;
    }
    sessions[from] = {
      pendingOrder: {
        items: JSON.parse(JSON.stringify(candidate.items || [])),
        total: candidate.total,
        existingOrderId: candidate.id,
      },
      orderFlowResolved: true,
    };
    await sendCatalog(from, catalog);
    return;
  }

  // Respuesta a "tenés un pedido sin entregar" — el usuario prefiere uno nuevo aparte
  if (cmd === "pedido_nuevo") {
    sessions[from] = { pendingOrder: { items: [] }, orderFlowResolved: true };
    await sendCatalog(from, catalog);
    return;
  }

  // "Mis pedidos" → el usuario eligió un pedido para cancelar: pedir confirmación explícita
  if (cmd.startsWith("mp_cancelar_")) {
    const orderId = cmd.slice("mp_cancelar_".length);
    const order = history.find((o) => String(o.id) === orderId && CANCELABLE_STATES.has(o.estado));
    if (!order) {
      console.warn("Pedido no cancelable o no encontrado:", orderId);
      await sendText(from, "Ese pedido ya no se puede cancelar (puede haber cambiado de estado).");
      await sendMainMenu(from, name);
      return;
    }
    await sendInteractiveButtons(
      from,
      `¿Confirmás cancelar el pedido *#${order.id}* por $${order.total}?`,
      [
        { id: `mp_confirmar_${order.id}`, title: "✅ Sí, cancelar" },
        { id: `mp_no_${order.id}`, title: "❌ No, dejarlo" },
      ]
    );
    return;
  }

  // "Mis pedidos" → confirmación explícita de la cancelación
  if (cmd.startsWith("mp_confirmar_")) {
    const orderId = cmd.slice("mp_confirmar_".length);
    const order = history.find((o) => String(o.id) === orderId && CANCELABLE_STATES.has(o.estado));
    if (!order) {
      await sendText(from, "Ese pedido ya no se puede cancelar (puede haber cambiado de estado).");
      await sendMainMenu(from, name);
      return;
    }
    await updateOrderStatus(order.id, "cancelado");
    await sendText(from, `❌ *Pedido #${order.id} cancelado.*`);
    await sendMainMenu(from, name);
    return;
  }

  // "Mis pedidos" → el usuario decide no cancelar nada
  if (cmd === "mp_salir" || cmd.startsWith("mp_no_")) {
    await sendText(from, "Listo, no cancelamos nada. 👍");
    await sendMainMenu(from, name);
    return;
  }

  // Respuesta de cantidad para un producto elegido en el paso anterior.
  // "1"/"2"/"3" quedan afuera del escape porque ahí casi siempre significan cantidad,
  // no el atajo numérico del menú de sandbox.
  const ESCAPE_CMDS = new Set([
    "catalogo", "catálogo", "menu_catalogo",
    "estado", "mis pedidos", "menu_pedidos",
    "hola", "menu", "menú", "ayuda", "menu_principal",
    "pedido", "menu_nuevo_pedido",
    "confirmar_pedido", "cancelar_pedido", "modificar_pedido", "agregar_otro",
  ]);
  const CANCEL_INTENT_RE = /\b(cancelar|no\s+quiero|ning[uú]no|dejal[oó]|olvid[aá]lo)\b/;
  const NEXT_STEP_BUTTONS = [
    { id: "menu_catalogo", title: "📋 Ver catálogo" },
    { id: "menu_principal", title: "🏠 Menú principal" },
  ];

  const awaitingProduct = sessions[from]?.awaitingQuantityFor;
  if (awaitingProduct && ESCAPE_CMDS.has(cmd)) {
    delete sessions[from].awaitingQuantityFor;
    delete sessions[from].awaitingQuantityRetries;
  } else if (awaitingProduct && CANCEL_INTENT_RE.test(cmd)) {
    delete sessions[from].awaitingQuantityFor;
    delete sessions[from].awaitingQuantityRetries;
    await sendInteractiveButtons(
      from,
      `Listo, no agregamos *${awaitingProduct.nombre}*. ¿Querés ver otro producto o volver al menú?`,
      NEXT_STEP_BUTTONS
    );
    return;
  } else if (awaitingProduct) {
    const qty = parseInt(cmd, 10);
    if (!Number.isFinite(qty) || qty <= 0) {
      const retries = (sessions[from].awaitingQuantityRetries || 0) + 1;
      sessions[from].awaitingQuantityRetries = retries;
      if (retries >= 2) {
        await sendInteractiveButtons(
          from,
          `Sigo sin entender la cantidad para *${awaitingProduct.nombre}* 🤔\n\nEscribime un número, o elegí una opción:`,
          NEXT_STEP_BUTTONS
        );
      } else {
        await sendText(from, "Decime la cantidad en números, por ejemplo: 2");
      }
      return;
    }
    const pending = sessions[from]?.pendingOrder || { items: [] };
    const existingItem = pending.items.find((i) => i.nombre === awaitingProduct.nombre);
    if (existingItem) {
      existingItem.cantidad += qty;
    } else {
      pending.items.push({ nombre: awaitingProduct.nombre, cantidad: qty, precio: awaitingProduct.precio });
    }
    pending.total = calcTotal(pending.items);
    sessions[from] = { pendingOrder: pending };

    const resumen = formatOrderSummary(pending);
    await sendInteractiveButtons(
      from,
      `Agregado ✅\n\n${resumen}\n\nTotal: $${pending.total}\n\n¿Confirmamos el pedido o agregamos algo más?`,
      [
        { id: "confirmar_pedido", title: "✅ Confirmar pedido" },
        { id: "agregar_otro", title: "➕ Agregar otro" },
        { id: "cancelar_pedido", title: "❌ Cancelar" },
      ]
    );
    return;
  }

  // Comandos rápidos sin IA para reducir latencia (texto libre o ids de botones/listas)
  if (cmd === "catalogo" || cmd === "catálogo" || cmd === "1" || cmd === "menu_catalogo") {
    await sendCatalog(from, catalog);
    return;
  }
  if (cmd === "estado" || cmd === "mis pedidos" || cmd === "2" || cmd === "menu_pedidos") {
    await sendOrderStatus(from, history);
    return;
  }
  if (cmd === "hola" || cmd === "menu" || cmd === "menú" || cmd === "ayuda" || cmd === "menu_principal") {
    await sendMainMenu(from, name);
    return;
  }
  if (cmd === "pedido" || cmd === "3" || cmd === "menu_nuevo_pedido") {
    await startOrderFlow(from, client, catalog, history);
    return;
  }
  if (cmd === "agregar_otro") {
    await sendCatalog(from, catalog);
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

  // Intención de hacer un pedido en texto libre (ej: "otro pedido", "quiero pedir algo",
  // "necesito hielo") — dispara el mismo catálogo que el botón "Hacer pedido", sin pasar por Claude.
  const ORDER_INTENT_RE =
    /\b(hacer|otro|nuevo|quiero)\s+(un\s+)?pedido\b|\bquiero\s+pedir\b|\bpedir\s+algo\b|\b(necesito|quiero)\s+(hielo|comprar)\b/;
  if (!isInteractive && ORDER_INTENT_RE.test(cmd)) {
    await startOrderFlow(from, client, catalog, history);
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
  const total = pending.total || calcTotal(pending.items);
  const order = pending.existingOrderId
    ? await updateOrderItems(pending.existingOrderId, { items: pending.items, total })
    : await createOrder({ cliente_id: client.id, items: pending.items, total });
  delete sessions[from];
  const accion = pending.existingOrderId ? "actualizado" : "confirmado";
  await sendText(
    from,
    `✅ *Pedido #${order.id} ${accion}*\n\n${formatOrderSummary(pending)}\n\nTotal: $${order.total}\n\nTe avisamos cuando salga. ¡Gracias por elegirnos!`
  );
}

// Antes de mostrar el catálogo para armar un pedido nuevo, chequea si el cliente ya tiene
// uno sin entregar y ofrece sumarle productos en vez de crear uno aparte por accidente.
async function startOrderFlow(from, client, catalog, history) {
  const session = sessions[from] || {};
  if (session.pendingOrder?.items?.length || session.orderFlowResolved) {
    await sendCatalog(from, catalog);
    return;
  }

  const existing = history.find((o) => UNDELIVERED_STATES.has(o.estado));
  if (!existing) {
    await sendCatalog(from, catalog);
    return;
  }

  sessions[from] = { ...session, pendingOrderCandidate: existing };
  await sendInteractiveButtons(
    from,
    `Tenés un pedido *#${existing.id}* sin entregar todavía:\n\n${formatOrderSummary(existing)}\n\nTotal: $${existing.total}\n\n¿Sumamos productos a ese pedido o hacemos uno nuevo por separado?`,
    [
      { id: `usar_pedido_${existing.id}`, title: "➕ Sumar al pedido" },
      { id: "pedido_nuevo", title: "🆕 Pedido nuevo" },
    ]
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
  await sendInteractiveList(
    to,
    "Estos son los productos de *ieloh* 🧊\nElegí uno para agregarlo — después vas a poder sumar más antes de confirmar.",
    "Ver productos",
    sections
  );
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
  const shown = orders.slice(0, 5);
  const lines = shown.map((o) => {
    const emoji = STATUS_EMOJI[o.estado] || "•";
    const fecha = new Date(o.created_at).toLocaleDateString("es-AR");
    return `${emoji} *#${o.id}* · ${o.estado.replace("_", " ")} · $${o.total} · ${fecha}`;
  });
  await sendText(to, `*Tus últimos pedidos*\n\n${lines.join("\n")}`);

  const cancelable = shown.filter((o) => CANCELABLE_STATES.has(o.estado));
  if (!cancelable.length) return;

  const sections = [
    {
      title: "Pedidos",
      rows: [
        ...cancelable.map((o) => ({
          id: `mp_cancelar_${o.id}`,
          title: `Cancelar #${o.id}`,
          description: `$${o.total} · ${o.estado}`,
        })),
        { id: "mp_salir", title: "No cancelar nada", description: "Volver al menú principal" },
      ],
    },
  ];
  await sendInteractiveList(to, "¿Querés cancelar algún pedido?", "Elegir pedido", sections);
}

function formatOrderSummary(order) {
  if (!order?.items?.length) return "";
  const lines = order.items.map((i) => `• ${i.cantidad}x ${i.nombre} — $${i.precio * i.cantidad}`);
  return lines.join("\n");
}

function calcTotal(items) {
  return items.reduce((sum, i) => sum + (i.precio || 0) * (i.cantidad || 1), 0);
}
