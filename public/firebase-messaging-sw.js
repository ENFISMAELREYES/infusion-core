importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyBXz5TRpGHX7nbFjQYjGJi2l17YBpxtjFw",
  authDomain: "infusion-core.firebaseapp.com",
  projectId: "infusion-core",
  storageBucket: "infusion-core.firebasestorage.app",
  messagingSenderId: "372027565230",
  appId: "1:372027565230:web:9c2055e465b9ed7a02b93f"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(function(payload) {
  console.log('Mensaje en background:', payload);
  const { title, body } = payload.notification;
  self.registration.showNotification(title, {
    body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
  });
});
