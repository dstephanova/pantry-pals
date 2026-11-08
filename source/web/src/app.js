import { initializeApp } from "firebase/app";
import {
  initializeAuth, indexedDBLocalPersistence, browserLocalPersistence,
  signInAnonymously, onAuthStateChanged,
} from "firebase/auth";
import {
  initializeFirestore, doc, collection, setDoc, getDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, limit, writeBatch, serverTimestamp,
} from "firebase/firestore";

/* ---------- tiny helpers ---------- */
const $ = (s, el = document) => el.querySelector(s);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : String(k));
  return el;
};
const native = window.PantryNative || null;
const hasPrefs = !!(native && native.getPref);
const store = {
  get(k) {
    if (hasPrefs) { const v = native.getPref(k); if (v != null) return v; }
    try { return localStorage.getItem(k); } catch { return null; }
  },
  set(k, v) { if (hasPrefs) native.setPref(k, v); try { localStorage.setItem(k, v); } catch {} },
  del(k) { if (hasPrefs) native.setPref(k, null); try { localStorage.removeItem(k); } catch {} },
};
// move saved name/code into the phone's own storage so the app can update itself online
if (hasPrefs && native.markMigrated) {
  for (const k of ["pp_code", "pp_name"]) {
    let v = null; try { v = localStorage.getItem(k); } catch {}
    if (v && native.getPref(k) == null) native.setPref(k, v);
  }
  if (!native.remote()) native.markMigrated();
}
const canCart = !!(native && native.addToCart);
function openExternal(url) {
  if (native && native.openUrl) native.openUrl(url);
  else window.open(url, "_blank", "noopener");
}
function shareText(text) {
  if (native && native.shareText) return native.shareText(text);
  if (navigator.share) return navigator.share({ text }).catch(() => {});
  copyText(text);
}
function copyText(text) {
  if (native && native.copy) { native.copy(text); toast("Copied ✨"); return; }
  navigator.clipboard?.writeText(text).then(() => toast("Copied ✨"), () => toast(text));
}
let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}

/* ---------- eBag link helpers ---------- */
const EBAG_RE = /https?:\/\/(?:www\.)?ebag\.bg\/[^\s]*/i;
function nameFromEbagUrl(url) {
  try {
    const u = new URL(url);
    const segs = u.pathname.split("/").map(s => decodeURIComponent(s)).filter(s => s && !/^\d+$/.test(s) && s.length > 2);
    if (!segs.length) return "eBag item";
    const best = segs.sort((a, b) => b.length - a.length)[0];
    const words = best.replace(/[-_+]+/g, " ").replace(/\s+/g, " ").trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
  } catch { return "eBag item"; }
}
function parseInput(text) {
  const m = text.match(EBAG_RE);
  if (!m) return { name: text.trim(), url: null };
  const url = m[0].replace(/[).,]+$/, "");
  const rest = text.replace(m[0], "").replace(/\s+/g, " ").trim();
  return { name: rest || nameFromEbagUrl(url), url, auto: !rest };
}

/* ask the phone to look up the product photo + real name */
const metaWaiters = {};
window.__meta = (id, data) => { const f = metaWaiters[id]; delete metaWaiters[id]; if (f) f(data || {}); };
function getMeta(url) {
  if (!native || !native.fetchMeta) return Promise.resolve({});
  return new Promise((res) => {
    const id = "m" + Math.random().toString(36).slice(2);
    metaWaiters[id] = res; native.fetchMeta(url, id);
    setTimeout(() => window.__meta(id, {}), 20000);
  });
}
async function enrich(itemId, url, replaceName) {
  const m = await getMeta(url);
  const data = {};
  if (m.img) data.img = m.img;
  if (m.price && !isNaN(parseFloat(m.price))) { data.price = parseFloat(m.price); data.currency = m.currency || "EUR"; data.priceAt = Date.now(); }
  if (replaceName && m.title) data.name = m.title;
  if (Object.keys(data).length) await updateDoc(doc(itemsCol(), itemId), data).catch(() => {});
}

/* ---------- Firebase ---------- */
const cfg = window.FIREBASE_CONFIG;
const configured = cfg && cfg.apiKey && !String(cfg.apiKey).startsWith("PASTE");
let app, auth, db;
if (configured) {
  app = initializeApp(cfg);
  auth = initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });
  db = initializeFirestore(app, { experimentalAutoDetectLongPolling: true });
}

