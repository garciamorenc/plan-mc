import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithRedirect, signInWithPopup, getRedirectResult,
  onAuthStateChanged, signOut
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js';
import {
  getFirestore, doc, onSnapshot, runTransaction, updateDoc, setDoc,
  increment, serverTimestamp, enableIndexedDbPersistence, deleteField
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js';

import { firebaseConfig, ALLOWED_UIDS } from './firebase-config.js';
import { DATA, DAYS_ORDER, DAY_NAMES } from './data.js';
import { CATALOG, CATEGORIES, CATEGORY_ICON, RECIPE_IDS, slug, categoryFor } from './catalog.js';

// ---------- Firebase init ----------
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);
enableIndexedDbPersistence(db).catch(()=>{}); // ignora si ya activo o multi-tab
const STATE_DOC = doc(db, 'state', 'main');

// ---------- Local state ----------
const CHK = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
const LSTORE = 'plan_mc_v2';
const local = {
  day: 'L',
  view: 'conjunta',
  hideHave: false,
  mise: new Set(),  // mise-en-place ticks (locales)
  prep: new Set(),
  tab: 'comidas',
};
const cloud = { pantry: {}, cooked: {}, skipped: {}, dayMap: {}, cycleStartedAt: null, ready: false };
let currentUid = null;
let autoCookDone = false;

const SLOT_ABBREV = {
  'Desayuno': 'Des',
  'Media mañana': 'MM',
  'Comida': 'Com',
  'Pre-entreno': 'Pre',
  'Cena': 'Cen'
};
const WEEKDAY_MAP = ['D','L','M','X','J','V','S'];
const CODE_TO_JS = { D:0, L:1, M:2, X:3, J:4, V:5, S:6 };
const TODAY = WEEKDAY_MAP[new Date().getDay()] || 'L';
const TODAY_IDX = DAYS_ORDER.indexOf(TODAY);
const sourceDay = (viewDay) => cloud.dayMap[viewDay] || viewDay;

// Día "pasado" respetando cuándo empezó el ciclo.
// Si el ciclo empezó hoy, no hay días pasados (aunque por índice de semana parezcan anteriores).
function isPastDay(viewDay){
  const viewIdx = DAYS_ORDER.indexOf(viewDay);
  if(viewIdx < 0) return false;
  const startTs = cloud.cycleStartedAt;
  if(!startTs) return viewIdx < TODAY_IDX;
  const start = typeof startTs.toDate === 'function' ? startTs.toDate() : new Date(startTs);
  const startMid = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const todayMid = new Date(); todayMid.setHours(0,0,0,0);
  const daysSinceStart = Math.floor((todayMid - startMid) / 86400000);
  if(daysSinceStart >= 7) return viewIdx < TODAY_IDX;
  // Primera fecha de viewDay en este ciclo:
  const startWkd = start.getDay();
  const targetWkd = CODE_TO_JS[viewDay];
  const offset = (targetWkd - startWkd + 7) % 7;
  const viewDate = new Date(startMid); viewDate.setDate(viewDate.getDate() + offset);
  return viewDate < todayMid;
}

(function initLocal(){
  const map=['D','L','M','X','J','V','S'];
  local.day = map[new Date().getDay()] || 'L';
  try{
    const s = JSON.parse(localStorage.getItem(LSTORE) || '{}');
    if(Array.isArray(s.mise)) local.mise = new Set(s.mise);
    if(s.view) local.view = s.view;
    if(s.tab)  local.tab  = s.tab;
  }catch(e){}
})();
function saveLocal(){
  try{ localStorage.setItem(LSTORE, JSON.stringify({
    mise:[...local.mise], view:local.view, tab:local.tab
  })); }catch(e){}
}

// ---------- Auth ----------
const $loading = document.getElementById('auth-loading');
const $gate = document.getElementById('auth-gate');
const $gateMsg = document.getElementById('gate-msg');
const $signIn = document.getElementById('sign-in-btn');
const $signOut = document.getElementById('sign-out-btn');
const $appRoot = document.getElementById('app');

$signIn.onclick = async () => {
  const provider = new GoogleAuthProvider();
  const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
  try{
    if(isMobile){
      $gate.hidden = true;
      $loading.hidden = false;
      await signInWithRedirect(auth, provider);
    } else {
      await signInWithPopup(auth, provider);
    }
  }catch(e){
    $loading.hidden = true;
    $gate.hidden = false;
    $gateMsg.textContent = 'Error iniciando sesión: ' + (e.code || e.message);
  }
};
$signOut.onclick = () => signOut(auth);

getRedirectResult(auth).catch(()=>{});

onAuthStateChanged(auth, (user) => {
  $loading.hidden = true;
  if(!user){
    showGate('Inicia sesión para acceder al plan.');
    return;
  }
  console.log('Tu UID (cópialo a firebase-config.js y firestore.rules):', user.uid);
  if(!ALLOWED_UIDS.includes(user.uid)){
    showGate('Esta cuenta no está autorizada.');
    signOut(auth);
    return;
  }
  currentUid = user.uid;
  $gate.hidden = true;
  $appRoot.hidden = false;
  subscribeState();
});

