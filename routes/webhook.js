const express = require('express');
const axios = require('axios');
const Groq = require('groq-sdk');

const router = express.Router();

const GROQ_MODEL = 'llama-3.3-70b-specdec';
const GROQ_MODEL_FALLBACK = 'llama-3.3-70b-versatile';
const SYSTEM_PROMPT =
  'Чи бол Говь-Алтай аймагт байрлах Хөвсгөл цаг бүртгэлийн салоны туслах АИ байна. Үйлчлүүлэгчдэд маш найрсаг, товч бөгөөд тодорхой монгол хэлээр хариулна уу.';

/** process.env-ийг runtime дээр уншина (module load биш) */
function getEnv(name) {
  return (process.env[name] || '').trim();
}

function maskSecret(value) {
  if (!value) return '(хоосон)';
  if (value.length <= 8) return '****';
  return value.slice(0, 4) + '...' + value.slice(-4) + ` (${value.length} тэмдэгт)`;
}

/** Env тохиргоог startup/log-д шалгах */
function logEnvStatus() {
  console.log('[Messenger] Env шалгалт:');
  console.log('  VERIFY_TOKEN     =', maskSecret(getEnv('VERIFY_TOKEN')));
  console.log('  PAGE_ACCESS_TOKEN=', maskSecret(getEnv('PAGE_ACCESS_TOKEN')));
  console.log('  GROQ_API_KEY     =', maskSecret(getEnv('GROQ_API_KEY')));
}

function logError(context, err) {
  console.error(`\n========== [Messenger] ${context} ==========`);
  console.error('message:', err?.message);
  if (err?.status) console.error('status:', err.status);
  if (err?.code) console.error('code:', err.code);
  if (err?.error) console.error('error body:', JSON.stringify(err.error, null, 2));
  if (err?.response?.data) console.error('response data:', JSON.stringify(err.response.data, null, 2));
  if (err?.response?.status) console.error('response status:', err.response.status);
  if (err?.stack) console.error('stack:', err.stack);
  console.error('==========================================\n');
}

let groqClient = null;
let groqClientKey = '';

function getGroq() {
  const apiKey = getEnv('GROQ_API_KEY');
  if (!apiKey) return null;
  if (!groqClient || groqClientKey !== apiKey) {
    groqClient = new Groq({ apiKey });
    groqClientKey = apiKey;
  }
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
    const verifyToken = getEnv('VERIFY_TOKEN');

    if (mode === 'subscribe' && token === verifyToken && verifyToken) {
      console.log('[Messenger] Webhook баталгаажлаа.');
      return res.status(200).send(challenge);
    }

    console.warn('[Messenger] Verify token таарахгүй.', {
      mode,
      gotToken: maskSecret(token),
      expectedToken: maskSecret(verifyToken),
    });
    return res.sendStatus(403);
  } catch (err) {
    logError('GET /api/webhook', err);
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
          handleMessagingEvent(event).catch((err) => {
            logError('Event боловсруулах', err);
          });
        }
      }
    }

    res.status(200).send('EVENT_RECEIVED');
  } catch (err) {
    logError('POST /api/webhook', err);
    res.status(200).send('EVENT_RECEIVED');
  }
});

async function handleMessagingEvent(event) {
  const senderId = event.sender?.id;
  if (!senderId) return;
  if (event.message?.is_echo) return;

  if (event.message) {
    const text = (event.message.text || '').trim();
    if (!text) {
      await sendTextMessage(senderId, 'Зөвхөн текст мессеж илгээнэ үү.');
      return;
    }

    console.log(`[Messenger] ${senderId}: ${text}`);

    let reply;
    try {
      reply = await askGroq(text);
    } catch (err) {
      logError('Groq API', err);
      await sendTextMessage(
        senderId,
        'Уучлаарай, AI хариу өгч чадсангүй. (Groq API алдаа — Logs шалгана уу.)'
      ).catch((e) => logError('Fallback send (Groq алдаа)', e));
      return;
    }

    try {
      await sendTextMessage(senderId, reply);
    } catch (err) {
      logError('Facebook Send API', err);
      // Groq хариу ирсэн ч Facebook руу илгээж чадаагүй
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
      logError('Postback', err);
    }
  }
}

async function askGroq(userText) {
  const apiKey = getEnv('GROQ_API_KEY');
  if (!apiKey) {
    throw new Error('GROQ_API_KEY тохируулаагүй — Render Environment эсвэл .env файл шалгана уу');
  }

  const groq = getGroq();
  const models = [GROQ_MODEL, GROQ_MODEL_FALLBACK];
  let lastErr = null;

  for (const model of models) {
    try {
      console.log(`[Groq] model=${model}, key=${maskSecret(apiKey)}`);
      const completion = await groq.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userText },
        ],
        temperature: 0.7,
        max_tokens: 512,
      });

      const reply = completion.choices?.[0]?.message?.content?.trim();
      if (!reply) throw new Error('Groq хоосон хариу буцаалаа');
      console.log(`[Groq] Амжилт (${model}):`, reply.slice(0, 80));
      return reply;
    } catch (err) {
      lastErr = err;
      logError(`Groq model ${model}`, err);
    }
  }

  throw lastErr || new Error('Groq бүх model амжилтгүй');
}

/** Facebook Send API — хариу илгээх */
async function sendTextMessage(recipientId, text) {
  const pageToken = getEnv('PAGE_ACCESS_TOKEN');
  if (!pageToken) {
    throw new Error('PAGE_ACCESS_TOKEN тохируулаагүй — Render Environment шалгана уу');
  }

  const url = 'https://graph.facebook.com/v21.0/me/messages';
  try {
    const res = await axios.post(
      url,
      {
        recipient: { id: recipientId },
        message: { text: String(text).slice(0, 2000) },
      },
      {
        params: { access_token: pageToken },
        timeout: 15000,
      }
    );
    console.log(`[Messenger] → ${recipientId}: ${String(text).slice(0, 80)}...`);
    return res.data;
  } catch (err) {
    logError('Facebook Send API POST', err);
    throw err;
  }
}

module.exports = router;
module.exports.sendTextMessage = sendTextMessage;
module.exports.askGroq = askGroq;
module.exports.logEnvStatus = logEnvStatus;
