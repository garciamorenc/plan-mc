import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithRedirect, signInWithPopup, getRedirectResult,
  onAuthStateChanged, signOut
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js';
import {
  getFirestore, doc, onSnapshot, runTransaction, updateDoc, setDoc, deleteDoc,
  collection, query, orderBy, limit,
  increment, serverTimestamp, enableIndexedDbPersistence, deleteField
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js';
import {
  getMessaging, getToken, onMessage, isSupported as msgIsSupported
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-messaging.js';

import { firebaseConfig, ALLOWED_UIDS, VAPID_KEY } from './firebase-config.js';
import { DATA as SEED_PLAN, DAYS_ORDER, DAY_NAMES } from './data.js';
import {
  CATALOG, CATEGORIES, CATEGORY_ICON, RECIPE_IDS,
  slug, categoryFor, rebuild as rebuildCatalog, seedCategoriesFromPlan
} from './catalog.js';

// ---------- Firebase init ----------
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);
enableIndexedDbPersistence(db).catch(()=>{}); // ignora si ya activo o multi-tab
const STATE_DOC = doc(db, 'state', 'main');
const PLAN_DOC = doc(db, 'plan', 'current');
const CAT_DOC = doc(db, 'categories', 'main');

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
const cloud = {
  pantry: {}, cooked: {}, skipped: {}, frozen: {}, dayMap: {}, cycleStartedAt: null,
  plan: null, planName: 'Plan inicial', planUpdatedAt: null,
  categories: {},
  archives: null,
  ready: false, planReady: false, catReady: false,
};
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
  initMessaging();
});

function showGate(msg){
  $loading.hidden = true;
  $gate.hidden = false;
  $appRoot.hidden = true;
  $gateMsg.textContent = msg;
}