function showGate(msg){
  $loading.hidden = true;
  $gate.hidden = false;
  $appRoot.hidden = true;
  $gateMsg.textContent = msg;
}

// ---------- Firestore listener ----------
function subscribeState(){
  // Crear el documento si no existe (primer arranque).
  onSnapshot(STATE_DOC, async (snap) => {
    if(!snap.exists()){
      try{
        await setDoc(STATE_DOC, {
          pantry: {}, cooked: {}, skipped: {}, dayMap: {},
          cycleStartedAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          updatedBy: currentUid,
        });
      }catch(e){ console.error('No se pudo crear state/main', e); }
      return;
    }
    const d = snap.data() || {};
    cloud.pantry = d.pantry || {};
    cloud.cooked = d.cooked || {};
    cloud.skipped = d.skipped || {};
    cloud.dayMap = d.dayMap || {};
    cloud.cycleStartedAt = d.cycleStartedAt || null;
    cloud.ready = true;
    render();
    if(!autoCookDone){
      autoCookDone = true;
      (async () => {
        const wasReset = await maybeAutoReset();
        if(wasReset){
          autoCookDone = false; // dejar que el snapshot con el nuevo cycleStartedAt re-dispare flujo
        } else {
          autoCookPastDays().catch(e => console.error('autoCook', e));
        }
      })();
    }
  }, (err) => console.error('snapshot', err));
}

// ---------- Cálculos ----------
const mealKey = (day, slot) => `${day}:${slot}`;

// Helpers de granularidad por persona. cooked[k] y skipped[k] son objetos {m,c}.
// Se admite el formato legacy boolean (true = ambos).
function isOn(map, k, who){
  const v = map?.[k];
  if(v === true) return true;
  if(v && typeof v === 'object'){
    const pv = v[who];
    return pv === true || (pv && typeof pv === 'object');
  }
  return false;
}
function setPersons(map, k, persons, value){
  const cur = map[k];
  let obj;
  if(cur === true) obj = { m: true, c: true };
  else if(cur && typeof cur === 'object') obj = { ...cur };
  else obj = {};
  for(const p of persons){
    if(value) obj[p] = true;
    else delete obj[p];
  }
  const out = { ...map };
  if(!obj.m && !obj.c) delete out[k];
  else out[k] = obj;
  return out;
}
// Cantidades realmente descontadas al cocinar (para deshacer con precisión).
// Si la entrada es legacy boolean, devuelve null → caller cae a mealConsumption.
function getDeducted(map, k, who){
  const v = map?.[k];
  if(!v || typeof v !== 'object') return null;
  const pv = v[who];
  if(pv && typeof pv === 'object' && pv.d) return pv.d;
  return null;
}
function setCookedPersons(map, k, deductedByPerson){
  const cur = map[k];
  let obj;
  if(cur === true) obj = { m: true, c: true };
  else if(cur && typeof cur === 'object') obj = { ...cur };
  else obj = {};
  for(const p of Object.keys(deductedByPerson)){
    obj[p] = { d: deductedByPerson[p] || {} };
  }
  const out = { ...map };
  out[k] = obj;
  return out;
}
function unsetCookedPersons(map, k, persons){
  const cur = map[k];
  let obj;
  if(cur === true) obj = { m: true, c: true };
  else if(cur && typeof cur === 'object') obj = { ...cur };
  else obj = {};
  for(const p of persons) delete obj[p];
  const out = { ...map };
  if(!obj.m && !obj.c) delete out[k];
  else out[k] = obj;
  return out;
}
// Aplica al pantry la deducción real (cap a 0) y devuelve el mapa real descontado por id.
function deductFromPantry(pantry, cons){
  const actual = {};
  for(const id of Object.keys(cons)){
    const have = pantry[id] || 0;
    const take = Math.min(have, cons[id]);
    actual[id] = take;
    pantry[id] = have - take;
  }
  return actual;
}
function personsForView(){
  if(local.view === 'maria') return ['m'];
  if(local.view === 'carlos') return ['c'];
  return ['m','c'];
}
function viewPersonsCookedAll(k){
  // ¿Están las personas del view actual todas cocinadas?
  return personsForView().every(p => isOn(cloud.cooked, k, p));
}

// Suma de demanda pendiente por id, sobre toda la semana.
// Por persona: cada porción (m, c) se incluye solo si esa persona no está cocinada NI saltada.
function computeDemand(){
  const demand = {};
  for(const viewDay of DAYS_ORDER){
    const src = sourceDay(viewDay);
    const meals = DATA[src]?.meals || [];
    for(const meal of meals){
      if(meal.free || !meal.items) continue;
      const k = mealKey(src, meal.slot);
      const incM = !isOn(cloud.cooked, k, 'm') && !isOn(cloud.skipped, k, 'm');
      const incC = !isOn(cloud.cooked, k, 'c') && !isOn(cloud.skipped, k, 'c');
      if(!incM && !incC) continue;
      for(const it of meal.items){
        let q = 0;
        if(incM) q += it.m||0;
        if(incC) q += it.c||0;
        if(q<=0) continue;
        demand[it.id] = (demand[it.id]||0) + q;
      }
    }
  }
  return demand;
}

