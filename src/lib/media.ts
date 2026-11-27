import { auth } from '../firebase';

export interface UploadedMediaResult {
  url: string;
  name: string;
  size: number;
  mime: string;
}

export function isSafeMediaUrl(url?: string): boolean {
  if (!url) return false;
  if (url.startsWith('/uploads/') || url.startsWith('/src/assets/')) return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

export async function compressImageFile(
  file: File,
  lowDataMode: boolean
): Promise<{ blob: Blob; mime: string; name: string }> {
  const maxDim = lowDataMode ? 960 : 1600;
  const quality = lowDataMode ? 0.65 : 0.84;

  if (file.type === 'image/gif') {
    return { blob: file, mime: file.type, name: file.name };
  }

  return new Promise((resolve) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        const ratio = Math.min(maxDim / width, maxDim / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve({ blob: file, mime: file.type, name: file.name });
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob(
        (blob) => {
          if (blob) {
            resolve({ blob, mime: 'image/webp', name: file.name.replace(/\.[^.]+$/, '.webp') });
          } else {
            resolve({ blob: file, mime: file.type, name: file.name });
          }
        },
        'image/webp',
        quality
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      resolve({ blob: file, mime: file.type, name: file.name });
    };
    img.src = objectUrl;
  });
}

import {
  isAndroidWebViewRuntime,
  RENDER_BACKEND_ORIGIN,
  resolveApiUrl,
} from './backend';

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const commaIdx = result.indexOf(',');
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = () => reject(new Error('Failed to read file for upload'));
    reader.readAsDataURL(blob);
  });
}

function uploadViaAndroidBridge(
  targetUrl: string,
  token: string,
  fileName: string,
  mimeType: string,
  base64Data: string
): Promise<UploadedMediaResult> {
  return new Promise((resolve, reject) => {
    const bridgeUpload = window.ClaroAndroid?.uploadFile;
    if (!bridgeUpload) {
      reject(new Error('Android upload bridge unavailable'));
      return;
    }

    const uploadId = `up_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const prevHandler = window.__onClaroAndroidUploadResult;
    const timeout = window.setTimeout(() => {
      window.__onClaroAndroidUploadResult = prevHandler;
      reject(new Error('Upload timed out. Please try again.'));
    }, 60000);

    window.__onClaroAndroidUploadResult = (id: string, status: number, body: string) => {
      if (id !== uploadId) {
        prevHandler?.(id, status, body);
        return;
      }
      window.clearTimeout(timeout);
      window.__onClaroAndroidUploadResult = prevHandler;
      if (status >= 200 && status < 300) {
        try {
          const parsed = JSON.parse(body) as UploadedMediaResult;
          if (parsed.url.startsWith('/uploads/')) {
            parsed.url = `${RENDER_BACKEND_ORIGIN}${parsed.url}`;
          }
          resolve(parsed);
        } catch {
          reject(new Error('Invalid upload response from server'));
        }
      } else {
        try {
          const err = JSON.parse(body) as { error?: string };
          reject(new Error(err.error || `Upload failed (${status})`));
        } catch {
          reject(new Error(`Upload failed (${status})`));
        }
      }
    };

    bridgeUpload(uploadId, targetUrl, token, fileName, mimeType, base64Data);
  });
}

export async function uploadAttachment(
  fileOrBlob: Blob,
  fileName: string,
  mimeType: string
): Promise<UploadedMediaResult> {
  const user = auth.currentUser;
  if (!user) throw new Error('You must be signed in to upload files.');
  const token = await user.getIdToken();

  const headers = {
    Authorization: `Bearer ${token}`,
    'X-File-Name': fileName,
    'X-File-Type': mimeType,
    'Content-Type': 'application/octet-stream',
  };

  const primaryUrl = resolveApiUrl('/api/upload');
  const androidRuntime = isAndroidWebViewRuntime();

  try {
    let res = await fetch(primaryUrl, {
      method: 'POST',
      headers,
      body: fileOrBlob,
    });

    if (res.status === 404 && !primaryUrl.startsWith(RENDER_BACKEND_ORIGIN)) {
      res = await fetch(`${RENDER_BACKEND_ORIGIN}/api/upload`, {
        method: 'POST',
        headers,
        body: fileOrBlob,
      });
    }

    if (res.ok) {
      const data = (await res.json()) as UploadedMediaResult;
      if (androidRuntime && data.url.startsWith('/uploads/')) {
        data.url = `${RENDER_BACKEND_ORIGIN}${data.url}`;
      }
      return data;
    }

    const err = (await res.json().catch(() => ({ error: 'Upload failed' }))) as { error?: string };
    throw new Error(err.error || `Upload failed (${res.status})`);
  } catch (err) {
    if (window.ClaroAndroid?.uploadFile) {
      const base64 = await blobToBase64(fileOrBlob);
      return uploadViaAndroidBridge(
        `${RENDER_BACKEND_ORIGIN}/api/upload`,
        token,
        fileName,
        mimeType,
        base64
      );
    }
    throw err instanceof Error ? err : new Error('Upload failed');
  }
}

export function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
