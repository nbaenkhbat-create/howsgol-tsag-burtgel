const bcrypt = require('bcryptjs');
const { getData, save, nextId } = require('../db');
const { getFirestore, isFirebaseConfigured } = require('./firebase');

const RESERVED = new Set(['admin-secretify', 'api', 'assets', 'favicon.ico', 'robots.txt', 'health']);

function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

function normalizeCompanyInput(input = {}, existing = null) {
  const username = normalizeUsername(input.username ?? existing?.username);
  const companyName = String(input.company_name ?? input.companyName ?? existing?.company_name ?? '').trim();
  const passwordInput = input.password != null ? String(input.password) : '';
  const passwordHash =
    passwordInput && !passwordInput.startsWith('$2')
      ? bcrypt.hashSync(passwordInput, 10)
      : passwordInput || existing?.password || '';

  return {
    company_name: companyName,
    phone: String(input.phone ?? existing?.phone ?? '').trim(),
    username,
    // Field name нь шаардлагын дагуу `password`, утга нь plaintext биш bcrypt hash.
    password: passwordHash,
    page_link: String(input.page_link ?? existing?.page_link ?? '').trim(),
    info_phone: String(input.info_phone ?? existing?.info_phone ?? '').trim(),
    location_link: String(input.location_link ?? existing?.location_link ?? '').trim(),
    website_link: String(
      input.website_link ??
        existing?.website_link ??
        (username ? `${process.env.PUBLIC_BASE_URL || 'https://howsgol-tsag-burtgel.onrender.com'}/${username}` : '')
    ).trim(),
  };
}

function validateCompany(company, { requirePassword = true } = {}) {
  if (!company.company_name || !company.username || (requirePassword && !company.password)) {
    throw new Error('Компанийн нэр, нэвтрэх нэр, нууц үг шаардлагатай');
  }
  if (!/^[a-z0-9_-]{2,30}$/.test(company.username)) {
    throw new Error('Нэвтрэх нэр зөвхөн a-z, 0-9, _, - тэмдэгт, 2-30 урт байх ёстой');
  }
  if (RESERVED.has(company.username)) {
    throw new Error('Энэ нэвтрэх нэрийг ашиглах боломжгүй');
  }
}

function toPublicCompany(doc) {
  if (!doc) return null;
  return {
    id: doc.id,
    company_name: doc.company_name || doc.companyName || '',
    companyName: doc.company_name || doc.companyName || '',
    phone: doc.phone || '',
    username: doc.username || '',
    page_link: doc.page_link || '',
    info_phone: doc.info_phone || '',
    location_link: doc.location_link || '',
    website_link: doc.website_link || '',
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null,
  };
}

function localVendorToCompany(v) {
  return {
    id: String(v.id),
    company_name: v.companyName || v.company_name || '',
    phone: v.phone || '',
    username: v.username,
    password: v.passwordHash || v.password || '',
    page_link: v.page_link || '',
    info_phone: v.info_phone || v.phone || '',
    location_link: v.location_link || '',
    website_link:
      v.website_link ||
      `${process.env.PUBLIC_BASE_URL || 'https://howsgol-tsag-burtgel.onrender.com'}/${v.username}`,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  };
}

async function useFirestore() {
  return isFirebaseConfigured();
}

async function listCompanies() {
  if (await useFirestore()) {
    const snap = await getFirestore().collection('companies').get();
    return snap.docs
      .map((doc) => toPublicCompany({ id: doc.id, ...doc.data() }))
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  }

  return getData().vendors.map((v) => toPublicCompany(localVendorToCompany(v)));
}

async function findCompanyByUsername(username, { includePassword = false } = {}) {
  const uname = normalizeUsername(username);
  if (!uname) return null;

  if (await useFirestore()) {
    const snap = await getFirestore()
      .collection('companies')
      .where('username', '==', uname)
      .limit(1)
      .get();
    if (snap.empty) return null;
    const data = { id: snap.docs[0].id, ...snap.docs[0].data() };
    return includePassword ? data : toPublicCompany(data);
  }

  const vendor = getData().vendors.find((v) => normalizeUsername(v.username) === uname);
  if (!vendor) return null;
  const company = localVendorToCompany(vendor);
  return includePassword ? company : toPublicCompany(company);
}

async function findCompanyByPage(entry = {}) {
  const pageId = String(entry.id || entry.page_id || '').trim();
  if (!pageId) return null;

  const companies = await listCompanies();
  const matched =
    companies.find((company) => {
      const pageLink = String(company.page_link || '').trim();
      return (
        pageLink === pageId ||
        pageLink.includes(pageId) ||
        pageLink.endsWith(`/${pageId}`) ||
        company.username === pageId
      );
    }) || null;

  if (matched) return matched;

  // Эхний MVP үед нэг л компани бүртгэлтэй бол Facebook page id/link таараагүй ч
  // тухайн ганц компанийг ашиглаж chatbot-ыг ажиллуулна.
  if (companies.length === 1) {
    console.warn('[Company] Page ID таараагүй ч ганц компани байгаа тул fallback ашиглав:', {
      pageId,
      username: companies[0].username,
    });
    return companies[0];
  }

  return null;
}

