const express = require('express');
const axios = require('axios');
const Groq = require('groq-sdk');
const companyService = require('../services/companyService');
const scheduleService = require('../services/scheduleService');

const router = express.Router();

const GROQ_MODEL = 'llama-3.3-70b-specdec';
const GROQ_MODEL_FALLBACK = 'llama-3.3-70b-versatile';
const PUBLIC_HOME = process.env.PUBLIC_BASE_URL || 'https://howsgol-tsag-burtgel.onrender.com';
const PUBLIC_ERROR_REPLY = 'Уучлаарай, AI хариу өгч чадсангүй. https://howsgol-tsag-burtgel.onrender.com/';

function getEnv(name) {
  return (process.env[name] || '').trim();
}

function maskSecret(value) {
  if (!value) return '(хоосон)';
  if (value.length <= 8) return '****';
  return value.slice(0, 4) + '...' + value.slice(-4) + ` (${value.length} тэмдэгт)`;
}

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

router.get('/', (req, res) => {
  try {
    const mode = String(req.query['hub.mode'] || '');
    const token = String(req.query['hub.verify_token'] || '');
    const challenge = req.query['hub.challenge'];
    const verifyToken = getEnv('VERIFY_TOKEN');

    console.log('[Messenger] Webhook verify хүсэлт:', {
      mode,
      tokenMatch: token === verifyToken,
      hasChallenge: challenge != null && challenge !== '',
      expectedToken: maskSecret(verifyToken),
      gotToken: maskSecret(token),
    });

    if (mode !== 'subscribe') {
      console.warn('[Messenger] hub.mode буруу:', mode);
      return res.sendStatus(403);
    }

    if (!verifyToken) {
      console.error('[Messenger] VERIFY_TOKEN env хоосон байна!');
      return res.sendStatus(500);
    }

    if (token !== verifyToken) {
      console.warn('[Messenger] Verify token таарахгүй.');
      return res.sendStatus(403);
    }

    if (challenge == null || challenge === '') {
      console.warn('[Messenger] hub.challenge хоосон байна.');
      return res.sendStatus(400);
    }

    // Facebook зөвхөн challenge string-ийг plain text хэлбэрээр хүлээдэг (JSON биш!)
    console.log('[Messenger] Webhook баталгаажлаа.');
    res.status(200).type('text/plain').send(String(challenge));
  } catch (err) {
    logError('GET /api/webhook', err);
    return res.sendStatus(500);
  }
});

router.post('/', (req, res) => {
  try {
    const body = req.body;
    if (body.object === 'page') {
      for (const entry of body.entry || []) {
        for (const event of entry.messaging || []) {
          handleMessagingEvent(entry, event).catch((err) => logError('Event боловсруулах', err));
        }
      }
    }
    res.status(200).send('EVENT_RECEIVED');
  } catch (err) {
    logError('POST /api/webhook', err);
    res.status(200).send('EVENT_RECEIVED');
  }
});

async function handleMessagingEvent(entry, event) {
  const senderId = event.sender?.id;
  if (!senderId || event.message?.is_echo) return;

  const text = (event.message?.text || event.postback?.payload || '').trim();
  if (!text) {
    await sendTextMessage(senderId, 'Зөвхөн текст мессеж илгээнэ үү.').catch((err) =>
      logError('Non-text reply send', err)
    );
    return;
  }

  const company = await companyService.findCompanyByPage(entry);
  if (!company) {
    console.warn('[Messenger] Page-д харгалзах компани олдсонгүй:', {
      pageId: entry.id,
      senderId,
    });
    await sendTextMessage(senderId, PUBLIC_ERROR_REPLY).catch((err) =>
      logError('Company missing fallback send', err)
    );
    return;
  }

  console.log(`[Messenger] page=${entry.id} company=${company.username} sender=${senderId}: ${text}`);

  try {
    const scheduleContext = await scheduleService.getAiScheduleContext(company);
    const reply = await askGroq(text, company, scheduleContext);
    await sendTextMessage(senderId, reply);
  } catch (err) {
    logError('Groq/Facebook AI flow', err);
    await sendTextMessage(senderId, PUBLIC_ERROR_REPLY).catch((e) =>
      logError('AI fallback send', e)
    );
  }
}

