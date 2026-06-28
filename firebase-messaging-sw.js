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

const messaging = firebase.messaging();

messaging.onBackgroundMessage(({ notification, data }) => {
  const title = notification?.title || 'Plan María & Carlos';
  const body = notification?.body || '';
  self.registration.showNotification(title, {
    body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data?.tag || 'plan-mc-notification',
    data: data || {},
  });
});

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
