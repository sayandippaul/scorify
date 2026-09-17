import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
import { getAuth } from "firebase/auth";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from "firebase/firestore";


const requiredFirebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
};

const missingFirebaseConfig = Object.entries(
  requiredFirebaseConfig
).filter(([, value]) => !value);

if (missingFirebaseConfig.length) {
  throw new Error(
    `Missing Firebase environment variables: ${missingFirebaseConfig
      .map(([key]) => key)
      .join(", ")}`
  );
}

const firebaseConfig = requiredFirebaseConfig;


// Initialize Firebase
const app = initializeApp(firebaseConfig);


// Firebase Authentication
export const auth = getAuth(app);


// Firestore Database
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager(),
  }),
});


// Analytics
export const analytics = getAnalytics(app);