// ---------- Firestore listeners ----------
function subscribeState(){
  // state/main: estado dinámico (despensa, cooked, skipped, dayMap, ciclo).
  onSnapshot(STATE_DOC, async (snap) => {
    if(!snap.exists()){
      try{
        await setDoc(STATE_DOC, {
          pantry: {}, cooked: {}, skipped: {}, frozen: {}, dayMap: {},
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
    cloud.frozen = d.frozen || {};
    cloud.dayMap = d.dayMap || {};
    cloud.cycleStartedAt = d.cycleStartedAt || null;
    cloud.ready = true;
    render();
    maybeBootAutoCook();
  }, (err) => console.error('state snapshot', err));

  // plan/current: el plan semanal de comidas, editable.
  onSnapshot(PLAN_DOC, async (snap) => {
    if(!snap.exists()){
      try{
        await setDoc(PLAN_DOC, {
          plan: SEED_PLAN,
          name: 'Plan inicial',
          updatedAt: serverTimestamp(),
          updatedBy: currentUid,
        });
      }catch(e){ console.error('No se pudo crear plan/current', e); }
      return;
    }
    const d = snap.data() || {};
    cloud.plan = d.plan || SEED_PLAN;
    cloud.planName = d.name || 'Sin nombre';
    cloud.planUpdatedAt = d.updatedAt || null;
    cloud.planReady = true;
    rebuildCatalog(cloud.plan, cloud.categories);
    render();
    maybeBootAutoCook();
  }, (err) => console.error('plan snapshot', err));

  // plans/ archivos del histórico, ordenados por fecha descendente.
  const archivesQuery = query(collection(db, 'plans'), orderBy('archivedAt', 'desc'), limit(50));
  onSnapshot(archivesQuery, (snap) => {
    cloud.archives = snap.docs.map(d => ({
      id: d.id,
      archivedAt: d.data().archivedAt || null,
      name: d.data().name || 'Sin nombre',
      plan: d.data().plan || null,
    }));
    render();
  }, (err) => console.error('archives snapshot', err));

  // categories/main: id ingrediente → categoría (editable cuando añades ingredientes nuevos).
  onSnapshot(CAT_DOC, async (snap) => {
    if(!snap.exists()){
      try{
        await setDoc(CAT_DOC, {
          ingredients: seedCategoriesFromPlan(SEED_PLAN),
          updatedAt: serverTimestamp(),
          updatedBy: currentUid,
        });
      }catch(e){ console.error('No se pudo crear categories/main', e); }
      return;
    }
    const d = snap.data() || {};
    cloud.categories = d.ingredients || {};
    cloud.catReady = true;
    rebuildCatalog(cloud.plan, cloud.categories);
    render();
  }, (err) => console.error('categories snapshot', err));
}

// ---------- Push notifications ----------
let messagingInstance = null;
let currentToken = null;
const notifState = { permission: 'default', supported: false, ready: false };

async function initMessaging(){
  try{
    notifState.supported = await msgIsSupported();
  }catch(e){ notifState.supported = false; }
  if(!notifState.supported){ notifState.ready = true; return; }
  notifState.permission = typeof Notification !== 'undefined' ? Notification.permission : 'default';
  notifState.ready = true;
  if(notifState.permission === 'granted'){
    await registerToken();
  }
  render();
}

async function registerToken(){
  if(!notifState.supported) return;
  if(!VAPID_KEY || VAPID_KEY.startsWith('TODO')) return;
  try{
    if(!messagingInstance) messagingInstance = getMessaging(app);
    // Firebase auto-registra firebase-messaging-sw.js en su propio scope
    // (/firebase-cloud-messaging-push-scope). Así NO pisa el sw.js principal.
    const token = await getToken(messagingInstance, { vapidKey: VAPID_KEY });
    if(!token) return;
    currentToken = token;
    // Mensajes en primer plano: el SW no muestra notificación; los pasamos por consola por ahora.
    onMessage(messagingInstance, (payload) => {
      console.log('Push en primer plano:', payload);
    });
    // Guardar token en users/{uid}.fcmTokens
    const userRef = doc(db, 'users', currentUid);
    await setDoc(userRef, {
      fcmTokens: { [token]: {
        ua: navigator.userAgent,
        updatedAt: serverTimestamp(),
      }},
      updatedAt: serverTimestamp(),
    }, { merge: true });
  }catch(e){ console.error('registerToken', e); }
}

async function requestNotificationPermission(){
  if(!notifState.supported){ toast('Este navegador no soporta notificaciones push.', 'error'); return; }
  try{
    const perm = await Notification.requestPermission();
    notifState.permission = perm;
    if(perm === 'granted'){
      await registerToken();
    }
    render();
  }catch(e){ console.error('requestPermission', e); }
}

async function disableNotifications(){
  if(!confirm('¿Desactivar notificaciones en este dispositivo?')) return;
  try{
    if(currentToken && currentUid){
      await updateDoc(doc(db, 'users', currentUid), {
        [`fcmTokens.${currentToken}`]: deleteField(),
        updatedAt: serverTimestamp(),
      });
    }
    currentToken = null;
  }catch(e){ console.error('disableNotifications', e); }
  render();
}

function maybeBootAutoCook(){
  if(autoCookDone) return;
  if(!cloud.ready || !cloud.planReady) return; // necesitamos plan para calcular consumiciones
  autoCookDone = true;
  (async () => {
    const wasReset = await maybeAutoReset();
    if(wasReset){
      autoCookDone = false;
    } else {
      autoCookPastDays().catch(e => console.error('autoCook', e));
    }
  })();
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
    const meals = cloud.plan?.[src]?.meals || [];
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
  const meal = (cloud.plan?.[day]?.meals||[]).find(m => m.slot === slot);
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
      let frozen = { ...(d.frozen||{}) };
      const toMark = persons.filter(p => !isOn(cooked, k, p));
      if(toMark.length === 0) return;
      const deductedByPerson = {};
      for(const p of toMark){
        const cons = mealConsumption(day, slot, [p]);
        deductedByPerson[p] = deductFromPantry(pantry, cons);
      }
      cooked = setCookedPersons(cooked, k, deductedByPerson);
      skipped = setPersons(skipped, k, toMark, false);
      // Si toda la comida queda cocinada, la porción congelada se considera consumida.
      const bothCooked = ['m','c'].every(p => isOn(cooked, k, p));
      if(bothCooked) delete frozen[k];
      tx.update(STATE_DOC, {
        pantry, cooked, skipped, frozen,
        updatedAt: serverTimestamp(), updatedBy: currentUid
      });
    });
  }catch(e){ console.error('markCooked', e); }
}

function isItemFrozen(mk, id){
  const v = cloud.frozen[mk];
  if(!v) return false;
  if(v === true) return true; // legacy: toda la comida estaba marcada
  return !!v[id];
}
// Devuelve fecha JS (local) de la comida (viewDay, time) en el ciclo actual.
function computeMealDateLocal(viewDay, time){
  const codeToJs = CODE_TO_JS;
  const target = codeToJs[viewDay];
  if(target == null) return null;
  let base;
  const start = cloud.cycleStartedAt?.toDate ? cloud.cycleStartedAt.toDate() : null;
  const now = new Date();
  if(!start){
    base = new Date(now); base.setHours(0,0,0,0);
    const dow = base.getDay();
    const off = dow === 0 ? -6 : 1 - dow;
    base.setDate(base.getDate() + off);
  } else {
    const startMid = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const todayMid = new Date(); todayMid.setHours(0,0,0,0);
    const daysSinceStart = Math.floor((todayMid - startMid) / 86400000);
    if(daysSinceStart >= 7){
      base = new Date(now); base.setHours(0,0,0,0);
      const dow = base.getDay();
      const off = dow === 0 ? -6 : 1 - dow;
      base.setDate(base.getDate() + off);
    } else {
      base = startMid;
    }
  }
  const baseWk = base.getDay();
  const offset = (target - baseWk + 7) % 7;
  const date = new Date(base);
  date.setDate(date.getDate() + offset);
  const [hh, mm] = (time || '13:00').split(':').map(n => parseInt(n, 10) || 0);
  date.setHours(hh, mm, 0, 0);
  return date;
}

function relativeDayLabel(date){
  const a = new Date(date); a.setHours(0,0,0,0);
  const b = new Date(); b.setHours(0,0,0,0);
  const days = Math.round((a - b) / 86400000);
  if(days <= 0) return 'hoy';
  if(days === 1) return 'mañana';
  if(days === 2) return 'pasado mañana';
  return DAY_NAMES[WEEKDAY_MAP[a.getDay()]] || '';
}

// Lista comidas en próximas 48 h con ingredientes congelados (no cocinadas ni saltadas por ambos).
function computeDefrostReminders(){
  const now = new Date();
  const out = [];
  for(const viewDay of DAYS_ORDER){
    const src = sourceDay(viewDay);
    const meals = cloud.plan?.[src]?.meals || [];
    for(const meal of meals){
      if(meal.free || !meal.items) continue;
      const k = mealKey(src, meal.slot);
      const fmap = cloud.frozen[k];
      if(!fmap) continue;
      const ck = cloud.cooked[k];
      const cookedBoth = ck === true || (ck && typeof ck === 'object' && ck.m && ck.c);
      if(cookedBoth) continue;
      const sk = cloud.skipped[k];
      const skippedBoth = sk === true || (sk && typeof sk === 'object' && sk.m && sk.c);
      if(skippedBoth) continue;
      const ids = fmap === true ? meal.items.map(it => slug(it.n)) : Object.keys(fmap).filter(id => fmap[id]);
      if(ids.length === 0) continue;
      const date = computeMealDateLocal(viewDay, meal.time);
      if(!date) continue;
      const hoursAhead = (date - now) / 3600000;
      if(hoursAhead < -2 || hoursAhead > 48) continue;
      const names = meal.items.filter(it => ids.includes(slug(it.n))).map(it => it.n);
      out.push({ viewDay, slot: meal.slot, mealDate: date, names });
    }
  }
  return out.sort((a, b) => a.mealDate - b.mealDate);
}

function frozenCount(mk){
  const v = cloud.frozen[mk];
  if(!v) return 0;
  if(v === true) return -1; // legacy: todos
  return Object.keys(v).length;
}

async function toggleFrozen(srcDay, slot, ingredientId){
  const k = mealKey(srcDay, slot);
  try{
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(STATE_DOC);
      const d = snap.data() || {};
      let frozen = { ...(d.frozen||{}) };
      const v = frozen[k];
      let cur;
      if(v === true){
        // Migración legacy: pasamos a objeto con todos los ingredientes de la comida.
        const meal = (cloud.plan?.[srcDay]?.meals||[]).find(m => m.slot === slot);
        cur = {};
        for(const it of (meal?.items||[])) cur[slug(it.n)] = true;
      } else if(v && typeof v === 'object'){
        cur = { ...v };
      } else {
        cur = {};
      }
      if(cur[ingredientId]) delete cur[ingredientId];
      else cur[ingredientId] = true;
      if(Object.keys(cur).length === 0) delete frozen[k];
      else frozen[k] = cur;
      tx.update(STATE_DOC, {
        frozen,
        updatedAt: serverTimestamp(), updatedBy: currentUid,
      });
    });
  }catch(e){ console.error('toggleFrozen', e); }
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
// Activa o desactiva todas las comidas de un día (ambas personas), en una sola transacción.
// Si makeSkipped=true: marca todo como skipped y deshace cualquier cocinada (devolviendo despensa).
// Si makeSkipped=false: limpia todo el skip del día.
async function toggleDay(srcDay, makeSkipped){
  const meals = (cloud.plan?.[srcDay]?.meals || []).filter(m => !m.free && m.items);
  if(meals.length === 0) return;
  try{
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(STATE_DOC);
      const d = snap.data() || {};
      let pantry = { ...(d.pantry||{}) };
      let cooked = d.cooked || {};
      let skipped = d.skipped || {};
      for(const meal of meals){
        const k = mealKey(srcDay, meal.slot);
        if(makeSkipped){
          const cookedPersons = ['m','c'].filter(p => isOn(cooked, k, p));
          if(cookedPersons.length > 0){
            for(const p of cookedPersons){
              const recorded = getDeducted(cooked, k, p);
              const restore = recorded || mealConsumption(srcDay, meal.slot, [p]);
              for(const id of Object.keys(restore)){
                pantry[id] = (pantry[id]||0) + restore[id];
              }
            }
            cooked = unsetCookedPersons(cooked, k, cookedPersons);
          }
          skipped = setPersons(skipped, k, ['m','c'], true);
        } else {
          skipped = setPersons(skipped, k, ['m','c'], false);
        }
      }
      tx.update(STATE_DOC, {
        pantry, cooked, skipped,
        updatedAt: serverTimestamp(), updatedBy: currentUid
      });
    });
  }catch(e){ console.error('toggleDay', e); }
}

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
    const meals = cloud.plan?.[src]?.meals || [];
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
      let frozen = { ...(d.frozen||{}) };
      let changed = false;
      for(const t of targets){
        if(isOn(cooked, t.k, t.person) || isOn(skipped, t.k, t.person)) continue;
        const cons = mealConsumption(t.src, t.slot, [t.person]);
        const actual = deductFromPantry(pantry, cons);
        cooked = setCookedPersons(cooked, t.k, { [t.person]: actual });
        changed = true;
      }
      if(!changed) return;
      // Limpia frozen para comidas que quedan totalmente cocinadas.
      for(const k of Object.keys(frozen)){
        if(['m','c'].every(p => isOn(cooked, k, p))) delete frozen[k];
      }
      tx.update(STATE_DOC, {
        pantry, cooked, frozen,
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
        cooked: {}, skipped: {}, frozen: {},
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
        cooked: {}, skipped: {}, frozen: {},
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
  if(!cloud.ready || !cloud.planReady){ $main.innerHTML = '<div class="loading">Cargando…</div>'; return; }
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
  const day = cloud.plan?.[src];
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

  // Banner de descongelar para próximas 48h
  const reminders = computeDefrostReminders();
  let html = '';
  if(reminders.length > 0){
    html += `<div class="defrost-banner"><div class="defrost-banner-head">❄ Descongela para las próximas 48 h</div><ul class="defrost-list">`;
    for(const r of reminders){
      const when = relativeDayLabel(r.mealDate);
      html += `<li><strong>${when} · ${r.slot.toLowerCase()}</strong>: ${escText(r.names.join(', '))}</li>`;
    }
    html += `</ul></div>`;
  }
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

    const frozenN = frozenCount(mk);
    const anyFrozen = frozenN > 0 || frozenN === -1;
    const badgeTxt = frozenN === -1 ? '❄ congelada' : `❄ ${frozenN}`;
    html += `<section class="card ${cooked?'cooked':''} ${anyFrozen?'frozen':''}"><div class="card-head">
      <div class="slot">${meal.slot}${meal.time?`<span class="time">${meal.time}</span>`:''}${anyFrozen?` <span class="frozen-badge">${badgeTxt}</span>`:''}</div>
      <div class="progress${done===total&&total>0?' done':''}">${done}/${total} listo${total!==1?'s':''}</div></div>`;
    if(meal.dish) html += `<div class="dish">${meal.dish}</div>`;
    html += `<ul class="rows">`;
    shown.forEach(it => {
      const ii = meal.items.indexOf(it);
      const k = miseKey(mi, ii);
      const ck = local.mise.has(k);
      const itemFrozen = isItemFrozen(mk, it.id);
      html += `<li class="row${ck?' checked':''}" data-k="${k}"><span class="box">${CHK}</span>
        <span class="name">${it.n}${it.note?`<span class="note">${it.note}</span>`:''}</span>
        <span class="qty">${qtyHTML(it)}</span>
        <button class="ingr-freeze${itemFrozen?' on':''}" data-slot="${meal.slot}" data-id="${it.id}" title="${itemFrozen?'Quitar congelado':'Marcar congelado'}">❄</button></li>`;
    });
    html += `</ul>`;
    if(meal.prep){
      const steps = meal.prep.filter(s => local.view==='conjunta' || s.who==='ambos' || s.who===local.view);
      if(steps.length){
        const pk = 'p'+mi, open = local.prep.has(pk);
        html += `<div class="prep"><button class="prep-btn" data-pk="${pk}" aria-expanded="${open}"><span class="arw">▸</span> Preparación</button><div class="prep-body${open?' open':''}">`;
        steps.forEach(s => {
          const lab = s.who==='maria'?'<span class="who maria">María</span>':s.who==='carlos'?'<span class="who carlos">Carlos</span>':'<span class="who ambos">Ambos</span>';
          html += `<div class="step">${lab}<span>${escText(s.t||'')}</span></div>`;
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
  $main.querySelectorAll('.ingr-freeze').forEach(b => {
    b.onclick = (e) => {
      e.stopPropagation();
      toggleFrozen(src, b.dataset.slot, b.dataset.id);
    };
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
    const meals = (cloud.plan?.[src]?.meals || []).filter(m => !m.free && m.items);
    if(meals.length === 0) continue;
    // ¿Está todo el día (ambas personas, todas las comidas con porción) activo?
    let allActive = true;
    let anyToggleable = false;
    for(const meal of meals){
      const k = mealKey(src, meal.slot);
      for(const person of ['m','c']){
        const cons = mealConsumption(src, meal.slot, [person]);
        if(Object.keys(cons).length === 0) continue;
        anyToggleable = true;
        if(isOn(cloud.skipped, k, person)) allActive = false;
      }
    }
    const dayToggleAction = allActive ? 'skip' : 'unskip';
    const dayToggleLbl = allActive ? `Desactivar el ${DAY_NAMES[d]} entero` : `Activar el ${DAY_NAMES[d]} entero`;
    html += `<div class="plan-day">
      <div class="plan-day-head">
        <span class="plan-day-name">${DAY_NAMES[d]}${src!==d?` <small>(de ${DAY_NAMES[src]})</small>`:''}</span>
        ${anyToggleable ? `<button class="plan-day-toggle" data-day="${src}" data-action="${dayToggleAction}" role="switch" aria-checked="${allActive}" aria-label="${dayToggleLbl}"></button>` : ''}
      </div>`;
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

  // Historial de planes (activo + archivos)
  html += `<section class="card cat-card"><div class="cat-title"><span class="cat-ic">📜</span>Planes</div>
    <p class="ajustes-help">El plan activo es el que se está usando ahora. Los demás son borradores guardados. Activa cualquiera para ponerlo en uso (el actual se archivará).</p>
    <ul class="rows">`;
  // Fila del plan activo
  const activeDate = cloud.planUpdatedAt?.toDate ? cloud.planUpdatedAt.toDate().toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' }) : '';
  html += `<li class="row archive-row active-row">
    <div class="archive-meta">
      <span class="name">${escText(cloud.planName || 'Plan')} <span class="active-badge">ACTIVO</span></span>
      ${activeDate ? `<span class="archive-date">${activeDate}</span>` : ''}
    </div>
    <div class="archive-ctrls">
      <button class="ed-btn-sec edit-active">Editar</button>
    </div>
  </li>`;
  if(cloud.archives == null){
    html += `<li class="row" style="justify-content:center;"><span class="ajustes-help">Cargando archivos…</span></li>`;
  } else {
    for(const a of cloud.archives){
      const date = a.archivedAt?.toDate ? a.archivedAt.toDate() : null;
      const dateStr = date ? date.toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' }) : '(sin fecha)';
      html += `<li class="row archive-row">
        <div class="archive-meta">
          <span class="name">${escText(a.name)}</span>
          <span class="archive-date">${dateStr}</span>
        </div>
        <div class="archive-ctrls">
          <button class="ed-btn-sec archive-edit" data-id="${a.id}">Editar</button>
          <button class="ed-btn-pri archive-restore" data-id="${a.id}">Activar</button>
          <button class="qbtn trash archive-del" data-id="${a.id}" title="Eliminar archivo">🗑</button>
        </div>
      </li>`;
    }
  }
  html += `</ul></section>`;

  // Notificaciones push
  html += `<section class="card cat-card"><div class="cat-title"><span class="cat-ic">🔔</span>Notificaciones</div>`;
  if(!notifState.ready){
    html += `<p class="ajustes-help">Cargando…</p>`;
  } else if(!notifState.supported){
    html += `<p class="ajustes-help">Este navegador no soporta notificaciones push. En iPhone debes <strong>instalar la app en pantalla de inicio</strong> con Safari para que funcionen.</p>`;
  } else if(!VAPID_KEY || VAPID_KEY.startsWith('TODO')){
    html += `<p class="ajustes-help">Falta la clave VAPID en <code>firebase-config.js</code>. Consulta el README.</p>`;
  } else if(notifState.permission === 'granted'){
    html += `<p class="ajustes-help">Activadas en este dispositivo. Recibirás un aviso ~24 h antes de cada comida con ingredientes congelados.</p>
      <div class="ajustes-actions">
        <button id="notif-disable-btn" class="btn-secondary">Desactivar en este dispositivo</button>
      </div>`;
  } else if(notifState.permission === 'denied'){
    html += `<p class="ajustes-help">Permiso de notificaciones bloqueado. Cámbialo desde los ajustes del navegador y recarga.</p>`;
  } else {
    html += `<p class="ajustes-help">Avisos automáticos 24 h antes de cada comida con ingredientes congelados.</p>
      <div class="ajustes-actions">
        <button id="notif-enable-btn" class="btn-secondary">Activar notificaciones</button>
      </div>`;
  }
  html += `</section>`;

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
  $main.querySelectorAll('.plan-day-toggle').forEach(b => {
    b.onclick = () => toggleDay(b.dataset.day, b.dataset.action === 'skip');
  });
  document.getElementById('new-week-btn-ajustes').onclick = startNewWeek;
  document.getElementById('notif-enable-btn')?.addEventListener('click', requestNotificationPermission);
  document.getElementById('notif-disable-btn')?.addEventListener('click', disableNotifications);
  $main.querySelector('.edit-active').onclick = () => openEditor();
  $main.querySelectorAll('.archive-restore').forEach(b => {
    b.onclick = () => restoreArchive(b.dataset.id);
  });
  $main.querySelectorAll('.archive-edit').forEach(b => {
    b.onclick = () => editArchive(b.dataset.id);
  });
  $main.querySelectorAll('.archive-del').forEach(b => {
    b.onclick = () => deleteArchive(b.dataset.id);
  });
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

// ---------- Editor del plan ----------
const $editor = document.getElementById('editor');
const $edChips = document.getElementById('ed-chips');
const $edMain = document.getElementById('ed-main');
const $edSave = document.getElementById('ed-save');
const $edCancel = document.getElementById('ed-cancel');

const deepCopy = (o) => JSON.parse(JSON.stringify(o));

let toastTimeout = null;
function toast(msg, type = 'info', duration = 3500){
  const el = document.getElementById('toast');
  if(!el) return;
  el.textContent = msg;
  el.className = `toast ${type}`;
  el.hidden = false;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => { el.hidden = true; }, duration);
}

function openEditor(planSource, sourceName){
  local.editor = {
    open: true,
    draft: deepCopy(planSource || cloud.plan),
    cats: deepCopy(cloud.categories || {}),
    name: sourceName || cloud.planName || 'Sin nombre',
    originalName: sourceName || cloud.planName || 'Sin nombre',
    day: local.day,
  };
  $appRoot.hidden = true;
  $editor.hidden = false;
  renderEditor();
}

function editArchive(archiveId){
  const arc = (cloud.archives || []).find(a => a.id === archiveId);
  if(!arc || !arc.plan){ toast('Archivo no encontrado o vacío', 'error'); return; }
  openEditor(arc.plan, arc.name);
}

function isEditorDirty(){
  const e = local.editor;
  if(!e) return false;
  return JSON.stringify(e.draft) !== JSON.stringify(cloud.plan)
      || JSON.stringify(e.cats) !== JSON.stringify(cloud.categories || {})
      || (e.name || '') !== (e.originalName || '');
}

function closeEditor(){
  if(isEditorDirty() && !confirm('Hay cambios sin guardar. ¿Descartarlos?')) return;
  local.editor = null;
  $editor.hidden = true;
  $appRoot.hidden = false;
  render();
}

$edCancel.onclick = closeEditor;
$edSave.onclick = () => savePlan();

function renderEditor(){
  // Name input + day chips
  $edChips.innerHTML = '';
  const nameInput = document.createElement('input');
  nameInput.id = 'ed-name';
  nameInput.placeholder = 'Nombre del plan';
  nameInput.value = local.editor.name || '';
  nameInput.oninput = () => { local.editor.name = nameInput.value; markDirty(); };
  $edChips.appendChild(nameInput);
  const chipsRow = document.createElement('div');
  chipsRow.className = 'ed-chips-row';
  for(const d of DAYS_ORDER){
    const b = document.createElement('button');
    b.className = 'chip' + (d === local.editor.day ? ' active' : '');
    b.textContent = d;
    b.setAttribute('aria-label', DAY_NAMES[d]);
    b.onclick = () => { local.editor.day = d; renderEditor(); };
    chipsRow.appendChild(b);
  }
  $edChips.appendChild(chipsRow);

  // Save button dirty state
  $edSave.classList.toggle('dirty', isEditorDirty());

  const day = local.editor.day;
  const dayPlan = local.editor.draft[day] || { meals: [] };
  if(!dayPlan.meals) dayPlan.meals = [];
  let html = '';
  const totalMeals = dayPlan.meals.length;
  dayPlan.meals.forEach((meal, mi) => {
    const isFree = !!meal.free;
    html += `<section class="ed-meal" data-mi="${mi}">
      <div class="ed-meal-head">
        <input class="ed-meal-slot" data-field="slot" value="${escAttr(meal.slot||'')}" placeholder="Slot (Comida, Cena…)" />
        <input class="ed-meal-time" data-field="time" value="${escAttr(meal.time||'')}" placeholder="hh:mm" />
        <div class="ed-moves">
          <button class="ed-move up" data-action="move-meal-up" ${mi===0?'disabled':''} title="Subir">▴</button>
          <button class="ed-move down" data-action="move-meal-down" ${mi===totalMeals-1?'disabled':''} title="Bajar">▾</button>
        </div>
        <button class="ed-trash" data-action="del-meal" title="Eliminar comida">🗑</button>
      </div>
      ${isFree ? '' : `<input class="ed-meal-dish" data-field="dish" value="${escAttr(meal.dish||'')}" placeholder="Nombre del plato" />`}
      <div class="ed-free-row">
        <input type="checkbox" id="free-${mi}" data-action="toggle-free" ${isFree?'checked':''} />
        <label for="free-${mi}">Comida libre (sin ingredientes ni preparación)</label>
      </div>`;
    if(isFree){
      html += `<input class="ed-free-msg" data-field="free" value="${escAttr(typeof meal.free === 'string' ? meal.free : 'Comida libre')}" placeholder="Mensaje" />`;
    } else {
      // Items
      html += `<div class="ed-section-title">Ingredientes</div><ul class="ed-items">`;
      const items = meal.items || [];
      items.forEach((it, ii) => {
        const curId = slug(it.n || '');
        const curCat = curId ? (local.editor.cats[curId] || categoryFor(it.n||'')) : '';
        const catOpts = CATEGORIES.map(c => `<option value="${c}" ${c===curCat?'selected':''}>${c}</option>`).join('');
        html += `<li class="ed-item" data-ii="${ii}">
          <input class="ed-item-name" data-field="n" value="${escAttr(it.n||'')}" placeholder="Nombre del ingrediente" />
          <div class="ed-item-row">
            <span class="ed-q-lbl m">M</span>
            <input class="ed-q" type="number" inputmode="numeric" min="0" data-field="m" value="${it.m||0}" />
            <span class="ed-q-lbl c">C</span>
            <input class="ed-q" type="number" inputmode="numeric" min="0" data-field="c" value="${it.c||0}" />
            <select class="ed-unit" data-field="u">
              <option value="g" ${(!it.u||it.u==='g')?'selected':''}>g</option>
              <option value="ml" ${it.u==='ml'?'selected':''}>ml</option>
            </select>
            <div class="ed-moves">
              <button class="ed-move up" data-action="move-item-up" ${ii===0?'disabled':''} title="Subir">▴</button>
              <button class="ed-move down" data-action="move-item-down" ${ii===items.length-1?'disabled':''} title="Bajar">▾</button>
            </div>
            <button class="ed-trash" data-action="del-item">🗑</button>
          </div>
          <div class="ed-item-extras">
            <select class="ed-item-cat" ${curId?'':'disabled'} title="Categoría">${catOpts}</select>
            <input class="ed-item-note" data-field="note" value="${escAttr(it.note||'')}" placeholder="Nota (opcional)" />
          </div>
        </li>`;
      });
      html += `</ul>
        <button class="ed-add-btn" data-action="add-item">+ Ingrediente</button>`;

      // Prep
      html += `<div class="ed-section-title">Preparación</div><ul class="ed-prep">`;
      const prep = meal.prep || [];
      prep.forEach((s, si) => {
        html += `<li class="ed-prep-step" data-si="${si}">
          <select class="ed-step-who" data-field="who">
            <option value="ambos" ${s.who==='ambos'?'selected':''}>Ambos</option>
            <option value="maria" ${s.who==='maria'?'selected':''}>María</option>
            <option value="carlos" ${s.who==='carlos'?'selected':''}>Carlos</option>
          </select>
          <textarea class="ed-step-text" data-field="t" placeholder="Paso de la preparación">${escText(s.t||'')}</textarea>
          <div class="ed-moves">
            <button class="ed-move up" data-action="move-step-up" ${si===0?'disabled':''} title="Subir">▴</button>
            <button class="ed-move down" data-action="move-step-down" ${si===prep.length-1?'disabled':''} title="Bajar">▾</button>
          </div>
          <button class="ed-trash" data-action="del-step">🗑</button>
        </li>`;
      });
      html += `</ul>
        <button class="ed-add-btn" data-action="add-step">+ Paso de preparación</button>`;
    }
    html += `</section>`;
  });
  html += `<button class="ed-add-btn ed-add-meal" data-action="add-meal">+ Añadir comida en ${DAY_NAMES[day]}</button>`;

  // Categorías: solo las visibles en el plan actual (las usadas)
  const idsSeen = new Set();
  for(const dd of Object.values(local.editor.draft)){
    for(const m of (dd?.meals||[])){
      for(const it of (m.items||[])){
        if(it.n) idsSeen.add(slug(it.n));
      }
    }
  }
  if(idsSeen.size > 0){
    html += `<section class="ed-card ed-cat-section">
      <div class="ed-section-title">Categorías de ingredientes</div>
      <p class="ajustes-help" style="padding:0 0 8px">Resumen de cada ingrediente con su categoría. También puedes cambiarla en línea junto a cada ingrediente.</p>`;
    const sortedIds = [...idsSeen].sort((a, b) => {
      const an = nameForId(a, local.editor.draft);
      const bn = nameForId(b, local.editor.draft);
      return an.localeCompare(bn);
    });
    for(const id of sortedIds){
      const name = nameForId(id, local.editor.draft);
      const cur = local.editor.cats[id] || categoryFor(name);
      const opts = CATEGORIES.map(c => `<option value="${c}" ${c===cur?'selected':''}>${c}</option>`).join('');
      html += `<div class="ed-cat-row" data-id="${id}">
        <span class="ed-cat-name">${escText(name)}</span>
        <select data-action="set-cat">${opts}</select>
      </div>`;
    }
    html += `</section>`;
  }

  $edMain.innerHTML = html;
  wireEditorEvents();
}

function nameForId(id, plan){
  for(const dd of Object.values(plan)){
    for(const m of (dd?.meals||[])){
      for(const it of (m.items||[])){
        if(slug(it.n) === id) return it.n;
      }
    }
  }
  return id;
}

function escAttr(s){ return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function escText(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function moveAt(arr, i, dir){
  const j = i + dir;
  if(j < 0 || j >= arr.length) return false;
  const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  return true;
}

function wireEditorEvents(){
  const meals = local.editor.draft[local.editor.day].meals;
  // Inputs que mutan draft sin re-renderizar (para no perder el foco).
  $edMain.querySelectorAll('.ed-meal').forEach(sec => {
    const mi = +sec.dataset.mi;
    const meal = meals[mi];

    sec.querySelectorAll('.ed-meal-head input[data-field], .ed-meal-dish, .ed-free-msg').forEach(inp => {
      inp.oninput = () => { meal[inp.dataset.field] = inp.value; markDirty(); };
    });

    // Toggle free
    const toggleFree = sec.querySelector('[data-action="toggle-free"]');
    if(toggleFree){
      toggleFree.onchange = () => {
        if(toggleFree.checked){
          meal.free = meal.free || 'Comida libre';
          delete meal.items; delete meal.prep; delete meal.dish;
        } else {
          delete meal.free;
          meal.items = meal.items || [];
          meal.prep = meal.prep || [];
          meal.dish = meal.dish || '';
        }
        renderEditor();
      };
    }

    // Items
    sec.querySelectorAll('.ed-item').forEach(li => {
      const ii = +li.dataset.ii;
      const it = meal.items[ii];
      li.querySelectorAll('[data-field]').forEach(inp => {
        const field = inp.dataset.field;
        const handler = () => {
          let val = inp.value;
          if(field === 'm' || field === 'c'){
            val = parseFloat(val);
            if(!Number.isFinite(val)) val = 0;
          }
          it[field] = val;
          markDirty();
        };
        if(inp.tagName === 'SELECT') inp.onchange = handler;
        else inp.oninput = handler;
      });
      // Categoría inline: usa el nombre actual para derivar el id en el momento.
      const catSel = li.querySelector('.ed-item-cat');
      if(catSel){
        catSel.onchange = (e) => {
          const id = slug(it.n || '');
          if(!id) return;
          local.editor.cats[id] = e.target.value;
          markDirty();
        };
      }
      li.querySelector('[data-action="del-item"]').onclick = () => {
        meal.items.splice(ii, 1);
        renderEditor();
      };
    });

    // Prep
    sec.querySelectorAll('.ed-prep-step').forEach(li => {
      const si = +li.dataset.si;
      const s = meal.prep[si];
      li.querySelectorAll('[data-field]').forEach(inp => {
        const handler = () => { s[inp.dataset.field] = inp.value; markDirty(); };
        if(inp.tagName === 'SELECT') inp.onchange = handler;
        else inp.oninput = handler;
      });
      li.querySelector('[data-action="del-step"]').onclick = () => {
        meal.prep.splice(si, 1);
        renderEditor();
      };
    });

    sec.querySelector('[data-action="add-item"]')?.addEventListener('click', () => {
      (meal.items = meal.items || []).push({ n: '', m: 0, c: 0, u: 'g' });
      renderEditor();
    });
    sec.querySelector('[data-action="add-step"]')?.addEventListener('click', () => {
      (meal.prep = meal.prep || []).push({ who: 'ambos', t: '' });
      renderEditor();
    });
    sec.querySelector('[data-action="del-meal"]').onclick = () => {
      if(!confirm('¿Eliminar esta comida?')) return;
      meals.splice(mi, 1);
      renderEditor();
    };

    // Reordenar comida
    sec.querySelector('[data-action="move-meal-up"]')?.addEventListener('click', () => {
      if(moveAt(meals, mi, -1)){ markDirty(); renderEditor(); }
    });
    sec.querySelector('[data-action="move-meal-down"]')?.addEventListener('click', () => {
      if(moveAt(meals, mi, +1)){ markDirty(); renderEditor(); }
    });
    // Reordenar ingredientes
    sec.querySelectorAll('[data-action="move-item-up"]').forEach((b, ii) => {
      b.onclick = () => { if(moveAt(meal.items, ii, -1)){ markDirty(); renderEditor(); } };
    });
    sec.querySelectorAll('[data-action="move-item-down"]').forEach((b, ii) => {
      b.onclick = () => { if(moveAt(meal.items, ii, +1)){ markDirty(); renderEditor(); } };
    });
    // Reordenar pasos
    sec.querySelectorAll('[data-action="move-step-up"]').forEach((b, si) => {
      b.onclick = () => { if(moveAt(meal.prep, si, -1)){ markDirty(); renderEditor(); } };
    });
    sec.querySelectorAll('[data-action="move-step-down"]').forEach((b, si) => {
      b.onclick = () => { if(moveAt(meal.prep, si, +1)){ markDirty(); renderEditor(); } };
    });
  });

  // Add meal
  $edMain.querySelector('[data-action="add-meal"]')?.addEventListener('click', () => {
    const dayPlan = local.editor.draft[local.editor.day] = local.editor.draft[local.editor.day] || { meals: [] };
    dayPlan.meals.push({ slot: 'Comida', time: '', dish: '', items: [], prep: [] });
    renderEditor();
  });

  // Categorías
  $edMain.querySelectorAll('.ed-cat-row').forEach(row => {
    const id = row.dataset.id;
    row.querySelector('select').onchange = (e) => {
      local.editor.cats[id] = e.target.value;
      markDirty();
    };
  });
}

function markDirty(){
  $edSave.classList.add('dirty');
}

async function restoreArchive(archiveId){
  const arc = (cloud.archives || []).find(a => a.id === archiveId);
  if(!arc || !arc.plan){ toast('Archivo no encontrado o vacío', 'error'); return; }
  if(!confirm(`Activar "${arc.name}". El plan actual pasará al histórico y se reiniciará la semana (comidas hechas + planificación). ¿Continuar?`)) return;
  const newArchiveId = 'archive-' + new Date().toISOString().replace(/[:.]/g, '-');
  const newArchiveRef = doc(db, 'plans', newArchiveId);
  try{
    await runTransaction(db, async (tx) => {
      const cur = await tx.get(PLAN_DOC);
      const planData = cur.exists() ? cur.data() : null;
      if(planData){
        tx.set(newArchiveRef, {
          plan: planData.plan,
          name: planData.name || 'Sin nombre',
          archivedAt: serverTimestamp(),
          archivedBy: currentUid,
        });
      }
      tx.set(PLAN_DOC, {
        plan: arc.plan,
        name: arc.name,
        updatedAt: serverTimestamp(),
        updatedBy: currentUid,
      });
      tx.update(STATE_DOC, {
        cooked: {}, skipped: {}, frozen: {},
        cycleStartedAt: serverTimestamp(),
        updatedAt: serverTimestamp(), updatedBy: currentUid,
      });
    });
    autoCookDone = false;
  }catch(e){
    console.error('restoreArchive', e);
    toast('Error restaurando: ' + (e.code || e.message), 'error');
  }
}

async function deleteArchive(archiveId){
  const arc = (cloud.archives || []).find(a => a.id === archiveId);
  const dateStr = arc?.archivedAt?.toDate ? arc.archivedAt.toDate().toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' }) : archiveId;
  if(!confirm(`Eliminar definitivamente el archivo del ${dateStr}?`)) return;
  try{
    await deleteDoc(doc(db, 'plans', archiveId));
  }catch(e){
    console.error('deleteArchive', e);
    toast('Error borrando: ' + (e.code || e.message), 'error');
  }
}

async function savePlan(){
  if(!isEditorDirty()){ closeEditor(); return; }
  const draft = local.editor.draft;
  const cats = local.editor.cats;
  const draftId = 'archive-' + new Date().toISOString().replace(/[:.]/g, '-');
  const draftRef = doc(db, 'plans', draftId);
  try{
    await setDoc(draftRef, {
      plan: draft,
      name: (local.editor.name || '').trim() || 'Sin nombre',
      archivedAt: serverTimestamp(),
      archivedBy: currentUid,
    });
    // Las categorías son metadatos compartidos; se aplican al instante (no resetean ciclo).
    if(JSON.stringify(cats) !== JSON.stringify(cloud.categories || {})){
      await setDoc(CAT_DOC, {
        ingredients: cats,
        updatedAt: serverTimestamp(),
        updatedBy: currentUid,
      });
    }
    local.editor = null;
    $editor.hidden = true;
    $appRoot.hidden = false;
    render();
    toast('Borrador guardado. Ve a Ajustes → Planes para activarlo.', 'success', 5000);
  }catch(e){
    console.error('savePlan', e);
    toast('Error guardando el plan: ' + (e.code || e.message), 'error');
  }
}
