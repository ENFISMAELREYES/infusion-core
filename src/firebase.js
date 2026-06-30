import { initializeApp, getApps } from "firebase/app";
import { getMessaging, getToken } from "firebase/messaging";

const firebaseConfig = {
  apiKey: "AIzaSyBXz5TRpGHX7nbFjQYjGJi2l17YBpxtjFw",
  authDomain: "infusion-core.firebaseapp.com",
  projectId: "infusion-core",
  storageBucket: "infusion-core.firebasestorage.app",
  messagingSenderId: "372027565230",
  appId: "1:372027565230:web:9c2055e465b9ed7a02b93f"
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];

let messaging = null;
try {
  messaging = getMessaging(app);
} catch(e) {
  console.log("Messaging no soportado:", e);
}

export { messaging };

export const VAPID_KEY = "BMLOo1m7MOcerY21MKP-LfhHiQ5BEsVXNJog9Gv_EIklKdC6evUdC7kZQcufIcjPm44R5Bbhx2tJcucSdPNqyqA";

export async function requestNotificationPermission(userId, token) {
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return null;

    const registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
    await navigator.serviceWorker.ready;

    const fcmToken = await getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: registration });
    if (!fcmToken) return null;

    await fetch(
      `https://firestore.googleapis.com/v1/projects/infusion-core/databases/default/documents/fcmTokens/${userId}?updateMask.fieldPaths=token&updateMask.fieldPaths=updatedAt`,
      { method: "PATCH",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ fields: {
          token: { stringValue: fcmToken },
          updatedAt: { stringValue: new Date().toISOString() },
        }})
      }
    );
    const result = await res.json();
    console.log("FCM token guardado:", result);
    return fcmToken;
  } catch(e) {
    console.error("Error FCM completo:", e.code, e.message, e);
    return null;
  }
}
