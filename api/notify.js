export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const { patientName, center, nurseName } = req.body;

  try {
    const PROJECT_ID = "infusion-core";
    const JEFE_UID = "xGme3zlkjbOaYXkRUd6XSzScOB43";

    // Obtener access token usando la cuenta de servicio
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    
    const { GoogleAuth } = await import("google-auth-library");
    const auth = new GoogleAuth({
      credentials: serviceAccount,
      scopes: ["https://www.googleapis.com/auth/firebase.messaging"],
    });
    const accessToken = await auth.getAccessToken();

    // Obtener token FCM del jefe desde Firestore
    const tokenRes = await fetch(
      `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/default/documents/fcmTokens/${JEFE_UID}`,
      { headers: { "Authorization": `Bearer ${accessToken}` } }
    );
    const tokenDoc = await tokenRes.json();
    const fcmToken = tokenDoc.fields?.token?.stringValue;

    if (!fcmToken) return res.status(200).json({ ok: false, reason: "No FCM token" });

    // Enviar notificación
    const notifRes = await fetch(
      `https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`,
      { method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${accessToken}` },
        body: JSON.stringify({
          message: {
            token: fcmToken,
            notification: {
              title: `⏳ Nueva orden — ${center}`,
              body: `${patientName} · ${nurseName}`,
            },
            webpush: {
              notification: {
                icon: "/icon-192.png",
              }
            }
          }
        })
      }
    );

    const result = await notifRes.json();
    return res.status(200).json({ ok: true, result });
  } catch(e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
