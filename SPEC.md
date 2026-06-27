# SPEC.md — Despensa, comidas y lista de la compra (bucle cerrado)

> **Cómo usar este brief:** pega este fichero en la raíz del repo como `SPEC.md`.
> Primer prompt en Claude Code: *"Implementa SPEC.md sobre el index.html actual."*

---

## 1. Contexto

App existente: una PWA estática (sin build) servida en GitHub Pages, en un único `index.html`
con la vista del plan semanal de comidas. El objeto `DATA` del `index.html` contiene los 7 días
(`L,M,X,J,V,S,D`), cada uno con sus comidas y, por ingrediente, la cantidad de María (`m`) y de
Carlos (`c`) en g/ml. Hay un service worker (`sw.js`) y un `manifest.webmanifest`.

Lo que añadimos: convertir la app en un **bucle cerrado** despensa → comidas → lista de la compra,
con **persistencia compartida solo entre dos personas** vía **Firebase (Firestore + Auth con Google)**.

Mantener el enfoque **sin bundler**: Firebase con el **SDK modular por CDN**. No introducir build salvo
que sea imprescindible.

---

## 2. Decisiones ya tomadas (defaults) — confirmar o cambiar

Implementar con estos valores por defecto salvo indicación contraria:

1. **Horizonte de la lista de la compra:** toda la **semana pendiente**. La demanda son los ingredientes
   de todas las comidas del plan que **no** estén marcadas como hechas en el ciclo actual.
   *(Alternativa no elegida: solo los próximos N días.)*
2. **Reinicio del ciclo semanal:** **manual**, con un botón "Empezar nueva semana" que limpia las marcas de
   "comida hecha" (la despensa se conserva). *(Alternativa no elegida: reinicio automático un día fijo.)*
3. **Marcar en el súper:** tocar un ítem de la lista **suma su cantidad directamente a la despensa**
   (y desaparece de la lista). La despensa es editable a mano para corregir. *(Alternativa no elegida:
   carrito provisional que se confirma al final de la compra.)*
4. **Genéricos "a elegir"** (verdura a elegir, proteína no grasa, carbohidrato a elegir, fruta libre):
   se tratan como un ingrediente normal más en despensa y lista.
5. **Granularidad:** despensa y lista son **a nivel de hogar** (totales `m+c`, una sola nevera). El reparto
   por persona se mantiene **solo en la vista de cocina** que ya existe.

---

## 3. Modelo conceptual (el bucle)

Todo en g/ml, agregado por `ingredientId`.

- `demanda[id]` = suma de `(m+c)` de ese ingrediente sobre las comidas **pendientes** (no hechas).
- **Lista de la compra:** `aComprar[id] = max(0, demanda[id] − despensa[id])`. Se muestran solo los `> 0`.
- **Marcar comida como hecha:** la comida sale de "pendiente" (baja la demanda) **y** se descuentan sus
  ingredientes de la despensa: `despensa[id] = max(0, despensa[id] − (m+c))`.
- **Comprar (marcar en el súper):** `despensa[id] += aComprar[id]` (cantidad necesaria de ese ítem).
- **Nueva semana:** se limpian las marcas de "hecho" → la demanda vuelve a ser el plan completo. La
  despensa se conserva (sobrantes y básicos).

Esta definición es consistente: cocinar baja la demanda y la despensa en la misma cantidad, así que no
reaparece en la lista lo que ya compraste y consumiste.

---

## 4. Modelo de datos

### 4.1 Catálogo de ingredientes (derivar una vez)

Generar a partir del `DATA` un catálogo con un id estable por ingrediente:

```js
// catalog[id] = { nombre, unidad: 'g'|'ml', categoria }
// id = slug(nombre)  → p. ej. "Salmón" -> "salmon", "Atún claro al natural (Dia)" -> "atun-dia"
// Los SKU distintos (atún Dia vs Carrefour) quedan con id distinto de forma natural.
```

Añadir a cada ingrediente del `DATA` su `id` (slug del nombre) para poder agregar por él.

**Categorías canónicas** (las de la lista de la compra; mapear cada ingrediente a una):
Carbohidratos y pan · Cacao y chocolate · Embutidos · Lácteos · Pescado y huevo ·
Grasas, frutos secos y semillas · Carne magra, pescado blanco y conservas · Fruta ·
Bebidas vegetales · Salsas y especias · Suplementos · Verduras.

