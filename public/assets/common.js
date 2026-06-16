// Хуваалцсан туслах функцууд
window.App = (function () {
  async function api(path, { method = 'GET', body, token } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await fetch(path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try {
      data = await res.json();
    } catch (_) {}
    if (!res.ok) {
      const err = new Error((data && data.error) || 'Алдаа гарлаа');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function showAlert(el, message, type = 'error') {
    if (!el) return;
    el.textContent = message;
    el.className = 'alert show ' + type;
  }
  function hideAlert(el) {
    if (el) el.className = 'alert';
  }

  const HOUR_LABELS = {}; // 1 -> "01:00"
  for (let h = 1; h <= 24; h++) {
    HOUR_LABELS[h] = String(h).padStart(2, '0') + ':00';
  }

  function todayStr() {
    const d = new Date();
    const tz = d.getTimezoneOffset() * 60000;
    return new Date(d - tz).toISOString().slice(0, 10);
  }

  function token(key) {
    return {
      get: () => localStorage.getItem(key),
      set: (v) => localStorage.setItem(key, v),
      clear: () => localStorage.removeItem(key),
    };
  }

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function')
        node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    });
    (Array.isArray(children) ? children : [children]).forEach((c) => {
      if (c == null) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  return { api, showAlert, hideAlert, HOUR_LABELS, todayStr, token, el };
})();
