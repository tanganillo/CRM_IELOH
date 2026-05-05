const axios = require("axios");

const BASE_URL = "https://graph.facebook.com/v20.0";

function headers() {
  return { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` };
}

// ── Envío de mensajes ────────────────────────────────────────────────────────

async function sendText(to, text) {
  return _send(to, { type: "text", text: { body: text, preview_url: false } });
}

async function sendTemplate(to, templateName, languageCode = "es", components = []) {
  return _send(to, {
    type: "template",
    template: { name: templateName, language: { code: languageCode }, components },
  });
}

async function sendInteractiveList(to, body, buttonLabel, sections) {
  return _send(to, {
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: body },
      action: { button: buttonLabel, sections },
    },
  });
}

async function sendInteractiveButtons(to, body, buttons) {
  return _send(to, {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: body },
      action: {
        buttons: buttons.map((b, i) => ({
          type: "reply",
          reply: { id: `btn_${i}`, title: b },
        })),
      },
    },
  });
}

async function _send(to, messageObj) {
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const { data } = await axios.post(
    `${BASE_URL}/${phoneId}/messages`,
    { messaging_product: "whatsapp", recipient_type: "individual", to, ...messageObj },
    { headers: headers() }
  );
  return data;
}

// ── Parsing de eventos entrantes ─────────────────────────────────────────────

function parseIncoming(body) {
  try {
    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    if (!value?.messages?.length) return null;

    const msg = value.messages[0];
    const contact = value.contacts?.[0];

    return {
      from: msg.from,                          // número E.164
      name: contact?.profile?.name || "Cliente",
      messageId: msg.id,
      type: msg.type,                          // text | interactive | button
      text: msg.text?.body || "",
      interactiveId: msg.interactive?.list_reply?.id || msg.interactive?.button_reply?.id || "",
      timestamp: msg.timestamp,
    };
  } catch {
    return null;
  }
}

// ── Broadcast masivo ─────────────────────────────────────────────────────────

async function broadcastText(phones, text) {
  const results = [];
  for (const phone of phones) {
    try {
      await sendText(phone, text);
      results.push({ phone, ok: true });
    } catch (err) {
      results.push({ phone, ok: false, error: err.message });
    }
    // Pausa corta para respetar rate limits de la API
    await new Promise((r) => setTimeout(r, 200));
  }
  return results;
}

module.exports = {
  sendText,
  sendTemplate,
  sendInteractiveList,
  sendInteractiveButtons,
  broadcastText,
  parseIncoming,
};
