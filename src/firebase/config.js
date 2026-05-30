import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyBXz5TRpGHX7nbFjQYjGJi2l17YBpxtjFw",
  authDomain: "infusion-core.firebaseapp.com",
  projectId: "infusion-core",
  storageBucket: "infusion-core.firebasestorage.app",
  messagingSenderId: "372027565230",
  appId: "1:372027565230:web:9c2055e465b9ed7a02b93f"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
