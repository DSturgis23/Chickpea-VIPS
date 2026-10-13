(() => {
  const TAGS = window.VIP.tags;
  const $ = id => document.getElementById(id);
  const $q = $("q"), $clear = $("clear"), $res = $("results"), $home = $("home");
  const $toast = $("toast"), $toastMsg = $toast.querySelector(".msg"), $undo = $toast.querySelector("button");
  let timer, seq = 0, lastQuery = "";

  // ── Helpers ────────────────────────────────────────────────
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const initials = n => (n || "?").split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join("").toUpperCase() || "?";
  const fmtDate = d => d ? new Date(d + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";
  const money = n => "£" + Number(n).toLocaleString("en-GB", { maximumFractionDigits: 0 });
  const buzz = () => { try { navigator.vibrate && navigator.vibrate(12); } catch (_) {} };
  function ago(ts) {
    const m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} hr ago`;
    return new Date(ts).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  }

  function toast(msg, { err = false, undo = null } = {}) {
    $toastMsg.textContent = msg;
    $toast.className = "toast show" + (err ? " err" : "");
    $undo.hidden = !undo;
    $undo.onclick = undo ? () => { hideToast(); undo(); } : null;
    clearTimeout(toast.t);
    toast.t = setTimeout(hideToast, undo ? 5000 : 2800);
  }
  const hideToast = () => { $toast.className = "toast"; };

  async function api(url, opts) {
    const r = await fetch(url, opts);
    if (r.status === 401) { location.href = "/login"; throw new Error("auth"); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || "Something went wrong."); e.data = j; throw e; }
    return j;
  }

  // ── Recently tagged (this phone only) ──────────────────────
  const RKEY = "vips.recent";
  const loadRecent = () => { try { return JSON.parse(localStorage.getItem(RKEY)) || []; } catch (_) { return []; } };
  function pushRecent(entry) {
    try {
      const list = loadRecent().filter(r => !(r.id === entry.id && r.tag === entry.tag));
      list.unshift(entry);
      localStorage.setItem(RKEY, JSON.stringify(list.slice(0, 8)));
    } catch (_) {}
  }
  function renderRecent() {
    const list = loadRecent();
    $("recent-block").hidden = !list.length;
    $("recent").innerHTML = list.map(r => `
      <li class="${r.action === "add" ? "is-vip" : ""}"><button type="button" data-name="${esc(r.name)}">
        <span class="avatar" style="width:36px;height:36px;font-size:13px">${esc(initials(r.name))}</span>
        <span class="who"><b>${esc(r.name)}</b><span>${r.action === "add" ? "Marked" : "Removed"} ${esc(r.tag)} · ${ago(r.at)}</span></span>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" style="color:var(--muted)"><path d="M9 6l6 6-6 6"/></svg>
      </button></li>`).join("");
  }
  $("recent").addEventListener("click", e => {
    const b = e.target.closest("button[data-name]");
    if (b) { $q.value = b.dataset.name; runSearch(); }
  });

  // ── Cards ──────────────────────────────────────────────────
  function card(c, likely, animate = true) {
    const stats = [[c.visits, c.visits === 1 ? "visit" : "visits"], [c.covers, "covers"]];
    if (c.spend > 0) stats.push([money(c.spend), "spent"]);
    if (c.pubs > 1) stats.push([c.pubs, "pubs"]);
    const meta = [];
    if (c.last_visit) meta.push(`Last visit ${fmtDate(c.last_visit)}${c.last_venue ? " · " + esc(c.last_venue) : ""}`);
    if (c.fav_venue) meta.push(`Most often at ${esc(c.fav_venue)}`);
    const contact = [c.email, c.phone].filter(Boolean).map(esc).join(" · ");
    if (contact) meta.push(contact);
    const buttons = TAGS.map(t => {
      const on = c.tags.includes(t);
      return `<button class="tag${on ? " on" : ""}" data-id="${esc(c.id)}" data-tag="${esc(t)}" data-on="${on}" aria-pressed="${on}">${on ? esc(t) : "Mark " + esc(t)}</button>`;
    }).join("");
    return `<article class="card${c.tags.length ? " is-vip" : ""}${animate ? "" : " still"}" id="c-${esc(c.id)}" data-likely="${likely ? 1 : ""}">
      <div class="head">
        <div class="avatar">${esc(initials(c.name))}</div>
        <div class="who"><div class="name">${esc(c.name || "(no name)")}</div>
          ${likely ? `<span class="badge likely">Most likely</span>` : ""}</div>
      </div>
      <div class="stats">${stats.map(([v, l]) => `<div class="stat"><b>${esc(v)}</b><span>${l}</span></div>`).join("")}</div>
      ${meta.length ? `<div class="meta">${meta.map(m => `<div>${m}</div>`).join("")}</div>` : ""}
      <div class="actions">${buttons}</div>
    </article>`;
  }

  // The live profile is usually the one with real visits and contact details;
  // old imports tend to be single visits with no email or phone.
  function likelyId(results) {
    if (results.length < 2) return null;
    const score = c => c.visits * 10 + (c.email ? 5 : 0) + (c.phone ? 5 : 0) + (c.tags.length ? 3 : 0);
    const ranked = [...results].sort((a, b) => score(b) - score(a));
    return score(ranked[0]) > score(ranked[1]) ? ranked[0].id : null;
  }

  // ── Search ─────────────────────────────────────────────────
  function showHome() { $home.hidden = false; $res.innerHTML = ""; renderRecent(); }

  async function runSearch() {
    const q = $q.value.trim(), mine = ++seq;
    $clear.hidden = !q;
    if (q.length < 2) { lastQuery = ""; showHome(); return; }
    if (q === lastQuery && $res.innerHTML) return;
    lastQuery = q;
    $home.hidden = true;
    $res.innerHTML = `<div class="section-label">Searching SevenRooms…</div>` + `<div class="skeleton"></div>`.repeat(3);
    try {
      const { results } = await api("/api/search?q=" + encodeURIComponent(q));
      if (mine !== seq) return;
      if (!results.length) {
        $res.innerHTML = `<div class="empty"><b>No guests found</b>Nothing in SevenRooms matches “${esc(q)}”. Try just a surname, or their email.</div>`;
        return;
      }
      const likely = likelyId(results);
      const label = results.length === 1 ? "<b>1 profile</b>"
        : `<b>${results.length} profiles</b><span>${results.length >= 50 ? "Showing first 50, so add more of the name" : "Busiest first"}</span>`;
      $res.innerHTML = `<div class="section-label">${label}</div>` + results.map(c => card(c, c.id === likely)).join("");
    } catch (e) {
      if (mine !== seq || e.message === "auth") return;
      lastQuery = "";
      $res.innerHTML = `<div class="empty"><b>Couldn't search</b>${esc(e.message)}</div>`;
    }
  }
  $q.addEventListener("input", () => { clearTimeout(timer); $clear.hidden = !$q.value; timer = setTimeout(runSearch, 400); });
  $q.addEventListener("keydown", e => { if (e.key === "Enter") { clearTimeout(timer); runSearch(); $q.blur(); } });
  $clear.addEventListener("click", () => { $q.value = ""; runSearch(); $q.focus(); });

  // ── Tagging ────────────────────────────────────────────────
  async function setTag(id, tag, action, btn) {
    if (btn) { btn.disabled = true; btn.classList.remove("confirm"); btn.textContent = action === "add" ? "Saving…" : "Removing…"; }
    try {
      const { client } = await api("/api/tag", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: id, tag, action }),
      });
      const el = $("c-" + client.id);
      if (el) el.outerHTML = card(client, el.dataset.likely === "1", false);
      pushRecent({ id: client.id, name: client.name, tag, action, at: Date.now() });
      buzz();
      return client;
    } catch (err) {
      if (err.message === "auth") return null;
      const fresh = err.data && err.data.client;
      const el = $("c-" + id);
      if (fresh && el) el.outerHTML = card(fresh, el.dataset.likely === "1", false);
      else if (btn) { btn.disabled = false; btn.textContent = action === "add" ? "Mark " + tag : tag; }
      toast(err.message, { err: true });
      return null;
    }
  }

  $res.addEventListener("click", async e => {
    const b = e.target.closest("button.tag");
    if (!b || b.disabled) return;
    const on = b.dataset.on === "true", tag = b.dataset.tag, id = b.dataset.id;
    // Removing needs a second tap, so a stray thumb can't strip someone's VIP.
    if (on && !b.classList.contains("confirm")) {
      b.classList.add("confirm"); b.textContent = "Tap again to remove";
      setTimeout(() => { if (b.isConnected && !b.disabled) { b.classList.remove("confirm"); b.textContent = tag; } }, 3000);
      return;
    }
    const action = on ? "remove" : "add";
    const client = await setTag(id, tag, action, b);
    if (!client) return;
    toast(action === "add" ? `${client.name} is now ${tag} ★` : `${tag} removed from ${client.name}`, {
      undo: () => setTag(id, tag, action === "add" ? "remove" : "add").then(c => c && toast("Undone")),
    });
  });

  // ── Install ────────────────────────────────────────────────
  const $install = $("install"), $sheet = $("ios-sheet");
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  let deferred = null;

  if (!standalone) {
    window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); deferred = e; $install.hidden = false; });
    if (isIOS) $install.hidden = false;
  }
  window.addEventListener("appinstalled", () => { $install.hidden = true; deferred = null; toast("Installed. Open it from your home screen ★"); });
  $install.addEventListener("click", async () => {
    if (deferred) {
      deferred.prompt();
      const { outcome } = await deferred.userChoice;
      if (outcome === "accepted") $install.hidden = true;
      deferred = null;
    } else {
      $sheet.hidden = false;
    }
  });
  $("ios-done").addEventListener("click", () => { $sheet.hidden = true; });
  $sheet.addEventListener("click", e => { if (e.target === $sheet) $sheet.hidden = true; });

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

  showHome();
})();
