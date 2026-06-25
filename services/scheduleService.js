const { getData, save, nextId } = require('../db');
const { getFirestore, isFirebaseConfigured } = require('./firebase');

const HOURS = Array.from({ length: 24 }, (_, i) => i + 1);
const DEFAULT_BOOKING_RETENTION_DAYS = 60;

function todayStr(offsetDays = 0) {
  const tz = process.env.BOOKING_TIMEZONE || 'Asia/Ulaanbaatar';
  const base = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(base);
}

function hourLabel(hour) {
  return String(hour).padStart(2, '0') + ':00';
}

function companyKey(companyOrId) {
  return typeof companyOrId === 'object'
    ? String(companyOrId.id || companyOrId.username)
    : String(companyOrId);
}

function localVendorId(companyOrId) {
  if (typeof companyOrId === 'object' && /^\d+$/.test(String(companyOrId.id))) {
    return Number(companyOrId.id);
  }
  const data = getData();
  const vendor = data.vendors.find(
    (v) => String(v.id) === String(companyOrId) || v.username === String(companyOrId)
  );
  return vendor ? vendor.id : companyOrId;
}

async function getScheduleDoc(companyId, date) {
  const doc = await getFirestore()
    .collection('companySchedules')
    .doc(`${companyId}_${date}`)
    .get();
  return doc.exists ? doc.data() : {};
}

async function getBookings(companyId, date) {
  if (isFirebaseConfigured()) {
    const snap = await getFirestore()
      .collection('bookings')
      .where('companyId', '==', companyId)
      .where('date', '==', date)
      .get();
    return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  }

  const vendorId = localVendorId(companyId);
  return getData().bookings.filter((b) => b.vendorId === vendorId && b.date === date);
}

async function isDayBlocked(companyId, date) {
  if (isFirebaseConfigured()) {
    const schedule = await getScheduleDoc(companyId, date);
    return Boolean(schedule.blockedDay);
  }

  const vendorId = localVendorId(companyId);
  return getData().blockedDays.some((b) => b.vendorId === vendorId && b.date === date);
}

async function getBlockedHours(companyId, date) {
  if (isFirebaseConfigured()) {
    const schedule = await getScheduleDoc(companyId, date);
    return Array.isArray(schedule.blockedHours) ? schedule.blockedHours.map(Number) : [];
  }

  const vendorId = localVendorId(companyId);
  return getData()
    .blockedSlots.filter((b) => b.vendorId === vendorId && b.date === date)
    .map((b) => b.hour);
}

async function getDaySlots(companyOrId, date, { adminView = false } = {}) {
  const id = companyKey(companyOrId);
  const dayBlocked = await isDayBlocked(id, date);
  const blocked = new Set(await getBlockedHours(id, date));
  const bookings = await getBookings(id, date);
  const bookingByHour = {};
  bookings.forEach((b) => (bookingByHour[b.hour] = b));

  const slots = HOURS.map((hour) => {
    const booking = bookingByHour[hour];
    const available = !dayBlocked && !blocked.has(hour) && !booking;
    if (!adminView) return { hour, available };
    return {
      hour,
      status: booking ? 'booked' : available ? 'available' : 'blocked',
      blocked: blocked.has(hour),
      booking: booking
        ? {
            id: booking.id,
            customerName: booking.customerName,
            customerPhone: booking.customerPhone,
          }
        : null,
    };
  });

  return { date, dayBlocked, slots };
}

async function getAvailableHourLabels(companyOrId, date) {
  const day = await getDaySlots(companyOrId, date);
  return day.slots.filter((slot) => slot.available).map((slot) => hourLabel(slot.hour));
}

async function getAiScheduleContext(company) {
  const today = todayStr(0);
  const tomorrow = todayStr(1);
  const [todayDay, todayHours, tomorrowDay, tomorrowHours] = await Promise.all([
    getDaySlots(company, today),
    getAvailableHourLabels(company, today),
    getDaySlots(company, tomorrow),
    getAvailableHourLabels(company, tomorrow),
  ]);

  return {
    today,
    tomorrow,
    todayAvailable: todayHours,
    tomorrowAvailable: tomorrowHours,
    todayClosed: todayDay.dayBlocked || todayHours.length === 0,
    tomorrowClosed: tomorrowDay.dayBlocked || tomorrowHours.length === 0,
  };
}

