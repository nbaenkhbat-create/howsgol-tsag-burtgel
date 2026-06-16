const { getData, save, nextId } = require('../db');
const { getFirestore, isFirebaseConfigured } = require('./firebase');

const HOURS = Array.from({ length: 24 }, (_, i) => i + 1);

function todayStr(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d - tz).toISOString().slice(0, 10);
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

module.exports = {
  HOURS,
  todayStr,
  hourLabel,
  getDaySlots,
  getAvailableHourLabels,
  getAiScheduleContext,
  setBlockedHours,
  listBlockedDays,
  setBlockedDay,
  createBooking,
  listBookings,
  deleteBooking,
};
