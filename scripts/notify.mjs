// Cron por hora: lee state/plan/users en Firestore, decide qué notificaciones disparar
// y las envía vía Firebase Cloud Messaging.
//
// Variables de entorno requeridas:
//   FIREBASE_SERVICE_ACCOUNT_JSON   contenido completo del JSON de service account
//
// Decide el aviso "saca a descongelar X para mañana <comida>" usando el campo state.frozen[mealKey]
// (objeto con ingredientes congelados por id). Se dispara cuando la hora del plato cae en una ventana
// de (DEFROST_HOURS - 1, DEFROST_HOURS] desde ahora. Configurable con env DEFROST_HOURS (default 24).

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
initializeApp({ credential: cert(sa) });
const db = getFirestore();
const fcm = getMessaging();

const DAYS_ORDER = ['L','M','X','J','V','S','D'];
const CODE_TO_JS = { D:0, L:1, M:2, X:3, J:4, V:5, S:6 };
const DAY_NAMES = { L:'lunes', M:'martes', X:'miércoles', J:'jueves', V:'viernes', S:'sábado', D:'domingo' };
const DEFROST_HOURS = parseInt(process.env.DEFROST_HOURS || '24', 10);
const TZ = process.env.TIMEZONE || 'Europe/Madrid';

const stripAccents = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
function slug(s){
  return stripAccents(s).toLowerCase()
    .replace(/[()%/]/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Devuelve la fecha JS para un weekday (L,M,...) dada una fecha de inicio de ciclo (objeto Date) y la hora "hh:mm".
// Asume ciclo de 7 días. Si la diferencia es ≥7 días, considera la semana actual (fecha más cercana).
function dateForMeal(dayCode, time, cycleStart, now){
  const targetWk = CODE_TO_JS[dayCode];
  if(targetWk == null) return null;
  // Calcular la fecha base del ciclo en zona Madrid (aproximamos con offset local del runner).
  // Para evitar fallos por TZ del runner, trabajamos con UTC y aplicamos el offset de Madrid.
  // Suficientemente simple: usar tiempo local del runner (UTC en Actions). Convertir a Madrid restando offset.
  // Atajo: el cron corre cada hora, y la diferencia se compara en ms, así que con UTC es ok.
  const start = new Date(cycleStart);
  start.setHours(0, 0, 0, 0);
  const daysSinceStart = Math.floor((now - start) / 86400000);
  // Si el ciclo lleva más de 7 días, asumimos esta semana (próximo evento futuro del día).
  let base;
  if(daysSinceStart >= 7){
    base = new Date(now); base.setHours(0,0,0,0);
    // ir al inicio de esta semana (lunes), aproximación: lunes más reciente
    const dow = base.getDay(); // 0=Sun
    const offsetToMonday = dow === 0 ? -6 : 1 - dow;
    base.setDate(base.getDate() + offsetToMonday);
  } else {
    base = start;
  }
  // Encontrar la fecha del weekday objetivo dentro de esta ventana
  const baseWk = base.getDay();
  const offset = (targetWk - baseWk + 7) % 7;
  const date = new Date(base);
  date.setDate(date.getDate() + offset);
  // Aplicar hora del plato
  const [hh, mm] = (time || '13:00').split(':').map(n => parseInt(n, 10) || 0);
  date.setHours(hh, mm, 0, 0);
  return date;
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

  // Para cada viewDay del plan, resolver el sourceDay vía dayMap, sus meals y mealKey por slot del source.
  const candidates = []; // { viewDay, srcDay, slot, dateMs, frozenIds, dish }
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
      // ¿Está ya cocinada por ambos? Saltar.
      const ck = cooked[mk];
      const cookedBoth = ck === true || (ck && ck.m && ck.c);
      if(cookedBoth) continue;
      const sk = skipped[mk];
      const skippedBoth = sk === true || (sk && sk.m && sk.c);
      if(skippedBoth) continue;
      const date = dateForMeal(viewDay, meal.time, cycleStartedAt, now);
      if(!date) continue;
      const hoursAhead = (date - now) / 3600000;
      // Ventana: notificar cuando faltan entre (DEFROST_HOURS - 1) y DEFROST_HOURS horas.
      if(hoursAhead > DEFROST_HOURS || hoursAhead <= DEFROST_HOURS - 1) continue;
      candidates.push({
        mealKey: mk,
        viewDay, srcDay: src, slot: meal.slot,
        date, frozenIds: ids,
        ingrNames: meal.items.filter(it => ids.includes(slug(it.n))).map(it => it.n),
        dish: meal.dish || '',
      });
    }
  }

  if(candidates.length === 0){ console.log('Sin candidatos en la ventana.'); return; }

  // Cargar usuarios y sus tokens
  const usersSnap = await db.collection('users').get();
  let sent = 0;
  for(const userDoc of usersSnap.docs){
    const u = userDoc.data();
    const tokens = Object.keys(u.fcmTokens || {});
    if(tokens.length === 0) continue;
    if(u.notificationsMuted) continue;
    const last = u.lastNotifications || {};
    for(const c of candidates){
      const notifKey = `defrost:${c.date.toISOString().slice(0,10)}:${c.mealKey}`;
      if(last[notifKey]) continue;
      const list = c.ingrNames.join(', ');
      const title = `Descongela para ${DAY_NAMES[c.viewDay]} (${c.slot})`;
      const body = c.dish ? `${c.dish}: ${list}` : list;
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
        // Limpiar tokens muertos
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
        // Marcar enviado
        await userDoc.ref.set({
          lastNotifications: { [notifKey]: FieldValue.serverTimestamp() }
        }, { merge: true });
      }catch(e){
        console.error('FCM send error:', e?.message || e);
      }
    }
  }
  console.log(`Push enviados: ${sent}. Candidatos: ${candidates.length}.`);
}

run().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
