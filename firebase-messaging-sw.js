// Service worker dedicado a Firebase Cloud Messaging.
// Firebase Messaging lo carga automáticamente al llamar a getMessaging().
importScripts('https://www.gstatic.com/firebasejs/11.0.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/11.0.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyCgX1xk2T2Ty2Xu_pDHdq4SsIeEiPLRfgg",
  authDomain: "plan-mc.firebaseapp.com",
  projectId: "plan-mc",
  storageBucket: "plan-mc.firebasestorage.app",
  messagingSenderId: "747664642276",
  appId: "1:747664642276:web:760d8133e74923d84cdcf1"
});

// Inicializamos messaging para que Firebase reciba pushes en este SW. El navegador
// muestra la notificación automáticamente cuando el payload incluye `notification`.
// NO añadimos onBackgroundMessage: si lo hacemos, Chrome muestra la notificación dos veces
// (una automática + otra manual desde el handler).
firebase.messaging();

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      for (const c of clients) {
        if (c.url.includes(self.location.origin) && 'focus' in c) return c.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});