### 4.2 Documento de estado en Firestore

Un único documento compartido: **`state/main`**.

```js
{
  pantry:        { [ingredientId]: number },  // g/ml en casa
  cooked:        { [mealKey]: true },         // comidas hechas en el ciclo actual
  cycleStartedAt: Timestamp,                  // inicio de la semana actual
  updatedAt:     Timestamp,
  updatedBy:     string                       // uid de quien escribió
}
```

- `mealKey = `${day}:${slot}`` → p. ej. `"L:Cena"` (estable frente a reordenar el array de comidas).
- La demanda y la lista se **calculan en cliente** desde `DATA` + `cooked` + `pantry`; no se guardan.
- Las marcas de **mise en place** de la vista de cocina siguen siendo **locales** (`localStorage`,
  como ahora): son transitorias y de un solo cocinero, no necesitan compartirse. (Opcional moverlas a
  Firestore más adelante; no en v1.)

---

## 5. Autenticación y control de acceso

- **Firebase Auth, proveedor Google.** Si no hay sesión → pantalla "Entrar con Google".
- En **móvil usar `signInWithRedirect`** (los popups fallan en muchos navegadores de móvil),
  con fallback a `signInWithPopup` en escritorio si se quiere.
- Tras iniciar sesión, comprobar que el `uid` está en la lista permitida (Carlos y María).
  Si no, mostrar "no autorizado" y `signOut()`.
- **Dominios autorizados:** añadir el dominio de GitHub Pages (`<usuario>.github.io`) y `localhost`
  en Firebase → Authentication → Settings → Authorized domains. Sin esto, el login de Google falla.

### 5.1 Reglas de seguridad de Firestore

El control de acceso real lo dan estas reglas (no esconder la config del cliente, que es pública por diseño):

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /state/main {
      allow read, write: if request.auth != null
        && request.auth.uid in ['UID_CARLOS', 'UID_MARIA'];
    }
    match /{document=**} { allow read, write: if false; }
  }
}
```

- **Cómo obtener los UID:** iniciar sesión una vez cada uno y leer `auth.currentUser.uid`
  (loguearlo en consola), pegarlos en las reglas y desplegar.
- Desplegar reglas: consola de Firebase o `firebase deploy --only firestore:rules`.

---

## 6. Pantallas

Añadir **navegación inferior** con tres pestañas. La vista actual del plan pasa a ser la primera pestaña.

### 6.1 Comidas (vista actual + "hecho")
- Reutilizar la vista de días/comidas existente (selector de día, conjunta/María/Carlos, preparación,
  mise en place local).
- Añadir en cada tarjeta de comida un botón **"Marcar como hecha"**. Al pulsarlo: marca `cooked[mealKey]`
  y **descuenta** los ingredientes de la despensa (ver §3). Las comidas hechas se muestran atenuadas/✓
  y con opción de **deshacer** (revierte la marca y vuelve a sumar a la despensa).

### 6.2 Lista de la compra
- Lista **calculada** = `max(0, demanda − despensa)` por ingrediente, **agrupada por categoría**,
  mostrando solo lo que falta (`> 0`) con su cantidad.
- Modo súper: ítems grandes y fáciles de tocar. Al tocar un ítem → suma su cantidad a la despensa
  (desaparece de la lista). Mostrar progreso (p. ej. "12/20 cogidos").
- Botón **"Empezar nueva semana"** accesible desde aquí o desde ajustes (ver §2.2).

### 6.3 Despensa
- Lista de ingredientes con la cantidad actual en casa, **agrupada por categoría**.
- Editar cantidad por ítem (ajuste +/− y "fijar"), añadir un ítem, poner a cero. Es la vista de la verdad
  de "qué tenemos" y la que corrige cualquier desajuste del bucle.

---

## 7. Sincronización, offline y concurrencia

- **Listener en tiempo real** sobre `state/main` (`onSnapshot`) para que los dos móviles se vean al instante
  (p. ej. tachar en el súper).
- **Persistencia offline** del SDK de Firestore activada, para funcionar sin cobertura en súper/cocina y
  sincronizar al recuperar señal.
- **Escrituras seguras frente a edición simultánea** (no sobrescribir el documento entero):
  - Comprar / sumar a despensa: `updateDoc` con `increment(+cantidad)` sobre `pantry.<id>`.
  - Marcar comida hecha y nueva semana: **transacción** (`runTransaction`) que lee, calcula despensa con
    clamp `≥ 0` y escribe `cooked` + `pantry` de forma atómica.
  - Siempre fijar `updatedAt = serverTimestamp()` y `updatedBy = uid`.

---

## 8. Configuración de Firebase (checklist)

1. Crear proyecto en console.firebase.google.com (plan **Spark**, sin tarjeta).
2. Añadir **app Web** y copiar el `firebaseConfig`.
3. Activar **Firestore Database** (modo producción).
4. Activar **Authentication → Sign-in method → Google**.
5. Añadir dominios autorizados: `<usuario>.github.io` y `localhost` (§5).
6. Desplegar las reglas de seguridad (§5.1).
7. Iniciar sesión una vez cada uno, copiar los dos UID a las reglas y volver a desplegar.

SDK por CDN (versión actual, p. ej. v11), import de ejemplo:

```js
import { initializeApp } from 'https://www.gstatic.com/firebasejs/<ver>/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithRedirect, getRedirectResult, onAuthStateChanged, signOut }
  from 'https://www.gstatic.com/firebasejs/<ver>/firebase-auth.js';