// Lista de la compra: max(0, demanda - despensa), solo > 0.
function computeShoppingList(){
  const demand = computeDemand();
  const list = [];
  for(const id of Object.keys(demand)){
    const need = Math.max(0, demand[id] - (cloud.pantry[id]||0));
    if(need > 0) list.push({ id, qty: need });
  }
  return list;
}

// Devuelve los ingredientes consumidos para una comida según las personas indicadas.
function mealConsumption(day, slot, persons){
  const meal = (DATA[day]?.meals||[]).find(m => m.slot === slot);
  const out = {};
  if(!meal || !meal.items) return out;
  const wantM = persons.includes('m');
  const wantC = persons.includes('c');
  for(const it of meal.items){
    let q = 0;
    if(wantM) q += it.m||0;
    if(wantC) q += it.c||0;
    if(q>0) out[it.id] = (out[it.id]||0) + q;
  }
  return out;
}

// ---------- Acciones (Firestore) ----------
// day aquí es el SOURCE day (la receta real, no la vista).
async function markCooked(day, slot, persons){
  const k = mealKey(day, slot);
  try{
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(STATE_DOC);
      const d = snap.data() || {};
      let pantry = { ...(d.pantry||{}) };
      let cooked = d.cooked || {};
      let skipped = d.skipped || {};
      const toMark = persons.filter(p => !isOn(cooked, k, p));
      if(toMark.length === 0) return;
      const deductedByPerson = {};
      for(const p of toMark){
        const cons = mealConsumption(day, slot, [p]);
        deductedByPerson[p] = deductFromPantry(pantry, cons);
      }
      cooked = setCookedPersons(cooked, k, deductedByPerson);
      skipped = setPersons(skipped, k, toMark, false);
      tx.update(STATE_DOC, {
        pantry, cooked, skipped,
        updatedAt: serverTimestamp(), updatedBy: currentUid
      });
    });
  }catch(e){ console.error('markCooked', e); }
}

// viewDay sirve para saber si el día visible es pasado → marcamos skipped.
async function undoCooked(day, slot, viewDay, persons){
  const k = mealKey(day, slot);
  const past = viewDay ? isPastDay(viewDay) : false;
  try{
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(STATE_DOC);
      const d = snap.data() || {};
      let pantry = { ...(d.pantry||{}) };
      let cooked = d.cooked || {};
      let skipped = d.skipped || {};
      const toUndo = persons.filter(p => isOn(cooked, k, p));
      if(toUndo.length > 0){
        for(const p of toUndo){
          const recorded = getDeducted(cooked, k, p);
          const restore = recorded || mealConsumption(day, slot, [p]); // legacy fallback
          for(const id of Object.keys(restore)){
            pantry[id] = (pantry[id]||0) + restore[id];
          }
        }
        cooked = unsetCookedPersons(cooked, k, toUndo);
      }
      if(past) skipped = setPersons(skipped, k, persons, true);
      tx.update(STATE_DOC, {
        pantry, cooked, skipped,
        updatedAt: serverTimestamp(), updatedBy: currentUid
      });
    });
  }catch(e){ console.error('undoCooked', e); }
}

// Toggle proactivo desde planificación.
// Si alguna persona del scope NO está skipped → marcamos a todas skipped (y si estaban cocinadas, devolvemos despensa).
// Si todas están skipped → desactivamos skip para todas.
async function toggleSkipped(srcDay, slot, persons){
  const k = mealKey(srcDay, slot);
  try{
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(STATE_DOC);
      const d = snap.data() || {};
      let pantry = { ...(d.pantry||{}) };
      let cooked = d.cooked || {};
      let skipped = d.skipped || {};
      const anyNotSkipped = persons.some(p => !isOn(skipped, k, p));
      if(anyNotSkipped){
        const cookedPersons = persons.filter(p => isOn(cooked, k, p));
        if(cookedPersons.length > 0){
          for(const p of cookedPersons){
            const recorded = getDeducted(cooked, k, p);
            const restore = recorded || mealConsumption(srcDay, slot, [p]);
            for(const id of Object.keys(restore)){
              pantry[id] = (pantry[id]||0) + restore[id];
            }
          }
          cooked = unsetCookedPersons(cooked, k, cookedPersons);
        }
        skipped = setPersons(skipped, k, persons, true);
      } else {
        skipped = setPersons(skipped, k, persons, false);
      }
      tx.update(STATE_DOC, {
        pantry, cooked, skipped,
        updatedAt: serverTimestamp(), updatedBy: currentUid
      });
    });
  }catch(e){ console.error('toggleSkipped', e); }
}

