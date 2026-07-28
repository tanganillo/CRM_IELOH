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

// ── Tolerancia a typos en la detección de intención de pedido ───────────────────
// Sin costo de API: distancia de Levenshtein contra un diccionario chico de palabras
// clave, usada solo para corregir texto libre antes de correr ORDER_INTENT_RE.
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

const ORDER_KEYWORDS = [
  "agregar", "sumar", "pedido", "producto", "productos",
  "comprar", "necesito", "quiero", "hacer", "otro", "nuevo", "pedir", "hielo", "algo",
];

// Reemplaza, palabra por palabra, cualquier token "parecido" a una keyword conocida por
// la keyword misma. Umbrales conservadores a propósito (largo mínimo 4, distancia máxima
// 1 para palabras cortas) para no corromper palabras sueltas ajenas al vocabulario del
// pedido; aunque una palabra se corrija de más, ORDER_INTENT_RE igual exige combinaciones
// de 2+ keywords consecutivas, así que un solo token corregido de más no dispara nada solo.
function correctTypos(text, keywords) {
  return text
    .split(/(\s+)/)
    .map((token) => {
      if (!token.trim()) return token;
      const bare = token.replace(/[^\p{L}\p{N}]/gu, "");
      if (bare.length < 4) return token;
      let best = null;
      let bestDist = Infinity;
      for (const kw of keywords) {
        if (Math.abs(kw.length - bare.length) > 1) continue;
        const maxDist = kw.length <= 6 ? 1 : 2;
        const dist = levenshtein(bare, kw);
        if (dist <= maxDist && dist < bestDist) {
          best = kw;
          bestDist = dist;
        }
      }
      return best || token;
    })
    .join("");
}

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

    // Punto único de chequeo: recién acá se sabe que se está por agregar el primer producto
    // a un pendingOrder vacío/nuevo. Si ya hay un carrito en curso (agregar_otro) o esta
    // sesión ya resolvió la pregunta, no se vuelve a interrumpir.
    const session = sessions[from] || {};
    const cartInProgress = session.pendingOrder?.items?.length > 0;
    if (!cartInProgress && !session.orderFlowResolved) {
      const existing = history.find((o) => UNDELIVERED_STATES.has(o.estado));
      if (existing) {
        sessions[from] = { ...session, pendingOrderCandidate: existing, pendingProductSelection: product };
        await offerUndeliveredOrderChoice(from, existing);
        return;
      }
    }

    await askQuantity(from, product, history);
    return;
  }

  // Respuesta a "tenés un pedido sin entregar" — el usuario elige sumar a ese pedido
  if (cmd.startsWith("usar_pedido_")) {
    const orderId = cmd.slice("usar_pedido_".length);
    const candidate = sessions[from]?.pendingOrderCandidate;
    const resumeProduct = sessions[from]?.pendingProductSelection;
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
    if (resumeProduct) {
      await askQuantity(from, resumeProduct, history);
      return;
    }
    await sendCatalog(from, catalog);
    return;
  }

  // Respuesta a "tenés un pedido sin entregar" — el usuario prefiere uno nuevo aparte
  if (cmd === "pedido_nuevo") {
    const resumeProduct = sessions[from]?.pendingProductSelection;
    sessions[from] = { pendingOrder: { items: [] }, orderFlowResolved: true };
    if (resumeProduct) {
      await askQuantity(from, resumeProduct, history);
      return;
    }
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

  // "Mis pedidos" → ver el historial completo (incluye entregados y cancelados)
  if (cmd === "mp_historial") {
    await sendOrderHistory(from, history);
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
  // El \b final se reemplaza por un lookahead: en JS \b no reconoce vocales acentuadas
  // como caracteres de palabra, así que "dejaló"/"olvídalo" no matcheaban con \b al final.
  const CANCEL_INTENT_RE = /\b(cancelar|no\s+quiero|ning[uú]no|dejal[oó]|olv[ií]dalo)(?![a-záéíóúñ])/;
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
  } else if (awaitingProduct && cmd === "qty_otra") {
    // Pidió el botón de cantidad libre: seguimos esperando, la próxima respuesta se
    // interpreta como número por el branch de texto libre de más abajo.
    await sendText(from, "Decime la cantidad en números, por ejemplo: 2");
    return;
  } else if (awaitingProduct && cmd.startsWith("qty_")) {
    // Tocó uno de los botones de cantidad sugerida (ids que generamos nosotros mismos,
    // siempre un entero positivo válido).
    const qty = parseInt(cmd.slice(4), 10);
    await addItemToPendingOrder(from, awaitingProduct, qty);
    return;
  } else if (awaitingProduct) {
    // Cantidad escrita a mano (ya sea directo o después de tocar "Otra cantidad")
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
    await addItemToPendingOrder(from, awaitingProduct, qty);
    return;
  }

  // Comandos rápidos sin IA para reducir latencia (texto libre o ids de botones/listas)
  if (cmd === "catalogo" || cmd === "catálogo" || cmd === "1" || cmd === "menu_catalogo") {
    await sendCatalog(from, catalog);
    return;
  }
  // "estado"/"mis pedidos" ya cubre los atajos exactos; ORDER_DETAIL_RE suma frases en
  // texto libre que piden lo mismo ("qué pedí", "detalle del pedido", "mostrame el
  // detalle") — sendOrderStatus ya incluye el detalle de items, así que alcanza con
  // enrutarlas al mismo lugar, sin necesidad de rastrear si "recién" consultaron Mis pedidos.
  const ORDER_DETAIL_RE =
    /\bqu[eé]\s+ped[ií](?![a-záéíóúñ])|\bdetalle\s+(del|de\s+mi)?\s*pedido\b|\bmostrame?\s+el\s+detalle\b|\bver\s+detalle\b/;
  if (
    cmd === "estado" ||
    cmd === "mis pedidos" ||
    cmd === "2" ||
    cmd === "menu_pedidos" ||
    (!isInteractive && ORDER_DETAIL_RE.test(cmd))
  ) {
    await sendOrderStatus(from, history);
    return;
  }
  if (cmd === "hola" || cmd === "menu" || cmd === "menú" || cmd === "ayuda" || cmd === "menu_principal") {
    await sendMainMenu(from, name);
    return;
  }
  if (cmd === "pedido" || cmd === "3" || cmd === "menu_nuevo_pedido") {
    await sendCatalog(from, catalog);
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
  // "necesito hielo", "agregar producto al pedido") — dispara el mismo catálogo que el
  // botón "Hacer pedido", sin pasar por Claude. Sin este short-circuit, frases así caen
  // en el fallback de Claude ("otro"/"saludo"), que a veces recita el catálogo entero
  // como texto plano en vez de la lista interactiva. Se corrigen typos comunes de las
  // keywords (agregaqr, prodcuto, necestio, etc.) antes de evaluar el regex.
  const ORDER_INTENT_RE =
    /\b(hacer|otro|nuevo|quiero)\s+(un\s+)?pedido\b|\bquiero\s+pedir\b|\bpedir\s+algo\b|\b(necesito|quiero)\s+(hielo|comprar)\b|\b(agregar|sumar)\s+(un\s+|otro\s+)?(producto|productos|algo)(\s+(al|a\s+mi)\s+pedido)?\b/;
  if (!isInteractive && ORDER_INTENT_RE.test(correctTypos(cmd, ORDER_KEYWORDS))) {
    await sendCatalog(from, catalog);
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

      if (aiResponse.parseFailed) {
        // Claude no devolvió el JSON esperado -- no hay forma de confiar en aiResponse.message
        // (puede venir con formato raro, incompleto, etc.), así que no lo relayamos tal cual.
        console.warn("Respuesta de Claude no parseable como JSON, usando mensaje de 'no entendí'");
        await sendText(
          from,
          `No entendí bien eso 🤔 ¿Podés reformularlo? Por ejemplo: "quiero hacer un pedido" o "ver catálogo".`
        );
      } else if (looksLikeCatalogRecitation(aiResponse.message, catalog)) {
        // El JSON parseó bien pero Claude decidió listar el catálogo en prosa en vez de
        // clasificarlo como intent "catalogo" -- lo corregimos mostrando la lista real.
        console.warn("Claude recitó el catálogo en texto plano, redirigiendo a sendCatalog");
        await sendCatalog(from, catalog);
      } else {
        await sendText(from, aiResponse.message);
      }
  }
}

// Heurística para detectar cuando Claude, en vez de responder puntual, terminó listando
// varios productos del catálogo en prosa (mismo síntoma que motivó ORDER_INTENT_RE, para
// los casos que ni así se logran cubrir). Si aparecen 3+ nombres de producto reales, es
// casi seguro que está recitando el catálogo entero, no respondiendo una pregunta puntual.
function looksLikeCatalogRecitation(message, catalog) {
  if (!message || !catalog?.length) return false;
  const lower = message.toLowerCase();
  const mentioned = catalog.filter((p) => lower.includes(p.nombre.toLowerCase())).length;
  return mentioned >= 3;
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

// Ofrece sumar al pedido sin entregar o armar uno nuevo aparte. Se dispara justo antes de
// agregar el primer producto a un pendingOrder vacío/nuevo (ver el handler de "cat_"), así
// cubre por igual el camino de "Catálogo" y el de "Hacer pedido" sin duplicar el chequeo.
async function offerUndeliveredOrderChoice(from, existing) {
  await sendInteractiveButtons(
    from,
    `Tenés un pedido *#${existing.id}* sin entregar todavía:\n\n${formatOrderSummary(existing)}\n\nTotal: $${existing.total}\n\n¿Sumamos productos a ese pedido o hacemos uno nuevo por separado?`,
    [
      { id: `usar_pedido_${existing.id}`, title: "➕ Sumar al pedido" },
      { id: "pedido_nuevo", title: "🆕 Pedido nuevo" },
    ]
  );
}

// Cantidades genéricas cuando el cliente nunca pidió este producto antes. Se eligieron
// botones en vez de caer al texto libre para que la experiencia sea siempre la misma
// (nunca sorprende con un prompt distinto), aunque no haya historial que personalizar.
const GENERIC_QUANTITY_FALLBACK = [2, 5];

// Busca, en el historial ya cargado del cliente (más reciente primero), las cantidades
// distintas que pidió de este mismo producto — sin repetir valores ya vistos. No hace
// falta una query nueva a Supabase: history ya trae los pedidos con sus items JSONB.
function getQuantitySuggestions(history, productName) {
  const seen = new Set();
  const suggestions = [];
  for (const order of history) {
    for (const item of order.items || []) {
      if (item.nombre !== productName || seen.has(item.cantidad)) continue;
      seen.add(item.cantidad);
      suggestions.push(item.cantidad);
      if (suggestions.length >= 2) return suggestions;
    }
  }
  return suggestions;
}

async function askQuantity(from, product, history) {
  sessions[from] = { ...(sessions[from] || {}), awaitingQuantityFor: product, awaitingQuantityRetries: 0 };

  const suggested = getQuantitySuggestions(history, product.nombre);
  const quantities = suggested.length ? suggested : GENERIC_QUANTITY_FALLBACK;

  await sendInteractiveButtons(
    from,
    `*${product.nombre}* — $${product.precio}\n${product.descripcion || ""}\n\n¿Cuántas unidades querés?`,
    [
      ...quantities.map((q) => ({ id: `qty_${q}`, title: `${q} unidades` })),
      { id: "qty_otra", title: "✏️ Otra cantidad" },
    ]
  );
}

async function addItemToPendingOrder(from, product, qty) {
  const pending = sessions[from]?.pendingOrder || { items: [] };
  const existingItem = pending.items.find((i) => i.nombre === product.nombre);
  if (existingItem) {
    existingItem.cantidad += qty;
  } else {
    pending.items.push({ nombre: product.nombre, cantidad: qty, precio: product.precio });
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
}

// WhatsApp corta (o rechaza) las filas de listas interactivas con título de más de 24 caracteres
function truncateTitle(text, maxLen = 24) {
  if (!text || text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 3)}...`;
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
        title: truncateTitle(p.nombre),
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

const STATUS_EMOJI = {
  pendiente:  "🕐",
  confirmado: "✅",
  en_camino:  "🚚",
  entregado:  "📦",
  cancelado:  "❌",
};

function formatOrderLine(o) {
  const emoji = STATUS_EMOJI[o.estado] || "•";
  const fecha = new Date(o.created_at).toLocaleDateString("es-AR");
  return `${emoji} *#${o.id}* · ${o.estado.replace("_", " ")} · $${o.total} · ${fecha}`;
}

// Vista por defecto de "Mis pedidos": solo los activos (sin entregar), con opción de
// cancelar y de saltar al historial completo si hace falta ver entregados/cancelados.
async function sendOrderStatus(to, orders) {
  const active = orders.filter((o) => UNDELIVERED_STATES.has(o.estado)).slice(0, 5);

  if (!active.length) {
    await sendText(to, "No tenés pedidos activos en este momento.");
    if (orders.length) {
      await sendInteractiveButtons(to, "¿Querés ver pedidos anteriores?", [
        { id: "mp_historial", title: "📜 Ver historial" },
        { id: "menu_principal", title: "🏠 Menú principal" },
      ]);
    }
    return;
  }

  // Detalle completo (encabezado + items) de cada pedido activo. Los activos son pocos por
  // naturaleza (se entregan o cancelan rápido), así que casi siempre entra cómodo en un
  // solo mensaje; si alguna vez no entrara, caemos al resumen corto de antes en vez de
  // arriesgarnos a que WhatsApp corte o rechace el mensaje por longitud.
  const detailedBlocks = active.map((o) => {
    const items = formatOrderSummary(o);
    return items ? `${formatOrderLine(o)}\n${items}` : formatOrderLine(o);
  });
  const detailedText = `*Tus pedidos activos*\n\n${detailedBlocks.join("\n\n")}`;
  const MAX_TEXT_LENGTH = 3500;
  const statusText =
    detailedText.length <= MAX_TEXT_LENGTH
      ? detailedText
      : `*Tus pedidos activos*\n\n${active.map(formatOrderLine).join("\n")}`;
  await sendText(to, statusText);

  const cancelable = active.filter((o) => CANCELABLE_STATES.has(o.estado));
  const sections = [
    {
      title: "Pedidos",
      rows: [
        ...cancelable.map((o) => ({
          id: `mp_cancelar_${o.id}`,
          title: `Cancelar #${o.id}`,
          description: `$${o.total} · ${o.estado}`,
        })),
        { id: "mp_historial", title: "Ver historial completo", description: "Incluye entregados y cancelados" },
        { id: "mp_salir", title: "No cancelar nada", description: "Volver al menú principal" },
      ],
    },
  ];
  await sendInteractiveList(to, "¿Querés cancelar algún pedido o ver más?", "Elegir opción", sections);
}

// "Ver historial completo": los últimos pedidos sin filtrar por estado, solo informativo.
async function sendOrderHistory(to, orders) {
  if (!orders.length) {
    await sendText(to, "Todavía no tenés pedidos. Escribí *catálogo* para ver los productos.");
    return;
  }
  const shown = orders.slice(0, 5);
  await sendText(to, `*Historial de pedidos*\n\n${shown.map(formatOrderLine).join("\n")}`);
}

function formatOrderSummary(order) {
  if (!order?.items?.length) return "";
  const lines = order.items.map((i) => `• ${i.cantidad}x ${i.nombre} — $${i.precio * i.cantidad}`);
  return lines.join("\n");
}

function calcTotal(items) {
  return items.reduce((sum, i) => sum + (i.precio || 0) * (i.cantidad || 1), 0);
}