/* ---------- state ---------- */
const S = {
  uid: null,
  code: store.get("pp_code"),
  myName: store.get("pp_name") || "",
  tab: "list",
  items: [],
  history: [],
  members: {},
  loaded: false,
  draft: { qty: 1, kind: "once" },
};
let unsubs = [];

const listRef = () => doc(db, "lists", S.code);
const itemsCol = () => collection(db, "lists", S.code, "items");
const histCol = () => collection(db, "lists", S.code, "history");
const memberRef = (id) => doc(db, "lists", S.code, "members", id);
const who = (id) => id === S.uid ? "You" : (S.members[id]?.name || "Someone");
const whoColor = (id) => {
  let n = 0; for (const c of id || "") n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return ["#2F7D5B", "#7C5CE0", "#E0703C", "#2D7FB8", "#C2477A"][n % 5];
};

/* ---------- start ---------- */
function boot() {
  if (!configured) return renderNoConfig();
  renderLoading("Waking up the pantry…");
  onAuthStateChanged(auth, (user) => {
    if (!user) { signInAnonymously(auth).catch(err => renderError("Couldn't sign in. Check your internet and try again.", err)); return; }
    S.uid = user.uid;
    if (S.code && S.myName) joinList(S.code, false);
    else renderWelcome();
  });
}

function newCode() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const r = crypto.getRandomValues(new Uint32Array(10));
  const c = [...r].map(x => A[x % A.length]).join("");
  return c.slice(0, 5) + "-" + c.slice(5);
}

async function joinList(code, isNew) {
  code = code.trim().toUpperCase();
  renderLoading("Opening your list…");
  try {
    if (isNew) await setDoc(listRef_(code), { created: serverTimestamp() });
    else {
      const snap = await getDoc(listRef_(code));
      if (!snap.exists()) { store.del("pp_code"); S.code = null; renderWelcome("That code doesn't match any list. Double-check it?"); return; }
    }
    S.code = code; store.set("pp_code", code);
    await setDoc(memberRef(S.uid), { name: S.myName }, { merge: true });
    subscribe();
  } catch (err) { renderError("Couldn't open the list. Check your internet and try again.", err); }
}
const listRef_ = (code) => doc(db, "lists", code);

function subscribe() {
  unsubs.forEach(u => u()); unsubs = [];
  S.loaded = false;
  const slow = setTimeout(() => { if (!S.loaded) toast("Still loading… is the internet on?"); }, 10000);
  unsubs.push(onSnapshot(itemsCol(), (snap) => {
    S.items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const first = !S.loaded;
    S.loaded = true; clearTimeout(slow); render();
    if (first) refreshPrices();
  }, (err) => { clearTimeout(slow); renderError("Lost connection to the list.", err); }));
  unsubs.push(onSnapshot(query(histCol(), orderBy("boughtAt", "desc"), limit(200)), (snap) => {
    S.history = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (S.loaded) render();
  }));
  unsubs.push(onSnapshot(collection(db, "lists", S.code, "members"), (snap) => {
    S.members = Object.fromEntries(snap.docs.map(d => [d.id, d.data()]));
    if (S.loaded) render();
  }));
}

/* ---------- prices ---------- */
let refreshed = false;
function refreshPrices() {
  if (refreshed || !native || !native.fetchMeta) return; refreshed = true;
  const stale = S.items.filter(i => i.url && (!i.priceAt || Date.now() - i.priceAt > 6 * 3600e3));
  stale.forEach((it, n) => setTimeout(() => enrich(it.id, it.url, false), n * 700));
}
const SYM = { EUR: "€", BGN: "лв", USD: "$" };
const money = (v, cur) => `${v.toFixed(2)} ${SYM[cur || "EUR"] || cur}`;
function totalOf(items) {
  const priced = items.filter(i => typeof i.price === "number");
  if (!priced.length) return null;
  const sum = priced.reduce((t, i) => t + i.price * (i.qty || 1), 0);
  return { text: money(sum, priced[0].currency), partial: priced.length < items.length };
}