// Marca como "hechas" todas las comidas-persona de días pasados que no estén ya cocinadas ni saltadas.
async function autoCookPastDays(){
  const targets = [];
  for(const viewDay of DAYS_ORDER){
    if(!isPastDay(viewDay)) continue;
    const src = sourceDay(viewDay);
    const meals = DATA[src]?.meals || [];
    for(const meal of meals){
      if(meal.free || !meal.items) continue;
      const k = mealKey(src, meal.slot);
      for(const p of ['m','c']){
        if(!isOn(cloud.cooked, k, p) && !isOn(cloud.skipped, k, p)){
          targets.push({ src, slot: meal.slot, k, person: p });
        }
      }
    }
  }
  if(targets.length === 0) return;
  try{
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(STATE_DOC);
      const d = snap.data() || {};
      let pantry = { ...(d.pantry||{}) };
      let cooked = d.cooked || {};
      const skipped = d.skipped || {};
      let changed = false;
      for(const t of targets){
        if(isOn(cooked, t.k, t.person) || isOn(skipped, t.k, t.person)) continue;
        const cons = mealConsumption(t.src, t.slot, [t.person]);
        const actual = deductFromPantry(pantry, cons);
        cooked = setCookedPersons(cooked, t.k, { [t.person]: actual });
        changed = true;
      }
      if(!changed) return;
      tx.update(STATE_DOC, {
        pantry, cooked,
        updatedAt: serverTimestamp(), updatedBy: currentUid
      });
    });
  }catch(e){ console.error('autoCookPastDays', e); }
}

// Reset automático al empezar la semana: si cycleStartedAt es de una semana anterior al lunes de esta,
// limpiamos cooked y skipped y reiniciamos el ciclo.
function shouldAutoReset(){
  if(!cloud.cycleStartedAt) return false;
  const start = typeof cloud.cycleStartedAt.toDate === 'function' ? cloud.cycleStartedAt.toDate() : new Date(cloud.cycleStartedAt);
  const now = new Date();
  const day = now.getDay();
  const offsetToMonday = day === 0 ? -6 : 1 - day;
  const thisMonday = new Date(now);
  thisMonday.setDate(now.getDate() + offsetToMonday);
  thisMonday.setHours(0,0,0,0);
  return start < thisMonday;
}
async function maybeAutoReset(){
  if(!shouldAutoReset()) return false;
  try{
    await runTransaction(db, async (tx) => {
      tx.update(STATE_DOC, {
        cooked: {}, skipped: {},
        cycleStartedAt: serverTimestamp(),
        updatedAt: serverTimestamp(), updatedBy: currentUid,
      });
    });
    return true;
  }catch(e){ console.error('maybeAutoReset', e); return false; }
}

async function buyItem(id, qty){
  try{
    await updateDoc(STATE_DOC, {
      [`pantry.${id}`]: increment(qty),
      updatedAt: serverTimestamp(), updatedBy: currentUid
    });
  }catch(e){ console.error('buyItem', e); }
}

async function setPantry(id, qty){
  qty = Math.max(0, Math.round(qty));
  try{
    await updateDoc(STATE_DOC, {
      [`pantry.${id}`]: qty,
      updatedAt: serverTimestamp(), updatedBy: currentUid
    });
  }catch(e){ console.error('setPantry', e); }
}

async function adjustPantry(id, delta){
  const cur = cloud.pantry[id] || 0;
  await setPantry(id, cur + delta);
}

async function startNewWeek(){
  if(!confirm('¿Empezar nueva semana? Se borrarán las marcas de "comida hecha" y "saltada". La despensa y el cambio de día se conservan.')) return;
  try{
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(STATE_DOC);
      const d = snap.data() || {};
      tx.update(STATE_DOC, {
        cooked: {}, skipped: {},
        cycleStartedAt: serverTimestamp(),
        updatedAt: serverTimestamp(), updatedBy: currentUid,
        pantry: d.pantry || {},
      });
    });
    // No llamamos a autoCookPastDays aquí: el snapshot disparará la nueva ejecución
    // con el cycleStartedAt ya actualizado (que será "hoy" → 0 días pasados → sin descuento).
    autoCookDone = false;
  }catch(e){ console.error('startNewWeek', e); }
}

async function deletePantryItem(id){
  if(RECIPE_IDS.has(id)) return; // no permitir borrar items de receta
  if(!confirm(`¿Eliminar "${CATALOG[id]?.name || id}" de la despensa?`)) return;
  try{
    await updateDoc(STATE_DOC, {
      [`pantry.${id}`]: deleteField(),
      updatedAt: serverTimestamp(), updatedBy: currentUid
    });
    delete CATALOG[id];
  }catch(e){ console.error('deletePantryItem', e); }
}

