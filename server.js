const path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getData, save, nextId } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'tsag-burtgel-dev-secret-change-me';

app.use(express.json());

/* ----------------------------------------------------------------------------
 * Super admin-ийг анх удаа автоматаар үүсгэх
 * -------------------------------------------------------------------------- */
function bootstrapSuperAdmin() {
  const data = getData();
  if (!data.superAdmin) {
    const username = process.env.SUPERADMIN_USER || 'superadmin';
    const password = process.env.SUPERADMIN_PASS || 'admin123';
    data.superAdmin = {
      username,
      passwordHash: bcrypt.hashSync(password, 10),
    };
    save();
    console.log('────────────────────────────────────────────');
    console.log(' Глобал Админ (Super Admin) бэлэн боллоо:');
    console.log('   URL:      /admin-secretify');
    console.log('   Нэвтрэх:  ' + username);
    console.log('   Нууц үг:  ' + password);
    console.log('────────────────────────────────────────────');
  }
}

/* ----------------------------------------------------------------------------
 * Туслах функцууд
 * -------------------------------------------------------------------------- */
const RESERVED = new Set(['admin-secretify', 'api', 'assets', 'favicon.ico', 'robots.txt']);
const HOURS = Array.from({ length: 24 }, (_, i) => i + 1); // 1..24

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

function auth(role) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Нэвтрэх шаардлагатай' });
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (role && decoded.role !== role) {
        return res.status(403).json({ error: 'Эрх хүрэлцэхгүй байна' });
      }
      req.user = decoded;
      next();
    } catch (e) {
      return res.status(401).json({ error: 'Хүчингүй токен' });
    }
  };
}

function findVendorByUsername(username) {
  return getData().vendors.find(
    (v) => v.username.toLowerCase() === String(username).toLowerCase()
  );
}

function findVendorById(id) {
  return getData().vendors.find((v) => v.id === id);
}

function isDayBlocked(vendorId, date) {
  return getData().blockedDays.some((b) => b.vendorId === vendorId && b.date === date);
}

function blockedHoursFor(vendorId, date) {
  return getData()
    .blockedSlots.filter((b) => b.vendorId === vendorId && b.date === date)
    .map((b) => b.hour);
}

function bookingsFor(vendorId, date) {
  return getData().bookings.filter((b) => b.vendorId === vendorId && b.date === date);
}

/* ============================================================================
 * GLOBAL ADMIN API
 * ========================================================================== */
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  const data = getData();
  if (!data.superAdmin) return res.status(500).json({ error: 'Админ тохируулагдаагүй' });
  if (
    username === data.superAdmin.username &&
    bcrypt.compareSync(String(password || ''), data.superAdmin.passwordHash)
  ) {
    return res.json({ token: signToken({ role: 'admin', username }) });
  }
  res.status(401).json({ error: 'Нэвтрэх нэр эсвэл нууц үг буруу' });
});

app.get('/api/admin/me', auth('admin'), (req, res) => {
  res.json({ username: req.user.username, role: 'admin' });
});

app.get('/api/admin/vendors', auth('admin'), (req, res) => {
  const vendors = getData().vendors.map((v) => ({
    id: v.id,
    name: v.name,
    companyName: v.companyName,
    username: v.username,
    phone: v.phone,
    createdAt: v.createdAt,
    bookingCount: getData().bookings.filter((b) => b.vendorId === v.id).length,
  }));
  res.json({ vendors });
});

app.post('/api/admin/vendors', auth('admin'), (req, res) => {
  const { name, companyName, username, password, phone } = req.body || {};
  if (!name || !companyName || !username || !password) {
    return res.status(400).json({ error: 'Нэр, компани, нэвтрэх нэр, нууц үг шаардлагатай' });
  }
  const uname = String(username).trim().toLowerCase();
  if (!/^[a-z0-9_-]{2,30}$/.test(uname)) {
    return res
      .status(400)
      .json({ error: 'Нэвтрэх нэр зөвхөн a-z, 0-9, _, - тэмдэгт, 2-30 урт байх ёстой' });
  }
  if (RESERVED.has(uname)) {
    return res.status(400).json({ error: 'Энэ нэвтрэх нэрийг ашиглах боломжгүй' });
  }
  if (findVendorByUsername(uname)) {
    return res.status(409).json({ error: 'Энэ нэвтрэх нэр аль хэдийн бүртгэгдсэн байна' });
  }
  const data = getData();
  const vendor = {
    id: nextId('vendor'),
    name: String(name).trim(),
    companyName: String(companyName).trim(),
    username: uname,
    passwordHash: bcrypt.hashSync(String(password), 10),
    phone: String(phone || '').trim(),
    createdAt: new Date().toISOString(),
  };
  data.vendors.push(vendor);
  save();
  res.status(201).json({
    vendor: { id: vendor.id, username: vendor.username, companyName: vendor.companyName },
    loginUrl: `/${vendor.username}`,
    bookingUrl: `/${vendor.username}/tsag`,
  });
});