/* ---------- actions ---------- */
async function addItem(text, qty, kind) {
  const { name, url, auto } = parseInput(text);
  if (!name) return;
  const dupe = S.items.find(i => (url && i.url === url) || (!url && !i.url && i.name.toLowerCase() === name.toLowerCase()));
  if (dupe) {
    await updateDoc(doc(itemsCol(), dupe.id), { qty: (dupe.qty || 1) + qty, skip: false });
    toast(`Added ${qty} more ${dupe.name}`); return;
  }
  const ref = doc(itemsCol());
  await setDoc(ref, {
    name, url, img: null, qty, kind, skip: false, addedBy: S.uid, createdAt: Date.now(), lastBought: null,
  });
  if (url) enrich(ref.id, url, auto);
}
const patch = (id, data) => updateDoc(doc(itemsCol(), id), data).catch(() => toast("Couldn't save that, try again"));

async function markBought(items, { resetSkips = null } = {}) {
  const now = Date.now();
  const batch = writeBatch(db);
  for (const it of items) {
    batch.set(doc(histCol()), {
      name: it.name, url: it.url || null, img: it.img || null, price: it.price ?? null, currency: it.currency || null, qty: it.qty || 1, kind: it.kind,
      addedBy: it.addedBy || null, boughtBy: S.uid, boughtAt: now, itemId: it.id,
    });
    if (it.kind === "once") batch.delete(doc(itemsCol(), it.id));
    else batch.update(doc(itemsCol(), it.id), { lastBought: now, skip: false });
  }
  if (resetSkips) for (const it of S.items) if (it.skip && it.kind === "repeat" && resetSkips === "repeat") batch.update(doc(itemsCol(), it.id), { skip: false });
  await batch.commit();
}

async function restore(h_) {
  const existing = S.items.find(i => i.id === h_.itemId || (h_.url && i.url === h_.url) || (!h_.url && i.name === h_.name));
  if (existing) { toast(`${existing.name} is already on the list`); return; }
  await setDoc(doc(itemsCol()), {
    name: h_.name, url: h_.url || null, img: h_.img || null, price: h_.price ?? null, currency: h_.currency || null, qty: h_.qty || 1, kind: h_.kind || "once",
    skip: false, addedBy: S.uid, createdAt: Date.now(), lastBought: h_.kind === "repeat" ? h_.boughtAt : null,
  });
  toast(`${h_.name} is back on the list 💚`);
}

/* ---------- rendering ---------- */
const root = () => $("#app");
function mascot(size = 40) {
  const s = h("span", { class: "mascot", style: `width:${size}px;height:${size}px` });
  s.innerHTML = `<svg viewBox="7 7 50 53" width="${size}" height="${size}" aria-hidden="true">
    <path d="M20 22c0-7 5-12 12-12s12 5 12 12" fill="none" stroke="#1C3B2E" stroke-width="3.5" stroke-linecap="round"/>
    <path d="M10 22h44l-4 32a6 6 0 0 1-6 5H20a6 6 0 0 1-6-5z" fill="#3FA374"/>
    <path d="M10 22h44l-1 7H11z" fill="#2F7D5B"/>
    <circle cx="25" cy="38" r="3" fill="#10241B"/><circle cx="39" cy="38" r="3" fill="#10241B"/>
    <circle cx="26" cy="37" r="1" fill="#fff"/><circle cx="40" cy="37" r="1" fill="#fff"/>
    <path d="M27 45q5 4 10 0" fill="none" stroke="#10241B" stroke-width="2.5" stroke-linecap="round"/>
    <circle cx="20" cy="44" r="3" fill="#F6A6B2" opacity=".8"/><circle cx="44" cy="44" r="3" fill="#F6A6B2" opacity=".8"/>
  </svg>`;
  return s;
}

function renderNoConfig() {
  root().replaceChildren(h("div", { class: "center" }, mascot(84),
    h("h1", {}, "Almost ready!"),
    h("p", { class: "muted" }, "This build doesn't have its Firebase settings yet.")));
}
function renderLoading(msg) {
  root().replaceChildren(h("div", { class: "center" }, h("div", { class: "bob" }, mascot(84)), h("p", { class: "muted" }, msg)));
}
function renderError(msg, err) {
  console.error(err);
  root().replaceChildren(h("div", { class: "center" }, mascot(84), h("h2", {}, "Oops"), h("p", { class: "muted" }, msg),
    h("button", { class: "btn primary", onclick: () => location.reload() }, "Try again")));
}