// Intercambia las recetas mostradas en dos días de la semana.
async function swapDays(a, b){
  if(a === b) return;
  const srcA = sourceDay(a);
  const srcB = sourceDay(b);
  const newMap = { ...cloud.dayMap, [a]: srcB, [b]: srcA };
  // Si volvemos a identidad, limpiar la entrada para no acumular ruido.
  if(newMap[a] === a) delete newMap[a];
  if(newMap[b] === b) delete newMap[b];
  try{
    await updateDoc(STATE_DOC, {
      dayMap: newMap,
      updatedAt: serverTimestamp(), updatedBy: currentUid
    });
  }catch(e){ console.error('swapDays', e); }
}

// Resetea el mapeo de un día: lo deja en identidad y, si algún otro día le apuntaba, también lo resetea.
async function clearDayMapping(d){
  const newMap = { ...cloud.dayMap };
  for(const k of Object.keys(newMap)){
    if(newMap[k] === d) delete newMap[k];
  }
  delete newMap[d];
  try{
    await updateDoc(STATE_DOC, {
      dayMap: newMap,
      updatedAt: serverTimestamp(), updatedBy: currentUid
    });
  }catch(e){ console.error('clearDayMapping', e); }
}

// ---------- Render ----------
const $main = document.getElementById('main');
const $header = document.getElementById('header');
const $tabbar = document.getElementById('tabbar');

function render(){
  if(!cloud.ready){ $main.innerHTML = '<div class="loading">Cargando…</div>'; return; }
  $tabbar.querySelectorAll('button').forEach(b => {
    b.setAttribute('aria-pressed', b.dataset.tab === local.tab);
  });
  if(local.tab === 'comidas') renderComidas();
  else if(local.tab === 'lista') renderLista();
  else if(local.tab === 'despensa') renderDespensa();
  else if(local.tab === 'ajustes') renderAjustes();
}

