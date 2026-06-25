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
const BOOKING_EXAMPLE = 'Бат, 99112233, 13 цаг';

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

    const schedulePause = await scheduleService.isAiChatPaused(company);
    if (schedulePause.paused) {
      console.log('[Messenger] Vendor хуваарь pause — AI алгасав:', {
        company: company.username,
        senderId,
        reason: schedulePause.reason,
        hour: schedulePause.hour,
      });
      return;
    }

    const scheduleContext = await scheduleService.getAiScheduleContext(company);
    const bookingReply = await processBookingFlow(text, company, senderId, scheduleContext);
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

function parsePhone(text) {
  const match = String(text || '').match(/(?:\+?976[-\s]?)?(\d{8})/);
  return match ? match[1] : '';
}

function parseNameOnly(text) {
  const raw = String(text || '').trim();
  if (!raw || parsePhone(raw)) return '';

  let name = raw
    .replace(/(?:\+?976[-\s]?)?\d{8}/g, ' ')
    .replace(/(?:^|\D)([01]?\d|2[0-4])(?::[0-5]\d)?\s*(?:цаг|tsag|h)?/gi, ' ')
    .replace(/нэр\s*[:=-]?/gi, ' ')
    .replace(/ner\s*[:=-]?/gi, ' ')
    .replace(/утас\s*[:=-]?/gi, ' ')
    .replace(/utas\s*[:=-]?/gi, ' ')
    .replace(/цаг\s*[:=-]?/gi, ' ')
    .replace(/tsag\s*[:=-]?/gi, ' ')
    .replace(/zahial|захиал|авъя|авья|awii|awya|book/gi, ' ')
    .replace(/[,\-:;|]+/g, ' ')
    .trim();

  if (!name || name.length < 2 || /^\d+$/.test(name)) return '';
  return name.split(/\s+/).slice(0, 4).join(' ');
}

function parseBookingParts(text) {
  return {
    hour: extractRequestedHour(text),
    phone: parsePhone(text),
    name: parseNameOnly(text),
  };
}

function looksLikeNameOnly(text) {
  const trimmed = String(text || '').trim();
  const name = parseNameOnly(trimmed);
  if (!name || name !== trimmed) return false;
  if (trimmed.length < 2 || trimmed.length > 40) return false;
  if (includesAny(trimmed, ['сайн', 'sain', 'hi', 'hello', 'help', 'байршил', 'bairshil', 'утас', 'utas'])) {
    return false;
  }
  return true;
}

function parseNameAndPhone(text) {
  const phone = parsePhone(text);
  const name = parseNameOnly(text);
  if (!phone || !name) return null;
  return { name, phone };
}

function buildBookingFormatReply(extra = '') {
  const lines = [
    'Хэрэв та цаг захиалах бол нэр, утасны дугаар, цагаа дарааллаар бичнэ үү.',
    '1. Нэр — Жишээ: Бат',
    '2. Утас — Жишээ: 99112233',
    '3. Цаг — Жишээ: 13 цаг',
    `Эсвэл нэг мессежээр: ${BOOKING_EXAMPLE}`,
  ];
  if (extra) lines.unshift(extra);
  return lines.join('\n');
}

function getNextBookingPrompt(pending) {
  if (!pending.name) return 'Нэрээ бичнэ үү. Жишээ: Бат';
  if (!pending.phone) return 'Утасны дугаараа бичнэ үү. Жишээ: 99112233';
  if (!pending.hour) return 'Захиалах цагаа бичнэ үү. Жишээ: 13 цаг';
  return null;
}

function createEmptyPending(company) {
  return {
    companyId: company.id,
    name: '',
    phone: '',
    hour: null,
    date: '',
    createdAt: Date.now(),
  };
}

function mergePendingFromMessage(pending, userText, context) {
  const text = String(userText || '').toLowerCase();
  const parts = parseBookingParts(userText);

  if (parts.name) pending.name = parts.name;
  if (parts.phone) pending.phone = parts.phone;
  if (parts.hour) {
    pending.hour = parts.hour;
    pending.date = includesAny(text, ['маргааш', 'margaash']) ? context.tomorrow : context.today;
  }
  if (!pending.date && pending.hour) pending.date = context.today;

  return pending;
}

