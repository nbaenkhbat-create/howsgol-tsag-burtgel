const express = require('express');
const axios = require('axios');
const Groq = require('groq-sdk');
const companyService = require('../services/companyService');
const scheduleService = require('../services/scheduleService');
const chatSessionService = require('../services/chatSessionService');

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
const pendingBookings = new Map();

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
          dispatchMessagingEvent(entry, event).catch((err) => logError('Event боловсруулах', err));
        }
      }
    }
    res.status(200).send('EVENT_RECEIVED');
  } catch (err) {
    logError('POST /api/webhook', err);
    res.status(200).send('EVENT_RECEIVED');
  }
});

async function dispatchMessagingEvent(entry, event) {
  if (event.read) {
    return handleReadEvent(entry, event);
  }
  if (event.message || event.postback) {
    return handleIncomingMessage(entry, event);
  }
}

async function handleReadEvent(entry, event) {
  const pageId = String(entry.id || '');
  const senderId = String(event.sender?.id || '');
  const customerId = String(event.recipient?.id || '');

  // Page (ажилтан) хэрэглэгчийн чатыг нээж уншсан үед sender = page, recipient = хэрэглэгч
  if (!pageId || senderId !== pageId || !customerId) return;

  const company = await companyService.findCompanyByPage(entry);
  if (!company) {
    console.warn('[Messenger] Read event: компани олдсонгүй', { pageId, customerId });
    return;
  }

  const session = await chatSessionService.setHumanActive(company, customerId);
  pendingBookings.delete(pendingKey(company, customerId));
  console.log('[Messenger] Human takeover идэвхжлээ:', {
    company: company.username,
    customerId,
    expiresAt: session.expiresAt,
    watermark: event.read?.watermark,
  });
}

async function handleIncomingMessage(entry, event) {
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
    // Company устсан эсвэл page_link таарахгүй үед AI тухайн page дээрээс салсан гэж үзээд
    // хэрэглэгч рүү ямар ч мессеж илгээхгүй.
    return;
  }

  console.log(`[Messenger] page=${entry.id} company=${company.username} sender=${senderId}: ${text}`);

  try {
    const pageToken = company.pageToken || company.page_token || '';

    if (await chatSessionService.isHumanActive(company, senderId)) {
      console.log('[Messenger] Human active — AI алгасав:', {
        company: company.username,
        senderId,
      });
      return;
    }

    const scheduleGate = await scheduleService.getScheduleChatGate(company);
    if (scheduleGate.mode === 'silent') {
      console.log('[Messenger] Vendor блоклосон цаг — AI алгасав:', {
        company: company.username,
        senderId,
        reason: scheduleGate.reason,
        hour: scheduleGate.hour,
      });
      pendingBookings.delete(pendingKey(company, senderId));
      return;
    }
    if (scheduleGate.mode === 'blocked_day_message') {
      console.log('[Messenger] Vendor блоклосон өдөр — тод мессеж:', {
        company: company.username,
        senderId,
        reason: scheduleGate.reason,
      });
      pendingBookings.delete(pendingKey(company, senderId));
      await sendTextMessage(senderId, scheduleGate.message, pageToken);
      return;
    }

    const scheduleContext = await scheduleService.getAiScheduleContext(company);
    const pendingReply = await continuePendingBooking(text, company, senderId);
    if (pendingReply) {
      await sendTextMessage(senderId, pendingReply, pageToken);
      return;
    }

    const bookingReply = await tryCreateChatBooking(text, company, senderId, scheduleContext);
    if (bookingReply) {
      await sendTextMessage(senderId, bookingReply, pageToken);
      return;
    }

    const directReply = buildDirectReply(text, company, scheduleContext);
    if (directReply) {
      await sendTextMessage(senderId, directReply, pageToken);
      return;
    }

    const reply = await askGroq(text, company, scheduleContext);
    await sendTextMessage(senderId, reply, pageToken);
  } catch (err) {
    logError('Groq/Facebook AI flow', err);
    await sendTextMessage(senderId, PUBLIC_ERROR_REPLY, company.pageToken || company.page_token || '').catch((e) =>
      logError('AI fallback send', e)
    );
  }
}

function includesAny(text, words) {
  const lower = String(text || '').toLowerCase();
  return words.some((word) => lower.includes(word));
}

function pendingKey(company, senderId) {
  return `${company.username}:${senderId}`;
}

function extractRequestedHour(text) {
  const normalized = String(text || '').toLowerCase();
  const match = normalized.match(/(?:^|\D)([01]?\d|2[0-4])(?::[0-5]\d)?\s*(?:цаг|tsag|:|h)?(?:\D|$)/);
  if (!match) return null;
  const hour = Number(match[1]);
  return hour >= 1 && hour <= 24 ? hour : null;
}

