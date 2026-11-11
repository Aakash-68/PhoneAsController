// The optional Android app (PhoneAsController APK) wraps this page in its own WebView and exposes
// window.PCNative (see android/). In a normal browser everything here is a no-op.
//   PCNative.version()  setVolumeCapture(on)  vibrate(ms, amplitude 1..255)  rumble(amplitude 0..255)  disconnect()
// The app forwards volume keys by calling window.__pcNativeKey('up'|'down', down, repeat).
export const app = typeof window.PCNative === 'object' && window.PCNative ? window.PCNative : null;
export const inApp = !!app;
if (inApp) document.documentElement.classList.add('in-app');

export function nativeCall(fn, ...args) {
  if (!app) return undefined;
  try { return app[fn](...args); } catch { return undefined; }
}
