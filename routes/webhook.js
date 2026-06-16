const express = require('express');
const axios = require('axios');
const Groq = require('groq-sdk');

const router = express.Router();

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN || '';
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || '';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';

const GROQ_MODEL = 'llama-3.3-70b-specdec';
const SYSTEM_PROMPT =
  'Чи бол Говь-Алтай аймагт байрлах Хөвсгөл цаг бүртгэлийн салоны туслах АИ байна. Үйлчлүүлэгчдэд маш найрсаг, товч бөгөөд тодорхой монгол хэлээр хариулна уу.';

let groqClient = null;
function getGroq() {
  if (!GROQ_API_KEY) return null;
  if (!groqClient) groqClient = new Groq({ apiKey: GROQ_API_KEY });
  return groqClient;
}

/**
 * GET /api/webhook — Facebook webhook баталгаажуулалт
 */
router.get('/', (req, res) => {
  try {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN && VERIFY_TOKEN) {
      console.log('[Messenger] Webhook баталгаажлаа.');
      return res.status(200).send(challenge);
    }

    console.warn('[Messenger] Verify token таарахгүй.');
    return res.sendStatus(403);
  } catch (err) {
    console.error('[Messenger] GET webhook алдаа:', err.message);
    return res.sendStatus(500);
  }
});

/**
 * POST /api/webhook — хэрэглэгчийн мессеж хүлээн авна
 */
router.post('/', (req, res) => {
  try {
    const body = req.body;

    if (body.object === 'page') {
      for (const entry of body.entry || []) {
        for (const event of entry.messaging || []) {
          // Facebook 20 сек дотор 200 хариу шаарддаг — async background-д боловсруулна
          handleMessagingEvent(event).catch((err) => {
            console.error('[Messenger] Event боловсруулахад алдаа:', err.message);
          });
        }
      }
    }

    res.status(200).send('EVENT_RECEIVED');
  } catch (err) {
    console.error('[Messenger] POST webhook алдаа:', err.message);
    res.status(200).send('EVENT_RECEIVED');
  }
});

async function handleMessagingEvent(event) {
  const senderId = event.sender?.id;
  if (!senderId) return;

  // Өөрийн илгээсэн мессежийг давтахгүй
  if (event.message?.is_echo) return;

  if (event.message) {
    const text = (event.message.text || '').trim();
    if (!text) {
      await sendTextMessage(senderId, 'Зөвхөн текст мессеж илгээнэ үү.');
      return;
    }

    console.log(`[Messenger] ${senderId}: ${text}`);

    try {
      const reply = await askGroq(text);
      await sendTextMessage(senderId, reply);
    } catch (err) {
      console.error('[Messenger] Groq/Send алдаа:', err.message);
      await sendTextMessage(
        senderId,
        'Уучлаарай, одоогоор хариу өгч чадсангүй. Түр хүлээгээд дахин оролдоно уу.'
      ).catch(() => {});
    }
    return;
  }

  if (event.postback) {
    const payload = event.postback.payload || '';
    console.log(`[Messenger] ${senderId} postback: ${payload}`);
    try {
      const reply = await askGroq(payload);
      await sendTextMessage(senderId, reply);
    } catch (err) {
      console.error('[Messenger] Postback алдаа:', err.message);
    }
  }
}

async function askGroq(userText) {
  const groq = getGroq();
  if (!groq) {
    throw new Error('GROQ_API_KEY тохируулаагүй');
  }

  const completion = await groq.chat.completions.create({
    model: GROQ_MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userText },
    ],
    temperature: 0.7,
    max_tokens: 512,
  });

  const reply = completion.choices?.[0]?.message?.content?.trim();
  if (!reply) throw new Error('Groq хоосон хариу буцаалаа');
  return reply;
}

/** Facebook Send API — хариу илгээх */
async function sendTextMessage(recipientId, text) {
  if (!PAGE_ACCESS_TOKEN) {
    console.warn('[Messenger] PAGE_ACCESS_TOKEN тохируулаагүй.');
    return;
  }

  const url = 'https://graph.facebook.com/v21.0/me/messages';
  await axios.post(
    url,
    {
      recipient: { id: recipientId },
      message: { text: String(text).slice(0, 2000) },
    },
    {
      params: { access_token: PAGE_ACCESS_TOKEN },
      timeout: 15000,
    }
  );
  console.log(`[Messenger] → ${recipientId}: ${String(text).slice(0, 80)}...`);
}

module.exports = router;
module.exports.sendTextMessage = sendTextMessage;
module.exports.askGroq = askGroq;
