import React, { useEffect, useState } from 'react';
import {
  collection,
  doc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import {
  Activity,
  ArrowLeft,
  CheckCircle2,
  HardDrive,
  Server,
  ShieldAlert,
  Sliders,
  UserCheck,
  UserX,
  Users,
} from 'lucide-react';
import { auth, db, handleFirestoreError, OperationType } from '../firebase';
import type { ReportDoc, ReportStatus, SystemConfigDoc, UserDirectoryEntry } from '../types';

interface AdminDashboardProps {
  currentUid: string;
  onExit: () => void;
}

interface ServerHealth {
  ok: boolean;
  uptimeSeconds?: number;
  memoryUsageMb?: number;
  activeUsersConnected?: number;
  activeWsSockets?: number;
  uploadsCount?: number;
  uploadsStorageMb?: number;
  turnConfigured?: boolean;
  nodeVersion?: string;
}

export const AdminDashboard: React.FC<AdminDashboardProps> = ({ currentUid, onExit }) => {
  const [users, setUsers] = useState<UserDirectoryEntry[]>([]);
  const [reports, setReports] = useState<ReportDoc[]>([]);
  const [health, setHealth] = useState<ServerHealth | null>(null);

  const [maxFileSizeMb, setMaxFileSizeMb] = useState(25);
  const [stunServerUrl, setStunServerUrl] = useState('stun:stun.l.google.com:19302');
  const [turnServerUrl, setTurnServerUrl] = useState('');
  const [e2eeDefault, setE2eeDefault] = useState(true);
  const [rateLimitPerMin, setRateLimitPerMin] = useState(40);
  const [maintenanceMode, setMaintenanceMode] = useState(false);
  const [configSaved, setConfigSaved] = useState(false);

  useEffect(() => {
    const unsubUsers = onSnapshot(
      collection(db, 'userDirectory'),
      (snap) => {
        setUsers(snap.docs.map((d) => d.data() as UserDirectoryEntry));
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'userDirectory')
    );

    const unsubReports = onSnapshot(
      collection(db, 'reports'),
      (snap) => {
        setReports(snap.docs.map((d) => d.data() as ReportDoc));
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'reports')
    );

    const unsubConfig = onSnapshot(
      doc(db, 'systemConfig', 'global'),
      (snap) => {
        if (snap.exists()) {
          const cfg = snap.data() as SystemConfigDoc;
          setMaxFileSizeMb(cfg.maxFileSizeMb);
          setStunServerUrl(cfg.stunServerUrl);
          setTurnServerUrl(cfg.turnServerUrl || '');
          setE2eeDefault(cfg.e2eeDefault);
          setRateLimitPerMin(cfg.rateLimitPerMin);
          setMaintenanceMode(cfg.maintenanceMode);
        }
      },
      (err) => handleFirestoreError(err, OperationType.GET, 'systemConfig/global')
    );

    return () => {
      unsubUsers();
      unsubReports();
      unsubConfig();
    };
  }, []);

  useEffect(() => {
    let active = true;
    const fetchHealth = async () => {
      const token = await auth.currentUser?.getIdToken();
      if (!token) return;
      const res = await fetch('/api/health', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok && active) {
        setHealth((await res.json()) as ServerHealth);
      }
    };
    void fetchHealth();
    const timer = window.setInterval(() => void fetchHealth(), 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  const handleToggleAccountStatus = async (target: UserDirectoryEntry) => {
    const nextStatus = target.accountStatus === 'active' ? 'suspended' : 'active';
    try {
      await updateDoc(doc(db, 'userDirectory', target.uid), {
        accountStatus: nextStatus,
        updatedAt: serverTimestamp(),
      });
      await updateDoc(doc(db, 'users', target.uid), {
        accountStatus: nextStatus,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `users/${target.uid}`);
    }
  };

  const handleUpdateReport = async (report: ReportDoc, nextStatus: ReportStatus) => {
    try {
      await updateDoc(doc(db, 'reports', report.reportId), {
        status: nextStatus,
        adminNotes: `Updated to ${nextStatus} by administrator`,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `reports/${report.reportId}`);
    }
  };

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await setDoc(doc(db, 'systemConfig', 'global'), {
        maxFileSizeMb: Number(maxFileSizeMb),
        stunServerUrl: stunServerUrl.trim() || 'stun:stun.l.google.com:19302',
        turnServerUrl: turnServerUrl.trim(),
        e2eeDefault,
        rateLimitPerMin: Number(rateLimitPerMin),
        maintenanceMode,
        updatedAt: serverTimestamp(),
        updatedBy: currentUid,
      });
      setConfigSaved(true);
      setTimeout(() => setConfigSaved(false), 2000);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'systemConfig/global');
    }
  };

  const activeUsersCount = users.filter((u) => u.accountStatus === 'active').length;
  const suspendedUsersCount = users.filter((u) => u.accountStatus === 'suspended').length;
  const onlineNowCount = users.filter((u) => u.onlineStatus === 'online').length;
  const pendingReportsCount = reports.filter((r) => r.status === 'pending').length;

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-[#0B1120] text-slate-900 dark:text-slate-100">
      {/* Top Bar */}
      <header className="h-16 px-6 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between sticky top-0 z-20">
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={onExit}
            className="px-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-medium flex items-center gap-1.5 hover:bg-slate-50 dark:hover:bg-slate-800"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Back to App</span>
          </button>
          <h1 className="font-display font-bold text-lg">Claro Admin Operations</h1>
        </div>
        <div className="text-xs text-slate-500 dark:text-slate-400">
          Verified Administrator Console
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-6 space-y-6">
        {/* KPI Row */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
            <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 mb-2">
              <span>Registered Accounts</span>
              <Users className="w-4 h-4 text-blue-600" />
            </div>
            <div className="text-2xl font-display font-bold tabular-nums">{users.length}</div>
            <div className="text-xs text-slate-500 mt-1 tabular-nums">
              {activeUsersCount} active · {suspendedUsersCount} suspended
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
            <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 mb-2">
              <span>Online &amp; Signaling</span>
              <Activity className="w-4 h-4 text-emerald-600" />
            </div>
            <div className="text-2xl font-display font-bold tabular-nums">{onlineNowCount}</div>
            <div className="text-xs text-slate-500 mt-1 tabular-nums">
              {health?.activeWsSockets ?? 0} live WS sockets
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
            <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 mb-2">
              <span>Abuse Reports</span>
              <ShieldAlert className="w-4 h-4 text-amber-600" />
            </div>
            <div className="text-2xl font-display font-bold tabular-nums">{pendingReportsCount}</div>
            <div className="text-xs text-slate-500 mt-1 tabular-nums">
              Pending review ({reports.length} total)
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
            <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 mb-2">
              <span>Media Storage</span>
              <HardDrive className="w-4 h-4 text-blue-600" />
            </div>
            <div className="text-2xl font-display font-bold tabular-nums">
              {health?.uploadsStorageMb ?? 0} MB
            </div>
            <div className="text-xs text-slate-500 mt-1 tabular-nums">
              {health?.uploadsCount ?? 0} stored attachments
            </div>
          </div>
        </div>

        {/* System Health & System Config */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Server & Call Infrastructure Health */}
          <section className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6">
            <div className="flex items-center gap-2 mb-4">
              <Server className="w-5 h-5 text-blue-600" />
              <h2 className="font-display font-semibold text-base">
                Server &amp; WebRTC Call Health
              </h2>
            </div>
            <div className="divide-y divide-slate-100 dark:divide-slate-800 text-sm">
              <div className="py-3 flex justify-between">
                <span className="text-slate-500 dark:text-slate-400">API &amp; WebSocket Server</span>
                <span className="font-medium text-emerald-600">
                  {health?.ok ? 'Operational' : 'Checking...'}
                </span>
              </div>
              <div className="py-3 flex justify-between">
                <span className="text-slate-500 dark:text-slate-400">Process Uptime</span>
                <span className="font-mono tabular-nums">{health?.uptimeSeconds ?? 0}s</span>
              </div>
              <div className="py-3 flex justify-between">
                <span className="text-slate-500 dark:text-slate-400">Memory Usage (RSS)</span>
                <span className="font-mono tabular-nums">{health?.memoryUsageMb ?? 0} MB</span>
              </div>
              <div className="py-3 flex justify-between">
                <span className="text-slate-500 dark:text-slate-400">TURN Relay Credentials</span>
                <span className="font-medium">
                  {health?.turnConfigured ? 'Configured' : 'STUN Only (Set TURN_URL env)'}
                </span>
              </div>
              <div className="py-3 flex justify-between">
                <span className="text-slate-500 dark:text-slate-400">Runtime Version</span>
                <span className="font-mono">{health?.nodeVersion || 'Node.js'}</span>
              </div>
            </div>
          </section>

          {/* Global System Configuration */}
          <section className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6">
            <div className="flex items-center gap-2 mb-4">
              <Sliders className="w-5 h-5 text-blue-600" />
              <h2 className="font-display font-semibold text-base">System Configuration</h2>
            </div>
            <form onSubmit={handleSaveConfig} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                    Max Upload Size (MB)
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={maxFileSizeMb}
                    onChange={(e) => setMaxFileSizeMb(Number(e.target.value))}
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                    Rate Limit (msgs/min)
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={1000}
                    value={rateLimitPerMin}
                    onChange={(e) => setRateLimitPerMin(Number(e.target.value))}
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm font-mono"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                  Default STUN Server URL
                </label>
                <input
                  type="text"
                  value={stunServerUrl}
                  onChange={(e) => setStunServerUrl(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm font-mono"
                />
              </div>
              <div className="flex items-center justify-between text-sm pt-1">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={e2eeDefault}
                    onChange={(e) => setE2eeDefault(e.target.checked)}
                    className="rounded border-slate-300"
                  />
                  <span>Enable E2EE by default for new chats</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={maintenanceMode}
                    onChange={(e) => setMaintenanceMode(e.target.checked)}
                    className="rounded border-slate-300"
                  />
                  <span>Maintenance mode</span>
                </label>
              </div>
              <div className="flex items-center justify-end gap-3 pt-2">
                {configSaved && (
                  <span className="text-xs text-emerald-600 flex items-center gap-1">
                    <CheckCircle2 className="w-4 h-4" />
                    <span>Saved</span>
                  </span>
                )}
                <button
                  type="submit"
                  className="px-4 py-2 rounded-xl bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
                >
                  Save Configuration
                </button>
              </div>
            </form>
          </section>
        </div>

        {/* Abuse Reports Queue */}
        <section className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800">
            <h2 className="font-display font-semibold text-base">Abuse Reports Queue</h2>
          </div>
          {reports.length === 0 ? (
            <p className="p-6 text-sm text-slate-500">No abuse reports submitted.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 dark:bg-slate-800/50 text-xs text-slate-500">
                  <tr>
                    <th className="px-6 py-3 font-medium">Reason</th>
                    <th className="px-6 py-3 font-medium">Reported UID</th>
                    <th className="px-6 py-3 font-medium">Details</th>
                    <th className="px-6 py-3 font-medium">Status</th>
                    <th className="px-6 py-3 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {reports.map((r) => (
                    <tr key={r.reportId}>
                      <td className="px-6 py-3.5 font-medium">{r.reason}</td>
                      <td className="px-6 py-3.5 font-mono text-xs text-slate-500">{r.reportedUserId}</td>
                      <td className="px-6 py-3.5 text-slate-600 dark:text-slate-300 max-w-xs truncate">
                        {r.details || '—'}
                      </td>
                      <td className="px-6 py-3.5 capitalize">{r.status}</td>
                      <td className="px-6 py-3.5 text-right space-x-2 whitespace-nowrap">
                        {!(r.status === 'resolved' || r.status === 'dismissed') && (
                          <>
                            <button
                              type="button"
                              onClick={() => void handleUpdateReport(r, 'resolved')}
                              className="px-3 py-1 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700"
                            >
                              Resolve
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleUpdateReport(r, 'dismissed')}
                              className="px-3 py-1 rounded-lg border border-slate-200 dark:border-slate-700 text-xs"
                            >
                              Dismiss
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Registered Users Directory */}
        <section className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800">
            <h2 className="font-display font-semibold text-base">Account Moderation</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 dark:bg-slate-800/50 text-xs text-slate-500">
                <tr>
                  <th className="px-6 py-3 font-medium">Name</th>
                  <th className="px-6 py-3 font-medium">Username</th>
                  <th className="px-6 py-3 font-medium">Status</th>
                  <th className="px-6 py-3 font-medium text-right">Moderation</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {users.map((u) => (
                  <tr key={u.uid}>
                    <td className="px-6 py-3.5 font-medium">{u.fullName}</td>
                    <td className="px-6 py-3.5 font-mono text-xs text-slate-500">@{u.username}</td>
                    <td className="px-6 py-3.5 capitalize">
                      {u.accountStatus === 'active' ? (
                        <span className="text-emerald-600 font-medium">Active</span>
                      ) : (
                        <span className="text-rose-600 font-medium">Suspended</span>
                      )}
                    </td>
                    <td className="px-6 py-3.5 text-right">
                      {u.uid !== currentUid && (
                        <button
                          type="button"
                          onClick={() => void handleToggleAccountStatus(u)}
                          className={`px-3 py-1.5 rounded-lg text-xs font-medium inline-flex items-center gap-1.5 ${
                            u.accountStatus === 'active'
                              ? 'border border-rose-200 text-rose-600 hover:bg-rose-50 dark:border-rose-900/60 dark:hover:bg-rose-950/30'
                              : 'bg-emerald-600 text-white hover:bg-emerald-700'
                          }`}
                        >
                          {u.accountStatus === 'active' ? (
                            <>
                              <UserX className="w-3.5 h-3.5" />
                              <span>Suspend</span>
                            </>
                          ) : (
                            <>
                              <UserCheck className="w-3.5 h-3.5" />
                              <span>Reactivate</span>
                            </>
                          )}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
};
