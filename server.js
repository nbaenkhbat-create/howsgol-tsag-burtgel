require('dotenv').config();

const path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getData, save } = require('./db');
const { logFirebaseStatus } = require('./services/firebase');
const companyService = require('./services/companyService');
const scheduleService = require('./services/scheduleService');
const webhookRoutes = require('./routes/webhook');

webhookRoutes.logEnvStatus();
logFirebaseStatus();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'tsag-burtgel-dev-secret-change-me';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://howsgol-tsag-burtgel.onrender.com';
const RESERVED = new Set(['admin-secretify', 'api', 'assets', 'favicon.ico', 'robots.txt', 'health', 'webhook']);

app.use(express.json({ limit: '2mb' }));

function bootstrapSuperAdmin() {
  const data = getData();
  const username = process.env.SUPERADMIN_USER || 'superadmin';
  const password = process.env.SUPERADMIN_PASS || 'admin123';

  const exists = !!data.superAdmin;
  const usernameChanged = exists && data.superAdmin.username !== username;
  const passwordChanged = exists && !bcrypt.compareSync(password, data.superAdmin.passwordHash);

  if (!exists || usernameChanged || passwordChanged) {
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
    } catch (_) {
      return res.status(401).json({ error: 'Хүчингүй токен' });
    }
  };
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function dateIsValid(date) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(date || ''));
}