function parseNameAndPhone(text) {
  const raw = String(text || '').trim();
  const phoneMatch = raw.match(/(?:\+?976[-\s]?)?(\d{8})/);
  if (!phoneMatch) return null;
  const phone = phoneMatch[1];
  let name = raw
    .replace(phoneMatch[0], ' ')
    .replace(/нэр\s*[:=-]?/gi, ' ')
    .replace(/ner\s*[:=-]?/gi, ' ')
    .replace(/утас\s*[:=-]?/gi, ' ')
    .replace(/utas\s*[:=-]?/gi, ' ')
    .replace(/[,\-:;|]+/g, ' ')
    .trim();

  if (!name) return null;
  name = name.split(/\s+/).slice(0, 4).join(' ');
  return { name, phone };
}

async function continuePendingBooking(userText, company, senderId) {
  const key = pendingKey(company, senderId);
  const pending = pendingBookings.get(key);
  if (!pending) return null;

  if (includesAny(userText, ['болих', 'bolih', 'цуцал', 'tsutsal', 'cancel'])) {
    pendingBookings.delete(key);
    return 'Захиалга цуцлагдлаа.';
  }

  const info = parseNameAndPhone(userText);
  if (!info) {
    return 'Захиалга баталгаажуулахын тулд нэр болон 8 оронтой утасны дугаараа нэг мессежээр илгээнэ үү. Жишээ: Бат 99112233';
  }

  try {
    await scheduleService.createBooking(
      company,
      pending.date,
      pending.hour,
      info.name,
      info.phone
    );
    pendingBookings.delete(key);
    return `Баталгаажлаа. ${pending.date} өдөр ${scheduleService.hourLabel(pending.hour)} цагт ${info.name} нэрээр таны захиалга бүртгэгдлээ.`;
  } catch (err) {
    pendingBookings.delete(key);
    logError('Pending booking create', err);
    return 'Уучлаарай, энэ цаг дөнгөж сая боломжгүй боллоо. Өөр цаг сонгоно уу.';
  }
}

function isBookingIntent(text) {
  return includesAny(text, [
    'авъя',
    'авья',
    'awya',
    'awii',
    'awiy',
    'авах',
    'zahial',
    'захиал',
    'бүртг',
    'burtg',
    'book',
  ]);
}

async function tryCreateChatBooking(userText, company, senderId, context) {
  const text = String(userText || '').toLowerCase();
  const hour = extractRequestedHour(text);
  if (!hour || !isBookingIntent(text)) return null;

  const date = includesAny(text, ['маргааш', 'margaash']) ? context.tomorrow : context.today;
  const available =
    date === context.tomorrow
      ? Array.isArray(context.tomorrowAvailable)
        ? context.tomorrowAvailable
        : []
      : Array.isArray(context.todayAvailable)
        ? context.todayAvailable
        : [];
  const label = scheduleService.hourLabel(hour);

  if (!available.includes(label)) {
    return available.length
      ? `Уучлаарай, ${label} цаг боломжгүй байна. Сул цагууд: ${available.join(', ')}`
      : date === context.tomorrow
        ? 'Маргааш захиалга авахгүй өдөр өө'
        : 'Уучлаарай, өнөөдөр захиалга авахгүй өдөр.';
  }

  const info = parseNameAndPhone(userText);
  if (!info) {
    pendingBookings.set(pendingKey(company, senderId), {
      companyId: company.id,
      date,
      hour,
      createdAt: Date.now(),
    });
    return `${date} өдөр ${label} цагийг баталгаажуулахын тулд нэр болон утасны дугаараа илгээнэ үү. Жишээ: Бат 99112233`;
  }

  await scheduleService.createBooking(company, date, hour, info.name, info.phone);

  return `Баталгаажлаа. ${date} өдөр ${label} цагт ${info.name} нэрээр таны захиалга бүртгэгдлээ.`;
}

