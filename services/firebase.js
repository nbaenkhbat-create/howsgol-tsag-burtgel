const { initializeApp, getApps, getApp, applicationDefault, cert } = require('firebase-admin/app');
const { getFirestore: getAdminFirestore } = require('firebase-admin/firestore');
const { getDatabase: getAdminDatabase } = require('firebase-admin/database');

let app = null;
let firestore = null;
let realtimeDb = null;
let credentialState = null;

function normalizePrivateKey(value) {
  return String(value || '').replace(/\\n/g, '\n');
}

function validateServiceAccount(serviceAccount) {
  if (!serviceAccount || typeof serviceAccount !== 'object') {
    return 'service account JSON хоосон байна';
  }
  if (!serviceAccount.project_id || !serviceAccount.client_email || !serviceAccount.private_key) {
    return 'FIREBASE_SERVICE_ACCOUNT_JSON нь service account биш байна (project_id/client_email/private_key дутуу)';
  }
  return '';
}

function parseJson(raw, label) {
  try {
    return { value: JSON.parse(raw), error: '' };
  } catch (err) {
    return { value: null, error: `${label} JSON parse алдаа: ${err.message}` };
  }
}

function getCredentialState() {
  if (credentialState) return credentialState;

  const rawJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (rawJson) {
    const parsed = parseJson(rawJson, 'FIREBASE_SERVICE_ACCOUNT_JSON');
    const validation = parsed.error || validateServiceAccount(parsed.value);
    credentialState = validation
      ? { ok: false, serviceAccount: null, reason: validation }
      : { ok: true, serviceAccount: parsed.value, reason: '' };
    return credentialState;
  }

  const base64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (base64) {
    try {
      const decoded = Buffer.from(base64, 'base64').toString('utf8');
      const parsed = parseJson(decoded, 'FIREBASE_SERVICE_ACCOUNT_BASE64');
      const validation = parsed.error || validateServiceAccount(parsed.value);
      credentialState = validation
        ? { ok: false, serviceAccount: null, reason: validation }
        : { ok: true, serviceAccount: parsed.value, reason: '' };
      return credentialState;
    } catch (err) {
      credentialState = { ok: false, serviceAccount: null, reason: `base64 decode алдаа: ${err.message}` };
      return credentialState;
    }
  }

  if (process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_PROJECT_ID) {
    credentialState = {
      ok: true,
      serviceAccount: {
        project_id: process.env.FIREBASE_PROJECT_ID,
        client_email: process.env.FIREBASE_CLIENT_EMAIL,
        private_key: normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY),
      },
      reason: '',
    };
    return credentialState;
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    credentialState = { ok: true, serviceAccount: null, reason: '' };
    return credentialState;
  }

  credentialState = { ok: false, serviceAccount: null, reason: 'Firebase Admin credential тохируулаагүй' };
  return credentialState;
}

function getFirebaseApp() {
  if (app) return app;

  const existingApps = getApps();
  if (existingApps.length) {
    app = getApp();
    return app;
  }

  const databaseURL = process.env.FIREBASE_DATABASE_URL;
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const credentials = getCredentialState();
  const options = {};

  if (databaseURL) options.databaseURL = databaseURL;
  if (projectId) options.projectId = projectId;

  if (!credentials.ok) {
    throw new Error(credentials.reason);
  }

  if (credentials.serviceAccount) {
    app = initializeApp({
      credential: cert(credentials.serviceAccount),
      ...options,
    });
    return app;
  }

  app = initializeApp({
    credential: applicationDefault(),
    ...options,
  });
  return app;
}

function isFirebaseConfigured() {
  return getCredentialState().ok;
}

function getFirestore() {
  if (firestore) return firestore;
  firestore = getAdminFirestore(getFirebaseApp());
  return firestore;
}

function getRealtimeDb() {
  if (realtimeDb) return realtimeDb;
  realtimeDb = getAdminDatabase(getFirebaseApp());
  return realtimeDb;
}

function logFirebaseStatus() {
  const credentials = getCredentialState();
  console.log('[Firebase] Admin SDK:', credentials.ok ? 'configured' : 'not configured');
  if (!credentials.ok) {
    console.warn('[Firebase] reason:', credentials.reason);
    console.warn('[Firebase] Firestore disabled, local JSON fallback ашиглана.');
  }
  if (process.env.FIREBASE_PROJECT_ID) {
    console.log('[Firebase] project:', process.env.FIREBASE_PROJECT_ID);
  }
}

module.exports = {
  getFirestore,
  getRealtimeDb,
  isFirebaseConfigured,
  logFirebaseStatus,
};
