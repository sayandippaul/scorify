import { useEffect, useState } from "react";
import {
  getLastAdminDelete,
  restoreLastAdminDelete,
} from "../services/adminUndoService";
import { ADMIN_UID } from "../config/security";
import { auth } from "../firebase/firebase";
import "./adminUndoDelete.css";

const formatRemaining = (expiresAt) => {
  const minutes = Math.max(0, Math.ceil((expiresAt - Date.now()) / 60000));
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return hours
    ? `${hours}h ${remainingMinutes}m remaining`
    : `${remainingMinutes}m remaining`;
};

export default function AdminUndoDelete() {
  const isAdmin =
    Boolean(ADMIN_UID) &&
    String(auth.currentUser?.uid || "") === String(ADMIN_UID);
  const [backup, setBackup] = useState(null);
  const [restoring, setRestoring] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!isAdmin) return undefined;
    let active = true;
    const load = () =>
      getLastAdminDelete()
        .then((value) => active && setBackup(value))
        .catch((error) => console.error("Unable to load admin undo:", error));
    load();
    const timer = window.setInterval(load, 30000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [isAdmin]);

  if (!isAdmin || !backup || dismissed) return null;

  const restore = async () => {
    if (restoring) return;
    setRestoring(true);
    try {
      await restoreLastAdminDelete();
      window.location.reload();
    } catch (error) {
      console.error("Unable to undo admin delete:", error);
      alert(error?.message || "Unable to undo the last delete.");
      setRestoring(false);
    }
  };

  return (
    <div className="admin-undo-delete" role="status">
      <span>
        🗑️ Last {backup.type || "item"} delete can be undone
        <small>{formatRemaining(Number(backup.expiresAt))}</small>
      </span>
      <div className="admin-undo-actions">
        <button
          className="admin-undo-restore"
          type="button"
          onClick={restore}
          disabled={restoring}
        >
          {restoring ? "Restoring..." : "Undo Delete"}
        </button>
        <button
          className="admin-undo-close"
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Hide undo delete notice"
          title="Hide"
        >
          ×
        </button>
      </div>
    </div>
  );
}
