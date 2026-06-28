// Notificación diaria: una vez al día, lista todas las comidas con ingredientes congelados
// que ocurran en las próximas WINDOW_HOURS horas (default 48).
//
// Dedup: una notificación por usuario y por día (clave `defrost-digest:YYYY-MM-DD`).
// La variable FORCE=true ignora el dedup (útil para pruebas manuales).

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
initializeApp({ credential: cert(sa) });
const db = getFirestore();
const fcm = getMessaging();

const DAYS_ORDER = ['L','M','X','J','V','S','D'];
const CODE_TO_JS = { D:0, L:1, M:2, X:3, J:4, V:5, S:6 };
const WEEKDAY_MAP = ['D','L','M','X','J','V','S'];
const DAY_NAMES = { L:'lunes', M:'martes', X:'miércoles', J:'jueves', V:'viernes', S:'sábado', D:'domingo' };
const WINDOW_HOURS = parseFloat(process.env.WINDOW_HOURS || '48');
const FORCE = (process.env.FORCE || '').toLowerCase() === 'true';

const stripAccents = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
function slug(s){
  return stripAccents(s).toLowerCase()
    .replace(/[()%/]/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Fecha aproximada del meal para un viewDay y un time "hh:mm".
// Trabajamos con el reloj del runner (UTC). Las diferencias en horas dentro de una ventana de 48 h
// no varían materialmente por offset de TZ.
function dateForMeal(dayCode, time, cycleStart, now){
  const targetWk = CODE_TO_JS[dayCode];
  if(targetWk == null) return null;
  const start = new Date(cycleStart);
  start.setHours(0, 0, 0, 0);
  const daysSinceStart = Math.floor((now - start) / 86400000);
  let base;
  if(daysSinceStart >= 7){
    base = new Date(now); base.setHours(0,0,0,0);
    const dow = base.getDay();
    const offsetToMonday = dow === 0 ? -6 : 1 - dow;
    base.setDate(base.getDate() + offsetToMonday);
  } else {
    base = start;
  }
  const baseWk = base.getDay();
  const offset = (targetWk - baseWk + 7) % 7;
  const date = new Date(base);
  date.setDate(date.getDate() + offset);
  const [hh, mm] = (time || '13:00').split(':').map(n => parseInt(n, 10) || 0);
  date.setHours(hh, mm, 0, 0);
  return date;
}

function relativeDayLabel(mealDate, now){
  const a = new Date(mealDate); a.setHours(0,0,0,0);
  const b = new Date(now); b.setHours(0,0,0,0);
  const days = Math.round((a - b) / 86400000);
  if(days <= 0) return 'hoy';
  if(days === 1) return 'mañana';
  if(days === 2) return 'pasado mañana';
  const wk = WEEKDAY_MAP[a.getDay()];
  return DAY_NAMES[wk] || '';
}

async function run(){
  const stateSnap = await db.doc('state/main').get();
  const planSnap = await db.doc('plan/current').get();
  if(!stateSnap.exists || !planSnap.exists){ console.log('Faltan state o plan'); return; }
  const state = stateSnap.data();
  const plan = planSnap.data().plan;
  const frozen = state.frozen || {};
  const cooked = state.cooked || {};
  const skipped = state.skipped || {};
  const dayMap = state.dayMap || {};
  const cycleStartedAt = state.cycleStartedAt?.toDate?.() || new Date();
  const now = new Date();

  const candidates = [];
  for(const viewDay of DAYS_ORDER){
    const src = dayMap[viewDay] || viewDay;
    const meals = plan[src]?.meals || [];
    for(const meal of meals){
      if(meal.free || !meal.items) continue;
      const mk = `${src}:${meal.slot}`;
      const fr = frozen[mk];
      if(!fr) continue;
      const ids = fr === true ? meal.items.map(it => slug(it.n)) : Object.keys(fr).filter(k => fr[k]);
      if(ids.length === 0) continue;
      const ck = cooked[mk];
      const cookedBoth = ck === true || (ck && ck.m && ck.c);
      if(cookedBoth) continue;
      const sk = skipped[mk];
      const skippedBoth = sk === true || (sk && sk.m && sk.c);
      if(skippedBoth) continue;
      const date = dateForMeal(viewDay, meal.time, cycleStartedAt, now);
      if(!date) continue;
      const hoursAhead = (date - now) / 3600000;
      if(hoursAhead < -1 || hoursAhead > WINDOW_HOURS) continue;
      const names = meal.items.filter(it => ids.includes(slug(it.n))).map(it => it.n);
      candidates.push({
        viewDay, srcDay: src, slot: meal.slot,
        date, hoursAhead,
        ingrNames: names,
        dish: meal.dish || '',
      });
    }
  }

  if(candidates.length === 0){
    console.log(`Sin comidas con ingredientes congelados en las próximas ${WINDOW_HOURS} h.`);
    return;
  }

  candidates.sort((a, b) => a.date - b.date);

  const lines = candidates.map(c => {
    const when = `${relativeDayLabel(c.date, now)} ${c.slot.toLowerCase()}`;
    return `${when}: ${c.ingrNames.join(', ')}`;
  });
  const body = lines.join(' · ');
  const total = candidates.length;
  const title = total === 1
    ? 'Saca a descongelar para 1 comida'
    : `Saca a descongelar para ${total} comidas`;

  // Clave de dedup por día (UTC). 1 notificación por día por usuario.
  const todayStr = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(now);
  const notifKey = `defrost-digest:${todayStr}`;

  const usersSnap = await db.collection('users').get();
  let sent = 0;
  for(const userDoc of usersSnap.docs){
    const u = userDoc.data();
    const tokens = Object.keys(u.fcmTokens || {});
    if(tokens.length === 0) continue;
    if(u.notificationsMuted) continue;
    const last = u.lastNotifications || {};
    if(!FORCE && last[notifKey]){
      console.log(`Usuario ${userDoc.id}: ya notificado hoy. Saltado.`);
      continue;
    }
    try{
      const resp = await fcm.sendEachForMulticast({
        tokens,
        notification: { title, body },
        data: { url: '/', tag: notifKey },
        webpush: {
          fcmOptions: { link: '/' },
          notification: { icon: '/icon-192.png' },
        },
      });
      const toRemove = [];
      resp.responses.forEach((r, i) => {
        if(!r.success){
          const code = r.error?.code || '';
          if(code.includes('registration-token-not-registered') || code.includes('invalid-argument')){
            toRemove.push(tokens[i]);
          }
        }
      });
      if(toRemove.length){
        const updates = {};
        for(const t of toRemove) updates[`fcmTokens.${t}`] = FieldValue.delete();
        await userDoc.ref.update(updates);
      }
      sent += resp.successCount;
      await userDoc.ref.set({
        lastNotifications: { [notifKey]: FieldValue.serverTimestamp() }
      }, { merge: true });
    }catch(e){
      console.error('FCM send error:', e?.message || e);
    }
  }
  console.log(`Push enviados: ${sent}. Candidatos: ${total}. Body: "${body}"`);
}

run().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