async function searchCompanies(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];

  const companies = await listCompanies();
  return companies
    .filter(
      (company) =>
        company.username.toLowerCase().includes(q) ||
        company.company_name.toLowerCase().includes(q)
    )
    .slice(0, 20);
}

async function createCompany(input) {
  const company = normalizeCompanyInput(input);
  validateCompany(company);

  const existing = await findCompanyByUsername(company.username, { includePassword: true });
  if (existing) {
    const err = new Error('Энэ нэвтрэх нэр аль хэдийн бүртгэгдсэн байна');
    err.status = 409;
    throw err;
  }

  const now = new Date().toISOString();

  if (await useFirestore()) {
    const docRef = getFirestore().collection('companies').doc(company.username);
    await docRef.set({ ...company, createdAt: now, updatedAt: now });
    return toPublicCompany({ id: docRef.id, ...company, createdAt: now, updatedAt: now });
  }

  const data = getData();
  const vendor = {
    id: nextId('vendor'),
    name: input.name || '',
    companyName: company.company_name,
    username: company.username,
    passwordHash: company.password,
    phone: company.phone,
    page_link: company.page_link,
    info_phone: company.info_phone,
    location_link: company.location_link,
    website_link: company.website_link,
    createdAt: now,
    updatedAt: now,
  };
  data.vendors.push(vendor);
  save();
  return toPublicCompany(localVendorToCompany(vendor));
}

async function ensureDefaultCompany() {
  const username = normalizeUsername(process.env.DEFAULT_COMPANY_USERNAME || 'bayr');
  if (!username) return null;

  const companies = await listCompanies();
  if (companies.length > 0) return null;

  console.log('[Company] Компани хоосон тул default company seed хийж байна:', username);
  return createCompany({
    company_name: process.env.DEFAULT_COMPANY_NAME || 'bayr',
    phone: process.env.DEFAULT_COMPANY_PHONE || '12345678',
    username,
    password: process.env.DEFAULT_COMPANY_PASSWORD || '12345678',
    page_link: process.env.DEFAULT_COMPANY_PAGE_LINK || 'https://www.facebook.com/search/top?q=nowijufaqae',
    info_phone: process.env.DEFAULT_COMPANY_INFO_PHONE || process.env.DEFAULT_COMPANY_PHONE || '12345677',
    location_link: process.env.DEFAULT_COMPANY_LOCATION_LINK || 'https://maps.app.goo.gl/tppoPZmyL4IMq29EFG',
    website_link:
      process.env.DEFAULT_COMPANY_WEBSITE_LINK ||
      `${process.env.PUBLIC_BASE_URL || 'https://howsgol-tsag-burtgel.onrender.com'}/${username}`,
  });
}

async function updateCompany(idOrUsername, input) {
  const key = normalizeUsername(idOrUsername);
  const existing = await findCompanyByUsername(key, { includePassword: true });
  if (!existing) {
    const err = new Error('Компани олдсонгүй');
    err.status = 404;
    throw err;
  }

  const merged = normalizeCompanyInput({ ...input, username: key }, existing);
  validateCompany(merged, { requirePassword: false });
  const now = new Date().toISOString();

  if (await useFirestore()) {
    await getFirestore().collection('companies').doc(key).set(
      {
        ...merged,
        createdAt: existing.createdAt || now,
        updatedAt: now,
      },
      { merge: true }
    );
    return toPublicCompany({ id: key, ...merged, createdAt: existing.createdAt, updatedAt: now });
  }

  const data = getData();
  const idx = data.vendors.findIndex((v) => normalizeUsername(v.username) === key);
  data.vendors[idx] = {
    ...data.vendors[idx],
    companyName: merged.company_name,
    username: merged.username,
    passwordHash: merged.password || data.vendors[idx].passwordHash,
    phone: merged.phone,
    page_link: merged.page_link,
    info_phone: merged.info_phone,
    location_link: merged.location_link,
    website_link: merged.website_link,
    updatedAt: now,
  };
  save();
  return toPublicCompany(localVendorToCompany(data.vendors[idx]));
}

async function deleteCompany(username) {
  const uname = normalizeUsername(username);
  if (await useFirestore()) {
    await getFirestore().collection('companies').doc(uname).delete();
    return;
  }

  const data = getData();
  const vendor = data.vendors.find((v) => normalizeUsername(v.username) === uname || String(v.id) === String(username));
  if (!vendor) return;
  data.vendors = data.vendors.filter((v) => v !== vendor);
  data.bookings = data.bookings.filter((b) => b.vendorId !== vendor.id);
  data.blockedSlots = data.blockedSlots.filter((b) => b.vendorId !== vendor.id);
  data.blockedDays = data.blockedDays.filter((b) => b.vendorId !== vendor.id);
  save();
}

async function verifyCompanyLogin(username, password) {
  const company = await findCompanyByUsername(username, { includePassword: true });
  if (!company || !bcrypt.compareSync(String(password || ''), company.password || '')) return null;
  return toPublicCompany(company);
}

module.exports = {
  normalizeUsername,
  toPublicCompany,
  listCompanies,
  findCompanyByUsername,
  findCompanyByPage,
  searchCompanies,
  createCompany,
  ensureDefaultCompany,
  updateCompany,
  deleteCompany,
  verifyCompanyLogin,
};