function renderWelcome(note) {
  const name = h("input", { class: "field", placeholder: "Your name", value: S.myName, maxlength: "24", autocomplete: "off" });
  const code = h("input", { class: "field code", placeholder: "ABCDE-FGHJK", maxlength: "11", autocomplete: "off", autocapitalize: "characters" });
  const needName = () => {
    const n = name.value.trim();
    if (!n) { name.focus(); toast("Tell us your name first 💚"); return null; }
    S.myName = n; store.set("pp_name", n); return n;
  };
  root().replaceChildren(h("div", { class: "welcome" },
    h("div", { class: "bob" }, mascot(96)),
    h("h1", {}, "Pantry Pals"),
    h("p", { class: "muted" }, "One shared grocery list. Repeatable stuff stays, one-time stuff goes."),
    note ? h("p", { class: "note" }, note) : null,
    h("label", { class: "lbl" }, "What should we call you?"), name,
    h("button", { class: "btn primary wide", onclick: () => { if (needName()) joinList(newCode(), true); } }, "Start a new list"),
    h("div", { class: "or" }, h("span", {}, "or join one")),
    code,
    h("button", { class: "btn ghost wide", onclick: () => {
      if (!needName()) return;
      const c = code.value.trim().toUpperCase();
      if (!/^[A-Z0-9]{5}-?[A-Z0-9]{5}$/.test(c)) { toast("Codes look like ABCDE-FGHJK"); return; }
      joinList(c.includes("-") ? c : c.slice(0, 5) + "-" + c.slice(5), false);
    } }, "Join with a family code"),
  ));
}

function render() {
  const repeat = S.items.filter(i => i.kind === "repeat").sort((a, b) => a.name.localeCompare(b.name));
  const once = S.items.filter(i => i.kind !== "repeat").sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

  const header = h("header", { class: "top" },
    h("div", { class: "brand" }, mascot(46), h("span", {}, "Pantry Pals")),
    h("button", { class: "avatar", style: `background:${whoColor(S.uid)}`, onclick: openSettings, "aria-label": "Settings" }, (S.myName[0] || "?").toUpperCase()));

  const tabs = h("div", { class: "tabs" },
    h("button", { class: S.tab === "list" ? "on" : "", onclick: () => { S.tab = "list"; render(); } }, `List · ${S.items.length}`),
    h("button", { class: S.tab === "history" ? "on" : "", onclick: () => { S.tab = "history"; render(); } }, "History"));

  const main = h("main", {});
  if (S.tab === "list") {
    main.append(addCard());
    if (!S.items.length) main.append(h("div", { class: "empty" }, mascot(64), h("p", {}, "Nothing on the list yet."), h("p", { class: "muted small" }, "Type something above, or share a product from the eBag app straight into Pantry Pals.")));
    if (repeat.length) main.append(section("Repeatable", "🔁", "Stays on the list after you buy it", repeat, "repeat"));
    if (once.length) main.append(section("Just this once", "✨", "Goes to History after you buy it", once, "once"));
  } else main.append(historyView());

  const kids = [header, tabs, main];
  const keepFocus = document.activeElement?.id === "addInput";
  const val = $("#addInput")?.value;
  root().replaceChildren(...kids);
  if (val) $("#addInput").value = val;
  if (keepFocus) $("#addInput").focus();
}

