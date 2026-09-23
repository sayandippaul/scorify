import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
} from "firebase/firestore";
import { auth, db } from "../firebase/firebase";
import { ADMIN_UID } from "../config/security";

const UNDO_COLLECTION = "adminUndo";
const UNDO_ITEM_COLLECTION = "items";
const UNDO_WINDOW_MS = 24 * 60 * 60 * 1000;

const adminRef = () => doc(db, UNDO_COLLECTION, String(ADMIN_UID));

const ensureAdmin = () => {
  if (
    !ADMIN_UID ||
    String(auth.currentUser?.uid || "") !== String(ADMIN_UID)
  ) {
    throw new Error("Only the admin can use undo delete.");
  }
};

const chunks = (items, size = 450) => {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
};

export const saveLastAdminDelete = async ({ type, documents }) => {
  ensureAdmin();
  const uniqueDocuments = documents.filter(
    (item) => item?.collection && item?.id && item?.data
  );
  const backupRef = adminRef();
  const previousItems = await getDocs(
    query(collection(backupRef, UNDO_ITEM_COLLECTION))
  );

  await Promise.all(previousItems.docs.map((item) => deleteDoc(item.ref)));
  await setDoc(backupRef, {
    type,
    createdAt: Date.now(),
    expiresAt: Date.now() + UNDO_WINDOW_MS,
    itemCount: uniqueDocuments.length,
  });

  await Promise.all(
    uniqueDocuments.map((item, index) =>
      setDoc(doc(backupRef, UNDO_ITEM_COLLECTION, `${index}`), {
        collection: item.collection,
        documentId: String(item.id),
        data: item.data,
      })
    )
  );
};

export const getLastAdminDelete = async () => {
  if (!ADMIN_UID) return null;
  const snapshot = await getDoc(adminRef());
  if (!snapshot.exists()) return null;
  const data = snapshot.data();
  if (Number(data.expiresAt || 0) <= Date.now()) {
    await clearLastAdminDelete();
    return null;
  }
  return data;
};

export const restoreLastAdminDelete = async () => {
  ensureAdmin();
  const backupSnapshot = await getDoc(adminRef());
  if (!backupSnapshot.exists()) return null;
  const backup = backupSnapshot.data();
  if (Number(backup.expiresAt || 0) <= Date.now()) {
    await clearLastAdminDelete();
    return null;
  }

  const itemSnapshot = await getDocs(
    query(collection(adminRef(), UNDO_ITEM_COLLECTION))
  );
  const items = itemSnapshot.docs.map((item) => item.data());

  for (const group of chunks(items)) {
    await Promise.all(
      group.map(async (item) => {
        try {
          await setDoc(
            doc(db, item.collection, item.documentId),
            item.data
          );
        } catch (error) {
          throw new Error(
            `Unable to restore ${item.collection}/${item.documentId}: ${
              error?.message || "permission denied"
            }`
          );
        }
      })
    );
  }

  await clearLastAdminDelete();
  return backup;
};

export const clearLastAdminDelete = async () => {
  if (!ADMIN_UID) return;
  const backupRef = adminRef();
  const items = await getDocs(
    query(collection(backupRef, UNDO_ITEM_COLLECTION))
  );
  await Promise.all(items.docs.map((item) => deleteDoc(item.ref)));
  await deleteDoc(backupRef);
};
