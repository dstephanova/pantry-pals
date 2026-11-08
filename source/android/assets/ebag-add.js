(async function () {
  var QTY = __QTY__, TOKEN = __TOKEN__;
  var done = false;
  function report(st, d) { if (done) return; done = true; try { EbagNative.result(TOKEN, st, String(d || "").slice(0, 200)); } catch (e) {} }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function vis(e) { if (!e) return false; var r = e.getBoundingClientRect(); var cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; }
  function label(e) { return ((e.innerText || e.value || "") + " " + (e.getAttribute("aria-label") || "") + " " + (e.title || "")).replace(/\s+/g, " ").trim().toLowerCase(); }
  function clickables() { return Array.prototype.slice.call(document.querySelectorAll("button, a, [role=button], input[type=submit], input[type=button]")).filter(vis); }
  var ADD = /(добави|в кошницата|в количката|купи|add to (cart|basket)|add)/;
  var NOT = /(списък|любими|wishlist|favou?rite|сравн|отзив|review|адрес|address)/;
  function findAdd() {
    var c = clickables().filter(function (e) { var t = label(e); return ADD.test(t) && !NOT.test(t) && t.length < 60; });
    c.sort(function (a, b) { return b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height; });
    return c[0];
  }
  function findPlus() {
    return clickables().find(function (e) {
      var t = label(e), cls = String(e.className || "").toLowerCase();
      return t === "+" || /увелич|increase|increment|plus|добави още/.test(t + " " + cls);
    });
  }
  function needsLogin() {
    var pw = Array.prototype.slice.call(document.querySelectorAll("input[type=password]")).filter(vis);
    return pw.length > 0;
  }
  try {
    var btn = null;
    for (var i = 0; i < 24 && !btn; i++) { btn = findAdd(); if (!btn) await sleep(500); }
    if (!btn) { report(/404|не е намер|not found/i.test(document.body.innerText) ? "missing" : "nobutton", document.title); return; }
    if (/изчерпан|няма наличност|out of stock|unavailable/i.test(label(btn) + " " + (btn.disabled ? "disabled" : ""))) { report("soldout", label(btn)); return; }
    btn.click();
    await sleep(1800);
    if (needsLogin()) { report("login", "eBag asked to sign in"); return; }
    for (var k = 1; k < QTY; k++) {
      var p = findPlus();
      if (p) p.click(); else { var b2 = findAdd(); if (b2) b2.click(); else break; }
      await sleep(1100);
    }
    await sleep(600);
    if (needsLogin()) { report("login", "eBag asked to sign in"); return; }
    report("ok", label(btn));
  } catch (e) { report("error", e && e.message); }
})();
