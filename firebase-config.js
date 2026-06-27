// Configuración pública de Firebase. Es pública por diseño:
// el control de acceso real está en firestore.rules.
//
// Cómo rellenar:
// 1) https://console.firebase.google.com → crea proyecto (plan Spark, sin tarjeta).
// 2) Añade una app Web → copia el objeto firebaseConfig aquí debajo.
// 3) Activa Firestore (modo producción) y Authentication → Google.
// 4) Authentication → Settings → Authorized domains: añade `<tu-usuario>.github.io` y `localhost`.
// 5) Inicia sesión una vez cada uno en la app y mira en consola el `uid` que se imprime;
//    pega los dos UID en ALLOWED_UIDS aquí y en firestore.rules, y vuelve a desplegar reglas.

export const firebaseConfig = {
  apiKey: "AIzaSyCgX1xk2T2Ty2Xu_pDHdq4SsIeEiPLRfgg",
  authDomain: "plan-mc.web.app",
  projectId: "plan-mc",
  storageBucket: "plan-mc.firebasestorage.app",
  messagingSenderId: "747664642276",
  appId: "1:747664642276:web:760d8133e74923d84cdcf1",
  measurementId: "G-B9BTTSH1E3"
};


export const ALLOWED_UIDS = [
  "SWNOoQ2jESbAYndKSrjn8IashRy1",
  "LebxC4ZYjdQJw81kTYamZcJLWIh1"
];
