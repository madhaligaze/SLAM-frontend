"use strict";
// Адрес бэкенда задаётся в config.js (генерируется из переменной BACKEND_URL при деплое).
const API_BASE = (window.API_BASE || "").replace(/\/$/, "");
const formatApiDetail = detail => {
  if (!detail) return "";
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) return detail.map(x => x.msg || x.message || JSON.stringify(x)).join("; ");
  return detail.message || JSON.stringify(detail);
};
const api = async (p, opt) => {
  let r;
  try {
    r = await fetch(API_BASE + "/api" + p, opt);
  } catch (e) {
    throw new Error("Нет связи с сервером: " + e.message);
  }
  const text = await r.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch (e) {}
  }
  if (!r.ok) {
    throw new Error(formatApiDetail(data && data.detail) || formatApiDetail(data) || text || r.statusText || `HTTP ${r.status}`);
  }
  return data;
};
const jpost = (p, body) => api(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const jpatch = (p, body) => api(p, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
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

/* ---------- отложенное сохранение ----------
   Бэкенд берёт ФИО из БД, а не из тела запроса на отправку. Поэтому перед
   стартом задачи все отложенные сохранения обязаны долететь — иначе уйдёт
   предыдущее значение поля. */
const pendingSavers = new Set();
const pendingCreates = new Set();
function debouncedSave(fn, ms = 500) {
  let timer = null, inflight = null;
  const fire = () => {
    timer = null;
    pendingSavers.delete(saver);
    inflight = Promise.resolve().then(fn).catch(() => {});
    return inflight;
  };
  const saver = () => {
    if (timer) clearTimeout(timer);
    pendingSavers.add(saver);
    timer = setTimeout(fire, ms);
  };
  saver.flush = () => (timer ? (clearTimeout(timer), fire()) : (inflight || Promise.resolve()));
  // Нужна, когда объект удалили: иначе отложенный PATCH прилетит на уже
  // несуществующий id и вернёт 404.
  saver.cancel = () => { if (timer) clearTimeout(timer); timer = null; pendingSavers.delete(saver); };
  return saver;
}
async function flushSaves() {
  await Promise.all([...pendingCreates]);
  await Promise.all([...pendingSavers].map(s => s.flush()));
  await Promise.all([...pendingCreates]);
}

/* ---------- черновик рабочего места ----------
   Поле «наименование рабочего места» намеренно не хранится на сервере, но и
   пропадать при каждой перерисовке оно не должно: держим его на устройстве. */
const draft = {
  key: id => "slam.workplace." + id,
  get(id) { try { return localStorage.getItem(this.key(id)) || ""; } catch (e) { return ""; } },
  set(id, v) { try { v ? localStorage.setItem(this.key(id), v) : localStorage.removeItem(this.key(id)); } catch (e) {} },
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
function toast(message, type = "info", ms = 3200) {
  const box = document.getElementById("toasts");
  const t = document.createElement("div");
  t.className = "toast " + (type === "error" ? "err" : type === "ok" ? "ok" : "");
  t.textContent = message;
  box.appendChild(t);
  setTimeout(() => { t.style.opacity = "0"; t.style.transition = "opacity .25s"; setTimeout(() => t.remove(), 250); }, ms);
}

/* ---------- модалки ---------- */
function modal(buildBody) {
  return new Promise(resolve => {
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    const box = document.createElement("div");
    box.className = "modal";
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
      <input type="text" class="m-input" placeholder="${esc(placeholder)}">
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
function confirmModal({ title, message = "", summaryRows = null, okText = "OK", danger = false }) {
  return modal((box, close) => {
    let summary = "";
    if (summaryRows) summary = `<div class="summary">` + summaryRows.map(([k, v]) =>
      `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join("") + `</div>`;
    box.innerHTML = `<h3>${esc(title)}</h3>${message ? `<p>${esc(message)}</p>` : ""}${summary}
      <div class="actions"><button type="button" class="ghost m-cancel">Отмена</button>
      <button type="button" class="m-ok" style="background:${danger ? "var(--danger)" : "var(--accent)"}">${esc(okText)}</button></div>`;
    box.querySelector(".m-ok").onclick = () => close(true);
    box.querySelector(".m-cancel").onclick = () => close(false);
    setTimeout(() => box.querySelector(".m-ok").focus(), 60);
  });
}

/* ---------- состояние ---------- */
let blocksCache = [];
let currentBlockId = null;
let answersTpl = null;          // шаблон сценария с бэкенда (грузится один раз)
const selected = new Set();
let selectionMode = false;
let lastLongPress = 0;

/* ---------- режим выбора (долгое нажатие в списке) ---------- */
function setSelecting(on) {
  selectionMode = on;
  document.body.classList.toggle("selecting", on);
  if (!on) {
    selected.clear();
    document.querySelectorAll(".row.selected").forEach(c => c.classList.remove("selected"));
  }
  updateSelbar();
}
function updateSelbar() {
  document.getElementById("selCount").textContent = selected.size;
  document.getElementById("selDelete").disabled = selected.size === 0;
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
async function deleteSelected() {
  if (!selected.size) return;
  const ids = [...selected], n = ids.length;
  const ok = await confirmModal({
    title: `Удалить ${n} ${plural(n, "блок", "блока", "блоков")}?`,
    message: "Выбранные бригады и все их сохранённые ФИО будут удалены без возможности восстановления.",
    okText: `Удалить ${n}`, danger: true,
  });
  if (!ok) return;
  let fail = 0;
  for (const id of ids) {
    try { await api("/blocks/" + id, { method: "DELETE" }); draft.set(id, ""); } catch (e) { fail++; }
  }
  setSelecting(false);
  await load();
  if (fail) toast(`Удалено ${n - fail}, с ошибкой ${fail}`, "error", 5000);
  else toast(`Удалено: ${n}`, "ok");
}

/* ---------- список бригад (главный экран) ---------- */
async function load() {
  try {
    blocksCache = await api("/blocks");
    renderList();
  } catch (e) {
    toast("Не удалось загрузить данные: " + e.message, "error", 5000);
  }
}
function renderList() {
  const root = document.getElementById("listView");
  if (!blocksCache.length) {
    root.innerHTML = `<div class="empty">${ICONS.doc}<div>
      Пока нет ни одной бригады.<br>Нажмите <b>«+ Блок»</b>, чтобы создать первую.</div></div>`;
    return;
  }
  const frag = document.createDocumentFragment();
  blocksCache.forEach(b => frag.appendChild(renderRow(b)));
  root.replaceChildren(frag);
}
function renderRow(b) {
  const el = document.getElementById("rowTpl").content.cloneNode(true).querySelector(".row");
  el.querySelector(".row-name").textContent = b.name || "Без названия";
  const n = b.workers.length;
  el.querySelector(".row-sub").textContent =
    `${n} ${plural(n, "работник", "работника", "работников")} · ${objShort(b.object_key)} · ${taskShort(b.task)}`;
  if (selected.has(b.id)) el.classList.add("selected");
  attachLongPress(el, () => {
    if (!selectionMode) setSelecting(true);
    if (navigator.vibrate) navigator.vibrate(15);
    toggleBlockSelect(b.id, el);
  });
  el.addEventListener("click", () => {
    if (Date.now() - lastLongPress < 500) return;
    if (selectionMode) { toggleBlockSelect(b.id, el); return; }
    openDetail(b.id);
  });
  return el;
}

/* ---------- экран одной бригады (detail) ---------- */
function showList() {
  currentBlockId = null;
  document.body.classList.remove("detail");
  document.getElementById("detailView").replaceChildren();
  load();
  window.scrollTo(0, 0);
}
async function openDetail(id) {
  let b = blocksCache.find(x => x.id === id);
  if (!b) { try { blocksCache = await api("/blocks"); b = blocksCache.find(x => x.id === id); } catch (e) {} }
  if (!b) { toast("Бригада не найдена", "error"); return; }
  currentBlockId = id;
  document.body.classList.add("detail");
  if (!(history.state && history.state.detail)) history.pushState({ detail: id }, "");

  const dn = document.getElementById("detailName");
  dn.value = b.name;
  const saveName = debouncedSave(() => jpatch("/blocks/" + id, { name: dn.value }));
  dn.oninput = saveName;
  document.getElementById("detailDelete").onclick = async () => {
    const ok = await confirmModal({ title: "Удалить бригаду?", message: `«${b.name || "без названия"}» и все её сохранённые ФИО будут удалены.`, okText: "Удалить", danger: true });
    if (ok) {
      try {
        await api("/blocks/" + id, { method: "DELETE" });
        draft.set(id, "");
        toast("Бригада удалена", "ok"); showList();
      } catch (e) { toast(e.message, "error"); }
    }
  };

  document.getElementById("detailView").replaceChildren(buildDetail(b));
  window.scrollTo(0, 0);
}

function buildDetail(b) {
  const el = document.getElementById("detailTpl").content.cloneNode(true).querySelector(".block");

  const company = el.querySelector(".company");
  company.value = b.company || "";
  const saveCompany = debouncedSave(() => jpatch("/blocks/" + b.id, { company: company.value }));
  company.addEventListener("input", () => {
    company.classList.remove("invalid");
    b.company = company.value;
    saveCompany();
    schedulePlan(el, b);
  });

  // Рабочее место восстанавливаем из черновика устройства: на сервере оно не
  // хранится намеренно, но и теряться между перерисовками не должно.
  const workplace = el.querySelector(".workplace");
  workplace.value = draft.get(b.id);
  workplace.addEventListener("input", () => {
    workplace.classList.remove("invalid");
    draft.set(b.id, workplace.value);
    schedulePlan(el, b);
  });

  setupSeg(el.querySelector(".seg.task"), b.task, v => {
    b.task = v;
    jpatch("/blocks/" + b.id, { task: v }).catch(() => {});
    schedulePlan(el, b);
  });
  setupSeg(el.querySelector(".seg.object"), b.object_key, v => {
    b.object_key = v;
    jpatch("/blocks/" + b.id, { object_key: v }).catch(() => {});
    schedulePlan(el, b);
  });

  const wbox = el.querySelector(".workers");
  b.workers.forEach((w, i) => wbox.appendChild(renderWorker(el, b, w, i)));

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
    if (btn === active) btn.classList.add("active");
    btn.addEventListener("click", () => {
      if (btn.classList.contains("active")) return;
      buttons.forEach(x => x.classList.remove("active"));
      btn.classList.add("active");
      onPick(btn.dataset.v);
    });
  });
}

/* ---------- работники: правки без полной перерисовки ---------- */
function renumber(wbox) {
  [...wbox.children].forEach((row, i) => { row.querySelector(".num").textContent = (i + 1) + "."; });
}
function renderWorker(el, b, w, index) {
  const div = document.createElement("div");
  div.className = "worker";
  if (w.id != null) div.dataset.id = w.id;
  const num = document.createElement("div");
  num.className = "num"; num.textContent = (index + 1) + ".";
  const inp = document.createElement("input");
  inp.type = "text"; inp.value = w.full_name || ""; inp.placeholder = "Фамилия Имя Отчество";
  inp.autocomplete = "off";
  const save = debouncedSave(() => {
    const id = div.dataset.id;
    if (!id) return;                       // ещё создаётся — допишется по ответу POST
    return jpatch("/workers/" + id, { full_name: inp.value });
  });
  inp.addEventListener("input", () => { save(); schedulePlan(el, b); });
  const del = document.createElement("button");
  del.className = "icon"; del.type = "button"; del.innerHTML = ICONS.close; del.title = "Удалить";
  del.addEventListener("click", async () => {
    const id = div.dataset.id;
    const wbox = div.parentElement;
    save.cancel();                         // не сохранять ФИО удалённой строки
    div.remove(); renumber(wbox); schedulePlan(el, b);
    if (!id) return;
    try { await api("/workers/" + id, { method: "DELETE" }); }
    catch (e) { toast("Не удалось удалить: " + e.message, "error"); refreshDetail(); }
  });
  div.appendChild(num); div.appendChild(inp); div.appendChild(del);
  return div;
}
function addWorker(el, b) {
  const wbox = el.querySelector(".workers");
  const btn = el.querySelector(".addWorker");
  // Строку показываем сразу, не дожидаясь сервера: бригадир вводит ФИО
  // подряд, и ожидание ответа на каждом «плюсе» ощущается как тормоза.
  const row = renderWorker(el, b, { id: null, full_name: "" }, wbox.children.length);
  wbox.appendChild(row);
  row.querySelector("input").focus();
  btn.disabled = true;
  const create = jpost("/blocks/" + b.id + "/workers", { full_name: "" })
    .then(blk => {
      b.workers = blk.workers;
      const created = blk.workers[blk.workers.length - 1];
      if (!created) return;
      if (!row.isConnected) {   // строку удалили, пока шёл запрос — убираем и на сервере
        return api("/workers/" + created.id, { method: "DELETE" }).catch(() => {});
      }
      row.dataset.id = created.id;
      const typed = row.querySelector("input").value;
      if (typed) return jpatch("/workers/" + created.id, { full_name: typed });
    })
    .catch(e => { row.remove(); renumber(wbox); toast(e.message, "error"); })
    .finally(() => { btn.disabled = false; pendingCreates.delete(create); });
  pendingCreates.add(create);
}
async function refreshDetail() {
  try { blocksCache = await api("/blocks"); } catch (e) { return; }
  const b = blocksCache.find(x => x.id === currentBlockId);
  if (!b) return;
  document.getElementById("detailView").replaceChildren(buildDetail(b));
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
  parts.push(`<div class="plan-legend">Формы отправляются по одной на каждого работника — `
    + `меняется только ФИО, остальные ${answersTpl.pages.reduce((s, p) => s + p.items.length, 0) - 1} `
    + `${plural(answersTpl.pages.reduce((s, p) => s + p.items.length, 0) - 1, "поле", "поля", "полей")} одинаковы.</div>`);
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
async function doSubmit(el, b) {
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

  const ok = await confirmModal({
    title: "Отправить форму SLAM?",
    message: "Будет отправлена реальная форма на каждого работника бригады.",
    summaryRows: [
      ["Работников", String(names.length)],
      ["Тип работ", taskLabel(task)],
      ["Объект", objLabel(object_key)],
      ["Подрядчик", company],
      ["Рабочее место", workplace],
    ],
    okText: `Отправить (${names.length})`,
  });
  if (!ok) return;

  const btn = el.querySelector(".doSubmit");
  btn.disabled = true; btn.textContent = "Запуск…";
  const pw = el.querySelector(".progressWrap"); pw.style.display = "block";
  pw.scrollIntoView({ behavior: "smooth", block: "nearest" });

  try {
    // Критично: ФИО бэкенд читает из БД. Дожидаемся всех отложенных сохранений,
    // иначе только что набранное имя уйдёт в форму в старой редакции.
    await flushSaves();
    const job = await jpost("/blocks/" + b.id + "/submit", { workplace, submit: true, task, object_key, company });
    pollJob(job.id, el, btn);
  } catch (e) {
    toast("Ошибка запуска: " + e.message, "error", 5000);
    btn.disabled = false; btn.textContent = "Отправить за всю бригаду";
  }
}

const RES_LABEL = {
  ok: ["ok", ICONS.ok, "отправлено"],
  filled: ["ok", ICONS.done, "заполнено"],
  unconfirmed: ["unconfirmed", ICONS.warn, "не подтверждено"],
  failed: ["failed", ICONS.err, "ошибка"],
  running: ["running", ICONS.spin, "заполняется…"],
  pending: ["", ICONS.clock, "ожидает"],
};

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
    const sig = [r.status, r.submitted, r.elapsed, (r.errors || []).length, (r.warnings || []).length,
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

async function pollJob(jobId, el, btn) {
  const fill = el.querySelector(".fill");
  const ptext = el.querySelector(".progressText");
  const rbox = el.querySelector(".results");
  let timer = null, stopped = false;

  const stop = () => { stopped = true; clearTimeout(timer); document.removeEventListener("visibilitychange", onVis); };
  const onVis = () => { if (!document.hidden && !stopped) { clearTimeout(timer); tick(); } };
  document.addEventListener("visibilitychange", onVis);

  const tick = async () => {
    if (stopped || !document.body.contains(el)) { stop(); return; }
    // В фоне вкладка всё равно не отрисовывается — не жжём батарею и трафик.
    if (document.hidden) { timer = setTimeout(tick, 5000); return; }

    let j;
    try { j = await api("/jobs/" + jobId); }
    catch (e) {
      toast("Потеряна связь с задачей: " + e.message, "error");
      if (document.body.contains(btn)) { btn.disabled = false; btn.textContent = "Отправить за всю бригаду"; }
      stop(); return;
    }

    fill.style.width = (j.total ? Math.round(j.done / j.total * 100) : 0) + "%";
    const statusRu = { queued: "в очереди", running: "выполняется", done: "готово", error: "ошибка" }[j.status] || j.status;
    ptext.textContent = `Обработано ${j.done} из ${j.total} • ${statusRu}`;
    renderResults(rbox, j.results, jobId);

    if (j.status === "done" || j.status === "error") {
      btn.disabled = false; btn.textContent = "Отправить за всю бригаду";
      const okCount = j.results.filter(r => r.submitted).length;
      const failCount = j.results.filter(r => r.status === "failed").length;
      const unconf = j.results.filter(r => r.status === "unconfirmed").length;
      if (failCount || unconf) {
        const bits = [`отправлено ${okCount}`];
        if (failCount) bits.push(`с ошибкой ${failCount}`);
        if (unconf) bits.push(`без подтверждения ${unconf}`);
        toast("Готово: " + bits.join(", "), "error", 6000);
      } else {
        toast(`Готово: отправлено ${okCount} из ${j.total}`, "ok", 5000);
      }
      stop(); return;
    }
    timer = setTimeout(tick, 1500);
  };
  tick();
}

/* ---------- глобальные кнопки ---------- */
document.getElementById("addBlock").addEventListener("click", async () => {
  const name = await promptModal({ title: "Новая бригада", label: "Название блока (бригады)", value: "Бригада", placeholder: "Например: Бригада Иванова" });
  if (name === null) return;
  try {
    const nb = await jpost("/blocks", { name });
    blocksCache.push(nb);
    toast("Бригада создана", "ok");
    openDetail(nb.id);     // сразу открываем её форму, выйти можно кнопкой «Назад»
  } catch (e) { toast(e.message, "error"); }
});

document.getElementById("backBtn").addEventListener("click", () => {
  if (history.state && history.state.detail) history.back();   // вызовет popstate -> showList
  else showList();
});
document.getElementById("selCancel").addEventListener("click", () => setSelecting(false));
document.getElementById("selDelete").addEventListener("click", deleteSelected);

// аппаратная/браузерная «Назад» возвращает к списку, а не закрывает приложение
window.addEventListener("popstate", () => { if (document.body.classList.contains("detail")) showList(); });

load();
ensureAnswersTemplate();