// ----- COMIDAS -----
function renderComidas(){
  const src = sourceDay(local.day);
  const swapped = src !== local.day;
  $header.innerHTML = `
    <div class="eyebrow">Plan semanal · María &amp; Carlos${swapped?` · <em>recetas de ${DAY_NAMES[src]}</em>`:''}</div>
    <h1 class="dayname" id="dayname">${DAY_NAMES[local.day]}</h1>
    <div class="chips" id="chips"></div>
    <div class="controls">
      <div class="seg" role="group" aria-label="Vista">
        <button class="v-conjunta" data-view="conjunta" aria-pressed="${local.view==='conjunta'}">Conjunta</button>
        <button class="v-maria" data-view="maria" aria-pressed="${local.view==='maria'}">María</button>
        <button class="v-carlos" data-view="carlos" aria-pressed="${local.view==='carlos'}">Carlos</button>
      </div>
      <button class="iconbtn ${local.hideHave?'on':''}" id="hideBtn" title="Ocultar lo que ya tengo" aria-pressed="${local.hideHave}">👁</button>
      <button class="iconbtn" id="resetBtn" title="Reiniciar mise-en-place del día">↺</button>
    </div>`;

  const $chips = document.getElementById('chips');
  DAYS_ORDER.forEach(d => {
    const b = document.createElement('button');
    b.className = 'chip' + (d===local.day ? ' active' : '');
    b.textContent = d; b.setAttribute('aria-label', DAY_NAMES[d]);
    b.onclick = () => { local.day = d; local.prep.clear(); render(); };
    $chips.appendChild(b);
  });
  $header.querySelectorAll('.seg button').forEach(b => {
    b.onclick = () => { local.view = b.dataset.view; saveLocal(); render(); };
  });
  document.getElementById('hideBtn').onclick = () => { local.hideHave = !local.hideHave; render(); };
  document.getElementById('resetBtn').onclick = () => {
    const pre = local.day + '.';
    [...local.mise].forEach(k => { if(k.startsWith(pre)) local.mise.delete(k); });
    saveLocal(); render();
  };
  const day = DATA[src];
  const miseKey = (mi, ii) => local.day + '.' + mi + '.' + ii;

  const visibleItems = (meal) => (meal.items||[]).filter(it => {
    if(local.view==='maria') return (it.m||0)>0;
    if(local.view==='carlos') return (it.c||0)>0;
    return true;
  });
  const qtyHTML = (it) => {
    const m=it.m||0, c=it.c||0, u=it.u||'g';
    if(local.view==='maria') return `<span class="solo m">${m}<span class="u">${u}</span></span>`;
    if(local.view==='carlos') return `<span class="solo c">${c}<span class="u">${u}</span></span>`;
    if(m>0&&c>0) return `<span class="total">${m+c}<span class="u">${u}</span></span><span class="split"><span class="pill m">M ${m}</span><span class="pill c">C ${c}</span></span>`;
    if(m>0) return `<span class="solo m">${m}<span class="u">${u}</span></span>`;
    return `<span class="solo c">${c}<span class="u">${u}</span></span>`;
  };

  let html = '';
  day.meals.forEach((meal, mi) => {
    if(meal.free){
      html += `<section class="card"><div class="card-head"><div class="slot">${meal.slot}${meal.time?`<span class="time">${meal.time}</span>`:''}</div></div><div class="freemsg">${meal.free}</div></section>`;
      return;
    }
    const items = visibleItems(meal);
    if(items.length === 0) return;
    const mk = mealKey(src, meal.slot);
    const cooked = viewPersonsCookedAll(mk);
    const cookedSomeone = ['m','c'].some(p => isOn(cloud.cooked, mk, p));
    const cookedPartial = !cooked && cookedSomeone;
    const total = items.length;
    const done = items.filter(it => local.mise.has(miseKey(mi, meal.items.indexOf(it)))).length;
    const shown = local.hideHave ? items.filter(it => !local.mise.has(miseKey(mi, meal.items.indexOf(it)))) : items;

    html += `<section class="card ${cooked?'cooked':''}"><div class="card-head">
      <div class="slot">${meal.slot}${meal.time?`<span class="time">${meal.time}</span>`:''}</div>
      <div class="progress${done===total&&total>0?' done':''}">${done}/${total} listo${total!==1?'s':''}</div></div>`;
    if(meal.dish) html += `<div class="dish">${meal.dish}</div>`;
    html += `<ul class="rows">`;
    shown.forEach(it => {
      const ii = meal.items.indexOf(it);
      const k = miseKey(mi, ii);
      const ck = local.mise.has(k);
      html += `<li class="row${ck?' checked':''}" data-k="${k}"><span class="box">${CHK}</span>
        <span class="name">${it.n}${it.note?`<span class="note">${it.note}</span>`:''}</span>
        <span class="qty">${qtyHTML(it)}</span></li>`;
    });
    html += `</ul>`;
    if(meal.prep){
      const steps = meal.prep.filter(s => local.view==='conjunta' || s.who==='ambos' || s.who===local.view);
      if(steps.length){
        const pk = 'p'+mi, open = local.prep.has(pk);
        html += `<div class="prep"><button class="prep-btn" data-pk="${pk}" aria-expanded="${open}"><span class="arw">▸</span> Preparación</button><div class="prep-body${open?' open':''}">`;
        steps.forEach(s => {
          const lab = s.who==='maria'?'<span class="who maria">María</span>':s.who==='carlos'?'<span class="who carlos">Carlos</span>':'<span class="who ambos">Ambos</span>';
          html += `<div class="step">${lab}<span>${s.t}</span></div>`;
        });
        html += `</div></div>`;
      }
    }
    const viewLbl = local.view === 'maria' ? ' (María)' : local.view === 'carlos' ? ' (Carlos)' : '';
    html += `<div class="meal-actions">`;
    if(cooked) html += `<button class="btn-undo" data-slot="${meal.slot}">↺ Deshacer${viewLbl}</button>`;
    else       html += `<button class="btn-done" data-slot="${meal.slot}">✓ Marcar como hecha${viewLbl}</button>`;
    if(cookedPartial && local.view === 'conjunta'){
      const who = isOn(cloud.cooked, mk, 'm') ? 'María' : 'Carlos';
      html += `<span class="meal-partial">${who} ya hecha</span>`;
    }
    html += `</div></section>`;
  });
  $main.innerHTML = html;

  $main.querySelectorAll('.row').forEach(r => {
    r.onclick = () => {
      const k = r.dataset.k;
      local.mise.has(k) ? local.mise.delete(k) : local.mise.add(k);
      saveLocal(); render();
    };
  });
  $main.querySelectorAll('.prep-btn').forEach(b => {
    b.onclick = () => {
      const pk = b.dataset.pk;
      local.prep.has(pk) ? local.prep.delete(pk) : local.prep.add(pk);
      render();
    };
  });
  $main.querySelectorAll('.btn-done').forEach(b => {
    b.onclick = () => markCooked(src, b.dataset.slot, personsForView());
  });
  $main.querySelectorAll('.btn-undo').forEach(b => {
    b.onclick = () => undoCooked(src, b.dataset.slot, local.day, personsForView());
  });
}

// ----- LISTA -----
function renderLista(){
  const list = computeShoppingList();
  const totalItems = list.length;
  $header.innerHTML = `
    <div class="eyebrow">Lista de la compra</div>
    <h1 class="dayname">Esta semana <small>${totalItems} ítem${totalItems!==1?'s':''}</small></h1>`;

  if(totalItems === 0){
    $main.innerHTML = `<div class="empty-state">Nada que comprar. 🎉<br><small>La despensa cubre toda la semana pendiente.</small></div>`;
    return;
  }

  // Agrupar por categoría
  const byCat = {};
  for(const item of list){
    const cat = CATALOG[item.id]?.category || 'Otros';
    (byCat[cat] = byCat[cat] || []).push(item);
  }
  let html = '';
  for(const cat of CATEGORIES){
    const arr = byCat[cat];
    if(!arr) continue;
    arr.sort((a,b) => (CATALOG[a.id]?.name||'').localeCompare(CATALOG[b.id]?.name||''));
    html += `<section class="card cat-card"><div class="cat-title"><span class="cat-ic">${CATEGORY_ICON[cat]||'📦'}</span>${cat}</div><ul class="rows">`;
    for(const item of arr){
      const c = CATALOG[item.id];
      const unit = c?.unit || 'g';
      const name = c?.name || item.id;
      html += `<li class="row buy-row" data-id="${item.id}" data-qty="${item.qty}">
        <span class="box big">${CHK}</span>
        <span class="name">${name}</span>
        <span class="qty"><span class="total">${item.qty}<span class="u">${unit}</span></span></span>
      </li>`;
    }
    html += `</ul></section>`;
  }
  $main.innerHTML = html;
  $main.querySelectorAll('.buy-row').forEach(r => {
    r.onclick = () => {
      const id = r.dataset.id;
      const qty = parseFloat(r.dataset.qty);
      r.classList.add('checked');
      buyItem(id, qty);
    };
  });
}

