export function createScrollLockManager() {
  const locks = new Set();

  function updateDocumentScrollLock() {
    if (typeof document === "undefined" || !document.body) {
      return;
    }
    if (locks.size > 0) {
      document.body.dataset.scrollLocked = "true";
    } else if (document.body.dataset.scrollLocked) {
      delete document.body.dataset.scrollLocked;
    }
  }

  function lockDocumentScroll(lockId) {
    if (!lockId) {
      return;
    }
    locks.add(lockId);
    updateDocumentScrollLock();
  }

  function unlockDocumentScroll(lockId) {
    if (!lockId) {
      return;
    }
    locks.delete(lockId);
    updateDocumentScrollLock();
  }

  return {
    lockDocumentScroll,
    unlockDocumentScroll,
  };
}
