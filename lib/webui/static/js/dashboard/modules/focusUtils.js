export function focusElementSilently(element) {
  if (!element || typeof element.focus !== "function") {
    return false;
  }
  try {
    element.focus({ preventScroll: true });
    return true;
  } catch (error) {
    try {
      element.focus();
      return true;
    } catch (error2) {
      return false;
    }
  }
}