// ----- DESPENSA -----
function renderDespensa(){
  $header.innerHTML = `
    <div class="eyebrow">Despensa</div>
    <h1 class="dayname">Qué tenemos en casa</h1>
    <div class="controls add-row">
      <input id="add-name" placeholder="Nombre del ingrediente" />
      <input id="add-qty" type="number" inputmode="numeric" min="0" placeholder="0" />
      <select id="add-unit"><option value="g">g</option><option value="ml">ml</option></select>
      <button id="add-btn" class="btn-add">+</button>
    </div>`;
  document.getElementById('add-btn').onclick = onAdd;

  // Construir lista: todos los ids del catálogo, además de los de pantry que no estén en él.
  const ids = new Set([...Object.keys(CATALOG), ...Object.keys(cloud.pantry)]);
  const byCat = {};
  for(const id of ids){
    const c = CATALOG[id] || { name: id, unit: 'g', category: 'Otros' };
    const cat = c.category;
    (byCat[cat] = byCat[cat] || []).push({ id, ...c, qty: cloud.pantry[id] || 0 });
  }
  let html = '';
  for(const cat of CATEGORIES){
    const arr = byCat[cat];
    if(!arr) continue;
    arr.sort((a,b) => a.name.localeCompare(b.name));
    html += `<section class="card cat-card"><div class="cat-title"><span class="cat-ic">${CATEGORY_ICON[cat]||'📦'}</span>${cat}</div><ul class="rows">`;
    for(const it of arr){
      const isCustom = !RECIPE_IDS.has(it.id);
      html += `<li class="row pantry-row ${it.qty>0?'':'empty'}" data-id="${it.id}">
        <span class="name">${it.name}</span>
        <div class="pantry-ctrls">
          <button class="qbtn minus" data-id="${it.id}">−</button>
          <input class="qval" type="number" inputmode="numeric" min="0" step="1" value="${it.qty}" data-id="${it.id}" />
          <span class="qunit">${it.unit}</span>
          <button class="qbtn plus" data-id="${it.id}">+</button>
          ${isCustom?`<button class="qbtn trash" data-id="${it.id}" title="Eliminar ${it.name}" aria-label="Eliminar ${it.name}">🗑</button>`:''}
        </div>
      </li>`;
    }
    html += `</ul></section>`;
  }
  $main.innerHTML = html;

  // Eventos
  $main.querySelectorAll('.qbtn.plus').forEach(b => {
    b.onclick = (e) => { e.stopPropagation(); adjustPantry(b.dataset.id, +10); };
    b.oncontextmenu = (e) => { e.preventDefault(); adjustPantry(b.dataset.id, +50); };
  });
  $main.querySelectorAll('.qbtn.minus').forEach(b => {
    b.onclick = (e) => { e.stopPropagation(); adjustPantry(b.dataset.id, -10); };
    b.oncontextmenu = (e) => { e.preventDefault(); adjustPantry(b.dataset.id, -50); };
  });
  $main.querySelectorAll('.qbtn.trash').forEach(b => {
    b.onclick = (e) => { e.stopPropagation(); deletePantryItem(b.dataset.id); };
  });
  $main.querySelectorAll('input.qval').forEach(inp => {
    inp.onfocus = () => inp.select();
    inp.onchange = () => {
      const n = parseFloat(inp.value);
      if(Number.isFinite(n) && n >= 0) setPantry(inp.dataset.id, n);
      else inp.value = cloud.pantry[inp.dataset.id] || 0;
    };
    inp.onkeydown = (e) => { if(e.key === 'Enter') inp.blur(); };
  });
}

