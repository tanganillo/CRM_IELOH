const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `Eres el asistente virtual de IELOH, una fábrica de hielo argentina.
Tu objetivo es ayudar a los clientes por WhatsApp a:
1. Consultar el catálogo de productos
2. Realizar pedidos
3. Consultar el estado de sus pedidos
4. Resolver dudas generales

Siempre responde en español rioplatense, de forma amigable y concisa.
Cuando el cliente quiera hacer un pedido, extrae: producto, cantidad y confirmación.
Cuando consulte un estado, confirma si quiere ver el último pedido o todos.

CATÁLOGO DISPONIBLE:
{catalog}

HISTORIAL RECIENTE DEL CLIENTE:
{history}

Responde SIEMPRE en formato JSON con esta estructura exacta:
{
  "intent": "catalogo" | "nuevo_pedido" | "consultar_estado" | "confirmacion_pedido" | "saludo" | "otro",
  "message": "Mensaje para el cliente en lenguaje natural",
  "order": {                          // solo si intent = nuevo_pedido o confirmacion_pedido
    "items": [{ "nombre": "...", "cantidad": 1, "precio": 0 }],
    "total": 0,
    "confirmado": false
  }
}`;

async function processMessage({ userMessage, catalog, history = [] }) {
  const systemWithContext = SYSTEM_PROMPT
    .replace("{catalog}", formatCatalog(catalog))
    .replace("{history}", formatHistory(history));

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: systemWithContext,
    messages: [{ role: "user", content: userMessage }],
  });

  const raw = response.content[0].text.trim();

  try {
    // Extraer JSON aunque venga con texto alrededor
    const match = raw.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : { intent: "otro", message: raw };
  } catch {
    return { intent: "otro", message: raw };
  }
}

function formatCatalog(catalog) {
  if (!catalog?.length) return "Sin productos disponibles.";
  return catalog
    .map((p) => `- ${p.nombre}: $${p.precio} (${p.descripcion})`)
    .join("\n");
}

function formatHistory(history) {
  if (!history?.length) return "Sin pedidos anteriores.";
  return history
    .slice(0, 3)
    .map((p) => `• Pedido #${p.id} (${p.estado}) - $${p.total} - ${new Date(p.created_at).toLocaleDateString("es-AR")}`)
    .join("\n");
}

module.exports = { processMessage };
