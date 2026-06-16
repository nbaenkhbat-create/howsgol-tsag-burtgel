/**
 * Маш энгийн JSON file-д суурилсан өгөгдлийн сан.
 * (Native compile шаардахгүй тул Windows + Node 24 дээр асуудалгүй ажиллана.)
 *
 * Бүтэц:
 *   superAdmin: { username, passwordHash }
 *   vendors:    [{ id, name, companyName, username, passwordHash, phone, createdAt }]
 *   bookings:   [{ id, vendorId, date, hour, customerName, customerPhone, createdAt }]
 *   blockedSlots: [{ vendorId, date, hour }]   // тодорхой өдрийн тодорхой цаг хаасан
 *   blockedDays:  [{ vendorId, date }]          // бүтэн өдөр хаасан
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const DEFAULT_DATA = {
  superAdmin: null,
  vendors: [],
  bookings: [],
  blockedSlots: [],
  blockedDays: [],
  seq: { vendor: 0, booking: 0 },
};

let cache = null;

function ensureLoaded() {
  if (cache) return cache;
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DB_FILE)) {
    cache = JSON.parse(JSON.stringify(DEFAULT_DATA));
    save();
  } else {
    try {
      const raw = fs.readFileSync(DB_FILE, 'utf-8');
      cache = Object.assign(JSON.parse(JSON.stringify(DEFAULT_DATA)), JSON.parse(raw || '{}'));
    } catch (e) {
      console.error('db.json уншихад алдаа гарлаа, шинээр эхлүүлж байна:', e.message);
      cache = JSON.parse(JSON.stringify(DEFAULT_DATA));
      save();
    }
  }
  return cache;
}

function save() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(cache, null, 2), 'utf-8');
}

function getData() {
  return ensureLoaded();
}

function nextId(kind) {
  const data = ensureLoaded();
  data.seq[kind] = (data.seq[kind] || 0) + 1;
  return data.seq[kind];
}

module.exports = { getData, save, nextId };
