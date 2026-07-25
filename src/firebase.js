import { initializeApp, getApps } from "firebase/app";
import { getMessaging, getToken } from "firebase/messaging";
import { getStorage, ref, uploadString, getDownloadURL } from "firebase/storage";
import { FIREBASE_CONFIG, VAPID_KEY as VAPID_KEY_CFG, PROJECT_ID, DATABASE_ID } from "./config";

const firebaseConfig = FIREBASE_CONFIG;

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];

let messaging = null;
try {
  messaging = getMessaging(app);
} catch(e) {
  console.log("Messaging no soportado:", e);
}

export { messaging };
export const storage = getStorage(app);
export const VAPID_KEY = VAPID_KEY_CFG;

// Sube una firma (dataURL PNG del canvas) a Firebase Storage y devuelve su URL pública.
// role: "paciente" | "enfermeria" | "medico"
export async function uploadSignature(sessionId, role, dataUrl) {
  const path = `signatures/${sessionId}/${role}.png`;
  const storageRef = ref(storage, path);
  await uploadString(storageRef, dataUrl, "data_url");
  return await getDownloadURL(storageRef);
}

export async function requestNotificationPermission(userId, token) {
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return null;

    const registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
    await navigator.serviceWorker.ready;

    const fcmToken = await getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: registration });
    if (!fcmToken) return null;

    await fetch(
      `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents/fcmTokens/${userId}?updateMask.fieldPaths=token&updateMask.fieldPaths=updatedAt`,
      { method: "PATCH",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ fields: {
          token: { stringValue: fcmToken },
          updatedAt: { stringValue: new Date().toISOString() },
        }})
      }
    );
    console.log("FCM token guardado:", fcmToken);
    return fcmToken;
  } catch(e) {
    console.error("Error FCM completo:", e.code, e.message, e);
    return null;
  }
}
