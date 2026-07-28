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

Clasificación de intent — leé con atención, esto es lo más importante de tu respuesta:
- "catalogo": el cliente quiere ver productos, arrancar un pedido nuevo sin especificar
  ítems todavía, o agregar/sumar algo a un pedido que ya tiene en curso -- aunque no diga
  "catálogo" explícitamente (ej: "sumar al pedido", "agregar algo", "quiero pedir de nuevo").
- "nuevo_pedido": ya especificó qué productos y cantidades quiere.
- "consultar_estado": pregunta por sus pedidos o el estado de alguno.
- "confirmacion_pedido": confirma un pedido que ya se le había resumido.
- "saludo": saludo genérico sin pedir nada puntual.
- "otro": pregunta general que podés responder con confianza usando el catálogo o el
  historial (precios, qué productos hay, cuánto tarda un pedido, etc.).
- "no_reconocido": el mensaje no encaja con confianza en ninguna categoría anterior. Usalo
  en vez de adivinar o improvisar una respuesta -- es preferible admitir que no entendiste
  a inventar algo que no corresponda al flujo real del bot. Ante la duda, elegí
  "no_reconocido" antes que forzar "otro".

CATÁLOGO DISPONIBLE:
{catalog}

HISTORIAL RECIENTE DEL CLIENTE:
{history}

Respondé SIEMPRE en formato JSON con esta estructura exacta:
{
  "intent": "catalogo" | "nuevo_pedido" | "consultar_estado" | "confirmacion_pedido" | "saludo" | "otro" | "no_reconocido",
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
    if (!match) return { intent: "otro", message: raw, parseFailed: true };
    return JSON.parse(match[0]);
  } catch {
    return { intent: "otro", message: raw, parseFailed: true };
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