function cleanCompanyPayload(body = {}, existingUsername = '') {
  const username = existingUsername || body.username;
  return {
    company_name: body.company_name || body.companyName,
    phone: body.phone,
    username,
    password: body.password,
    page_link: body.page_link,
    info_phone: body.info_phone,
    location_link: body.location_link,
    website_link:
      body.website_link ||
      (username ? `${PUBLIC_BASE_URL}/${String(username).trim().toLowerCase()}` : ''),
  };
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

app.get(
  '/api/admin/vendors',
  auth('admin'),
  asyncRoute(async (_req, res) => {
    const companies = await companyService.listCompanies();
    const vendors = await Promise.all(
      companies.map(async (company) => {
        const bookings = await scheduleService.listBookings(company);
        return {
          ...company,
          bookingCount: Array.isArray(bookings) ? bookings.length : 0,
        };
      })
    );
    res.json({ vendors });
  })
);

app.post(
  '/api/admin/vendors',
  auth('admin'),
  asyncRoute(async (req, res) => {
    const company = await companyService.createCompany(cleanCompanyPayload(req.body));
    res.status(201).json({
      vendor: company,
      loginUrl: `/${company.username}`,
      bookingUrl: '/',
    });
  })
);

app.put(
  '/api/admin/vendors/:username',
  auth('admin'),
  asyncRoute(async (req, res) => {
    const company = await companyService.updateCompany(
      req.params.username,
      cleanCompanyPayload(req.body, req.params.username)
    );
    res.json({ vendor: company });
  })
);

app.delete(
  '/api/admin/vendors/:username',
  auth('admin'),
  asyncRoute(async (req, res) => {
    await companyService.deleteCompany(req.params.username);
    res.json({ ok: true });
  })
);

/* ============================================================================
 * VENDOR (Байгууллагын Админ) API
 * ========================================================================== */
app.post(
  '/api/vendor/login',
  asyncRoute(async (req, res) => {
    const { username, password } = req.body || {};
    const company = await companyService.verifyCompanyLogin(username, password);
    if (!company) return res.status(401).json({ error: 'Нэвтрэх нэр эсвэл нууц үг буруу' });

    return res.json({
      token: signToken({ role: 'vendor', vendorId: company.id, username: company.username }),
      vendor: { username: company.username, companyName: company.company_name, name: company.company_name },
    });
  })
);

app.get(
  '/api/vendor/me',
  auth('vendor'),
  asyncRoute(async (req, res) => {
    const company = await companyService.findCompanyByUsername(req.user.username);
    if (!company) return res.status(404).json({ error: 'Олдсонгүй' });
    res.json({
      username: company.username,
      companyName: company.company_name,
      name: company.company_name,
      phone: company.phone,
    });
  })
);

app.get(
  '/api/vendor/day',
  auth('vendor'),
  asyncRoute(async (req, res) => {
    const date = String(req.query.date || '');
    if (!dateIsValid(date)) return res.status(400).json({ error: 'Огноо буруу (YYYY-MM-DD)' });
    const company = await companyService.findCompanyByUsername(req.user.username);
    if (!company) return res.status(404).json({ error: 'Олдсонгүй' });
    res.json(await scheduleService.getDaySlots(company, date, { adminView: true }));
  })
);

app.post(
  '/api/vendor/blocked-slots',
  auth('vendor'),
  asyncRoute(async (req, res) => {
    const { date, hours } = req.body || {};
    if (!dateIsValid(date)) return res.status(400).json({ error: 'Огноо буруу' });
    if (!Array.isArray(hours)) return res.status(400).json({ error: 'hours массив байх ёстой' });
    const company = await companyService.findCompanyByUsername(req.user.username);
    if (!company) return res.status(404).json({ error: 'Олдсонгүй' });
    const blockedHours = await scheduleService.setBlockedHours(company, date, hours);
    res.json({ ok: true, date, blockedHours });
  })
);

app.get(
  '/api/vendor/blocked-days',
  auth('vendor'),
  asyncRoute(async (req, res) => {
    const company = await companyService.findCompanyByUsername(req.user.username);
    if (!company) return res.status(404).json({ error: 'Олдсонгүй' });
    res.json({ blockedDays: await scheduleService.listBlockedDays(company) });
  })
);

app.post(
  '/api/vendor/blocked-day',
  auth('vendor'),
  asyncRoute(async (req, res) => {
    const { date, blocked } = req.body || {};
    if (!dateIsValid(date)) return res.status(400).json({ error: 'Огноо буруу' });
    const company = await companyService.findCompanyByUsername(req.user.username);
    if (!company) return res.status(404).json({ error: 'Олдсонгүй' });
    await scheduleService.setBlockedDay(company, date, blocked);
    res.json({ ok: true, date, blocked: Boolean(blocked) });
  })
);

app.get(
  '/api/vendor/bookings',
  auth('vendor'),
  asyncRoute(async (req, res) => {
    const company = await companyService.findCompanyByUsername(req.user.username);
    if (!company) return res.status(404).json({ error: 'Олдсонгүй' });
    res.json({ bookings: await scheduleService.listBookings(company) });
  })
);

app.delete(
  '/api/vendor/bookings/:id',
  auth('vendor'),
  asyncRoute(async (req, res) => {
    const company = await companyService.findCompanyByUsername(req.user.username);
    if (!company) return res.status(404).json({ error: 'Олдсонгүй' });
    await scheduleService.deleteBooking(company, req.params.id);
    res.json({ ok: true });
  })
);

/* ============================================================================
 * PUBLIC (Үйлчлүүлэгч) API
 * ========================================================================== */
app.get(
  '/api/search',
  asyncRoute(async (req, res) => {
    const results = (await companyService.searchCompanies(req.query.q)).map((company) => ({
      username: company.username,
      companyName: company.company_name,
      company_name: company.company_name,
    }));
    res.json({ results });
  })
);

app.get(
  '/api/public/:username',
  asyncRoute(async (req, res) => {
    const company = await companyService.findCompanyByUsername(req.params.username);
    if (!company) return res.status(404).json({ error: 'Байгууллага олдсонгүй' });
    res.json({ username: company.username, companyName: company.company_name, company });
  })
);

app.get(
  '/api/public/:username/day',
  asyncRoute(async (req, res) => {
    const company = await companyService.findCompanyByUsername(req.params.username);
    if (!company) return res.status(404).json({ error: 'Байгууллага олдсонгүй' });
    const date = String(req.query.date || '');
    if (!dateIsValid(date)) return res.status(400).json({ error: 'Огноо буруу (YYYY-MM-DD)' });
    const day = await scheduleService.getDaySlots(company, date);
    res.json({ ...day, companyName: company.company_name });
  })
);

app.get(
  '/api/public/:username/next-days',
  asyncRoute(async (req, res) => {
    const company = await companyService.findCompanyByUsername(req.params.username);
    if (!company) return res.status(404).json({ error: 'Байгууллага олдсонгүй' });
    const today = scheduleService.todayStr(0);
    const tomorrow = scheduleService.todayStr(1);
    const [todaySlots, tomorrowSlots] = await Promise.all([
      scheduleService.getDaySlots(company, today),
      scheduleService.getDaySlots(company, tomorrow),
    ]);
    res.json({ company, days: [todaySlots, tomorrowSlots] });
  })
);

app.post(
  '/api/public/:username/book',
  asyncRoute(async (req, res) => {
    const company = await companyService.findCompanyByUsername(req.params.username);
    if (!company) return res.status(404).json({ error: 'Байгууллага олдсонгүй' });
    const { date, hour, customerName, customerPhone } = req.body || {};
    if (!dateIsValid(date)) return res.status(400).json({ error: 'Огноо буруу' });
    if (!customerName || !customerPhone) {
      return res.status(400).json({ error: 'Нэр болон утасны дугаараа бөглөнө үү' });
    }
    const booking = await scheduleService.createBooking(company, date, hour, customerName, customerPhone);
    res.status(201).json({ ok: true, booking: { id: booking.id, date, hour: Number(hour) } });
  })
);

/* ============================================================================
 * FACEBOOK MESSENGER WEBHOOK
 * Meta callback URL: https://howsgol-tsag-burtgel.onrender.com/api/webhook
 * (эсвэл /webhook — хоёул ажиллана)
 * ========================================================================== */
app.use('/api/webhook', webhookRoutes);
app.use('/webhook', webhookRoutes);

/* ============================================================================
 * STATIC ASSETS + ХУУДАСНЫ ROUTING
 * ========================================================================== */
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets')));

const page = (file) => (_req, res) => res.sendFile(path.join(__dirname, 'public', file));

app.get('/', page('index.html'));
app.get('/admin-secretify', page('admin.html'));
app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/:username/tsag', (req, res, next) => {
  if (RESERVED.has(req.params.username.toLowerCase())) return next();
  res.redirect(302, '/');
});

app.get('/:username', (req, res, next) => {
  if (RESERVED.has(req.params.username.toLowerCase())) return next();
  page('booking.html')(req, res);
});

app.use((err, _req, res, _next) => {
  console.error('[Server] Алдаа:', err);
  res.status(err.status || 500).json({ error: err.message || 'Серверийн алдаа' });
});

app.use((_req, res) => {
  res.status(404).send('404 — Хуудас олдсонгүй');
});

bootstrapSuperAdmin();
companyService.ensureDefaultCompany().catch((err) => {
  console.error('[Company] Default company seed алдаа:', err);
});
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Цаг бүртгэлийн систем ажиллаж байна:  port ${PORT}`);
});
