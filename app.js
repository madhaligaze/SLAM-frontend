"use strict";
// Адрес бэкенда задаётся в config.js (генерируется из переменной BACKEND_URL при деплое).
const API_BASE = (window.API_BASE || "").replace(/\/$/, "");
const formatApiDetail = detail => {
  if (!detail) return "";
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) return detail.map(x => x.msg || x.message || JSON.stringify(x)).join("; ");
  return detail.message || JSON.stringify(detail);
};
/* Ошибка несёт status (HTTP-код) или network=true — по ним решаем, повторять
   ли запрос: сеть на телефоне пропадает постоянно, а 4xx повтором не лечится. */
const api = async (p, opt) => {
  let r, text;
  try {
    r = await fetch(API_BASE + "/api" + p, opt);
    text = await r.text();
  } catch (e) {
    const err = new Error("Нет связи с сервером");
    err.network = true;
    throw err;
  }
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch (e) {}
  }
  if (!r.ok) {
    const err = new Error(formatApiDetail(data && data.detail) || formatApiDetail(data) || text || r.statusText || `HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return data;
};
const jsend = method => (p, body, extra) =>
  api(p, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), ...extra });
const jpost = jsend("POST"), jpatch = jsend("PATCH"), jput = jsend("PUT");
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
};
const objLabel = k => k === "sulphide_2" ? "Сульфидная фабрика 2" : "Сульфидная фабрика 1";
const objShort = k => k === "sulphide_2" ? "Сульфид 2" : "Сульфид 1";
const taskLabel = k => k === "demontazh" ? "Демонтаж лесов" : "Монтаж лесов";
const taskShort = k => k === "demontazh" ? "Демонтаж" : "Монтаж";
const normName = s => String(s || "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
const workerNames = b => (b.workers || []).map(w => (w.full_name || "").trim()).filter(Boolean);

// «сегодня 08:12» / «вчера 17:40» / «14.10 08:12»
function fmtWhen(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d)) return "";
  const hm = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  const day0 = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day0(new Date()) - day0(d)) / 864e5);
  if (days === 0) return "сегодня " + hm;
  if (days === 1) return "вчера " + hm;
  return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" }) + " " + hm;
}

/* ---------- сохранение правок ----------
   Раньше каждое поле уходило отложенным запросом, о котором больше никто не
   знал: выход из бригады перечитывал список с сервера раньше, чем правка туда
   долетала, — и при следующем открытии на экране стоял старый состав. Теперь:
   - кэш на устройстве меняется сразу при наборе, экран от сети не зависит;
   - запросы одного сохранителя идут строго по очереди и несут актуальное
     значение (медленный старый запрос не перетрёт новый);
   - при уходе с экрана, сворачивании и закрытии вкладки всё недосохранённое
     уходит немедленно, с keepalive — такой запрос переживает закрытие страницы;
   - сбой сети правку не теряет: повторяем, а в шапке видно «Не сохранено». */
const savers = new Set();
function makeSaver(blockId, send, ms = 400) {
  let timer = null, dirty = false, chain = null, retries = 0;
  const s = { blockId, failed: false };
  const settle = () => { if (!dirty && !chain) savers.delete(s); updateSaveState(); };
  const run = urgent => {
    dirty = false;
    const p = Promise.resolve()
      .then(() => send(urgent ? { keepalive: true } : {}))
      .then(() => { retries = 0; s.failed = false; }, e => {
        if (e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) {
          // Ошибка в самих данных (бригаду удалили, слишком длинное ФИО) — повтор не поможет.
          s.failed = false;
          if (blocksCache.some(b => b.id === blockId)) toast("Не сохранено: " + e.message, "error", 5000);
          return;
        }
        s.failed = true;
        if (!dirty) {
          dirty = true; retries++;
          clearTimeout(timer);
          timer = setTimeout(() => s.flush(), Math.min(15000, 1000 * 2 ** retries));
        }
      })
      .finally(() => { if (chain === p) chain = null; settle(); });
    chain = p;
    updateSaveState();
    return p;
  };
  s.schedule = () => {
    dirty = true; savers.add(s);
    clearTimeout(timer); timer = setTimeout(() => s.flush(), ms);
    updateSaveState();
  };
  // urgent: страница уходит — не ждём предыдущий запрос, шлём сразу.
  s.flush = (urgent = false) => {
    clearTimeout(timer); timer = null;
    if (!dirty) return chain || Promise.resolve();
    if (chain && !urgent) return chain.then(() => s.flush());
    return run(urgent);
  };
  s.cancel = () => { clearTimeout(timer); timer = null; dirty = false; s.failed = false; savers.delete(s); updateSaveState(); };
  Object.defineProperty(s, "busy", { get: () => dirty || !!chain });
  return s;
}
const flushAll = (urgent = false) => Promise.all([...savers].map(s => s.flush(urgent)));
const busyBlockIds = () => new Set([...savers].filter(s => s.busy || s.failed).map(s => s.blockId));

// Сохранители живут по одному на бригаду и читают значения из кэша, а не из
// полей ввода: поле названия общее для всех бригад, и отложенное сохранение
// бригады A не должно записать в неё название открытой следом бригады B.
const blockSavers = new Map();
function saversFor(id) {
  let s = blockSavers.get(id);
  if (s) return s;
  const cur = () => blocksCache.find(x => x.id === id);
  s = {
    block: makeSaver(id, opts => {
      const b = cur();
      if (!b) return;
      return jpatch("/blocks/" + id, { name: b.name, company: b.company, task: b.task, object_key: b.object_key }, opts);
    }),
    workers: makeSaver(id, opts => {
      const b = cur();
      if (!b) return;
      return jput("/blocks/" + id + "/workers", { names: workerNames(b) }, opts);
    }),
  };
  blockSavers.set(id, s);
  return s;
}

let saveStateTimer = null;
function updateSaveState() {
  const st = $("saveState");
  if (!st) return;
  const list = [...savers];
  clearTimeout(saveStateTimer);
  const show = (cls, html, title) => { st.className = cls; st.innerHTML = html; st.title = title; st.setAttribute("aria-label", title); };
  if (list.some(s => s.failed)) {
    show("err", ICONS.warn + "<span>Не сохранено</span>", "Нет связи с сервером. Повторю сам, или нажмите, чтобы повторить сейчас.");
  } else if (list.some(s => s.busy)) {
    show("busy", ICONS.spin, "Сохранение…");
  } else if (st.innerHTML) {
    show("ok", ICONS.done, "Сохранено");
    saveStateTimer = setTimeout(() => { st.className = "ok idle"; }, 1500);
  }
}

/* ---------- черновик рабочего места ----------
   Поле «наименование рабочего места» намеренно не хранится на сервере, но и
   пропадать при каждой перерисовке оно не должно: держим его на устройстве. */
const draft = {
  key: id => "slam.workplace." + id,
  get(id) { try { return localStorage.getItem(this.key(id)) || ""; } catch (e) { return ""; } },
  set(id, v) { try { v ? localStorage.setItem(this.key(id), v) : localStorage.removeItem(this.key(id)); } catch (e) {} },
};
// Последние отправленные рабочие места — подсказки в один тап.
const recentWp = {
  key: id => "slam.recentWorkplaces." + id,
  get(id) { try { return JSON.parse(localStorage.getItem(this.key(id)) || "[]"); } catch (e) { return []; } },
  add(id, v) {
    try { localStorage.setItem(this.key(id), JSON.stringify([v, ...this.get(id).filter(x => x !== v)].slice(0, 4))); } catch (e) {}
  },
  clear(id) { try { localStorage.removeItem(this.key(id)); } catch (e) {} },
};

/* ---------- SVG-иконки ---------- */
const svg = (paths, extra = "") =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"${extra}>${paths}</svg>`;
const ICONS = {
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  doc: svg('<path d="M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>'),
  ok: svg('<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9"/>'),
  done: svg('<path d="M5 12l5 5L20 7"/>'),
  err: svg('<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>'),
  warn: svg('<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.2v.1"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/>'),
  spin: svg('<path d="M12 3a9 9 0 1 0 9 9"/>', ' class="spin"'),
};

/* ---------- тосты ---------- */
function toast(message, type = "info", ms = 3200, action = null) {
  const box = $("toasts");
  const t = document.createElement("div");
  t.className = "toast " + (type === "error" ? "err" : type === "ok" ? "ok" : "");
  const msg = document.createElement("span");
  msg.className = "t-msg"; msg.textContent = message;
  t.appendChild(msg);
  const remove = () => { t.style.opacity = "0"; t.style.transition = "opacity .25s"; setTimeout(() => t.remove(), 250); };
  if (action) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "t-act"; b.textContent = action.label;
    b.onclick = () => { action.run(); remove(); };
    t.appendChild(b);
  }
  box.appendChild(t);
  setTimeout(remove, ms);
}

/* ---------- модалки ---------- */
function modal(buildBody) {
  return new Promise(resolve => {
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    const box = document.createElement("div");
    box.className = "modal";
    box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true");
    overlay.appendChild(box);
    const close = (val) => {
      document.removeEventListener("keydown", onKey);
      overlay.style.opacity = "0"; overlay.style.transition = "opacity .15s";
      setTimeout(() => overlay.remove(), 150);
      resolve(val);
    };
    const onKey = (e) => { if (e.key === "Escape") close(null); };
    document.addEventListener("keydown", onKey);
    overlay.addEventListener("mousedown", e => { if (e.target === overlay) close(null); });
    buildBody(box, close);
    document.body.appendChild(overlay);
  });
}
function promptModal({ title, label, value = "", placeholder = "", okText = "Создать" }) {
  return modal((box, close) => {
    box.innerHTML = `<h3>${esc(title)}</h3>
      <label style="margin-top:4px">${esc(label)}</label>
      <input type="text" class="m-input" placeholder="${esc(placeholder)}" maxlength="200">
      <div class="actions"><button type="button" class="ghost m-cancel">Отмена</button><button type="button" class="m-ok">${esc(okText)}</button></div>`;
    const input = box.querySelector(".m-input");
    input.value = value;
    const ok = () => { const v = input.value.trim(); if (!v) { input.classList.add("invalid"); input.focus(); return; } close(v); };
    box.querySelector(".m-ok").onclick = ok;
    box.querySelector(".m-cancel").onclick = () => close(null);
    input.addEventListener("keydown", e => { if (e.key === "Enter") ok(); });
    setTimeout(() => { input.focus(); input.select(); }, 60);
  });
}
function confirmModal({ title, message = "", list = null, warning = "", summaryRows = null, okText = "OK", danger = false }) {
  return modal((box, close) => {
    let summary = "";
    if (summaryRows) summary = `<div class="summary">` + summaryRows.map(([k, v]) =>
      `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join("") + `</div>`;
    const names = list ? `<ol class="names">${list.map(n => `<li>${esc(n)}</li>`).join("")}</ol>` : "";
    box.innerHTML = `<h3>${esc(title)}</h3>${message ? `<p>${esc(message)}</p>` : ""}${names}`
      + `${warning ? `<div class="m-warn">${esc(warning)}</div>` : ""}${summary}
      <div class="actions"><button type="button" class="ghost m-cancel">Отмена</button>
      <button type="button" class="m-ok" style="background:${danger ? "var(--danger)" : "var(--accent)"}">${esc(okText)}</button></div>`;
    box.querySelector(".m-ok").onclick = () => close(true);
    box.querySelector(".m-cancel").onclick = () => close(false);
    setTimeout(() => box.querySelector(".m-ok").focus(), 60);
  });
}

/* ---------- состояние ---------- */
let blocksCache = [];
let loadState = "loading";       // loading | ok | error — пока список ни разу не пришёл
let loadError = "";
let loadSeq = 0, appliedSeq = 0;
let currentBlockId = null;
let detailEl = null;             // карточка открытой бригады
let answersTpl = null;           // шаблон сценария с бэкенда (грузится один раз)
const selected = new Set();
let selectionMode = false;
let lastLongPress = 0;

/* ---------- навигация ----------
   Открытая бригада живёт в адресе (#/b/34): если телефон выгрузил вкладку,
   пока шла отправка, после перезагрузки бригадир вернётся туда же и увидит
   её ход, а не главный экран. */
let enteredFromList = false;
const routeId = () => { const m = location.hash.match(/^#\/b\/(\d+)$/); return m ? +m[1] : null; };
function route() {
  const id = routeId();
  if (id != null) openDetail(id); else showList();
}
function goDetail(id) {
  enteredFromList = true;
  if (routeId() === id) openDetail(id); else location.hash = "#/b/" + id;
}
function goList() {
  if (enteredFromList) { enteredFromList = false; history.back(); return; }   // hashchange -> showList
  history.replaceState(null, "", location.pathname + location.search);
  showList();
}

/* ---------- режим выбора (долгое нажатие в списке) ---------- */
function setSelecting(on) {
  if (on === selectionMode) return;
  selectionMode = on;
  document.body.classList.toggle("selecting", on);
  if (on) {
    // своя запись в истории: системная «Назад» выходит из выбора, а не из приложения
    history.pushState({ sel: 1 }, "");
  } else {
    selected.clear();
    document.querySelectorAll(".row.selected").forEach(c => c.classList.remove("selected"));
    if (history.state && history.state.sel) history.back();
  }
  updateSelbar();
}
function updateSelbar() {
  $("selCount").textContent = selected.size;
  $("selDelete").disabled = selected.size === 0;
}
function toggleBlockSelect(id, el) {
  if (selected.has(id)) { selected.delete(id); el.classList.remove("selected"); }
  else { selected.add(id); el.classList.add("selected"); }
  updateSelbar();
}
function attachLongPress(el, onLong, ms = 500) {
  let timer = null, sx = 0, sy = 0;
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } el.classList.remove("lp-armed"); };
  el.addEventListener("pointerdown", e => {
    if (selectionMode) return;
    if (e.target.closest("input,textarea,button,.seg,a,details,summary")) return;
    sx = e.clientX; sy = e.clientY; el.classList.add("lp-armed");
    timer = setTimeout(() => { timer = null; el.classList.remove("lp-armed"); lastLongPress = Date.now(); onLong(); }, ms);
  }, { passive: true });
  el.addEventListener("pointermove", e => { if (timer && (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10)) cancel(); }, { passive: true });
  ["pointerup", "pointercancel", "pointerleave"].forEach(ev => el.addEventListener(ev, cancel, { passive: true }));
}
function forgetBlock(id) {
  const s = blockSavers.get(id);
  if (s) { s.block.cancel(); s.workers.cancel(); blockSavers.delete(id); }
  blocksCache = blocksCache.filter(b => b.id !== id);
  draft.set(id, ""); recentWp.clear(id);
}
async function deleteSelected() {
  if (!selected.size) return;
  const ids = [...selected], n = ids.length;
  const ok = await confirmModal({
    title: `Удалить ${n} ${plural(n, "бригаду", "бригады", "бригад")}?`,
    message: "Выбранные бригады и все их сохранённые ФИО будут удалены без возможности восстановления.",
    okText: `Удалить ${n}`, danger: true,
  });
  if (!ok) return;
  let fail = 0;
  for (const id of ids) {
    try { await api("/blocks/" + id, { method: "DELETE" }); forgetBlock(id); } catch (e) { fail++; }
  }
  setSelecting(false);
  renderList();
  load();
  if (fail) toast(`Удалено ${n - fail}, с ошибкой ${fail}`, "error", 5000);
  else toast(`Удалено: ${n}`, "ok");
}

/* ---------- список бригад (главный экран) ---------- */
async function load() {
  const seq = ++loadSeq;
  let fresh;
  try {
    fresh = await api("/blocks");
  } catch (e) {
    if (seq < appliedSeq) return;
    if (loadState !== "ok") { loadState = "error"; loadError = e.message; renderList(); }
    else if (!document.hidden) toast("Не удалось обновить список: " + e.message, "error", 4000);
    return;
  }
  if (seq < appliedSeq) return;               // уже применён ответ на более новый запрос
  appliedSeq = seq;
  // Открытую бригаду и ту, чьи правки ещё не долетели, берём из кэша
  // устройства: ответ сервера мог быть собран раньше, чем правка дошла.
  const keep = busyBlockIds();
  if (currentBlockId != null) keep.add(currentBlockId);
  blocksCache = fresh.map(f => {
    const mine = keep.has(f.id) && blocksCache.find(x => x.id === f.id);
    const b = mine || f;
    const w = watchers.get(f.id);
    b.last_job = w && w.job ? summarize(w.job) : f.last_job;
    return b;
  });
  loadState = "ok";
  // Идущие отправки (начатые до перезагрузки или с другого телефона) — под наблюдение.
  for (const b of blocksCache) {
    if (isActive(b.last_job) && !watchers.has(b.id)) watchJob(b.id, { id: b.last_job.id });
  }
  renderList();
}
function renderList() {
  const root = $("listView");
  if (!blocksCache.length) {
    if (loadState === "loading") {
      root.innerHTML = `<div class="empty">${ICONS.spin}<div>Загрузка…</div></div>`;
    } else if (loadState === "error") {
      root.innerHTML = `<div class="empty">${ICONS.warn}<div>Не удалось загрузить бригады.<br>
        <span class="muted">${esc(loadError)}</span></div>
        <button type="button" class="ghost retry">Повторить</button></div>`;
      root.querySelector(".retry").onclick = () => { loadState = "loading"; renderList(); load(); };
    } else {
      root.innerHTML = `<div class="empty">${ICONS.doc}<div>
        Пока нет ни одной бригады.<br>Нажмите <b>«+ Бригада»</b>, чтобы создать первую.</div></div>`;
    }
    return;
  }
  const frag = document.createDocumentFragment();
  blocksCache.forEach(b => frag.appendChild(renderRow(b)));
  root.replaceChildren(frag);
}
function renderRow(b) {
  const el = $("rowTpl").content.cloneNode(true).querySelector(".row");
  el.dataset.id = b.id;
  el.querySelector(".row-name").textContent = b.name || "Без названия";
  const n = workerNames(b).length;
  el.querySelector(".row-sub").textContent =
    `${n} ${plural(n, "работник", "работника", "работников")} · ${objShort(b.object_key)} · ${taskShort(b.task)}`;
  paintRowJob(el, b.last_job);
  if (selected.has(b.id)) el.classList.add("selected");
  attachLongPress(el, () => {
    if (!selectionMode) setSelecting(true);
    if (navigator.vibrate) navigator.vibrate(15);
    toggleBlockSelect(b.id, el);
  });
  el.addEventListener("click", () => {
    if (Date.now() - lastLongPress < 500) return;
    if (selectionMode) { toggleBlockSelect(b.id, el); return; }
    goDetail(b.id);
  });
  el.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); el.click(); } });
  return el;
}
// Строка под названием бригады: идёт ли отправка и чем кончилась последняя.
function jobBadge(s) {
  if (!s) return null;
  const when = fmtWhen(s.finished_at || s.created_at);
  if (s.status === "queued") return ["run", ICONS.clock, "В очереди на отправку"];
  if (s.status === "running") return ["run", ICONS.spin, `Отправляется: ${s.done} из ${s.total}`];
  if (!s.submit) return ["", ICONS.done, `Проверка без отправки · ${when}`];
  if (s.status === "error") return ["bad", ICONS.err, `Прервано: отправлено ${s.sent} из ${s.total} · ${when}`];
  if (s.failed || s.unconfirmed) return ["warn", ICONS.warn, `Отправлено ${s.sent} из ${s.total} · ${when}`];
  return ["ok", ICONS.ok, `Отправлено ${s.sent} из ${s.total} · ${when}`];
}
function paintRowJob(row, s) {
  const box = row.querySelector(".row-job");
  const badge = jobBadge(s);
  box.hidden = !badge;
  if (!badge) return;
  box.className = "row-job " + badge[0];
  box.innerHTML = badge[1] + `<span>${esc(badge[2])}</span>`;
}

/* ---------- экран одной бригады (detail) ---------- */
function showList() {
  currentBlockId = null; detailEl = null;
  document.body.classList.remove("detail");
  $("detailView").replaceChildren();
  $("saveState").replaceChildren();
  renderList();                       // сразу из кэша — в нём уже все правки
  window.scrollTo(0, 0);
  flushAll().then(load);              // свежие данные — когда правки долетели
}
async function openDetail(id) {
  if (currentBlockId === id && detailEl) return;
  if (selectionMode) setSelecting(false);
  let b = blocksCache.find(x => x.id === id);
  if (!b) { await load(); b = blocksCache.find(x => x.id === id); }
  if (!b) {
    if (loadState === "ok") toast("Бригада не найдена — возможно, её удалили", "error");
    goList(); return;
  }
  currentBlockId = id;
  document.body.classList.add("detail");

  const dn = $("detailName");
  dn.value = b.name;
  dn.oninput = () => {
    const v = dn.value.trim();
    if (!v) return;                     // пустое название сервер не примет
    b.name = v;
    saversFor(id).block.schedule();
  };
  dn.onblur = () => { if (!dn.value.trim()) dn.value = b.name; };
  dn.onkeydown = e => { if (e.key === "Enter") dn.blur(); };
  $("detailDelete").onclick = async () => {
    const ok = await confirmModal({ title: "Удалить бригаду?", message: `«${b.name || "без названия"}» и все её сохранённые ФИО будут удалены.`, okText: "Удалить", danger: true });
    if (!ok) return;
    try {
      await api("/blocks/" + id, { method: "DELETE" });
      forgetBlock(id);
      toast("Бригада удалена", "ok"); goList();
    } catch (e) { toast(e.message, "error"); }
  };

  detailEl = buildDetail(b);
  $("detailView").replaceChildren(detailEl);
  window.scrollTo(0, 0);

  // Последняя отправка бригады: идущая — под наблюдение, завершённая — итогом.
  const w = watchers.get(id);
  if (w && w.job) renderJobPanel(detailEl, w.job);
  try {
    const job = await api(`/blocks/${id}/job`);
    if (currentBlockId !== id || !job) return;
    if (isActive(job)) watchJob(id, job);
    else if (!watchers.has(id)) renderJobPanel(detailEl, job);
  } catch (e) {}
}

function buildDetail(b) {
  const el = $("detailTpl").content.cloneNode(true).querySelector(".block");
  const save = saversFor(b.id);

  const company = el.querySelector(".company");
  company.value = b.company || "";
  company.addEventListener("input", () => {
    company.classList.remove("invalid");
    b.company = company.value;
    save.block.schedule();
    schedulePlan(el, b);
  });

  // Рабочее место восстанавливаем из черновика устройства: на сервере оно не
  // хранится намеренно, но и теряться между перерисовками не должно.
  const workplace = el.querySelector(".workplace");
  workplace.value = draft.get(b.id);
  workplace.addEventListener("input", () => {
    workplace.classList.remove("invalid");
    draft.set(b.id, workplace.value);
    renderChips(el, b);
    schedulePlan(el, b);
  });
  renderChips(el, b);

  setupSeg(el.querySelector(".seg.task"), b.task, v => {
    b.task = v;
    save.block.schedule();
    schedulePlan(el, b);
  });
  setupSeg(el.querySelector(".seg.object"), b.object_key, v => {
    b.object_key = v;
    save.block.schedule();
    schedulePlan(el, b);
  });

  const wbox = el.querySelector(".workers");
  (b.workers || []).forEach(w => wbox.appendChild(workerRow(el, b, w.full_name)));
  syncWorkers(el, b, false);

  el.querySelector(".addWorker").addEventListener("click", () => addWorker(el, b));
  el.querySelector(".doSubmit").addEventListener("click", () => doSubmit(el, b));

  const plan = el.querySelector(".planPreview");
  plan.addEventListener("toggle", () => { if (plan.open) renderPlan(el, b); });
  ensureAnswersTemplate().then(() => updatePlanCount(el));
  return el;
}

function setupSeg(seg, value, onPick) {
  const buttons = [...seg.querySelectorAll("button")];
  const active = buttons.find(btn => btn.dataset.v === value) || buttons[0];
  buttons.forEach(btn => {
    btn.type = "button";
    btn.setAttribute("aria-pressed", btn === active ? "true" : "false");
    if (btn === active) btn.classList.add("active");
    btn.addEventListener("click", () => {
      if (btn.classList.contains("active")) return;
      buttons.forEach(x => { x.classList.remove("active"); x.setAttribute("aria-pressed", "false"); });
      btn.classList.add("active"); btn.setAttribute("aria-pressed", "true");
      onPick(btn.dataset.v);
    });
  });
}

function renderChips(el, b) {
  const box = el.querySelector(".recentWp");
  const cur = el.querySelector(".workplace").value.trim();
  const items = recentWp.get(b.id).filter(x => x !== cur);
  box.replaceChildren(...items.map(v => {
    const c = document.createElement("button");
    c.type = "button"; c.className = "chip"; c.textContent = v; c.title = v;
    c.addEventListener("click", () => {
      const wp = el.querySelector(".workplace");
      wp.value = v; wp.classList.remove("invalid");
      draft.set(b.id, v);
      renderChips(el, b); schedulePlan(el, b);
    });
    return c;
  }));
}

/* ---------- работники ----------
   Состав — это просто строки ввода. Любая правка (набор, добавление,
   удаление) обновляет кэш и сохраняет весь список одним запросом. */
function workerRow(el, b, name) {
  const div = document.createElement("div");
  div.className = "worker";
  const num = document.createElement("div");
  num.className = "num";
  const inp = document.createElement("input");
  inp.type = "text"; inp.value = name || ""; inp.placeholder = "Фамилия Имя Отчество";
  inp.autocomplete = "off"; inp.spellcheck = false; inp.maxLength = 300;
  inp.setAttribute("autocapitalize", "words");
  inp.setAttribute("enterkeyhint", "next");
  inp.setAttribute("aria-label", "ФИО работника");
  inp.addEventListener("input", () => syncWorkers(el, b));
  // Enter — к следующей строке, а с последней заполненной — новая строка:
  // бригадир вводит ФИО подряд, не дотягиваясь до кнопки «Добавить».
  inp.addEventListener("keydown", e => {
    if (e.key !== "Enter" || e.isComposing) return;
    e.preventDefault();
    const next = div.nextElementSibling;
    if (next) next.querySelector("input").focus();
    else if (inp.value.trim()) addWorker(el, b);
  });
  const del = document.createElement("button");
  del.className = "icon"; del.type = "button"; del.innerHTML = ICONS.close;
  del.title = "Удалить"; del.setAttribute("aria-label", "Удалить работника");
  del.addEventListener("click", () => removeWorker(el, b, div));
  div.append(num, inp, del);
  return div;
}
function syncWorkers(el, b, save = true) {
  const rows = [...el.querySelectorAll(".worker")];
  const seen = new Set();
  b.workers = rows.map((row, i) => {
    row.querySelector(".num").textContent = (i + 1) + ".";
    const inp = row.querySelector("input");
    const key = normName(inp.value);
    const dup = !!key && seen.has(key);
    seen.add(key);
    inp.classList.toggle("dup", dup);
    inp.title = dup ? "Это ФИО уже есть выше — форма на него уйдёт дважды" : "";
    return { full_name: inp.value };
  });
  if (save) saversFor(b.id).workers.schedule();
  schedulePlan(el, b);
}
function addWorker(el, b, name = "", index = null) {
  const wbox = el.querySelector(".workers");
  const row = workerRow(el, b, name);
  wbox.insertBefore(row, index == null ? null : (wbox.children[index] || null));
  syncWorkers(el, b, !!name);
  if (!name) row.querySelector("input").focus();
}
function removeWorker(el, b, row) {
  const name = row.querySelector("input").value.trim();
  const index = [...row.parentElement.children].indexOf(row);
  row.remove();
  syncWorkers(el, b);
  if (!name) return;
  toast(`Удалён: ${name}`, "info", 5000, { label: "Вернуть", run: () => {
    if (el.isConnected) { addWorker(el, b, name, index); return; }
    const cur = blocksCache.find(x => x.id === b.id);
    if (!cur) return;
    cur.workers.splice(Math.min(index, cur.workers.length), 0, { full_name: name });
    saversFor(b.id).workers.schedule();
    renderList();
  } });
}

/* ---------- плашка «что программа впишет в форму» ---------- */
async function ensureAnswersTemplate() {
  if (answersTpl) return answersTpl;
  try { answersTpl = await api("/answers"); } catch (e) { answersTpl = null; }
  return answersTpl;
}
function planValues(el, b) {
  const names = [...el.querySelectorAll(".worker input")].map(i => i.value.trim()).filter(Boolean);
  return {
    names,
    workplace: el.querySelector(".workplace").value.trim(),
    company: el.querySelector(".company").value.trim(),
    task: el.querySelector(".seg.task .active")?.dataset.v || b.task,
    object_key: el.querySelector(".seg.object .active")?.dataset.v || b.object_key,
  };
}
/* Одна строка плашки. Длинные значения сворачиваются до трёх строк, а кнопка
   разворота лежит СНАРУЖИ обрезаемого блока — внутри её бы просто срезало. */
function planRow(question, tag, value, note, emptyText) {
  const empty = !value;
  const long = (value || "").length > 150;
  return `<div class="plan-row">` +
    `<div class="plan-q">${esc(question)}<span class="plan-tag ${tag[0]}">${esc(tag[1])}</span></div>` +
    `<div class="plan-val${long ? " clamp" : ""}${empty ? " empty-val" : ""}">` +
    `${esc(empty ? emptyText : value)}</div>` +
    (long ? `<button type="button" class="plan-more">показать полностью</button>` : "") +
    (note ? `<div class="plan-note">${esc(note)}</div>` : "") +
    `</div>`;
}
function updatePlanCount(el) {
  const cnt = el.querySelector(".planPreview .cnt");
  if (!cnt) return;
  if (!answersTpl) { cnt.textContent = "нет связи"; return; }
  const n = answersTpl.pages.reduce((s, p) => s + p.items.length, 0);
  cnt.textContent = `${n} ${plural(n, "поле", "поля", "полей")}`;
}
// Перерисовываем плашку не на каждый символ, а раз в кадр-другой.
function schedulePlan(el, b) {
  const plan = el.querySelector(".planPreview");
  if (!plan || !plan.open) return;
  clearTimeout(plan._t);
  plan._t = setTimeout(() => renderPlan(el, b), 120);
}
async function renderPlan(el, b) {
  const body = el.querySelector(".planPreview .plan-body");
  if (!body) return;
  await ensureAnswersTemplate();
  updatePlanCount(el);
  if (!answersTpl) {
    body.innerHTML = `<div class="plan-legend">Не удалось получить сценарий с сервера — проверьте связь.</div>`;
    return;
  }
  const v = planValues(el, b);
  const ph = answersTpl.placeholders;
  const subst = {
    [ph.full_name]: v.names.length
      ? (v.names.length === 1 ? v.names[0] : `ФИО каждого работника (${v.names.length}): ` + v.names.join(", "))
      : "",
    [ph.workplace]: v.workplace,
    [ph.company]: v.company,
    [ph.task]: answersTpl.task_options[v.task] || "",
    [ph.object]: answersTpl.object_options[v.object_key] || "",
  };
  const TAGS = {
    worker: ["tag-worker", "ФИО"],
    session: ["tag-session", "каждый раз"],
    block: ["tag-block", "из бригады"],
    constant: ["tag-constant", "постоянно"],
  };
  const parts = [];
  for (const page of answersTpl.pages) {
    parts.push(`<div class="plan-sec">${esc(page.section)}</div>`);
    for (const item of page.items) {
      const raw = Object.prototype.hasOwnProperty.call(subst, item.value) ? subst[item.value] : item.value;
      const tag = TAGS[item.source] || TAGS.constant;
      parts.push(planRow(item.q, tag, raw, item.note, "— не заполнено —"));
    }
  }
  const rest = answersTpl.pages.reduce((s, p) => s + p.items.length, 0) - 1;
  parts.push(`<div class="plan-legend">Формы отправляются по одной на каждого работника — `
    + `меняется только ФИО, остальные ${rest} ${plural(rest, "поле", "поля", "полей")} одинаковы.</div>`);
  body.innerHTML = parts.join("");
}
// Разворачивание длинных значений — одним слушателем на документ.
document.addEventListener("click", e => {
  const btn = e.target.closest(".plan-more");
  if (!btn) return;
  const val = btn.previousElementSibling;
  if (!val) return;
  btn.textContent = val.classList.toggle("clamp") ? "показать полностью" : "свернуть";
});

/* ---------- отправка ---------- */
const SUBMIT_TEXT = "Отправить за всю бригаду";
function setSubmitState(el, busyText) {
  const btn = el.querySelector(".doSubmit");
  btn.disabled = !!busyText;
  btn.textContent = busyText || SUBMIT_TEXT;
}
async function doSubmit(el, b) {
  const w = watchers.get(b.id);
  if (w && (!w.job || isActive(w.job))) { toast("По этой бригаде отправка уже идёт", "info"); return; }
  const wpEl = el.querySelector(".workplace");
  const companyEl = el.querySelector(".company");
  const workplace = wpEl.value.trim();
  const company = companyEl.value.trim();
  const task = el.querySelector(".seg.task .active")?.dataset.v;
  const object_key = el.querySelector(".seg.object .active")?.dataset.v;

  if (!company) { companyEl.classList.add("invalid"); companyEl.scrollIntoView({ behavior: "smooth", block: "center" }); toast("Укажите подрядную организацию", "error"); return; }
  if (!workplace) { wpEl.classList.add("invalid"); wpEl.focus(); toast("Укажите наименование рабочего места", "error"); return; }
  if (!task || !object_key) { toast("Выберите тип работ и объект", "error"); return; }
  const names = [...el.querySelectorAll(".worker input")].map(i => i.value.trim()).filter(Boolean);
  if (!names.length) { toast("В бригаде нет ни одного ФИО", "error"); return; }
  const seen = new Set(), dups = new Set();
  names.forEach(n => { const k = normName(n); if (seen.has(k)) dups.add(n); seen.add(k); });

  const n = names.length;
  const ok = await confirmModal({
    title: "Отправить форму SLAM?",
    message: `Уйдёт ${n} ${plural(n, "реальная форма", "реальные формы", "реальных форм")} — по одной на каждого. Проверьте состав:`,
    list: names,
    warning: dups.size ? `Повторяется: ${[...dups].join(", ")} — на ${dups.size > 1 ? "них" : "него"} форма уйдёт дважды.` : "",
    summaryRows: [
      ["Тип работ", taskLabel(task)],
      ["Объект", objLabel(object_key)],
      ["Подрядчик", company],
      ["Рабочее место", workplace],
    ],
    okText: `Отправить (${n})`,
  });
  if (!ok) return;

  setSubmitState(el, "Запуск…");
  try {
    // Состав уходит в самом запросе: сервер сохранит и отправит ровно его,
    // даже если отложенное сохранение ФИО ещё не долетело.
    const job = await jpost("/blocks/" + b.id + "/submit", { workplace, submit: true, task, object_key, company, names });
    recentWp.add(b.id, workplace);
    if (el.isConnected) renderChips(el, b);
    watchJob(b.id, job);
    el.querySelector(".progressWrap").scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (e) {
    // 409 — отправка уже идёт; сеть — запрос мог дойти, а ответ потеряться.
    // В обоих случаях сначала ищем задачу на сервере, а не шлём повторно.
    if (e.status === 409 || e.network) {
      const job = await api(`/blocks/${b.id}/job`).catch(() => null);
      if (job && isActive(job)) {
        watchJob(b.id, job);
        toast("Отправка по этой бригаде уже идёт — показываю её ход", "info", 5000);
        return;
      }
    }
    if (el.isConnected) setSubmitState(el, null);
    toast("Ошибка запуска: " + e.message, "error", 6000);
  }
}

/* ---------- отправки: наблюдение ----------
   Задача живёт на сервере и от вкладки не зависит: свернули приложение,
   закрыли вкладку — формы продолжают уходить. Клиент только наблюдает, и
   наблюдает упорно: сбой сети (типичный, когда телефон выходит из фона) —
   не повод бросать, а повод повторить позже. Наблюдение привязано к
   бригаде, а не к экрану: уход в список и обратно его не обрывает. */
const watchers = new Map();       // blockId -> { id, job, timer, fails, inflight }
const pendingNotices = [];        // итоги, пришедшие, пока вкладка была скрыта
const isActive = j => !!j && (j.status === "queued" || j.status === "running");
const summarize = j => ({
  id: j.id, status: j.status, submit: j.submit, total: j.total, done: j.done,
  sent: j.results.filter(r => r.submitted).length,
  failed: j.results.filter(r => r.status === "failed").length,
  unconfirmed: j.results.filter(r => r.status === "unconfirmed").length,
  created_at: j.created_at, finished_at: j.finished_at,
});

function watchJob(blockId, job) {
  let w = watchers.get(blockId);
  if (!w || w.id !== job.id) {
    if (w) clearTimeout(w.timer);
    w = { id: job.id, job: null, timer: null, fails: 0, inflight: false };
    watchers.set(blockId, w);
  }
  if (job.results) { w.job = job; applyJob(blockId, job); }
  if (!job.results || isActive(job)) schedulePoll(blockId, job.results ? 1500 : 0);
  else watchers.delete(blockId);
}
function schedulePoll(blockId, ms) {
  const w = watchers.get(blockId);
  if (!w) return;
  clearTimeout(w.timer);
  w.timer = setTimeout(() => pollJob(blockId), ms);
}
async function pollJob(blockId) {
  const w = watchers.get(blockId);
  if (!w || w.inflight) return;
  clearTimeout(w.timer);
  w.inflight = true;
  let j;
  try {
    j = await api("/jobs/" + w.id);
  } catch (e) {
    w.inflight = false;
    if (watchers.get(blockId) !== w) return;
    if (e.status === 404) { watchers.delete(blockId); jobLost(blockId); return; }
    w.fails++;
    if (w.job) applyJob(blockId, w.job, { offline: true });
    schedulePoll(blockId, Math.min(15000, 1500 * 2 ** Math.min(w.fails, 4)));
    return;
  }
  w.inflight = false;
  if (watchers.get(blockId) !== w) return;
  const was = w.job;
  w.fails = 0; w.job = j;
  applyJob(blockId, j);
  if (isActive(j)) { schedulePoll(blockId, document.hidden ? 10000 : 1500); return; }
  watchers.delete(blockId);
  updateTitle();
  if (!was || isActive(was)) announceDone(blockId, j);
}
const pokeWatchers = () => { for (const id of [...watchers.keys()]) pollJob(id); };

function applyJob(blockId, job, opts = {}) {
  const b = blocksCache.find(x => x.id === blockId);
  if (b) b.last_job = summarize(job);
  const row = document.querySelector(`#listView .row[data-id="${blockId}"]`);
  if (row) paintRowJob(row, b && b.last_job);
  if (currentBlockId === blockId && detailEl) renderJobPanel(detailEl, job, opts);
  updateTitle();
}
function jobLost(blockId) {
  updateTitle();
  if (currentBlockId === blockId && detailEl) {
    setSubmitState(detailEl, null);
    detailEl.querySelector(".progressText").textContent =
      "Сервер больше не знает об этой отправке (он перезапускался). Проверьте ответы в самой форме, прежде чем отправлять снова.";
  }
}
function announceDone(blockId, job) {
  const b = blocksCache.find(x => x.id === blockId);
  const name = b ? b.name : job.block_name;
  const s = summarize(job);
  let msg;
  if (!job.submit) msg = `«${name}»: проверка без отправки завершена`;
  else {
    msg = `${job.status === "error" ? "Прервано" : "Готово"} — «${name}»: отправлено ${s.sent} из ${s.total}`;
    if (s.failed) msg += `, с ошибкой ${s.failed}`;
    if (s.unconfirmed) msg += `, без подтверждения ${s.unconfirmed}`;
  }
  const bad = job.status === "error" || s.failed || s.unconfirmed;
  const show = () => {
    toast(msg, bad ? "error" : "ok", 7000);
    if (navigator.vibrate) navigator.vibrate(bad ? [80, 60, 80] : 60);
  };
  if (document.hidden) pendingNotices.push(show); else show();
}
const BASE_TITLE = document.title;
function updateTitle() {
  const act = [...watchers.values()].map(w => w.job).filter(isActive);
  if (!act.length) { document.title = BASE_TITLE; return; }
  const done = act.reduce((s, j) => s + j.done, 0), total = act.reduce((s, j) => s + j.total, 0);
  document.title = `(${done}/${total}) SLAM — отправка`;
}

const RES_LABEL = {
  ok: ["ok", ICONS.ok, "отправлено"],
  filled: ["ok", ICONS.done, "заполнено"],
  unconfirmed: ["unconfirmed", ICONS.warn, "не подтверждено"],
  failed: ["failed", ICONS.err, "ошибка"],
  running: ["running", ICONS.spin, "заполняется…"],
  pending: ["", ICONS.clock, "ожидает"],
};
function etaText(job) {
  const fin = job.results.filter(r => r.elapsed > 0);
  const avg = fin.length ? fin.reduce((s, r) => s + r.elapsed, 0) / fin.length : 10;
  const sec = Math.round(Math.max(0, job.total - job.done) * avg);
  return sec >= 90 ? `~${Math.round(sec / 60)} мин` : `~${Math.max(5, sec)} с`;
}
function renderJobPanel(el, job, opts = {}) {
  const pw = el.querySelector(".progressWrap");
  pw.hidden = false;
  const active = isActive(job);
  const s = summarize(job);
  el.querySelector(".job-title").textContent = active
    ? (job.status === "queued" ? "В очереди" : "Идёт отправка")
    : (job.submit ? "Последняя отправка" : "Последняя проверка (без отправки)");
  el.querySelector(".job-when").textContent = fmtWhen(job.finished_at || job.started_at || job.created_at);
  el.querySelector(".fill").style.width = (job.total ? Math.round(job.done / job.total * 100) : 0) + "%";
  let text;
  if (active && opts.offline) text = "Нет связи с сервером. Отправка идёт там и без телефона — обновлю, как только связь вернётся.";
  else if (job.status === "queued") text = "Ждёт, пока сервер закончит отправку другой бригады.";
  else if (active) text = `Обработано ${job.done} из ${job.total} • осталось ${etaText(job)}`;
  else if (!job.submit) text = `Проверено ${job.done} из ${job.total}, в форму ничего не отправлялось.`;
  else {
    const bits = [`отправлено ${s.sent} из ${s.total}`];
    if (s.failed) bits.push(`с ошибкой ${s.failed}`);
    if (s.unconfirmed) bits.push(`без подтверждения ${s.unconfirmed}`);
    text = (job.status === "error" ? "Прервано: " : "Готово: ") + bits.join(", ");
  }
  const pt = el.querySelector(".progressText");
  pt.textContent = text;
  pt.classList.toggle("offline", !!(active && opts.offline));
  el.querySelector(".job-note").hidden = !active;
  renderResults(el.querySelector(".results"), job.results, job.id);
  setSubmitState(el, active ? (job.status === "queued" ? "В очереди…" : `Идёт отправка… ${job.done}/${job.total}`) : null);
}

/* Обновление списка результатов на месте: полная перерисовка каждые полторы
   секунды схлопывала раскрытые плашки и заметно дёргала экран. */
function renderResults(rbox, results, jobId) {
  while (rbox.children.length > results.length) rbox.lastElementChild.remove();
  results.forEach((r, i) => {
    let node = rbox.children[i];
    if (!node) {
      node = document.createElement("div");
      node.innerHTML = `<div class="head"><b></b><span class="mk"></span><span class="took"></span></div>`;
      rbox.appendChild(node);
    }
    const key = r.status === "ok" && !r.submitted ? "filled" : (RES_LABEL[r.status] ? r.status : "pending");
    const [cls, icon, label] = RES_LABEL[key];
    // В подписи — задача и ФИО: иначе строка от прошлой отправки с тем же
    // статусом «ожидает» не перерисовалась бы под нового работника.
    const sig = [jobId, r.full_name, r.status, r.submitted, r.elapsed, (r.errors || []).length, (r.warnings || []).length,
                 r.fields_verified, r.fields_total, (r.steps || []).length].join("|");
    if (node._sig === sig) return;
    node._sig = sig;
    node.className = "res " + cls;

    node.querySelector("b").textContent = r.full_name || "—";
    const mk = node.querySelector(".mk");
    mk.className = "mk" + (key === "pending" ? " wait" : "");
    mk.innerHTML = icon + esc(label);
    node.querySelector(".took").textContent = r.elapsed ? r.elapsed + " с" : "";

    // блоки ниже шапки пересобираем только при смене подписи
    [...node.children].slice(1).forEach(n => n.remove());
    if (r.errors && r.errors.length) {
      const d = document.createElement("div");
      d.className = "errs"; d.textContent = r.errors.join("\n");
      node.appendChild(d);
    }
    if (r.warnings && r.warnings.length) {
      const d = document.createElement("div");
      d.className = "warns"; d.textContent = r.warnings.join("\n");
      node.appendChild(d);
    }
    if (r.fields_total) {
      node.appendChild(buildWrittenPanel(jobId, i, r));
    }
    if (r.steps && r.steps.length) {
      const det = document.createElement("details");
      det.className = "steps";
      det.innerHTML = `<summary>ход выполнения</summary><pre>${esc(r.steps.join("\n"))}</pre>`;
      node.appendChild(det);
    }
  });
}

/* Плашка «что реально записано» — фактический протокол с движка.
   Тянется лениво: 24 поля с текстами мер контроля весят десятки килобайт. */
function buildWrittenPanel(jobId, index, r) {
  const det = document.createElement("details");
  det.className = "plan";
  const bad = r.fields_total - r.fields_verified;
  det.innerHTML =
    `<summary>` +
    `<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>` +
    `<span>Что записано в форму</span>` +
    `<span class="cnt ${bad ? "plan-bad" : "plan-ok"}">${r.fields_verified}/${r.fields_total} проверено</span>` +
    `</summary><div class="plan-body"><div class="plan-legend">Загрузка…</div></div>`;
  det.addEventListener("toggle", async () => {
    if (!det.open || det._loaded) return;
    det._loaded = true;
    const body = det.querySelector(".plan-body");
    try {
      const data = await api(`/jobs/${jobId}/fields/${index}`);
      const parts = [];
      let section = null;
      for (const f of data.fields) {
        if (f.section !== section) { section = f.section; parts.push(`<div class="plan-sec">${esc(section)}</div>`); }
        const tag = f.verified ? ["tag-block", "сверено"] : ["tag-session", "не сверено"];
        parts.push(planRow(f.q, tag, f.value, f.note, "— пусто —"));
      }
      body.innerHTML = parts.join("") ||
        `<div class="plan-legend">Протокол пуст.</div>`;
    } catch (e) {
      det._loaded = false;
      body.innerHTML = `<div class="plan-legend">Не удалось загрузить протокол: ${esc(e.message)}</div>`;
    }
  });
  return det;
}

/* ---------- глобальные кнопки ---------- */
$("addBlock").addEventListener("click", async () => {
  const name = await promptModal({ title: "Новая бригада", label: "Название бригады", value: "Бригада", placeholder: "Например: Бригада Иванова" });
  if (name === null) return;
  try {
    const nb = await jpost("/blocks", { name });
    blocksCache.push(nb);
    renderList();
    toast("Бригада создана", "ok");
    goDetail(nb.id);     // сразу открываем её форму, выйти можно кнопкой «Назад»
  } catch (e) { toast(e.message, "error"); }
});
$("backBtn").addEventListener("click", goList);
$("saveState").addEventListener("click", () => flushAll());
$("selCancel").addEventListener("click", () => setSelecting(false));
$("selDelete").addEventListener("click", deleteSelected);

window.addEventListener("hashchange", route);
// системная «Назад» в режиме выбора выходит из выбора
window.addEventListener("popstate", () => {
  if (selectionMode && !(history.state && history.state.sel)) setSelecting(false);
});

/* ---------- жизненный цикл страницы ----------
   Свернули приложение или закрывают вкладку — дописываем правки сразу.
   Вернулись — сразу обновляем отправки, не дожидаясь таймера, и показываем
   итоги, пришедшие, пока нас не было. */
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { flushAll(true); return; }
  pendingNotices.splice(0).forEach(show => show());
  pokeWatchers();
  if (currentBlockId == null) load();
});
window.addEventListener("pagehide", () => flushAll(true));
window.addEventListener("online", () => { pokeWatchers(); flushAll(); });
window.addEventListener("pageshow", e => { if (e.persisted) { pokeWatchers(); load(); } });
window.addEventListener("beforeunload", e => {
  flushAll(true);
  if ([...savers].some(s => s.failed)) { e.preventDefault(); e.returnValue = ""; }
});

route();
ensureAnswersTemplate();