function getCurrentSlotHour() {
  const tz = process.env.BOOKING_TIMEZONE || 'Asia/Ulaanbaatar';
  const hour = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(new Date())
  );
  // 1–24 цагийн grid: 00:00–00:59 → 24, 01:00–23:59 → 1–23
  return hour === 0 ? 24 : hour;
}

/**
 * Vendor panel-ийн блоклосон өдөр/цаг дээр Facebook AI-ийн үйлдлийг тодорхойлно.
 * - blocked_day: өнөөдөр бүтэн хаалттай → тод мессеж илгээнэ
 * - blocked_hour: одоогийн цаг блоклогдсон → AI чимээгүй (ажилтан хариулна)
 * - open: хэвийн AI
 */
async function getScheduleChatGate(company) {
  const id = companyKey(company);
  const today = todayStr(0);
  const dayBlocked = await isDayBlocked(id, today);

  if (dayBlocked) {
    return {
      mode: 'blocked_day_message',
      message: 'Уучлаарай, өнөөдөр захиалга авахгүй өдөр.',
      reason: 'blocked_day',
    };
  }

  const blockedHours = await getBlockedHours(id, today);
  if (blockedHours.length >= HOURS.length) {
    return {
      mode: 'blocked_day_message',
      message: 'Уучлаарай, өнөөдөр захиалга авахгүй өдөр.',
      reason: 'all_hours_blocked',
    };
  }

  const currentHour = getCurrentSlotHour();
  if (blockedHours.includes(currentHour)) {
    return { mode: 'silent', reason: 'blocked_hour', hour: currentHour };
  }

  return { mode: 'open' };
}

async function isAiChatPaused(company) {
  const gate = await getScheduleChatGate(company);
  return {
    paused: gate.mode !== 'open',
    mode: gate.mode,
    message: gate.message || '',
    reason: gate.reason,
    hour: gate.hour,
  };
}

async function setBlockedHours(companyOrId, date, hours) {
  const id = companyKey(companyOrId);
  const clean = [...new Set((hours || []).map(Number))].filter((h) => HOURS.includes(h));

  if (isFirebaseConfigured()) {
    await getFirestore()
      .collection('companySchedules')
      .doc(`${id}_${date}`)
      .set(
        {
          companyId: id,
          date,
          blockedHours: clean,
          updatedAt: new Date().toISOString(),
        },
        { merge: true }
      );
    return clean;
  }

  const vendorId = localVendorId(companyOrId);
  const data = getData();
  data.blockedSlots = data.blockedSlots.filter(
    (b) => !(b.vendorId === vendorId && b.date === date)
  );
  clean.forEach((hour) => data.blockedSlots.push({ vendorId, date, hour }));
  save();
  return clean;
}

async function listBlockedDays(companyOrId) {
  const id = companyKey(companyOrId);

  if (isFirebaseConfigured()) {
    const snap = await getFirestore()
      .collection('companySchedules')
      .where('companyId', '==', id)
      .where('blockedDay', '==', true)
      .get();
    return snap.docs.map((doc) => doc.data().date).sort();
  }

  const vendorId = localVendorId(companyOrId);
  return getData()
    .blockedDays.filter((b) => b.vendorId === vendorId)
    .map((b) => b.date)
    .sort();
}

async function setBlockedDay(companyOrId, date, blocked) {
  const id = companyKey(companyOrId);

  if (isFirebaseConfigured()) {
    await getFirestore()
      .collection('companySchedules')
      .doc(`${id}_${date}`)
      .set(
        {
          companyId: id,
          date,
          blockedDay: Boolean(blocked),
          updatedAt: new Date().toISOString(),
        },
        { merge: true }
      );
    return;
  }

  const vendorId = localVendorId(companyOrId);
  const data = getData();
  data.blockedDays = data.blockedDays.filter((b) => !(b.vendorId === vendorId && b.date === date));
  if (blocked) data.blockedDays.push({ vendorId, date });
  save();
}

