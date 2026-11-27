import React, { useEffect, useState } from 'react';
import {
  Check,
  Copy,
  Download,
  FileCode2,
  FolderTree,
  Package,
  ShieldCheck,
  Smartphone,
  X,
} from 'lucide-react';
import { auth } from '../firebase';
import { RENDER_BACKEND_ORIGIN, resolveApiUrl } from '../lib/backend';

interface AndroidFile {
  path: string;
  content: string;
}

interface ReleaseInfo {
  packageName: string;
  versionName: string;
  versionCode: number;
  minSdk: number;
  targetSdk: number;
  apkReady: boolean;
  apkSizeBytes: number;
  aabReady: boolean;
  aabSizeBytes: number;
}

interface AndroidSourceModalProps {
  onClose: () => void;
}

export const AndroidSourceModal: React.FC<AndroidSourceModalProps> = ({ onClose }) => {
  const [files, setFiles] = useState<AndroidFile[]>([]);
  const [releaseInfo, setReleaseInfo] = useState<ReleaseInfo | null>(null);
  const [selectedPath, setSelectedPath] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [downloadingType, setDownloadingType] = useState<'apk' | 'aab' | 'zip' | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const token = await auth.currentUser?.getIdToken();
        if (!token) return;
        const [sourceRes, releaseRes] = await Promise.all([
          fetch(resolveApiUrl('/api/android-source'), { headers: { Authorization: `Bearer ${token}` } }),
          fetch(resolveApiUrl('/api/android-releases'), { headers: { Authorization: `Bearer ${token}` } }),
        ]);

        if (active && sourceRes.ok) {
          const data = (await sourceRes.json()) as { files: AndroidFile[] };
          if (data.files.length > 0) {
            setFiles(data.files);
            setSelectedPath(data.files[0].path);
          }
        }
        if (active && releaseRes.ok) {
          const info = (await releaseRes.json()) as ReleaseInfo;
          setReleaseInfo(info);
        }
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const currentFile = files.find((f) => f.path === selectedPath);

  const handleCopy = async () => {
    if (!currentFile) return;
    await navigator.clipboard.writeText(currentFile.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const handleDownloadFile = () => {
    if (!currentFile) return;
    const blob = new Blob([currentFile.content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = currentFile.path.split('/').pop() || 'file.kt';
    a.click();
    URL.revokeObjectURL(url);
  };

  const triggerBinaryDownload = async (
    endpoint: string,
    filename: string,
    kind: 'apk' | 'aab' | 'zip'
  ) => {
    setDownloadError(null);
    setDownloadingType(kind);
    try {
      const token = await auth.currentUser?.getIdToken();
      if (!token) {
        setDownloadError('Please sign in first to download packages.');
        return;
      }
      const res = await fetch(resolveApiUrl(endpoint), {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        setDownloadError(`Download failed (${res.status}). Please try again.`);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setDownloadError('Network error while downloading package.');
    } finally {
      setDownloadingType(null);
    }
  };

  const formatSize = (bytes?: number) => {
    if (!bytes) return '';
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    return `${(bytes / 1024).toFixed(1)} KB`;
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl w-full max-w-6xl h-[90vh] flex flex-col overflow-hidden shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-6 py-4 border-b border-slate-200 dark:border-slate-800">
          <div className="flex items-center gap-3">
            <FolderTree className="w-5 h-5 text-blue-600 dark:text-blue-400" />
            <div>
              <h3 className="font-display font-semibold text-base text-slate-900 dark:text-white">
                Claro Android (.APK) &amp; Google Play Store (.AAB) Downloads
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Connected to {RENDER_BACKEND_ORIGIN} ({releaseInfo?.packageName || 'com.claro.messenger'} · v{releaseInfo?.versionName || '1.0.5'} · Target SDK {releaseInfo?.targetSdk || 35})
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="w-10 h-10 rounded-xl flex items-center justify-center text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Two Direct Separate Download Options: APK & AAB */}
        <div className="p-5 bg-slate-50 dark:bg-slate-950/50 border-b border-slate-200 dark:border-slate-800 shrink-0 space-y-3">
          {downloadError && (
            <div className="rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
              {downloadError}
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Option 1: Direct APK Download */}
            <div className="rounded-xl border border-emerald-200 dark:border-emerald-900/60 bg-white dark:bg-slate-900 p-4 flex flex-col justify-between gap-3">
              <div>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 font-semibold text-sm text-slate-900 dark:text-white">
                    <Smartphone className="w-4 h-4 text-emerald-600" />
                    <span>1. Direct Android .APK File</span>
                  </div>
                  {releaseInfo?.apkSizeBytes ? (
                    <span className="text-[11px] font-mono text-slate-500">
                      {formatSize(releaseInfo.apkSizeBytes)}
                    </span>
                  ) : null}
                </div>
                <p className="text-xs text-slate-600 dark:text-slate-300 mt-1.5 leading-relaxed">
                  Self-contained installable Android package (<span className="font-mono">claro-v1.0.5.apk</span>) connected directly to <span className="font-mono">claro-calls.onrender.com</span> with native device Gmail chooser &amp; WebRTC HD Calls.
                </p>
              </div>
              <button
                type="button"
                disabled={downloadingType !== null}
                onClick={() =>
                  void triggerBinaryDownload('/api/download-apk', 'claro-v1.0.5.apk', 'apk')
                }
                className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold transition-colors disabled:opacity-50"
              >
                <Download className="w-4 h-4" />
                <span>
                  {downloadingType === 'apk'
                    ? 'Downloading claro-v1.0.5.apk...'
                    : 'Download APK (claro-v1.0.5.apk)'}
                </span>
              </button>
            </div>

            {/* Option 2: Direct Play Store AAB Download */}
            <div className="rounded-xl border border-blue-200 dark:border-blue-900/60 bg-white dark:bg-slate-900 p-4 flex flex-col justify-between gap-3">
              <div>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 font-semibold text-sm text-slate-900 dark:text-white">
                    <Package className="w-4 h-4 text-blue-600" />
                    <span>2. Play Store .AAB Bundle</span>
                  </div>
                  {releaseInfo?.aabSizeBytes ? (
                    <span className="text-[11px] font-mono text-slate-500">
                      {formatSize(releaseInfo.aabSizeBytes)}
                    </span>
                  ) : null}
                </div>
                <p className="text-xs text-slate-600 dark:text-slate-300 mt-1.5 leading-relaxed">
                  Signed Android App Bundle (<span className="font-mono">claro-v1.0.5.aab</span>) validated with Google <span className="font-mono">bundletool</span> (Target SDK 35). Upload directly inside Google Play Console.
                </p>
              </div>
              <button
                type="button"
                disabled={downloadingType !== null}
                onClick={() =>
                  void triggerBinaryDownload('/api/download-aab', 'claro-v1.0.5.aab', 'aab')
                }
                className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold transition-colors disabled:opacity-50"
              >
                <Download className="w-4 h-4" />
                <span>
                  {downloadingType === 'aab'
                    ? 'Downloading claro-v1.0.5.aab...'
                    : 'Download Play Store AAB (claro-v1.0.5.aab)'}
                </span>
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1 text-[11px] text-slate-500 dark:text-slate-400">
            <span className="inline-flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
              <span>
                Saved on server in <code className="font-mono">android-releases/claro-release.apk</code> &amp;{' '}
                <code className="font-mono">android-releases/claro-release.aab</code>
              </span>
            </span>
            <button
              type="button"
              disabled={downloadingType !== null}
              onClick={() =>
                void triggerBinaryDownload(
                  '/api/download-android-source',
                  'claro-android-project.zip',
                  'zip'
                )
              }
              className="text-blue-600 dark:text-blue-400 hover:underline font-medium inline-flex items-center gap-1"
            >
              <Download className="w-3 h-3" />
              <span>
                {downloadingType === 'zip'
                  ? 'Preparing source ZIP...'
                  : 'Also download full Kotlin Source Project (.zip)'}
              </span>
            </button>
          </div>
        </div>

        {/* Source Explorer */}
        <div className="flex-1 flex min-h-0">
          <div className="w-72 border-r border-slate-200 dark:border-slate-800 overflow-y-auto p-3 bg-slate-50/70 dark:bg-slate-950/40 shrink-0">
            {loading ? (
              <p className="text-xs text-slate-500 p-3">Loading Android project files...</p>
            ) : (
              <div className="space-y-1">
                {files.map((file) => (
                  <button
                    key={file.path}
                    type="button"
                    onClick={() => setSelectedPath(file.path)}
                    className={`w-full text-left px-3 py-2 rounded-lg text-xs flex items-center gap-2 transition-colors ${
                      selectedPath === file.path
                        ? 'bg-blue-600 text-white font-medium'
                        : 'text-slate-700 dark:text-slate-300 hover:bg-slate-200/70 dark:hover:bg-slate-800'
                    }`}
                  >
                    <FileCode2 className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate font-mono text-[11px]">{file.path}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex-1 flex flex-col min-w-0">
            {currentFile ? (
              <>
                <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
                  <span className="font-mono text-xs text-slate-600 dark:text-slate-300 truncate">
                    {currentFile.path}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleCopy}
                      className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-1.5"
                    >
                      {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>{copied ? 'Copied' : 'Copy'}</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleDownloadFile}
                      className="px-3 py-1.5 rounded-lg bg-slate-900 dark:bg-slate-700 text-white text-xs font-medium hover:opacity-90 flex items-center gap-1.5"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>Download File</span>
                    </button>
                  </div>
                </div>
                <pre className="flex-1 overflow-auto p-5 text-xs font-mono text-slate-800 dark:text-slate-200 bg-slate-50 dark:bg-[#0B1120] leading-relaxed">
                  {currentFile.content}
                </pre>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-sm text-slate-500">
                Select a file to inspect its source code.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