function buildSystemPrompt(company, context) {
  const companyName = company.company_name || company.companyName || company.username;
  const locationLink = company.location_link || '';
  const infoPhone = company.info_phone || company.phone || '';
  const username = company.username || '';

  return `Чи бол ${companyName} салоны туслах АИ байна. Үйлчлүүлэгчдэд маш найрсаг, товч бөгөөд тодорхой монгол хэлээр хариулна уу. Дараах дүрмийг яг таг баримтал:
  - Дүрэм 1 (Цаг асуух): Хэрэглэгч өнөөдрийн цаг асуувал өнөөдрийн сул байгаа цагуудыг (жишээ нь: 13:00, 14:20 гэх мэт) хэлж өгнө. Хэрэв өнөөдөр ямар ч сул цаг байхгүй бол 'Өнөөдөр сул цаг байхгүй ээ' гэж хариулна.
  - Дүрэм 2 (Маргаашийн цаг асуух): Хэрэглэгч маргаашийн цаг асуухад хэрэв маргааш нь амардаг өдөр (эсвэл хуваарьгүй) бол шууд 'Маргааш ажиллахгүй өдөр өө' гэж хариулна.
  - Дүрэм 3 (Байршил асуух): Хэрэглэгч байршил хаана вэ гэж асуувал ямар ч илүү дутуу үг, тайлбар хэлэлгүйгээр ШУУД зөвхөн энэ Google Map линкийг өгнө: ${locationLink}
  - Дүрэм 4 (Лавлах утас асуух): Хэрэглэгч лавлах утас асуувал ШУУД яг ингэж хариулна: '${infoPhone}. Хэрэв та өөрийн хүссэн цагаа авахыг хүсвэл энэ ${PUBLIC_HOME}/ link рүү ороод ${username} гэж хайж байгаад цагаа сонгоод бүртгэлээ хийж болно.'

Контекст:
- Өнөөдөр: ${context.today}
- Өнөөдрийн сул цагууд: ${context.todayAvailable.length ? context.todayAvailable.join(', ') : 'сул цаг байхгүй'}
- Маргааш: ${context.tomorrow}
- Маргаашийн сул цагууд: ${context.tomorrowAvailable.length ? context.tomorrowAvailable.join(', ') : 'сул цаг байхгүй'}
- Маргааш хаалттай эсвэл хуваарьгүй эсэх: ${context.tomorrowClosed ? 'тийм' : 'үгүй'}`;
}

async function askGroq(userText, company, scheduleContext) {
  const apiKey = getEnv('GROQ_API_KEY');
  if (!apiKey) throw new Error('GROQ_API_KEY тохируулаагүй');

  const groq = getGroq();
  const systemPrompt = buildSystemPrompt(company, scheduleContext);
  const models = [GROQ_MODEL, GROQ_MODEL_FALLBACK];
  let lastErr = null;

  for (const model of models) {
    try {
      console.log(`[Groq] model=${model}, key=${maskSecret(apiKey)}, company=${company.username}`);
      const completion = await groq.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userText },
        ],
        temperature: 0.4,
        max_tokens: 512,
      });

      const reply = completion.choices?.[0]?.message?.content?.trim();
      if (!reply) throw new Error('Groq хоосон хариу буцаалаа');
      return reply;
    } catch (err) {
      lastErr = err;
      logError(`Groq model ${model}`, err);
    }
  }

  throw lastErr || new Error('Groq бүх model амжилтгүй');
}

async function sendTextMessage(recipientId, text) {
  const pageToken = getEnv('PAGE_ACCESS_TOKEN');
  if (!pageToken) throw new Error('PAGE_ACCESS_TOKEN тохируулаагүй');

  const res = await axios.post(
    'https://graph.facebook.com/v21.0/me/messages',
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
}

module.exports = router;
module.exports.sendTextMessage = sendTextMessage;
module.exports.askGroq = askGroq;
module.exports.logEnvStatus = logEnvStatus;
