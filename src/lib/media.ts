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

const FALLBACK_API_BASE =
  'https://ais-pre-x6vzwrkkfc7urh5uizhj7k-561146321083.asia-southeast1.run.app';

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

  let res = await fetch('/api/upload', {
    method: 'POST',
    headers,
    body: fileOrBlob,
  });

  if (
    res.status === 404 &&
    typeof window !== 'undefined' &&
    window.location.hostname === 'localhost'
  ) {
    res = await fetch(`${FALLBACK_API_BASE}/api/upload`, {
      method: 'POST',
      headers,
      body: fileOrBlob,
    });
  }

  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(
        'Media upload requires publishing the web backend via Share/Deploy. Text messaging and Audio/Video calls work immediately.'
      );
    }
    const err = (await res.json().catch(() => ({ error: 'Upload failed' }))) as { error?: string };
    throw new Error(err.error || 'Upload failed');
  }

  return (await res.json()) as UploadedMediaResult;
}

export function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