function buildDirectReply(userText, company, context) {
  const text = String(userText || '').toLowerCase();
  const locationLink = company.location_link || '';
  const infoPhone = company.info_phone || company.phone || '';
  const username = company.username || '';
  const todayAvailable = Array.isArray(context.todayAvailable) ? context.todayAvailable : [];
  const tomorrowAvailable = Array.isArray(context.tomorrowAvailable) ? context.tomorrowAvailable : [];

  if (
    includesAny(text, [
      'сайн байна',
      'сайн уу',
      'sain baina',
      'sain uu',
      'sn bnu',
      'sn bn',
      'snu',
      'hi',
      'hello',
      'hey',
    ])
  ) {
    const companyName = company.company_name || company.companyName || username;
    return `Сайн байна уу. ${companyName}-ийн цаг захиалгын туслах байна. Та өнөөдрийн цаг, маргаашийн цаг, байршил, лавлах утас гэж асууж болно. Цаг захиалах бол ${PUBLIC_HOME}/ link рүү ороод ${username} гэж хайгаарай.`;
  }

  if (includesAny(text, ['юу хийж', 'yu hiij', 'юу хийдэг', 'yu hiideg', 'тусламж', 'help', 'menu'])) {
    return `Та өнөөдрийн цаг, маргаашийн цаг, байршил, лавлах утас гэж асууж болно. Цаг захиалах бол ${PUBLIC_HOME}/ link рүү ороод ${username} гэж хайгаарай.`;
  }

  if (includesAny(text, ['байршил', 'bairshil', 'хаана', 'haana', 'хаяг', 'hayg', 'map'])) {
    return locationLink || PUBLIC_HOME + '/';
  }

  if (includesAny(text, ['лавлах', 'lawlah', 'утас', 'utas', 'дугаар', 'dugaar'])) {
    return `${infoPhone}. Хэрэв та өөрийн хүссэн цагаа авахыг хүсвэл энэ ${PUBLIC_HOME}/ link рүү ороод ${username} гэж хайж байгаад цагаа сонгоод бүртгэлээ хийж болно.`;
  }

  if (includesAny(text, ['маргааш', 'margaash'])) {
    if (context.tomorrowClosed) return 'Маргааш захиалга авахгүй өдөр өө';
    return tomorrowAvailable.length
      ? buildAvailableTimesReply('Маргаашийн сул цагууд', tomorrowAvailable, company)
      : 'Маргааш захиалга авахгүй өдөр өө';
  }

  if (includesAny(text, ['өнөөдөр', 'өнөөдрийн', 'unuudur', 'onoogiin', 'цаг', 'tsag'])) {
    if (context.todayClosed) return 'Уучлаарай, өнөөдөр захиалга авахгүй өдөр.';
    return todayAvailable.length
      ? buildAvailableTimesReply('Өнөөдрийн сул цагууд', todayAvailable, company)
      : 'Уучлаарай, өнөөдөр захиалга авахгүй өдөр.';
  }

  return null;
}

function buildAvailableTimesReply(title, availableTimes, company) {
  const username = company.username || '';
  const locationLink = company.location_link || '';
  const parts = [
    `${title}: ${availableTimes.join(', ')}`,
    'Хэрэв та захиалга өгөх бол нэр, утсаа ингэж бичнэ үү: Бат 99112233',
  ];
  if (locationLink) parts.push(locationLink);
  parts.push(`Эсвэл ${PUBLIC_HOME}/ link рүү ороод ${username} гэж хайгаад сул цагаа хараад захиалга өгч болно.`);
  return parts.join('\n');
}

function buildSystemPrompt(company, context) {
  const companyName = company.company_name || company.companyName || company.username;
  const locationLink = company.location_link || '';
  const infoPhone = company.info_phone || company.phone || '';
  const username = company.username || '';
  const todayAvailable = Array.isArray(context.todayAvailable) ? context.todayAvailable : [];
  const tomorrowAvailable = Array.isArray(context.tomorrowAvailable) ? context.tomorrowAvailable : [];

  return `Чи бол ${companyName} салоны туслах АИ байна. Үйлчлүүлэгчдэд маш найрсаг, товч бөгөөд тодорхой монгол хэлээр хариулна уу. Дараах дүрмийг яг таг баримтал:
  - Дүрэм 1 (Цаг асуух): Хэрэглэгч өнөөдрийн цаг асуувал өнөөдрийн сул байгаа цагуудыг (жишээ нь: 13:00, 14:20 гэх мэт) хэлж өгнө. Хэрэв өнөөдөр ямар ч сул цаг байхгүй бол 'Өнөөдөр сул цаг байхгүй ээ' гэж хариулна.
  - Дүрэм 2 (Маргаашийн цаг асуух): Хэрэглэгч маргаашийн цаг асуухад хэрэв маргааш нь амардаг өдөр (эсвэл хуваарьгүй) бол шууд 'Маргааш ажиллахгүй өдөр өө' гэж хариулна.
  - Дүрэм 3 (Байршил асуух): Хэрэглэгч байршил хаана вэ гэж асуувал ямар ч илүү дутуу үг, тайлбар хэлэлгүйгээр ШУУД зөвхөн энэ Google Map линкийг өгнө: ${locationLink}
  - Дүрэм 4 (Лавлах утас асуух): Хэрэглэгч лавлах утас асуувал ШУУД яг ингэж хариулна: '${infoPhone}. Хэрэв та өөрийн хүссэн цагаа авахыг хүсвэл энэ ${PUBLIC_HOME}/ link рүү ороод ${username} гэж хайж байгаад цагаа сонгоод бүртгэлээ хийж болно.'

Контекст:
- Өнөөдөр: ${context.today}
- Өнөөдрийн сул цагууд: ${todayAvailable.length ? todayAvailable.join(', ') : 'сул цаг байхгүй'}
- Маргааш: ${context.tomorrow}
- Маргаашийн сул цагууд: ${tomorrowAvailable.length ? tomorrowAvailable.join(', ') : 'сул цаг байхгүй'}
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

async function sendTextMessage(recipientId, text, pageTokenOverride = '') {
  const pageToken = String(pageTokenOverride || '').trim() || getEnv('PAGE_ACCESS_TOKEN');
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