function addCard() {
  const input = h("input", { id: "addInput", class: "field", placeholder: "Add an item or eBag link", autocomplete: "off", enterkeyhint: "done" });
  const qtyEl = h("span", { class: "qtyval" }, S.draft.qty);
  const setQty = (d) => { S.draft.qty = Math.max(1, Math.min(99, S.draft.qty + d)); qtyEl.textContent = S.draft.qty; };
  const kindBtn = (k, label) => h("button", { class: "pill" + (S.draft.kind === k ? " on " + k : ""), onclick: (e) => {
    S.draft.kind = k; e.currentTarget.parentNode.querySelectorAll(".pill").forEach(p => p.className = "pill");
    e.currentTarget.className = "pill on " + k;
  } }, label);
  const submit = async () => {
    const v = input.value.trim(); if (!v) { input.focus(); return; }
    input.value = "";
    try { await addItem(v, S.draft.qty, S.draft.kind); } catch (e) { toast("Couldn't add that, try again"); input.value = v; }
    S.draft.qty = 1; qtyEl.textContent = 1;
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  return h("div", { class: "card add" },
    h("div", { class: "row" }, input, (() => { const b = h("button", { class: "btn primary add-btn", onclick: submit, "aria-label": "Add" }); b.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M11 3v16M3 11h16" stroke="#fff" stroke-width="3" stroke-linecap="round"/></svg>'; return b; })()),
    h("div", { class: "row between" },
      h("div", { class: "pills" }, kindBtn("repeat", "🔁 Repeatable"), kindBtn("once", "✨ Once")),
      h("div", { class: "stepper" },
        h("button", { onclick: () => setQty(-1), "aria-label": "Less" }, "−"), qtyEl,
        h("button", { onclick: () => setQty(1), "aria-label": "More" }, "+"))));
}

function section(title, icon, sub, items, kind) {
  const toBuy = items.filter(i => !i.skip);
  const tot = totalOf(toBuy);
  const label = toBuy.length
    ? `Buy all ${kind === "repeat" ? "repeatable" : "once"} · ${toBuy.length}` + (tot ? ` · ${tot.partial ? "~" : ""}${tot.text}` : "")
    : "Everything here is skipped";
  return h("section", {},
    h("div", { class: "sec-head" }, h("h2", {}, `${icon} ${title}`), h("span", { class: "muted small" }, sub)),
    h("div", { class: "card list" }, items.map(itemRow),
      h("div", { class: "sec-buy" }, h("button", { class: "btn primary wide " + kind, disabled: !toBuy.length, onclick: () => openBuy(toBuy, kind) }, label))));
}

function thumb(x) {
  if (x.img) {
    const im = h("img", { class: "thumb", src: x.img, alt: "", loading: "lazy", referrerpolicy: "no-referrer" });
    im.addEventListener("error", () => im.replaceWith(h("div", { class: "thumb ph" }, x.kind === "repeat" ? "🔁" : "🛒")));
    return im;
  }
  return h("div", { class: "thumb ph" }, x.kind === "repeat" ? "🔁" : "🛒");
}

function itemRow(it) {
  return h("div", { class: "item" + (it.skip ? " skipped" : "") },
    thumb(it),
    h("button", { class: "item-main", onclick: () => openEdit(it) },
      h("div", { class: "name" }, it.name, it.url ? h("span", { class: "tag" }, "eBag") : null),
      typeof it.price === "number" ? h("div", { class: "price" }, money(it.price, it.currency), (it.qty || 1) > 1 ? h("span", { class: "muted" }, ` · ${money(it.price * it.qty, it.currency)} for ${it.qty}`) : null) : null,
      h("div", { class: "meta" },
        h("span", { class: "dot", style: `background:${whoColor(it.addedBy)}` }),
        `${who(it.addedBy)} added`,
        it.skip ? h("span", { class: "skiptxt" }, " · skipped this time") : null,
        it.kind === "repeat" && it.lastBought ? ` · bought ${ago(it.lastBought)}` : null)),
    h("div", { class: "item-side" },
      h("div", { class: "stepper sm" },
        h("button", { onclick: () => it.qty > 1 ? patch(it.id, { qty: it.qty - 1 }) : null, "aria-label": "Less" }, "−"),
        h("span", { class: "qtyval" }, `×${it.qty || 1}`),
        h("button", { onclick: () => patch(it.id, { qty: Math.min(99, (it.qty || 1) + 1) }), "aria-label": "More" }, "+")),
      h("div", { class: "acts" },
        h("button", { class: "mini" + (it.skip ? " on" : ""), onclick: () => patch(it.id, { skip: !it.skip }) }, it.skip ? "Unskip" : "Skip"),
        h("button", { class: "mini buy", disabled: it.skip, onclick: () => openBuy([it], false) }, "Buy"))));
}

function historyView() {
  if (!S.history.length) return h("div", { class: "empty" }, mascot(64), h("p", {}, "No history yet."), h("p", { class: "muted small" }, "Things you buy show up here, so you can bring them back with one tap."));
  const groups = new Map();
  for (const x of S.history) {
    const k = dayLabel(x.boughtAt);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(x);
  }
  return h("div", {}, [...groups].map(([day, xs]) => h("section", {},
    h("div", { class: "sec-head" }, h("h2", {}, day)),
    h("div", { class: "card list" }, xs.map(x => {
      const onList = S.items.some(i => i.id === x.itemId || (x.url && i.url === x.url) || (!x.url && i.name === x.name));
      return h("div", { class: "item" },
        thumb(x),
        h("div", { class: "item-main static" },
          h("div", { class: "name" }, `${x.kind === "repeat" ? "🔁" : "✨"} ${x.name}`, h("span", { class: "muted small" }, ` ×${x.qty || 1}`)),
          h("div", { class: "meta" }, h("span", { class: "dot", style: `background:${whoColor(x.boughtBy)}` }), `${who(x.boughtBy)} bought · ${timeLabel(x.boughtAt)}` + (typeof x.price === "number" ? ` · ${money(x.price * (x.qty || 1), x.currency)}` : ""))),
        h("div", { class: "item-side" },
          h("button", { class: "mini" + (onList ? "" : " buy"), disabled: onList, onclick: () => restore(x) }, onList ? "On list" : "Restore")));
    })))));
}

/* ---------- sheets ---------- */
function sheet(...content) {
  const wrap = h("div", { class: "sheet-wrap", onclick: (e) => { if (e.target === wrap) close(); } },
    h("div", { class: "sheet" }, h("div", { class: "grab" }), ...content));
  const close = () => { wrap.classList.remove("open"); setTimeout(() => wrap.remove(), 220); };
  document.body.append(wrap); requestAnimationFrame(() => wrap.classList.add("open"));
  return close;
}

function openBuy(items, allKind) {
  const isAll = !!allKind;
  const exact = items.filter(i => i.url);
  let close;
  const body = h("div", { class: "buybody" });
  const title = isAll ? (allKind === "repeat" ? "Buy all repeatable 🔁" : "Buy all once ✨") : `Buy ${items[0].name}`;
  const t = totalOf(items);
  const totalEl = t ? h("p", { class: "total" }, `${t.partial ? "About " : "Total "}${t.text}`, t.partial ? h("span", { class: "muted small" }, " (some items have no price)") : null) : null;
  const status = {}; // id -> status from eBag

  const STATUS = {
    ok: ["✓ Added", "ok"], login: ["Sign in needed", "bad"], soldout: ["Sold out", "bad"], missing: ["Not on eBag anymore", "bad"],
    nobutton: ["Couldn't find the button", "bad"], timeout: ["eBag was too slow", "bad"], stopped: ["Stopped", "bad"], error: ["Something went wrong", "bad"],
  };
  const row = (it) => {
    const st = status[it.id];
    let side;
    if (st) {
      const [txt, cls] = STATUS[st.status] || ["Didn't work", "bad"];
      side = h("div", { class: "item-side" }, h("span", { class: "st " + cls }, txt),
        cls === "bad" ? h("button", { class: "mini", onclick: () => openExternal(it.url) }, "Open ↗") : null);
    } else if (it.url) {
      side = h("div", { class: "item-side" }, h("button", { class: "mini" + (canCart ? "" : " buy"), onclick: (e) => { e.currentTarget.textContent = "Opened ✓"; openExternal(it.url); } }, "Open eBag ↗"));
    } else side = h("div", { class: "item-side" }, h("span", { class: "muted small" }, "add it yourself"));
    return h("div", { class: "item" }, thumb(it),
      h("div", { class: "item-main static" },
        h("div", { class: "name" }, it.name, h("span", { class: "muted small" }, ` ×${it.qty || 1}`)),
        h("div", { class: "meta" }, (typeof it.price === "number" ? money(it.price * (it.qty || 1), it.currency) + " · " : "") + (it.kind === "repeat" ? "🔁 stays on the list" : "✨ goes to History"))),
      side);
  };

  const doneBtn = () => h("button", { class: "btn primary wide big", onclick: async (e) => {
    e.currentTarget.disabled = true;
    try { await markBought(items, { resetSkips: isAll ? allKind : null }); close(); toast(isAll ? "Shopping done! 🎉" : "Bought ✓"); }
    catch { e.currentTarget.disabled = false; toast("Couldn't save that, try again"); }
  } }, "Done, mark as bought");

  function draw(phase) {
    const kids = [h("h2", {}, title), totalEl];
    if (phase === "adding") {
      kids.push(h("div", { class: "adding" }, h("div", { class: "bob" }, mascot(56)), h("p", {}, "Adding to your eBag cart…"), h("p", { class: "muted small" }, "You'll see eBag working. Tap Stop at the top to cancel.")));
    } else {
      if (phase === "start") kids.push(h("p", { class: "muted small" }, canCart && exact.length
        ? "Pantry Pals can put the eBag items in your cart for you."
        : exact.length ? "Tap each one to open it in eBag and add it to your cart." : "Add these to your eBag cart, then come back and tap Done."));
      if (phase === "result") {
        const ok = Object.values(status).filter(x => x.status === "ok").length;
        const needLogin = Object.values(status).some(x => x.status === "login");
        kids.push(h("p", { class: "result-line" }, `${ok} of ${exact.length} added to your eBag cart ${ok === exact.length ? "🎉" : ""}`));
        if (needLogin) kids.push(h("div", { class: "note" }, "eBag wants you to sign in first.", h("button", { class: "linkbtn", onclick: () => { close(); native.connectEbag(); } }, " Connect eBag →")));
      }
      kids.push(h("div", { class: "card list buylist" }, items.map(row)));
      if (isAll && S.items.some(i => i.skip && i.kind === allKind)) kids.push(h("p", { class: "muted small" }, "Skipped items stay on the list and come back next time."));
      if (phase === "start" && canCart && exact.length) {
        kids.push(h("button", { class: "btn primary wide big", onclick: () => {
          if (!native.ebagConnected()) { draw("connect"); return; }
          window.__cartDone = (res) => { for (const r of res || []) status[r.id] = r; draw("result"); };
          native.addToCart(JSON.stringify(exact.map(i => ({ id: i.id, url: i.url, qty: i.qty || 1, name: i.name }))));
          draw("adding");
        } }, `Add ${exact.length} to my eBag cart ✨`));
        kids.push(h("button", { class: "btn ghost wide", onclick: () => draw("manual") }, "I'll add them myself"));
      } else if (phase === "connect") {
        // replaced below
      } else {
        if (phase === "result") kids.push(h("button", { class: "btn ghost wide", onclick: () => native.openEbag() }, "Open my eBag to check out"));
        kids.push(doneBtn());
        kids.push(h("button", { class: "btn ghost wide", onclick: () => close() }, "Not yet"));
      }
    }
    if (phase === "connect") {
      kids.length = 0;
      kids.push(h("h2", {}, "Connect eBag first"),
        h("p", {}, "Sign in to eBag once inside Pantry Pals, and it'll stay signed in."),
        h("p", { class: "muted small" }, "Use your eBag email and password. If you normally use Google to sign in, set a password first: on eBag tap “Forgot password” and follow the email."),
        h("button", { class: "btn primary wide big", onclick: () => {
          window.__ebagConnected = () => { draw("start"); toast("eBag connected 💚"); };
          native.connectEbag();
        } }, "Connect eBag"),
        h("button", { class: "btn ghost wide", onclick: () => draw("start") }, "Back"));
    }
    body.replaceChildren(...kids.filter(Boolean));
  }
  close = sheet(body);
  draw("start");
}

function openEdit(it) {
  let kind = it.kind;
  const name = h("input", { class: "field", value: it.name, maxlength: "80" });
  const url = h("input", { class: "field", value: it.url || "", placeholder: "Paste an eBag product link (optional)" });
  const kindRow = h("div", { class: "pills" },
    ["repeat", "once"].map(k => h("button", { class: "pill" + (kind === k ? " on " + k : ""), onclick: (e) => {
      kind = k; kindRow.querySelectorAll(".pill").forEach(p => p.className = "pill"); e.currentTarget.className = "pill on " + k;
    } }, k === "repeat" ? "🔁 Repeatable" : "✨ Once")));
  let delArmed = false;
  const close = sheet(
    h("h2", {}, "Edit item"),
    h("label", { class: "lbl" }, "Name"), name,
    h("label", { class: "lbl" }, "eBag link"), url,
    it.url ? h("button", { class: "linkbtn", onclick: () => openExternal(it.url) }, "Open in eBag ↗") : null,
    h("label", { class: "lbl" }, "Kind"), kindRow,
    h("p", { class: "muted small" }, `Added by ${who(it.addedBy)} · ${dayLabel(it.createdAt)}`),
    h("button", { class: "btn primary wide", onclick: async () => {
      const u = url.value.trim();
      const m = u.match(EBAG_RE);
      if (u && !m) { toast("That doesn't look like an eBag link"); return; }
      const newUrl = m ? m[0] : null;
      await patch(it.id, { name: name.value.trim() || it.name, url: newUrl, kind, ...(newUrl !== it.url ? { img: null } : {}) });
      close();
      if (newUrl && newUrl !== it.url) enrich(it.id, newUrl, false);
    } }, "Save"),
    h("button", { class: "btn danger wide", onclick: async (e) => {
      if (!delArmed) { delArmed = true; e.currentTarget.textContent = "Tap again to remove"; return; }
      await deleteDoc(doc(itemsCol(), it.id)); close(); toast("Removed");
    } }, "Remove from list"));
}

function openSettings() {
  const name = h("input", { class: "field", value: S.myName, maxlength: "24" });
  let leaveArmed = false;
  const close = sheet(
    h("h2", {}, "Settings"),
    h("label", { class: "lbl" }, "Your name"), name,
    h("button", { class: "btn primary wide", onclick: async () => {
      const n = name.value.trim(); if (!n) return;
      S.myName = n; store.set("pp_name", n);
      await setDoc(memberRef(S.uid), { name: n }, { merge: true }); close(); render();
    } }, "Save name"),
    h("label", { class: "lbl" }, "Family code"),
    h("div", { class: "codebox" }, S.code),
    h("p", { class: "muted small" }, "Send this to your brother. He opens Pantry Pals, picks “Join with a family code” and types it in."),
    h("div", { class: "row" },
      h("button", { class: "btn ghost", onclick: () => copyText(S.code) }, "Copy"),
      h("button", { class: "btn ghost", onclick: () => shareText(`Join my Pantry Pals list 🛒 Code: ${S.code}`) }, "Share")),
    canCart ? h("label", { class: "lbl" }, "eBag account") : null,
    canCart ? h("div", { class: "ebag-row" },
      h("span", {}, native.ebagConnected() ? "✅ Connected" : "Not connected yet"),
      h("button", { class: "btn ghost", onclick: () => { close(); native.connectEbag(); } }, native.ebagConnected() ? "Sign in again" : "Connect eBag")) : null,
    canCart ? h("p", { class: "muted small" }, "Sign in with your eBag email and password. Google sign-in doesn't work inside apps, so set a password on eBag first with “Forgot password”.") : null,
    h("button", { class: "btn danger wide", onclick: (e) => {
      if (!leaveArmed) { leaveArmed = true; e.currentTarget.textContent = "Tap again to leave this list"; return; }
      unsubs.forEach(u => u()); unsubs = []; store.del("pp_code"); S.code = null; close(); renderWelcome();
    } }, "Leave this list"));
}

/* ---------- dates ---------- */
function dayLabel(ms) {
  if (!ms) return "";
  const d = new Date(ms), t = new Date();
  const days = Math.round((new Date(t.toDateString()) - new Date(d.toDateString())) / 864e5);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString("en-GB", { weekday: days < 7 ? "long" : undefined, day: "numeric", month: "short" });
}
const timeLabel = (ms) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
function ago(ms) {
  const days = Math.floor((Date.now() - ms) / 864e5);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}

/* ---------- shared from eBag app ---------- */
window.onSharedText = async (text) => {
  if (!S.code || !S.loaded) { store.set("pp_pending", text); return; }
  const { name } = parseInput(text);
  try { await addItem(text, 1, "once"); S.tab = "list"; render(); toast(`Added ${name} ✨`); } catch { toast("Couldn't add that"); }
};
// flush a share that arrived before the list was ready
setInterval(() => {
  const p = store.get("pp_pending");
  if (p && S.loaded) { store.del("pp_pending"); window.onSharedText(p); }
}, 1000);

boot();