// ----- AJUSTES -----
function renderAjustes(){
  $header.innerHTML = `
    <div class="eyebrow">Ajustes</div>
    <h1 class="dayname">Configuración</h1>`;

  let html = `<section class="card cat-card"><div class="cat-title"><span class="cat-ic">📅</span>Planificación</div>
    <p class="ajustes-help">Desactiva las comidas que NO vayáis a cocinar esta semana. Cada fila es una persona; los chips atenuados son comidas en las que esa persona no come.</p>`;
  for(const d of DAYS_ORDER){
    const src = sourceDay(d);
    const meals = (DATA[src]?.meals || []).filter(m => !m.free && m.items);
    if(meals.length === 0) continue;
    html += `<div class="plan-day"><span class="plan-day-name">${DAY_NAMES[d]}${src!==d?` <small>(de ${DAY_NAMES[src]})</small>`:''}</span>`;
    for(const person of ['m','c']){
      const personName = person === 'm' ? 'María' : 'Carlos';
      html += `<div class="plan-person-row ${person}">
        <span class="plan-person-lbl">${personName}</span>
        <div class="plan-meals">`;
      for(const meal of meals){
        const k = mealKey(src, meal.slot);
        const cons = mealConsumption(src, meal.slot, [person]);
        const hasItems = Object.keys(cons).length > 0;
        const active = !isOn(cloud.skipped, k, person);
        const label = SLOT_ABBREV[meal.slot] || meal.slot.slice(0,3);
        const cls = `plan-meal ${person}${hasItems?'':' empty-portion'}`;
        const title = hasItems ? meal.slot : `${meal.slot} (sin porción para ${personName})`;
        html += `<button class="${cls}" data-day="${src}" data-slot="${meal.slot}" data-person="${person}" aria-pressed="${active}" title="${title}">${label}</button>`;
      }
      html += `</div></div>`;
    }
    html += `</div>`;
  }
  html += `</section>`;

  html += `<section class="card cat-card"><div class="cat-title"><span class="cat-ic">🔀</span>Cambio de día</div>
    <p class="ajustes-help">Asigna las recetas de un día a otro (p. ej. el Lunes mostrará las del Miércoles y viceversa). Se conserva al empezar nueva semana.</p>
    <ul class="rows">`;
  for(const d of DAYS_ORDER){
    const s = sourceDay(d);
    const swapped = s !== d;
    const options = DAYS_ORDER.map(x => `<option value="${x}" ${x===s?'selected':''}>${DAY_NAMES[x]}</option>`).join('');
    html += `<li class="row swap-row">
      <span class="name">${DAY_NAMES[d]}</span>
      <div class="swap-ctrls">
        <select class="swap-sel" data-day="${d}" aria-label="Recetas para ${DAY_NAMES[d]}">${options}</select>
        ${swapped?`<button class="qbtn swap-reset" data-day="${d}" title="Restaurar">↺</button>`:''}
      </div>
    </li>`;
  }
  html += `</ul></section>`;

  html += `<section class="card cat-card"><div class="cat-title"><span class="cat-ic">🔄</span>Ciclo semanal</div>
    <p class="ajustes-help">Cada lunes el ciclo se reinicia automáticamente (cocinadas y desactivaciones de planificación se borran). Si necesitas forzar un reinicio mid-semana, púlsalo aquí.</p>
    <div class="ajustes-actions">
      <button id="new-week-btn-ajustes" class="btn-secondary">Empezar nueva semana</button>
    </div></section>`;

  html += `<section class="card cat-card"><div class="cat-title"><span class="cat-ic">👤</span>Sesión</div>
    <div class="ajustes-actions">
      <button id="sign-out-btn-ajustes" class="btn-secondary">Cerrar sesión</button>
    </div></section>`;

  $main.innerHTML = html;

  $main.querySelectorAll('.plan-meal').forEach(b => {
    b.onclick = () => toggleSkipped(b.dataset.day, b.dataset.slot, [b.dataset.person]);
  });
  document.getElementById('new-week-btn-ajustes').onclick = startNewWeek;
  $main.querySelectorAll('.swap-sel').forEach(sel => {
    sel.onchange = (e) => {
      const d = sel.dataset.day;
      const target = e.target.value;
      const s = sourceDay(d);
      if(target === s) return;
      if(target === d) clearDayMapping(d);
      else swapDays(d, target);
    };
  });
  $main.querySelectorAll('.swap-reset').forEach(b => {
    b.onclick = () => clearDayMapping(b.dataset.day);
  });
  document.getElementById('sign-out-btn-ajustes').onclick = () => signOut(auth);
}

function onAdd(){
  const $n = document.getElementById('add-name');
  const $q = document.getElementById('add-qty');
  const $u = document.getElementById('add-unit');
  const name = ($n.value || '').trim();
  const qty  = parseFloat($q.value);
  const unit = $u.value === 'ml' ? 'ml' : 'g';
  if(!name || !Number.isFinite(qty) || qty < 0) return;
  const id = slug(name);
  if(!CATALOG[id]){
    CATALOG[id] = { name, unit, category: categoryFor(name) };
  }
  setPantry(id, qty);
  $n.value = ''; $q.value = '';
}

// ---------- Tab nav ----------
$tabbar.querySelectorAll('button').forEach(b => {
  b.onclick = () => { local.tab = b.dataset.tab; saveLocal(); render(); };
});
