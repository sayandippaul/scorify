import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";

import {
  doc,
  setDoc,
  getDoc,
  serverTimestamp,
} from "firebase/firestore";

import { auth, db } from "../firebase/firebase";
import { ADMIN_UID } from "../config/security";


// ===============================
// REGISTER PLAYER
// ===============================
export async function registerPlayer(player) {
  const {
    name,
    email,
    password,
    type,
    battingHand,
    battingPosition,
    bowlingHand,
    bowlingStyle,
  } = player;

  // Create Firebase Authentication account
  const userCredential =
    await createUserWithEmailAndPassword(
      auth,
      email.trim(),
      password
    );

  const user = userCredential.user;

  // Store player profile in Firestore
  await setDoc(doc(db, "players", user.uid), {
    name: name.trim(),
    email: email.trim().toLowerCase(),

    type,

    battingHand: battingHand || null,
    battingPosition: battingPosition || null,

    bowlingHand: bowlingHand || null,
    bowlingStyle: bowlingStyle || null,

    createdAt: serverTimestamp(),
  });

  return {
    id: user.uid,
    name: name.trim(),
    email: email.trim().toLowerCase(),

    type,

    battingHand: battingHand || null,
    battingPosition: battingPosition || null,

    bowlingHand: bowlingHand || null,
    bowlingStyle: bowlingStyle || null,
  };
}


// ===============================
// LOGIN PLAYER
// ===============================
export async function loginPlayer(email, password) {
  const userCredential =
    await signInWithEmailAndPassword(
      auth,
      email.trim().toLowerCase(),
      password
    );

  const user = userCredential.user;

  // =========================
  // ADMIN LOGIN
  // =========================

  if (user.uid === ADMIN_UID) {
    return {
      id: user.uid,
      uid: user.uid,
      name: "Admin",
      email: user.email,
      type: "admin",
      isAdmin: true,
    };
  }

  // =========================
  // NORMAL PLAYER LOGIN
  // =========================

  const playerRef = doc(db, "players", user.uid);
  const playerSnap = await getDoc(playerRef);

  if (!playerSnap.exists()) {
    throw new Error("Player profile not found.");
  }

  return {
    id: user.uid,
    uid: user.uid,
    ...playerSnap.data(),
    isAdmin: false,
  };
}

// ===============================
// LOGOUT PLAYER
// ===============================
export async function logoutPlayer() {
  await signOut(auth);
}