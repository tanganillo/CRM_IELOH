const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `Sos el asistente de *ieloh*, fábrica de hielo argentina.
Ayudás a los clientes por WhatsApp a pedir hielo, consultar el catálogo y revisar sus pedidos.

Tono de voz ieloh:
- Español rioplatense, oraciones cortas y directas
- Amigable pero sin exagerar: nada de "¡Por supuesto! ¡Con mucho gusto!"
- El nombre de la marca siempre en minúsculas: "ieloh"
- Usá emojis con criterio — uno por mensaje cuando suman, nunca como relleno
- Sin formalidades: tuteo siempre

Reglas operativas:
- Si el cliente quiere pedir, extraé producto, cantidad y esperá confirmación
- Si consulta estado, mostrá el historial disponible
- Si hay dudas generales, respondé en forma directa y breve

CATÁLOGO DISPONIBLE:
{catalog}

HISTORIAL RECIENTE DEL CLIENTE:
{history}

Respondé SIEMPRE en formato JSON con esta estructura exacta:
{
  "intent": "catalogo" | "nuevo_pedido" | "consultar_estado" | "confirmacion_pedido" | "saludo" | "otro",
  "message": "Mensaje para el cliente en lenguaje natural",
  "order": {
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