import { getFirestore, doc, onSnapshot, runTransaction, updateDoc, increment, serverTimestamp }
  from 'https://www.gstatic.com/firebasejs/<ver>/firebase-firestore.js';
```

La `firebaseConfig` va en su propio fichero (p. ej. `firebase-config.js`); es pública por diseño.

---

## 9. Orden de construcción sugerido

1. Puerta de autenticación (Google + restricción a los dos UID) envolviendo la app.
2. Catálogo de ingredientes (ids + categorías) y `id` en el `DATA`.
3. Conexión a Firestore: listener de `state/main`, persistencia offline.
4. Pestaña Despensa (lectura/edición de `pantry`).
5. Botón "hecha"/deshacer en comidas → marca `cooked` + descuenta despensa (transacción).
6. Pestaña Lista calculada (demanda − despensa) agrupada por categoría.
7. Tocar en el súper → `increment` a despensa.
8. Botón "Empezar nueva semana" (transacción que limpia `cooked`).
9. Pulido: navegación inferior, estados de carga/offline, subir la versión del service worker (`v3`) para
   invalidar caché al desplegar.

---

## 10. Criterios de aceptación (definición de "hecho")

- Solo los dos UID autorizados pueden leer/escribir; un tercer Google distinto recibe "no autorizado".
  Verificado además porque las reglas deniegan a cualquier otro uid.
- Con despensa vacía y nada cocinado, la lista muestra el plan completo (totales `m+c`).
- Comprar un ítem en la lista lo hace desaparecer y aparece en la despensa con esa cantidad.
- Marcar una comida como hecha descuenta sus ingredientes de la despensa y recalcula la lista; "deshacer"
  lo revierte.
- "Empezar nueva semana" limpia las comidas hechas y conserva la despensa.
- Cambios hechos en un móvil aparecen en el otro en segundos; funciona sin conexión y sincroniza al volver.
- Sigue siendo instalable como PWA y la vista de cocina por persona no se rompe.

---

## 11. Notas de implementación

- Mantener el estilo vanilla del `index.html` actual; estructura sugerida: `index.html`, `app.js` (UI/lógica),
  `data.js` (el `DATA` del plan), `firebase-config.js`, `firestore.rules`. Reorganizar si conviene, sin bundler.
- No romper lo ya existente (días, vistas por persona, mise en place local, manifest, iconos).
- Probar en `localhost` contra el proyecto Firebase real (o con los emuladores de Firebase) antes de subir.
- Tras desplegar, subir la versión del service worker para que la caché no sirva la versión antigua.

---

# Anexo A — Fase 2: Notificaciones (recordatorios de descongelar y de compra)

> Este anexo **no se implementa en la fase 1**. Se documenta ahora para no contaminar el modelo de
> la v1 con decisiones prematuras, y para tener claro el camino cuando se aborde.

## A.1 Objetivos

1. **Recordar descongelar**: si un ingrediente está marcado como *congelado* y forma parte de una
   comida pendiente de mañana, enviar push **N horas antes** (por defecto 24 h) con el texto
   "Saca a descongelar X para la cena de mañana".
2. **Recordar compra**: si la lista de la compra calculada para los próximos `K` días (por defecto 2)
   tiene ítems con `aComprar > 0`, enviar push **una vez al día** (a una hora configurable) con
   "Te falta comprar X, Y, Z".

Notificaciones **silenciadas si la app está abierta en primer plano** (las acciones se ven en la UI).

## A.2 Restricciones de plataforma

- **iOS**: web push **solo funciona con la PWA instalada en la pantalla de inicio** (iOS 16.4+).
  Es nuestro caso de uso real, así que es viable. Sin instalar, no llega nada.
- **Android/Chrome**: push estándar vía FCM, sin restricciones.
- **El móvil no puede programar push por sí solo de forma fiable** (los timers del SW no sobreviven
  al cierre). El disparo lo decide un proceso en la nube.

## A.3 Cambios en el modelo de datos

### A.3.1 Concepto de "congelado"

Añadir a `state/main`:

```js
frozen: { [ingredientId]: number }  // g/ml de ese ingrediente que están en el congelador
```

Invariante: `frozen[id] <= pantry[id]` (lo congelado es un subconjunto de la despensa).

**Cómo se marca como congelado**:
- Al **comprar** un ítem (tocar en el súper): preguntar/togglear "¿al congelador?" → si sí,
  `pantry[id] += cant` **y** `frozen[id] += cant`.
- En la **pestaña Despensa**: cada ítem tiene un control para mover cantidad pantry ↔ frozen
  ("mover N g al congelador" / "sacar N g del congelador").
- Al **marcar comida como hecha**: si esa comida consume un ingrediente que está (parcial o
  totalmente) congelado, descontar primero de `frozen` y luego de `pantry` (transacción).

### A.3.2 Tokens FCM por usuario

Documento nuevo `users/{uid}`:

```js
{
  fcmTokens:   { [token]: { ua: string, createdAt: Timestamp, lastSeenAt: Timestamp } },
  prefs: {
    defrostHoursAhead: 24,        // antelación del aviso de descongelar
    shopDaysAhead:     2,         // ventana de días para el aviso de compra
    dailyDigestHour:   19,        // hora local del resumen diario (0-23)
    timezone:          "Europe/Madrid",
    muted:             false
  },
  lastNotifications: {
    [notificationKey]: Timestamp  // para deduplicar (ver A.5)
  }
}
```

Reglas: cada uno lee/escribe **solo su propio `users/{uid}`**.

### A.3.3 Reglas de Firestore (delta)

```
match /users/{uid} {
  allow read, write: if request.auth != null && request.auth.uid == uid
    && uid in ['UID_CARLOS', 'UID_MARIA'];
}
```

El cron (ver A.4) usa una cuenta de servicio con privilegios admin → bypasea las reglas, así que
no hace falta exponerle nada al cliente.

## A.4 Arquitectura del disparador

**Elegido: GitHub Actions cron + FCM HTTP v1**. Razones: 0 €, sin tarjeta, sin salir del plan
Spark de Firebase, ya desplegamos en GitHub.

### A.4.1 Workflow

`.github/workflows/notify.yml`:

- `schedule: cron: "0 * * * *"` (cada hora en punto, UTC).
- Job único en `ubuntu-latest`:
  1. Lee secreto `FIREBASE_SERVICE_ACCOUNT_JSON` (cuenta de servicio del proyecto).
  2. Ejecuta un script Node (`scripts/notify.mjs`) con `firebase-admin`.
  3. El script decide qué notificaciones disparar y llama a FCM.

### A.4.2 Lógica del script

Pseudocódigo:

```
state = firestore.doc('state/main').get()
users = firestore.collection('users').get()
now   = Date.now()