async function validatePendingSlot(pending, context) {
  if (!pending.hour) return { ok: true };

  const label = scheduleService.hourLabel(pending.hour);
  const available =
    pending.date === context.tomorrow
      ? Array.isArray(context.tomorrowAvailable)
        ? context.tomorrowAvailable
        : []
      : Array.isArray(context.todayAvailable)
        ? context.todayAvailable
        : [];

  if (!available.includes(label)) {
    const dateLabel = pending.date === context.tomorrow ? 'Маргааш' : 'Өнөөдөр';
    return {
      ok: false,
      message: available.length
        ? `Уучлаарай, ${label} цаг боломжгүй байна. ${dateLabel} сул цагууд: ${available.join(', ')}`
        : `${dateLabel} захиалга авахгүй өдөр.`,
    };
  }

  return { ok: true };
}

async function processBookingFlow(userText, company, senderId, context) {
  const key = pendingKey(company, senderId);
  const text = String(userText || '').toLowerCase();
  let pending = pendingBookings.get(key);

  if (pending && includesAny(userText, ['болих', 'bolih', 'цуцал', 'tsutsal', 'cancel'])) {
    pendingBookings.delete(key);
    return 'Захиалга цуцлагдлаа.';
  }

  const parts = parseBookingParts(userText);
  const hasBookingSignal =
    isBookingIntent(text) ||
    parts.hour ||
    parts.phone ||
    (parts.name && pending) ||
    looksLikeNameOnly(userText);

  if (!pending && !hasBookingSignal) return null;

  if (!pending) pending = createEmptyPending(company);

  const hadHour = pending.hour;
  pending = mergePendingFromMessage(pending, userText, context);
  pendingBookings.set(key, pending);

  if (pending.hour && pending.hour !== hadHour) {
    const slotCheck = await validatePendingSlot(pending, context);
    if (!slotCheck.ok) {
      pending.hour = null;
      pending.date = '';
      pendingBookings.set(key, pending);
      return `${slotCheck.message}\n${getNextBookingPrompt(pending)}`;
    }
  }

  const prompt = getNextBookingPrompt(pending);
  if (prompt) return prompt;

  try {
    await scheduleService.createBooking(
      company,
      pending.date,
      pending.hour,
      pending.name,
      pending.phone
    );
    pendingBookings.delete(key);
    return `Баталгаажлаа. ${pending.date} өдөр ${scheduleService.hourLabel(pending.hour)} цагт ${pending.name} нэрээр таны захиалга бүртгэгдлээ.`;
  } catch (err) {
    pendingBookings.delete(key);
    logError('Booking create', err);
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
    return `Сайн байна уу. ${companyName}-ийн цаг захиалгын туслах байна. Та өнөөдрийн цаг, маргаашийн цаг, байршил, лавлах утас гэж асууж болно.\n${buildBookingFormatReply()}`;
  }

  if (includesAny(text, ['юу хийж', 'yu hiij', 'юу хийдэг', 'yu hiideg', 'тусламж', 'help', 'menu'])) {
    return `Та өнөөдрийн цаг, маргаашийн цаг, байршил, лавлах утас гэж асууж болно.\n${buildBookingFormatReply()}`;
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

  return `${infoPhone}. Хэрэв та өөрийн хүссэн цагаа авахыг хүсвэл энэ ${PUBLIC_HOME}/ link рүү ороод ${username} гэж хайж байгаад цагаа сонгоод бүртгэлээ хийж болно.`;
}

function buildAvailableTimesReply(title, availableTimes, company) {
  const username = company.username || '';
  const locationLink = company.location_link || '';
  const parts = [
    `${title}: ${availableTimes.join(', ')}`,
    buildBookingFormatReply(),
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
  - Дүрэм 5 (Цаг захиалах): Заавал 3 зүйл авна — нэр, утас (8 орон), цаг. Дутуу байвал дарааллаар асуу: эхлээд нэр, дараа нь утас, эцэст цаг. Жишээ нэг мессежээр: ${BOOKING_EXAMPLE}

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
