export const RENDER_BACKEND_ORIGIN = 'https://claro-calls.onrender.com';
export const FIREBASE_AUTH_HOST = 'gen-lang-client-0374037632.firebaseapp.com';

export function isAndroidWebViewRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.ClaroAndroid !== undefined ||
    window.location.hostname === FIREBASE_AUTH_HOST
  );
}

export function resolveApiUrl(path: string): string {
  if (!path.startsWith('/')) return path;
  if (isAndroidWebViewRuntime()) {
    return `${RENDER_BACKEND_ORIGIN}${path}`;
  }
  return path;
}

export function resolveWsUrl(): string {
  if (typeof window === 'undefined') {
    return 'wss://claro-calls.onrender.com/ws';
  }
  if (isAndroidWebViewRuntime()) {
    return 'wss://claro-calls.onrender.com/ws';
  }
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}

export function resolveMediaUrl(url?: string): string {
  if (!url) return '';
  if (url.startsWith('/uploads/') && isAndroidWebViewRuntime()) {
    return `${RENDER_BACKEND_ORIGIN}${url}`;
  }
  return url;
}
