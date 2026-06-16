const express = require('express');
const axios = require('axios');

const router = express.Router();

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN || '';
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || '';

/**
 * Facebook Webhook баталгаажуулалт (Meta Developer → Webhooks → Verify)
 * GET /api/webhook?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...
 */
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN && VERIFY_TOKEN) {
    console.log('[Messenger] Webhook баталгаажлаа.');
    return res.status(200).send(challenge);
  }

  console.warn('[Messenger] Webhook баталгаажуулалт амжилтгүй — verify token таарахгүй.');
  res.sendStatus(403);
});

/**
 * Хэрэглэгчийн чат ирэх үед Facebook энд POST илгээнэ.
 * POST /api/webhook
 */
router.post('/', (req, res) => {
  const body = req.body;

  if (body.object === 'page') {
    for (const entry of body.entry || []) {
      for (const event of entry.messaging || []) {
        handleMessagingEvent(event);
      }
    }
  }

  // Facebook 200 OK хүлээдэг — хурдан хариулна
  res.status(200).send('EVENT_RECEIVED');
});

function handleMessagingEvent(event) {
  const senderId = event.sender?.id;

  if (event.message) {
    const text = event.message.text || '(текстгүй мессеж)';
    console.log(`[Messenger] ${senderId}: ${text}`);
    // TODO: энд захиалга, хайлт гэх мэт логик нэмнэ
    return;
  }

  if (event.postback) {
    console.log(`[Messenger] ${senderId} postback: ${event.postback.payload}`);
    return;
  }

  console.log('[Messenger] Бусад event:', JSON.stringify(event));
}

/** Graph API-аар хариу илгээх (PAGE_ACCESS_TOKEN шаардлагатай) */
async function sendTextMessage(recipientId, text) {
  if (!PAGE_ACCESS_TOKEN) {
    console.warn('[Messenger] PAGE_ACCESS_TOKEN тохируулаагүй — хариу илгээгдэхгүй.');
    return;
  }
  await axios.post(
    'https://graph.facebook.com/v21.0/me/messages',
    {
      recipient: { id: recipientId },
      message: { text },
    },
    { params: { access_token: PAGE_ACCESS_TOKEN } }
  );
}

module.exports = router;
module.exports.sendTextMessage = sendTextMessage;