for each user in users:
  if user.prefs.muted: continue
  tz = user.prefs.timezone

  // 1) Aviso de descongelar
  for each mealKey en plan de "mañana" (en tz del usuario) que NO esté en state.cooked:
    ingredientes = ingredientes(mealKey) ∩ { id : state.frozen[id] > 0 }
    if ingredientes no vacío:
      fireAt = inicio_de_mañana(tz) - user.prefs.defrostHoursAhead horas
      if now ∈ [fireAt, fireAt + 1h) y no enviado ya:
        push(user, "Saca a descongelar: <lista>", key=`defrost:${fecha}:${mealKey}`)

  // 2) Resumen de compra
  if hora_local(now, tz) == user.prefs.dailyDigestHour:
    demanda = sum(ingredientes de comidas pendientes en próximos shopDaysAhead días)
    falta   = { id: max(0, demanda[id] - state.pantry[id]) }
    falta   = filter(falta, v > 0)
    if falta no vacío y no enviado hoy:
      push(user, "Te falta comprar: <top 5 por categoría>", key=`shop:${fecha}`)
```

Tras enviar, actualizar `users/{uid}.lastNotifications[key] = serverTimestamp()`.

### A.4.3 FCM

- Activar **Cloud Messaging** en la consola de Firebase, generar **VAPID key**.
- En el cliente: `getToken(messaging, { vapidKey, serviceWorkerRegistration })` al iniciar sesión.
  Guardar token en `users/{uid}.fcmTokens`. Renovar `lastSeenAt` cada arranque.
- Service worker: añadir handler `onBackgroundMessage` para mostrar la notificación con título,
  cuerpo, ícono y `click_action` que abra la pestaña relevante (Lista / Comidas).
- Limpiar tokens muertos: si FCM responde `UNREGISTERED` o `INVALID_ARGUMENT`, borrar el token
  del documento del usuario.

## A.5 Deduplicación y ventanas

- Cada notificación tiene una `key` determinista (`defrost:2026-06-28:M:Cena`, `shop:2026-06-28`).
- Antes de enviar, comprobar `users/{uid}.lastNotifications[key]`. Si existe → no reenviar.
- El cron corre cada hora; las ventanas (1 h para descongelar, "esta hora == dailyDigestHour" para
  compra) absorben el desfase sin duplicar.

## A.6 UI (deltas sobre fase 1)

- **Onboarding de notificaciones**: tras login, si `Notification.permission === 'default'`,
  banner discreto "Activar avisos de descongelar y compra". Al aceptar → `requestPermission()` +
  `getToken()` + guardar token.
- **Pantalla de ajustes** nueva (cuarta pestaña o accesible desde Despensa):
  - Toggle "Notificaciones".
  - Sliders/inputs: antelación descongelar (12/24/36 h), ventana compra (1/2/3 días), hora del
    resumen diario.
  - Botón "Enviar prueba" (dispara una notificación local vía el SW para verificar permisos).
- **Despensa**: añadir a cada ítem un indicador y control de "congelado: N g". En la lista
  agrupada por categoría, los ítems con `frozen[id] > 0` muestran un copo de nieve.
- **Comidas**: en la tarjeta, si la receta tiene ingredientes congelados, mostrar aviso
  "Recuerda descongelar".

## A.7 Checklist de configuración (fase 2)

1. Activar Cloud Messaging en el proyecto Firebase, generar VAPID key.
2. Crear cuenta de servicio en GCP (rol "Firebase Admin SDK Administrator Service Agent") y
   descargar JSON.
3. Pegar el JSON en GitHub → Settings → Secrets → `FIREBASE_SERVICE_ACCOUNT_JSON`.
4. Añadir `scripts/notify.mjs` y `.github/workflows/notify.yml`.
5. Extender `firestore.rules` con `match /users/{uid}` (A.3.3) y desplegar.
6. Subir versión del SW (`v4`) con el handler de push.
7. Probar end-to-end: instalar PWA en iOS, dar permiso, forzar un escenario con `frozen` y comida
   mañana, ejecutar el workflow manualmente (`workflow_dispatch`), verificar push.

## A.8 Criterios de aceptación (fase 2)

- Con un ingrediente en `frozen` y una comida pendiente mañana que lo use, llega push
  ~24 h antes (configurable). No se duplica si el cron corre varias veces.
- A la hora del resumen diario, si faltan ingredientes para los próximos 2 días, llega un push
  único con la lista resumida.
- Marcar una comida como hecha con ingredientes congelados descuenta primero de `frozen`,
  luego de `pantry`, manteniendo `frozen <= pantry`.
- Cada usuario solo recibe sus propios avisos y solo ve/edita sus propias preferencias.
- Si se revoca el permiso o se desinstala la PWA, el token se limpia tras el primer fallo de FCM.
- La fase 1 sigue funcionando intacta para usuarios que no acepten notificaciones.
