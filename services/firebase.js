const admin = require('firebase-admin');

let app = null;
let firestore = null;
let realtimeDb = null;

function parseServiceAccount() {
  const rawJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (rawJson) {
    return JSON.parse(rawJson);
  }

  const base64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (base64) {
    return JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
  }

  return null;
}

function getFirebaseApp() {
  if (app) return app;

  if (admin.apps.length) {
    app = admin.app();
    return app;
  }

  const databaseURL = process.env.FIREBASE_DATABASE_URL;
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const serviceAccount = parseServiceAccount();
  const options = {};

  if (databaseURL) options.databaseURL = databaseURL;
  if (projectId) options.projectId = projectId;

  if (serviceAccount) {
    app = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      ...options,
    });
    return app;
  }

  // Render/Google runtime дээр GOOGLE_APPLICATION_CREDENTIALS эсвэл default creds байвал ажиллана.
  app = admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    ...options,
  });
  return app;
}

function isFirebaseConfigured() {
  return Boolean(
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
      process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 ||
      process.env.GOOGLE_APPLICATION_CREDENTIALS ||
      process.env.FIREBASE_PROJECT_ID
  );
}

function getFirestore() {
  if (firestore) return firestore;
  firestore = getFirebaseApp().firestore();
  return firestore;
}

function getRealtimeDb() {
  if (realtimeDb) return realtimeDb;
  realtimeDb = getFirebaseApp().database();
  return realtimeDb;
}

function logFirebaseStatus() {
  console.log('[Firebase] Admin SDK:', isFirebaseConfigured() ? 'configured' : 'not configured');
  if (process.env.FIREBASE_PROJECT_ID) {
    console.log('[Firebase] project:', process.env.FIREBASE_PROJECT_ID);
  }
}

module.exports = {
  admin,
  getFirestore,
  getRealtimeDb,
  isFirebaseConfigured,
  logFirebaseStatus,
};