app.delete('/api/admin/vendors/:id', auth('admin'), (req, res) => {
  const id = Number(req.params.id);
  const data = getData();
  const idx = data.vendors.findIndex((v) => v.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Олдсонгүй' });
  data.vendors.splice(idx, 1);
  data.bookings = data.bookings.filter((b) => b.vendorId !== id);
  data.blockedSlots = data.blockedSlots.filter((b) => b.vendorId !== id);
  data.blockedDays = data.blockedDays.filter((b) => b.vendorId !== id);
  save();
  res.json({ ok: true });
});

/* ============================================================================
 * VENDOR (Байгууллагын Админ) API
 * ========================================================================== */
app.post('/api/vendor/login', (req, res) => {
  const { username, password } = req.body || {};
  const vendor = findVendorByUsername(username);
  if (vendor && bcrypt.compareSync(String(password || ''), vendor.passwordHash)) {
    return res.json({
      token: signToken({ role: 'vendor', vendorId: vendor.id, username: vendor.username }),
      vendor: { username: vendor.username, companyName: vendor.companyName, name: vendor.name },
    });
  }
  res.status(401).json({ error: 'Нэвтрэх нэр эсвэл нууц үг буруу' });
});

app.get('/api/vendor/me', auth('vendor'), (req, res) => {
  const vendor = findVendorById(req.user.vendorId);
  if (!vendor) return res.status(404).json({ error: 'Олдсонгүй' });
  res.json({
    username: vendor.username,
    companyName: vendor.companyName,
    name: vendor.name,
    phone: vendor.phone,
  });
});

// Тухайн өдрийн бүх цагийн төлөв (admin талд)
app.get('/api/vendor/day', auth('vendor'), (req, res) => {
  const date = String(req.query.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Огноо буруу (YYYY-MM-DD)' });
  }
  const vendorId = req.user.vendorId;
  const dayBlocked = isDayBlocked(vendorId, date);
  const blocked = new Set(blockedHoursFor(vendorId, date));
  const books = bookingsFor(vendorId, date);
  const bookingByHour = {};
  books.forEach((b) => (bookingByHour[b.hour] = b));

  const slots = HOURS.map((hour) => {
    const booking = bookingByHour[hour];
    let status = 'available';
    if (booking) status = 'booked';
    else if (dayBlocked || blocked.has(hour)) status = 'blocked';
    return {
      hour,
      status,
      blocked: blocked.has(hour),
      booking: booking
        ? { customerName: booking.customerName, customerPhone: booking.customerPhone }
        : null,
    };
  });

  res.json({ date, dayBlocked, slots });
});

// Тухайн өдрийн "захиалга авахгүй цагууд"-ын бүтэн жагсаалтыг хадгална
app.post('/api/vendor/blocked-slots', auth('vendor'), (req, res) => {
  const { date, hours } = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
    return res.status(400).json({ error: 'Огноо буруу' });
  }
  if (!Array.isArray(hours)) return res.status(400).json({ error: 'hours массив байх ёстой' });
  const vendorId = req.user.vendorId;
  const data = getData();
  // Захиалга өгсөн цагийг блоклохгүй
  const booked = new Set(bookingsFor(vendorId, date).map((b) => b.hour));
  const clean = [...new Set(hours.map(Number))].filter(
    (h) => HOURS.includes(h) && !booked.has(h)
  );
  // Энэ өдрийн хуучин блокуудыг устгаад шинээр бичнэ
  data.blockedSlots = data.blockedSlots.filter(
    (b) => !(b.vendorId === vendorId && b.date === date)
  );
  clean.forEach((hour) => data.blockedSlots.push({ vendorId, date, hour }));
  save();
  res.json({ ok: true, date, blockedHours: clean });
});

app.get('/api/vendor/blocked-days', auth('vendor'), (req, res) => {
  const vendorId = req.user.vendorId;
  const days = getData()
    .blockedDays.filter((b) => b.vendorId === vendorId)
    .map((b) => b.date)
    .sort();
  res.json({ blockedDays: days });
});

app.post('/api/vendor/blocked-day', auth('vendor'), (req, res) => {
  const { date, blocked } = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
    return res.status(400).json({ error: 'Огноо буруу' });
  }
  const vendorId = req.user.vendorId;
  const data = getData();
  data.blockedDays = data.blockedDays.filter(
    (b) => !(b.vendorId === vendorId && b.date === date)
  );
  if (blocked) data.blockedDays.push({ vendorId, date });
  save();
  res.json({ ok: true, date, blocked: !!blocked });
});