async function createBooking(companyOrId, date, hour, customerName, customerPhone) {
  const id = companyKey(companyOrId);
  const h = Number(hour);
  if (!HOURS.includes(h)) throw new Error('Цаг буруу');

  const day = await getDaySlots(companyOrId, date);
  const slot = day.slots.find((s) => s.hour === h);
  if (!slot?.available) {
    const err = new Error('Энэ цаг боломжгүй байна');
    err.status = 409;
    throw err;
  }

  const booking = {
    companyId: id,
    date,
    hour: h,
    customerName: String(customerName || '').trim(),
    customerPhone: String(customerPhone || '').trim(),
    createdAt: new Date().toISOString(),
  };

  if (isFirebaseConfigured()) {
    const docRef = await getFirestore().collection('bookings').add(booking);
    return { id: docRef.id, ...booking };
  }

  const vendorId = localVendorId(companyOrId);
  const data = getData();
  const local = { id: nextId('booking'), vendorId, ...booking };
  data.bookings.push(local);
  save();
  return local;
}

async function listBookings(companyOrId) {
  const id = companyKey(companyOrId);

  if (isFirebaseConfigured()) {
    const snap = await getFirestore()
      .collection('bookings')
      .where('companyId', '==', id)
      .get();
    return snap.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .sort((a, b) =>
        (a.date + String(a.hour).padStart(2, '0')).localeCompare(
          b.date + String(b.hour).padStart(2, '0')
        )
      );
  }

  const vendorId = localVendorId(companyOrId);
  return getData()
    .bookings.filter((b) => b.vendorId === vendorId)
    .sort((a, b) =>
      (a.date + String(a.hour).padStart(2, '0')).localeCompare(
        b.date + String(b.hour).padStart(2, '0')
      )
    );
}

async function deleteBooking(companyOrId, bookingId) {
  if (isFirebaseConfigured()) {
    await getFirestore().collection('bookings').doc(String(bookingId)).delete();
    return;
  }

  const vendorId = localVendorId(companyOrId);
  const data = getData();
  data.bookings = data.bookings.filter(
    (b) => !(String(b.id) === String(bookingId) && b.vendorId === vendorId)
  );
  save();
}

async function cleanupExpiredBookings(retentionDays = Number(process.env.BOOKING_RETENTION_DAYS || DEFAULT_BOOKING_RETENTION_DAYS)) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);
  const cutoffIso = cutoff.toISOString();

  if (isFirebaseConfigured()) {
    const snap = await getFirestore()
      .collection('bookings')
      .where('createdAt', '<', cutoffIso)
      .get();

    if (snap.empty) return 0;

    let deleted = 0;
    for (let i = 0; i < snap.docs.length; i += 450) {
      const batch = getFirestore().batch();
      snap.docs.slice(i, i + 450).forEach((doc) => {
        batch.delete(doc.ref);
        deleted += 1;
      });
      await batch.commit();
    }
    console.log(`[Bookings] ${deleted} хуучин захиалга устгалаа (${retentionDays} өдөр+).`);
    return deleted;
  }

  const data = getData();
  const before = data.bookings.length;
  data.bookings = data.bookings.filter((booking) => {
    if (!booking.createdAt) return true;
    return new Date(booking.createdAt).toISOString() >= cutoffIso;
  });
  const deleted = before - data.bookings.length;
  if (deleted > 0) {
    save();
    console.log(`[Bookings] ${deleted} хуучин захиалга устгалаа (${retentionDays} өдөр+).`);
  }
  return deleted;
}

module.exports = {
  HOURS,
  todayStr,
  hourLabel,
  getDaySlots,
  getAvailableHourLabels,
  getAiScheduleContext,
  getScheduleChatGate,
  isAiChatPaused,
  setBlockedHours,
  listBlockedDays,
  setBlockedDay,
  createBooking,
  listBookings,
  deleteBooking,
  cleanupExpiredBookings,
};
