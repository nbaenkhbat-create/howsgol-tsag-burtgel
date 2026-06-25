const { getFirestore, isFirebaseConfigured } = require('./firebase');

const DEFAULT_HUMAN_ACTIVE_MINUTES = 30;
const localSessions = new Map();

function getHumanActiveMinutes() {
  const n = Number(process.env.HUMAN_ACTIVE_MINUTES || DEFAULT_HUMAN_ACTIVE_MINUTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_HUMAN_ACTIVE_MINUTES;
}

function sessionDocId(companyUsername, userId) {
  return `${String(companyUsername).trim().toLowerCase()}_${String(userId).trim()}`;
}

function isSessionActive(data) {
  if (!data || data.isHumanActive !== true) return false;
  if (!data.expiresAt) return true;
  return new Date(data.expiresAt) > new Date();
}

async function setHumanActive(company, userId) {
  const companyId = company.username || company.id;
  const minutes = getHumanActiveMinutes();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + minutes * 60 * 1000).toISOString();
  const data = {
    companyId,
    userId: String(userId),
    isHumanActive: true,
    expiresAt,
    updatedAt: now.toISOString(),
  };

  const key = sessionDocId(companyId, userId);

  if (isFirebaseConfigured()) {
    await getFirestore().collection('chat_sessions').doc(key).set(data, { merge: true });
  } else {
    localSessions.set(key, data);
  }

  return data;
}

async function isHumanActive(company, userId) {
  const companyId = company.username || company.id;
  const key = sessionDocId(companyId, userId);

  if (isFirebaseConfigured()) {
    const doc = await getFirestore().collection('chat_sessions').doc(key).get();
    if (!doc.exists) return false;
    return isSessionActive(doc.data());
  }

  const data = localSessions.get(key);
  if (!isSessionActive(data)) {
    if (data) localSessions.delete(key);
    return false;
  }
  return true;
}

module.exports = {
  setHumanActive,
  isHumanActive,
  getHumanActiveMinutes,
};