app.get('/api/vendor/bookings', auth('vendor'), (req, res) => {
  const vendorId = req.user.vendorId;
  const bookings = getData()
    .bookings.filter((b) => b.vendorId === vendorId)
    .sort((a, b) => (a.date + String(a.hour).padStart(2, '0')).localeCompare(b.date + String(b.hour).padStart(2, '0')));
  res.json({ bookings });
});

app.delete('/api/vendor/bookings/:id', auth('vendor'), (req, res) => {
  const id = Number(req.params.id);
  const vendorId = req.user.vendorId;
  const data = getData();
  const idx = data.bookings.findIndex((b) => b.id === id && b.vendorId === vendorId);
  if (idx === -1) return res.status(404).json({ error: 'Олдсонгүй' });
  data.bookings.splice(idx, 1);
  save();
  res.json({ ok: true });
});

/* ============================================================================
 * PUBLIC (Үйлчлүүлэгч) API
 * ========================================================================== */
app.get('/api/search', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) return res.json({ results: [] });
  const results = getData()
    .vendors.filter(
      (v) =>
        v.username.toLowerCase().includes(q) ||
        v.companyName.toLowerCase().includes(q)
    )
    .slice(0, 20)
    .map((v) => ({ username: v.username, companyName: v.companyName }));
  res.json({ results });
});

app.get('/api/public/:username', (req, res) => {
  const vendor = findVendorByUsername(req.params.username);
  if (!vendor) return res.status(404).json({ error: 'Байгууллага олдсонгүй' });
  res.json({ username: vendor.username, companyName: vendor.companyName });
});

// Үйлчлүүлэгчид зөвхөн сул цагуудыг харуулна
app.get('/api/public/:username/day', (req, res) => {
  const vendor = findVendorByUsername(req.params.username);
  if (!vendor) return res.status(404).json({ error: 'Байгууллага олдсонгүй' });
  const date = String(req.query.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Огноо буруу (YYYY-MM-DD)' });
  }
  const vendorId = vendor.id;
  const dayBlocked = isDayBlocked(vendorId, date);
  const blocked = new Set(blockedHoursFor(vendorId, date));
  const booked = new Set(bookingsFor(vendorId, date).map((b) => b.hour));

  const slots = HOURS.map((hour) => {
    const available = !dayBlocked && !blocked.has(hour) && !booked.has(hour);
    return { hour, available };
  });
  res.json({ date, companyName: vendor.companyName, slots });
});

app.post('/api/public/:username/book', (req, res) => {
  const vendor = findVendorByUsername(req.params.username);
  if (!vendor) return res.status(404).json({ error: 'Байгууллага олдсонгүй' });
  const { date, hour, customerName, customerPhone } = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
    return res.status(400).json({ error: 'Огноо буруу' });
  }
  const h = Number(hour);
  if (!HOURS.includes(h)) return res.status(400).json({ error: 'Цаг буруу' });
  if (!customerName || !customerPhone) {
    return res.status(400).json({ error: 'Нэр болон утасны дугаараа бөглөнө үү' });
  }
  const vendorId = vendor.id;
  if (isDayBlocked(vendorId, date)) {
    return res.status(409).json({ error: 'Тухайн өдөр захиалга авахгүй байна' });
  }
  if (blockedHoursFor(vendorId, date).includes(h)) {
    return res.status(409).json({ error: 'Энэ цаг захиалга авахгүй' });
  }
  if (bookingsFor(vendorId, date).some((b) => b.hour === h)) {
    return res.status(409).json({ error: 'Энэ цаг аль хэдийн захиалагдсан байна' });
  }
  const data = getData();
  const booking = {
    id: nextId('booking'),
    vendorId,
    date,
    hour: h,
    customerName: String(customerName).trim(),
    customerPhone: String(customerPhone).trim(),
    createdAt: new Date().toISOString(),
  };
  data.bookings.push(booking);
  save();
  res.status(201).json({ ok: true, booking: { date, hour: h } });
});

/* ============================================================================
 * STATIC ASSETS + ХУУДАСНЫ ROUTING
 * ========================================================================== */
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets')));

const page = (file) => (req, res) =>
  res.sendFile(path.join(__dirname, 'public', file));

app.get('/', page('index.html'));
app.get('/admin-secretify', page('admin.html'));
app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/:username/tsag', (req, res, next) => {
  if (RESERVED.has(req.params.username.toLowerCase())) return next();
  page('booking.html')(req, res);
});

app.get('/:username', (req, res, next) => {
  if (RESERVED.has(req.params.username.toLowerCase())) return next();
  page('vendor.html')(req, res);
});

app.use((req, res) => {
  res.status(404).send('404 — Хуудас олдсонгүй');
});

bootstrapSuperAdmin();
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Цаг бүртгэлийн систем ажиллаж байна:  port ${PORT}`);
});
