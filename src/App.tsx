import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  deleteUser,
  onAuthStateChanged,
  signOut,
  updatePassword,
  updateProfile,
  User as FirebaseUser,
} from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
} from 'firebase/firestore';
import {
  Bell,
  Lock,
  LogOut,
  MessageSquare,
  Moon,
  Phone,
  PhoneCall,
  PhoneIncoming,
  PhoneMissed,
  PhoneOutgoing,
  Plus,
  Search,
  Settings as SettingsIcon,
  Shield,
  ShieldCheck,
  Smartphone,
  Sun,
  Trash2,
  UserPlus,
  Users,
  Video,
  Wifi,
  X,
} from 'lucide-react';
import { auth, db, handleFirestoreError, OperationType } from './firebase';
import { resolveWsUrl } from './lib/backend';
import { ensureDeviceKeyPair } from './lib/crypto';
import { compressImageFile, uploadAttachment } from './lib/media';
import { playMessageSound } from './lib/sound';
import type {
  ActiveTab,
  BlockedUserDoc,
  CallDoc,
  ChatDoc,
  ContactDoc,
  DataMode,
  NotificationDoc,
  OnlineStatus,
  UserDirectoryEntry,
  UserPrivate,
} from './types';
import { ADMIN_EMAIL, VALIDATION_LIMITS } from './types';
import { AdminDashboard } from './components/AdminDashboard';
import { AndroidSourceModal } from './components/AndroidSourceModal';
import { AuthView } from './components/AuthView';
import { Avatar } from './components/Avatar';
import { CallOverlay } from './components/CallOverlay';
import { ChatWindow } from './components/ChatWindow';
import { OfflineIndicator, PWAInstallButton } from './components/PWAInstallButton';

function sanitizeUsername(raw: string, uid: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_.]/g, '').slice(0, 30);
  if (cleaned.length >= 2) return cleaned;
  return `user_${uid.slice(0, 6)}`;
}

const PRESENCE_STALE_MS = 70_000;

function resolveActiveStatus(
  onlineStatus?: OnlineStatus,
  lastSeen?: Timestamp,
  nowMs: number = Date.now(),
  allowShow: boolean = true
): OnlineStatus {
  if (!allowShow || onlineStatus !== 'online') return 'offline';
  const ts = lastSeen?.toMillis?.();
  if (!ts) return 'online';
  return nowMs - ts <= PRESENCE_STALE_MS ? 'online' : 'offline';
}

export default function App() {
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [pendingMeta, setPendingMeta] = useState<{ fullName?: string; username?: string }>({});

  const [darkMode, setDarkMode] = useState<boolean>(() => {
    return localStorage.getItem('claro_theme') === 'dark';
  });
  const [dataMode, setDataMode] = useState<DataMode>(() => {
    const saved = localStorage.getItem('claro_data_mode');
    if (saved === 'standard' || saved === 'saver' || saved === 'text_only') return saved;
    return 'standard';
  });

  const [activeTab, setActiveTab] = useState<ActiveTab>('chats');
  const [showAdmin, setShowAdmin] = useState(false);
  const [showAndroidModal, setShowAndroidModal] = useState(false);

  const [userProfile, setUserProfile] = useState<UserPrivate | null>(null);
  const [isAdminUser, setIsAdminUser] = useState(false);
  const [myPrivateKey, setMyPrivateKey] = useState<CryptoKey | null>(null);
  const [myPublicJwk, setMyPublicJwk] = useState<string>('');

  const [peerProfiles, setPeerProfiles] = useState<Record<string, UserDirectoryEntry>>({});
  const [chats, setChats] = useState<ChatDoc[]>([]);
  const [optimisticChats, setOptimisticChats] = useState<Record<string, ChatDoc>>({});
  const [calls, setCalls] = useState<CallDoc[]>([]);
  const [contacts, setContacts] = useState<ContactDoc[]>([]);
  const [blockedUsers, setBlockedUsers] = useState<BlockedUserDoc[]>([]);
  const [notifications, setNotifications] = useState<NotificationDoc[]>([]);

  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [activeCall, setActiveCall] = useState<CallDoc | null>(null);
  const [autoAcceptCallId, setAutoAcceptCallId] = useState<string | null>(null);

  const [chatSearch, setChatSearch] = useState('');
  const [contactSearch, setContactSearch] = useState('');
  const [contactSearchResults, setContactSearchResults] = useState<UserDirectoryEntry[]>([]);
  const [contactSearching, setContactSearching] = useState(false);
  const [contactSearchError, setContactSearchError] = useState<string | null>(null);
  const [contactSelfMatched, setContactSelfMatched] = useState(false);
  const [newChatSearch, setNewChatSearch] = useState('');
  const [newChatResults, setNewChatResults] = useState<UserDirectoryEntry[]>([]);
  const [newChatSearching, setNewChatSearching] = useState(false);
  const [newChatSearchError, setNewChatSearchError] = useState<string | null>(null);
  const [newChatSelfMatched, setNewChatSelfMatched] = useState(false);
  const [showNewChatModal, setShowNewChatModal] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const notifiedCallIdsRef = useRef<Set<string>>(new Set());

  // Settings form state
  const [editFullName, setEditFullName] = useState('');
  const [editUsername, setEditUsername] = useState('');
  const [editPhoneNumber, setEditPhoneNumber] = useState('');
  const [editAbout, setEditAbout] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [settingsMsg, setSettingsMsg] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  // WebSocket & presence refs
  const wsRef = useRef<WebSocket | null>(null);
  const [wsTypingMap, setWsTypingMap] = useState<Record<string, boolean>>({});
  const profilePicInputRef = useRef<HTMLInputElement | null>(null);
  const androidForegroundRef = useRef<boolean>(true);
  const showOnlineStatusRef = useRef<boolean>(true);
  const [presenceNow, setPresenceNow] = useState<number>(() => Date.now());

  // Apply Dark/Light Theme class to <html>
  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) {
      root.classList.add('dark');
      localStorage.setItem('claro_theme', 'dark');
    } else {
      root.classList.remove('dark');
      localStorage.setItem('claro_theme', 'light');
    }
  }, [darkMode]);

  // Listen to Firebase Auth state
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => {
      setFirebaseUser(user);
      setAuthReady(true);
    });
    return () => unsub();
  }, []);

  const isVerifiedSession = Boolean(
    firebaseUser && (firebaseUser.emailVerified || firebaseUser.phoneNumber)
  );

  // Initialize user documents & WebCrypto device keypair when verified
  useEffect(() => {
    if (!firebaseUser || !isVerifiedSession) {
      setUserProfile(null);
      setIsAdminUser(false);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const keyResult = await ensureDeviceKeyPair(firebaseUser.uid);
        if (cancelled) return;
        setMyPrivateKey(keyResult.privateKey);
        setMyPublicJwk(keyResult.publicKeyJwkString);

        const userRef = doc(db, 'users', firebaseUser.uid);
        const dirRef = doc(db, 'userDirectory', firebaseUser.uid);
        const snap = await getDoc(userRef);

        if (!snap.exists()) {
          const defaultName =
            pendingMeta.fullName ||
            firebaseUser.displayName ||
            firebaseUser.email?.split('@')[0] ||
            'Claro User';
          const baseUser =
            pendingMeta.username ||
            firebaseUser.email?.split('@')[0] ||
            `user_${firebaseUser.uid.slice(0, 6)}`;
          const cleanUsername = sanitizeUsername(baseUser, firebaseUser.uid);

          await setDoc(userRef, {
            uid: firebaseUser.uid,
            fullName: defaultName.slice(0, VALIDATION_LIMITS.NAME_MAX),
            username: cleanUsername,
            email: firebaseUser.email || '',
            phoneNumber: firebaseUser.phoneNumber || '',
            profilePicture: firebaseUser.photoURL || '',
            about: 'Available on Claro',
            onlineStatus: 'online',
            lastSeen: serverTimestamp(),
            accountStatus: 'active',
            showEmail: Boolean(firebaseUser.email),
            showPhone: Boolean(firebaseUser.phoneNumber),
            showOnlineStatus: true,
            readReceipts: true,
            notificationsEnabled: true,
            lowDataMode: false,
            publicKeyJwk: keyResult.publicKeyJwkString,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });

          await setDoc(dirRef, {
            uid: firebaseUser.uid,
            fullName: defaultName.slice(0, VALIDATION_LIMITS.NAME_MAX),
            username: cleanUsername,
            usernameLower: cleanUsername.toLowerCase(),
            profilePicture: firebaseUser.photoURL || '',
            about: 'Available on Claro',
            onlineStatus: 'online',
            lastSeen: serverTimestamp(),
            accountStatus: 'active',
            discoverableEmail: (firebaseUser.email || '').toLowerCase(),
            discoverablePhone: firebaseUser.phoneNumber || '',
            publicKeyJwk: keyResult.publicKeyJwkString,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } else {
          const existing = snap.data() as UserPrivate;
          const isAppActiveNow =
            document.visibilityState === 'visible' &&
            navigator.onLine !== false &&
            androidForegroundRef.current;
          const initialOnline: OnlineStatus =
            isAppActiveNow && existing.showOnlineStatus !== false ? 'online' : 'offline';

          await updateDoc(userRef, {
            onlineStatus: initialOnline,
            lastSeen: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });

          const dirSnap = await getDoc(dirRef);
          if (!dirSnap.exists()) {
            await setDoc(dirRef, {
              uid: firebaseUser.uid,
              fullName: existing.fullName || firebaseUser.displayName || 'Claro User',
              username: existing.username,
              usernameLower: existing.username.toLowerCase(),
              profilePicture: existing.profilePicture || '',
              about: existing.about || 'Available on Claro',
              onlineStatus: initialOnline,
              lastSeen: serverTimestamp(),
              accountStatus: existing.accountStatus || 'active',
              discoverableEmail:
                existing.showEmail !== false ? (existing.email || firebaseUser.email || '').toLowerCase() : '',
              discoverablePhone:
                existing.showPhone !== false ? existing.phoneNumber || firebaseUser.phoneNumber || '' : '',
              publicKeyJwk: keyResult.publicKeyJwkString,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
          } else {
            const syncedUsername = sanitizeUsername(
              existing.username || `user_${firebaseUser.uid.slice(0, 6)}`,
              firebaseUser.uid
            );
            await updateDoc(dirRef, {
              fullName: existing.fullName || firebaseUser.displayName || 'Claro User',
              username: syncedUsername,
              usernameLower: syncedUsername.toLowerCase(),
              onlineStatus: initialOnline,
              lastSeen: serverTimestamp(),
              discoverableEmail:
                existing.showEmail !== false ? (existing.email || firebaseUser.email || '').toLowerCase() : '',
              discoverablePhone:
                existing.showPhone !== false ? existing.phoneNumber || firebaseUser.phoneNumber || '' : '',
              publicKeyJwk: keyResult.publicKeyJwkString,
              updatedAt: serverTimestamp(),
            });
          }
        }

        // Check and persist admin authorization
        const adminSnap = await getDoc(doc(db, 'admins', firebaseUser.uid));
        if (firebaseUser.email === ADMIN_EMAIL && firebaseUser.emailVerified) {
          if (!adminSnap.exists()) {
            await setDoc(doc(db, 'admins', firebaseUser.uid), {
              uid: firebaseUser.uid,
              email: ADMIN_EMAIL,
              role: 'admin',
              createdAt: serverTimestamp(),
            });
          }
          if (!cancelled) setIsAdminUser(true);
        } else {
          if (!cancelled) setIsAdminUser(adminSnap.exists());
        }
      } catch (err) {
        console.error('Initialization error:', err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [firebaseUser, isVerifiedSession, pendingMeta]);

  useEffect(() => {
    showOnlineStatusRef.current = userProfile?.showOnlineStatus !== false;
  }, [userProfile?.showOnlineStatus]);

  // Real-time Online / Offline presence: Online strictly while actively using the app, Offline when away/closed
  useEffect(() => {
    if (!firebaseUser || !isVerifiedSession) return;
    const uid = firebaseUser.uid;
    let lastWrittenStatus: OnlineStatus | null = null;
    let lastOnlineWriteAt = 0;

    const writePresence = (shouldBeOnline: boolean, forceHeartbeat = false) => {
      const nextStatus: OnlineStatus =
        shouldBeOnline && showOnlineStatusRef.current ? 'online' : 'offline';
      const now = Date.now();
      if (
        nextStatus === 'online' &&
        lastWrittenStatus === 'online' &&
        !forceHeartbeat &&
        now - lastOnlineWriteAt < 15_000
      ) {
        return;
      }
      if (nextStatus === 'offline' && lastWrittenStatus === 'offline' && !forceHeartbeat) {
        return;
      }
      lastWrittenStatus = nextStatus;
      if (nextStatus === 'online') lastOnlineWriteAt = now;

      const payload = {
        onlineStatus: nextStatus,
        lastSeen: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      void updateDoc(doc(db, 'userDirectory', uid), payload).catch(() => {});
      void updateDoc(doc(db, 'users', uid), payload).catch(() => {});
    };

    const syncActivity = (forceOffline = false, forceHeartbeat = false) => {
      const activeNow =
        !forceOffline &&
        document.visibilityState === 'visible' &&
        navigator.onLine !== false &&
        androidForegroundRef.current;
      writePresence(activeNow, forceHeartbeat);
    };

    const onVisibilityChange = () => syncActivity(document.visibilityState !== 'visible');
    const onFocus = () => syncActivity(false);
    const onOnline = () => syncActivity(false);
    const onOffline = () => syncActivity(true);
    const onPageHide = () => syncActivity(true);

    window.__onClaroAndroidVisibilityChange = (inForeground: boolean) => {
      androidForegroundRef.current = inForeground;
      syncActivity(!inForeground, true);
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onPageHide);

    // Sync immediately on session mount
    syncActivity(false, true);

    // Keep lastSeen fresh every 30s while actively using the app; refresh peer staleness clock every 20s
    const heartbeatTimer = window.setInterval(() => {
      if (
        document.visibilityState === 'visible' &&
        navigator.onLine !== false &&
        androidForegroundRef.current
      ) {
        syncActivity(false, true);
      }
    }, 30_000);

    const stalenessTimer = window.setInterval(() => {
      setPresenceNow(Date.now());
    }, 20_000);

    return () => {
      window.clearInterval(heartbeatTimer);
      window.clearInterval(stalenessTimer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', onPageHide);
      window.__onClaroAndroidVisibilityChange = undefined;
      syncActivity(true, true);
    };
  }, [firebaseUser, isVerifiedSession]);

  // Keep Android background keep-alive foreground service aligned with signed-in session
  useEffect(() => {
    window.ClaroAndroid?.setSignedIn?.(Boolean(firebaseUser && isVerifiedSession));
  }, [firebaseUser, isVerifiedSession]);

  // Attach real-time Firestore listeners once verified (no public directory dump)
  useEffect(() => {
    if (!firebaseUser || !isVerifiedSession) return;
    const uid = firebaseUser.uid;

    const unsubProfile = onSnapshot(
      doc(db, 'users', uid),
      (snap) => {
        if (snap.exists()) {
          const p = snap.data() as UserPrivate;
          setUserProfile(p);
          setEditFullName(p.fullName);
          setEditUsername(p.username);
          setEditPhoneNumber(p.phoneNumber || '');
          setEditAbout(p.about || '');
          if (!localStorage.getItem('claro_data_mode') && p.lowDataMode) {
            setDataMode('saver');
          }
        }
      },
      (err) => handleFirestoreError(err, OperationType.GET, `users/${uid}`)
    );

    const unsubChats = onSnapshot(
      query(collection(db, 'chats'), where('participantIds', 'array-contains', uid)),
      (snap) => {
        const list = snap.docs
          .map((d) => d.data() as ChatDoc)
          .sort((a, b) => {
            const ta = a.lastMessageTime?.toMillis?.() ?? a.updatedAt?.toMillis?.() ?? 0;
            const tb = b.lastMessageTime?.toMillis?.() ?? b.updatedAt?.toMillis?.() ?? 0;
            return tb - ta;
          });
        setChats(list);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'chats')
    );

    const unsubCalls = onSnapshot(
      query(collection(db, 'calls'), where('participantIds', 'array-contains', uid)),
      (snap) => {
        const list = snap.docs
          .map((d) => d.data() as CallDoc)
          .sort((a, b) => (b.startedAt?.toMillis?.() ?? 0) - (a.startedAt?.toMillis?.() ?? 0));
        setCalls(list);
        const live = list.find((c) => c.callStatus === 'ringing' || c.callStatus === 'connected');
        if (live) {
          setActiveCall(live);
          if (live.callStatus === 'ringing' && live.receiverId === uid) {
            if (!notifiedCallIdsRef.current.has(live.callId)) {
              notifiedCallIdsRef.current.add(live.callId);
              void (async () => {
                let callerName = 'Claro Contact';
                try {
                  const callerSnap = await getDoc(doc(db, 'userDirectory', live.callerId));
                  if (callerSnap.exists()) {
                    const callerData = callerSnap.data() as UserDirectoryEntry;
                    callerName = callerData.fullName || callerName;
                    setPeerProfiles((prev) => ({ ...prev, [callerData.uid]: callerData }));
                  }
                } catch {
                  // Ignore caller lookup failure
                }
                window.ClaroAndroid?.showIncomingCallNotification?.(
                  live.callId,
                  callerName,
                  live.callType
                );
                if (
                  'Notification' in window &&
                  Notification.permission === 'granted' &&
                  document.hidden
                ) {
                  try {
                    const n = new Notification(`Incoming ${live.callType} call`, {
                      body: `${callerName} is calling you on Claro`,
                      tag: `call_${live.callId}`,
                      requireInteraction: true,
                    });
                    n.onclick = () => {
                      window.focus();
                      n.close();
                    };
                  } catch {
                    // Ignore browser notification errors
                  }
                }
              })();
            }
          } else if (live.callStatus !== 'ringing') {
            window.ClaroAndroid?.dismissIncomingCallNotification?.(live.callId);
          }
        } else {
          setActiveCall((prev) => {
            if (prev) {
              window.ClaroAndroid?.dismissIncomingCallNotification?.(prev.callId);
            }
            return null;
          });
          setAutoAcceptCallId(null);
        }
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'calls')
    );

    const unsubContacts = onSnapshot(
      query(collection(db, 'contacts'), where('userId', '==', uid)),
      (snap) => {
        setContacts(snap.docs.map((d) => d.data() as ContactDoc));
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'contacts')
    );

    const unsubBlocked = onSnapshot(
      query(collection(db, 'blockedUsers'), where('userId', '==', uid)),
      (snap) => {
        setBlockedUsers(snap.docs.map((d) => d.data() as BlockedUserDoc));
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'blockedUsers')
    );

    const unsubNotifs = onSnapshot(
      query(collection(db, 'notifications'), where('userId', '==', uid)),
      (snap) => {
        const list = snap.docs
          .map((d) => d.data() as NotificationDoc)
          .sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
        if (list.some((n) => !n.readStatus)) {
          playMessageSound();
        }
        setNotifications(list);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'notifications')
    );

    return () => {
      unsubProfile();
      unsubChats();
      unsubCalls();
      unsubContacts();
      unsubBlocked();
      unsubNotifs();
    };
  }, [firebaseUser, isVerifiedSession]);

  // Subscribe individually ONLY to known peers (saved contacts, chat peers, call peers, blocked users)
  const knownPeerKey = useMemo(() => {
    if (!firebaseUser) return '';
    const uids = new Set<string>();
    for (const c of contacts) uids.add(c.contactUserId);
    for (const ch of chats) {
      uids.add(ch.participantA === firebaseUser.uid ? ch.participantB : ch.participantA);
    }
    for (const ca of calls) {
      uids.add(ca.callerId === firebaseUser.uid ? ca.receiverId : ca.callerId);
    }
    for (const b of blockedUsers) uids.add(b.blockedUserId);
    uids.delete(firebaseUser.uid);
    return Array.from(uids).sort().join(',');
  }, [blockedUsers, calls, chats, contacts, firebaseUser]);

  useEffect(() => {
    if (!firebaseUser || !isVerifiedSession || !knownPeerKey) return;
    const uids = knownPeerKey.split(',').filter(Boolean);
    const unsubs = uids.map((peerUid) =>
      onSnapshot(
        doc(db, 'userDirectory', peerUid),
        (snap) => {
          if (snap.exists()) {
            const entry = snap.data() as UserDirectoryEntry;
            setPeerProfiles((prev) => ({ ...prev, [peerUid]: entry }));
          }
        },
        () => {
          // Ignore single peer read issues
        }
      )
    );
    return () => {
      unsubs.forEach((u) => u());
    };
  }, [firebaseUser, isVerifiedSession, knownPeerKey]);

  // Handle Answer / Decline taps directly from the Android incoming call heads-up notification
  useEffect(() => {
    if (!firebaseUser) return;
    window.__onClaroAndroidCallAction = async (callId: string, action: 'answer' | 'decline') => {
      window.ClaroAndroid?.dismissIncomingCallNotification?.(callId);
      if (action === 'decline') {
        try {
          await updateDoc(doc(db, 'calls', callId), {
            callStatus: 'rejected',
            endedAt: serverTimestamp(),
            duration: 0,
            updatedAt: serverTimestamp(),
          });
        } catch {
          // Call may have already ended
        }
        setActiveCall((prev) => (prev?.callId === callId ? null : prev));
        setAutoAcceptCallId(null);
      } else if (action === 'answer') {
        setAutoAcceptCallId(callId);
        try {
          const snap = await getDoc(doc(db, 'calls', callId));
          if (snap.exists()) {
            const callData = snap.data() as CallDoc;
            if (callData.callStatus === 'ringing' || callData.callStatus === 'connected') {
              setActiveCall(callData);
            }
          }
        } catch {
          // Ignore lookup error
        }
      }
    };
    return () => {
      window.__onClaroAndroidCallAction = undefined;
    };
  }, [firebaseUser]);

  // Targeted privacy-preserving search (only returns matching accounts; never lists all registered users)
  const searchUsersByQuery = useCallback(
    async (
      rawQuery: string
    ): Promise<{ results: UserDirectoryEntry[]; matchedSelf: boolean; error: string | null }> => {
      if (!firebaseUser) return { results: [], matchedSelf: false, error: null };
      const cleaned = rawQuery.trim().replace(/^@/, '');
      const qLower = cleaned.toLowerCase();
      const strippedPhone = cleaned.replace(/[\s\-().]/g, '');
      const pureDigits = strippedPhone.replace(/[^0-9]/g, '');

      const isPhoneQuery = pureDigits.length >= 6;
      const isTextQuery = qLower.length >= 2;
      if (!isTextQuery && !isPhoneQuery) {
        return { results: [], matchedSelf: false, error: null };
      }

      const foundMap = new Map<string, UserDirectoryEntry>();
      let matchedSelf = false;
      let firstError: string | null = null;
      const tasks: Array<Promise<void>> = [];

      const runDirectoryQuery = (qRef: ReturnType<typeof query>) =>
        getDocs(qRef)
          .then((snap) => {
            snap.docs.forEach((d) => {
              const entry = d.data() as UserDirectoryEntry;
              if (entry.uid === firebaseUser.uid) {
                matchedSelf = true;
                return;
              }
              if (entry.accountStatus === 'active') {
                foundMap.set(entry.uid, entry);
              }
            });
          })
          .catch((err: unknown) => {
            if (!firstError) {
              firstError = err instanceof Error ? err.message : 'Search failed. Please try again.';
            }
          });

      if (isTextQuery) {
        tasks.push(
          runDirectoryQuery(
            query(
              collection(db, 'userDirectory'),
              where('usernameLower', '>=', qLower),
              where('usernameLower', '<=', `${qLower}\uf8ff`),
              limit(10)
            )
          )
        );

        tasks.push(
          runDirectoryQuery(
            query(
              collection(db, 'userDirectory'),
              where('discoverableEmail', '>=', qLower),
              where('discoverableEmail', '<=', `${qLower}\uf8ff`),
              limit(10)
            )
          )
        );

        if (!qLower.includes('@') && !isPhoneQuery) {
          const titleCase = cleaned
            .split(/\s+/)
            .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase() : ''))
            .join(' ');
          const capFirst = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
          const nameVariants = Array.from(new Set([cleaned, capFirst, titleCase])).filter(
            (v) => v.length >= 2
          );
          for (const variant of nameVariants) {
            tasks.push(
              runDirectoryQuery(
                query(
                  collection(db, 'userDirectory'),
                  where('fullName', '>=', variant),
                  where('fullName', '<=', `${variant}\uf8ff`),
                  limit(10)
                )
              )
            );
          }
        }
      }

      if (isPhoneQuery) {
        const phoneCandidateSet = new Set<string>([
          strippedPhone,
          pureDigits,
          `+${pureDigits}`,
        ]);
        if (pureDigits.startsWith('0') && pureDigits.length >= 7) {
          phoneCandidateSet.add(`+88${pureDigits}`);
          phoneCandidateSet.add(`88${pureDigits}`);
          phoneCandidateSet.add(`+880${pureDigits}`);
          phoneCandidateSet.add(pureDigits.slice(1));
        }
        if (pureDigits.startsWith('880') && pureDigits.length >= 9) {
          phoneCandidateSet.add(`+${pureDigits}`);
          phoneCandidateSet.add(`0${pureDigits.slice(3)}`);
          phoneCandidateSet.add(pureDigits.slice(3));
        }
        if (pureDigits.length === 10 && pureDigits.startsWith('1')) {
          phoneCandidateSet.add(`+880${pureDigits}`);
          phoneCandidateSet.add(`0${pureDigits}`);
        }

        const phoneCandidates = Array.from(phoneCandidateSet)
          .filter((val) => val.length >= 6 && val.length <= 32)
          .slice(0, 8);

        for (const phoneVal of phoneCandidates) {
          tasks.push(
            runDirectoryQuery(
              query(
                collection(db, 'userDirectory'),
                where('discoverablePhone', '>=', phoneVal),
                where('discoverablePhone', '<=', `${phoneVal}\uf8ff`),
                limit(5)
              )
            )
          );
        }
      }

      // Also match already-added contacts locally by full name or username
      for (const c of contacts) {
        const p = peerProfiles[c.contactUserId];
        if (
          p &&
          p.uid !== firebaseUser.uid &&
          (p.fullName.toLowerCase().includes(qLower) || p.usernameLower.includes(qLower))
        ) {
          foundMap.set(p.uid, p);
        }
      }

      await Promise.all(tasks);
      const nowMs = Date.now();
      const list = Array.from(foundMap.values()).map((item) => ({
        ...item,
        onlineStatus: resolveActiveStatus(item.onlineStatus, item.lastSeen, nowMs),
      }));
      if (list.length > 0) {
        setPeerProfiles((prev) => {
          const next = { ...prev };
          for (const item of list) next[item.uid] = item;
          return next;
        });
      }
      return {
        results: list,
        matchedSelf,
        error: list.length === 0 && !matchedSelf ? firstError : null,
      };
    },
    [contacts, firebaseUser, peerProfiles]
  );

  useEffect(() => {
    const trimmed = contactSearch.trim();
    if (!trimmed) {
      setContactSearchResults([]);
      setContactSearching(false);
      setContactSearchError(null);
      setContactSelfMatched(false);
      return;
    }
    let active = true;
    setContactSearching(true);
    setContactSearchError(null);
    const timer = window.setTimeout(() => {
      void searchUsersByQuery(trimmed).then(({ results, matchedSelf, error }) => {
        if (active) {
          setContactSearchResults(results);
          setContactSelfMatched(matchedSelf);
          setContactSearchError(error);
          setContactSearching(false);
        }
      });
    }, 300);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [contactSearch, searchUsersByQuery]);

  useEffect(() => {
    if (!showNewChatModal) {
      setNewChatResults([]);
      setNewChatSearching(false);
      setNewChatSearchError(null);
      setNewChatSelfMatched(false);
      return;
    }
    const trimmed = newChatSearch.trim();
    if (!trimmed) {
      setNewChatResults([]);
      setNewChatSearching(false);
      setNewChatSearchError(null);
      setNewChatSelfMatched(false);
      return;
    }
    let active = true;
    setNewChatSearching(true);
    setNewChatSearchError(null);
    const timer = window.setTimeout(() => {
      void searchUsersByQuery(trimmed).then(({ results, matchedSelf, error }) => {
        if (active) {
          setNewChatResults(results);
          setNewChatSelfMatched(matchedSelf);
          setNewChatSearchError(error);
          setNewChatSearching(false);
        }
      });
    }, 300);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [newChatSearch, searchUsersByQuery, showNewChatModal]);

  // Connect real-time WebSocket for fast typing & call signal relay
  useEffect(() => {
    if (!firebaseUser || !isVerifiedSession) return;
    let active = true;
    let ws: WebSocket | null = null;

    (async () => {
      const token = await firebaseUser.getIdToken();
      if (!active) return;
      ws = new WebSocket(resolveWsUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        ws?.send(JSON.stringify({ type: 'auth', token }));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data)) as {
            type?: string;
            from?: string;
            chatId?: string;
            payload?: {
              typing?: boolean;
              kind?: string;
              callId?: string;
              callerName?: string;
              callType?: 'audio' | 'video';
            };
          };
          if (msg.type === 'typing' && msg.chatId) {
            setWsTypingMap((prev) => ({
              ...prev,
              [msg.chatId!]: Boolean(msg.payload?.typing),
            }));
          } else if (
            msg.type === 'call_signal' &&
            msg.payload?.kind === 'incoming_call' &&
            msg.payload.callId
          ) {
            const callId = msg.payload.callId;
            if (!notifiedCallIdsRef.current.has(callId)) {
              notifiedCallIdsRef.current.add(callId);
              window.ClaroAndroid?.showIncomingCallNotification?.(
                callId,
                msg.payload.callerName || 'Claro Contact',
                msg.payload.callType === 'video' ? 'video' : 'audio'
              );
            }
          }
        } catch {
          // Ignore malformed WS message
        }
      };
    })();

    return () => {
      active = false;
      ws?.close();
      wsRef.current = null;
    };
  }, [firebaseUser, isVerifiedSession]);

  const sendWsTyping = useCallback((to: string, chatId: string, typing: boolean) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'typing', to, chatId, payload: { typing } }));
    }
  }, []);

  const sendWsSignal = useCallback((to: string, payload: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'call_signal', to, payload }));
    }
  }, []);

  const directoryByUid = useMemo(() => {
    const map = new Map<string, UserDirectoryEntry>();
    for (const [uid, entry] of Object.entries(peerProfiles)) {
      map.set(uid, {
        ...entry,
        onlineStatus: resolveActiveStatus(entry.onlineStatus, entry.lastSeen, presenceNow),
      });
    }
    return map;
  }, [peerProfiles, presenceNow]);

  const blockedSet = useMemo(() => new Set(blockedUsers.map((b) => b.blockedUserId)), [blockedUsers]);
  const contactSet = useMemo(() => new Set(contacts.map((c) => c.contactUserId)), [contacts]);
  const knownContactsList = useMemo(() => {
    return contacts
      .map((c) => directoryByUid.get(c.contactUserId))
      .filter((u): u is UserDirectoryEntry => Boolean(u && u.accountStatus === 'active'));
  }, [contacts, directoryByUid]);

  const knownCallPeersList = useMemo(() => {
    if (!firebaseUser) return [];
    const seen = new Set<string>();
    const list: UserDirectoryEntry[] = [];
    for (const u of knownContactsList) {
      if (!seen.has(u.uid)) {
        seen.add(u.uid);
        list.push(u);
      }
    }
    for (const ch of chats) {
      const peerUid = ch.participantA === firebaseUser.uid ? ch.participantB : ch.participantA;
      const p = directoryByUid.get(peerUid);
      if (p && !seen.has(p.uid)) {
        seen.add(p.uid);
        list.push(p);
      }
    }
    return list;
  }, [chats, directoryByUid, firebaseUser, knownContactsList]);

  const openOrCreateChat = async (peer: UserDirectoryEntry) => {
    if (!firebaseUser) return;
    setPeerProfiles((prev) => ({ ...prev, [peer.uid]: peer }));
    const [pA, pB] = [firebaseUser.uid, peer.uid].sort();
    const chatId = `${pA}_${pB}`;

    const existingLocal = chats.find((c) => c.chatId === chatId) || optimisticChats[chatId];
    if (existingLocal) {
      setSelectedChatId(chatId);
      setActiveTab('chats');
      setShowNewChatModal(false);
      return;
    }

    try {
      let existsRemote = false;
      try {
        const existingSnap = await getDoc(doc(db, 'chats', chatId));
        existsRemote = existingSnap.exists();
        if (existsRemote) {
          const remoteChat = existingSnap.data() as ChatDoc;
          setOptimisticChats((prev) => ({ ...prev, [chatId]: remoteChat }));
        }
      } catch {
        // Proceed to create if read failed on missing doc
      }

      if (!existsRemote) {
        const draftChat: ChatDoc = {
          chatId,
          participantIds: [pA, pB],
          participantA: pA,
          participantB: pB,
          unreadA: 0,
          unreadB: 0,
          typingA: false,
          typingB: false,
          isE2EE: true,
          createdAt: Timestamp.now(),
          updatedAt: Timestamp.now(),
        };
        setOptimisticChats((prev) => ({ ...prev, [chatId]: draftChat }));
        await setDoc(doc(db, 'chats', chatId), {
          chatId,
          participantIds: [pA, pB],
          participantA: pA,
          participantB: pB,
          unreadA: 0,
          unreadB: 0,
          typingA: false,
          typingB: false,
          isE2EE: true,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
      setSelectedChatId(chatId);
      setActiveTab('chats');
      setShowNewChatModal(false);
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `chats/${chatId}`);
    }
  };

  const handleStartCall = async (peer: UserDirectoryEntry, callType: 'audio' | 'video') => {
    if (!firebaseUser) return;
    if (callType === 'video' && dataMode === 'text_only') {
      return;
    }
    setPeerProfiles((prev) => ({ ...prev, [peer.uid]: peer }));
    const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const callPayload = {
      callId,
      callerId: firebaseUser.uid,
      receiverId: peer.uid,
      participantIds: [firebaseUser.uid, peer.uid] as [string, string],
      callType,
      callStatus: 'ringing' as const,
      startedAt: serverTimestamp(),
      duration: 0,
      updatedAt: serverTimestamp(),
    };

    try {
      await setDoc(doc(db, 'calls', callId), callPayload);
      sendWsSignal(peer.uid, {
        kind: 'incoming_call',
        callId,
        callerName: userProfile?.fullName || 'Claro Contact',
        callType,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `calls/${callId}`);
    }
  };

  const handleAddContact = async (peer: UserDirectoryEntry) => {
    if (!firebaseUser || peer.uid === firebaseUser.uid) return;
    const contactDocId = `${firebaseUser.uid}_${peer.uid}`;
    try {
      await setDoc(doc(db, 'contacts', contactDocId), {
        userId: firebaseUser.uid,
        contactUserId: peer.uid,
        nickname: peer.fullName,
        createdAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `contacts/${contactDocId}`);
    }
  };

  const handleRemoveContact = async (peerUid: string) => {
    if (!firebaseUser) return;
    const contactDocId = `${firebaseUser.uid}_${peerUid}`;
    try {
      await deleteDoc(doc(db, 'contacts', contactDocId));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `contacts/${contactDocId}`);
    }
  };

  const handleToggleBlock = async (peerUid: string, currentlyBlocked: boolean) => {
    if (!firebaseUser) return;
    const blockId = `${firebaseUser.uid}_${peerUid}`;
    try {
      if (currentlyBlocked) {
        await deleteDoc(doc(db, 'blockedUsers', blockId));
      } else {
        await setDoc(doc(db, 'blockedUsers', blockId), {
          userId: firebaseUser.uid,
          blockedUserId: peerUid,
          reason: 'Blocked by user',
          createdAt: serverTimestamp(),
        });
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `blockedUsers/${blockId}`);
    }
  };

  const handleSubmitReport = async (peerUid: string, reason: string, details: string) => {
    if (!firebaseUser) return;
    const reportId = `rep_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    try {
      await setDoc(doc(db, 'reports', reportId), {
        reportId,
        reporterId: firebaseUser.uid,
        reportedUserId: peerUid,
        reason: reason.slice(0, VALIDATION_LIMITS.REPORT_REASON_MAX),
        details: details.slice(0, VALIDATION_LIMITS.REPORT_DETAILS_MAX),
        status: 'pending',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `reports/${reportId}`);
    }
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firebaseUser || !userProfile) return;
    setSettingsMsg(null);

    const cleanName = editFullName.trim().slice(0, VALIDATION_LIMITS.NAME_MAX);
    const cleanUser = editUsername.trim().replace(/^@/, '');
    if (!cleanName || !VALIDATION_LIMITS.USERNAME_REGEX.test(cleanUser) || cleanUser.length < 2) {
      setSettingsMsg('Username must be 2-40 characters (letters, numbers, underscore, dot).');
      return;
    }

    const cleanPhone = editPhoneNumber.trim().replace(/[\s\-().]/g, '').slice(0, 32);
    if (cleanPhone && !/^\+?[0-9]{6,20}$/.test(cleanPhone)) {
      setSettingsMsg('Please enter a valid mobile number (6-20 digits, optional + prefix).');
      return;
    }

    const shouldEnablePhone = Boolean(cleanPhone) && (Boolean(userProfile.showPhone) || !userProfile.phoneNumber);

    try {
      await updateProfile(firebaseUser, { displayName: cleanName });
      await updateDoc(doc(db, 'users', firebaseUser.uid), {
        fullName: cleanName,
        username: cleanUser,
        phoneNumber: cleanPhone,
        about: editAbout.trim().slice(0, VALIDATION_LIMITS.ABOUT_MAX),
        updatedAt: serverTimestamp(),
      });
      if (shouldEnablePhone && !userProfile.showPhone) {
        await updateDoc(doc(db, 'users', firebaseUser.uid), {
          showPhone: true,
          updatedAt: serverTimestamp(),
        });
      }
      await updateDoc(doc(db, 'userDirectory', firebaseUser.uid), {
        fullName: cleanName,
        username: cleanUser,
        usernameLower: cleanUser.toLowerCase(),
        about: editAbout.trim().slice(0, VALIDATION_LIMITS.ABOUT_MAX),
        discoverablePhone: shouldEnablePhone ? cleanPhone : '',
        updatedAt: serverTimestamp(),
      });
      setSettingsMsg('Profile updated.');
    } catch (err) {
      setSettingsMsg(err instanceof Error ? err.message : 'Failed to update profile.');
    }
  };

  const handleProfilePictureChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !firebaseUser) return;
    try {
      const compressed = await compressImageFile(file, Boolean(userProfile?.lowDataMode));
      const uploaded = await uploadAttachment(compressed.blob, compressed.name, compressed.mime);
      await updateProfile(firebaseUser, { photoURL: uploaded.url });
      await updateDoc(doc(db, 'users', firebaseUser.uid), {
        profilePicture: uploaded.url,
        updatedAt: serverTimestamp(),
      });
      await updateDoc(doc(db, 'userDirectory', firebaseUser.uid), {
        profilePicture: uploaded.url,
        updatedAt: serverTimestamp(),
      });
      setSettingsMsg('Profile photo updated.');
    } catch (err) {
      setSettingsMsg(err instanceof Error ? err.message : 'Could not update photo.');
    }
  };

  const handleTogglePreference = async (
    key: 'showEmail' | 'showPhone' | 'showOnlineStatus' | 'readReceipts' | 'notificationsEnabled' | 'lowDataMode',
    nextVal: boolean
  ) => {
    if (!firebaseUser || !userProfile) return;
    try {
      if (key === 'notificationsEnabled' && nextVal && 'Notification' in window) {
        await Notification.requestPermission();
      }
      await updateDoc(doc(db, 'users', firebaseUser.uid), {
        [key]: nextVal,
        updatedAt: serverTimestamp(),
      });
      if (key === 'showEmail' || key === 'showPhone' || key === 'showOnlineStatus') {
        const showEmail = key === 'showEmail' ? nextVal : Boolean(userProfile.showEmail);
        const showPhone = key === 'showPhone' ? nextVal : Boolean(userProfile.showPhone);
        const showOnline = key === 'showOnlineStatus' ? nextVal : userProfile.showOnlineStatus !== false;
        const isActiveNow =
          document.visibilityState === 'visible' &&
          navigator.onLine !== false &&
          androidForegroundRef.current;
        const resolvedStatus: OnlineStatus = showOnline && isActiveNow ? 'online' : 'offline';
        if (key === 'showOnlineStatus') {
          showOnlineStatusRef.current = nextVal;
          await updateDoc(doc(db, 'users', firebaseUser.uid), {
            onlineStatus: resolvedStatus,
            lastSeen: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }
        await updateDoc(doc(db, 'userDirectory', firebaseUser.uid), {
          discoverableEmail: showEmail ? (userProfile.email || '').toLowerCase() : '',
          discoverablePhone: showPhone ? userProfile.phoneNumber || '' : '',
          onlineStatus: resolvedStatus,
          lastSeen: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `users/${firebaseUser.uid}`);
    }
  };

  const handleSelectDataMode = async (mode: DataMode) => {
    setDataMode(mode);
    localStorage.setItem('claro_data_mode', mode);
    if (!firebaseUser) return;
    try {
      await updateDoc(doc(db, 'users', firebaseUser.uid), {
        lowDataMode: mode !== 'standard',
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `users/${firebaseUser.uid}`);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firebaseUser || newPassword.length < 6) return;
    try {
      await updatePassword(firebaseUser, newPassword);
      setNewPassword('');
      setSettingsMsg('Password updated successfully.');
    } catch (err) {
      setSettingsMsg(
        err instanceof Error
          ? err.message
          : 'Please sign out and sign back in recently before changing your password.'
      );
    }
  };

  const handleLogout = async () => {
    if (firebaseUser) {
      const offlinePayload = {
        onlineStatus: 'offline',
        lastSeen: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      await Promise.all([
        updateDoc(doc(db, 'userDirectory', firebaseUser.uid), offlinePayload).catch(() => {}),
        updateDoc(doc(db, 'users', firebaseUser.uid), offlinePayload).catch(() => {}),
      ]);
    }
    await signOut(auth);
  };

  const handleDeleteAccount = async () => {
    if (!firebaseUser) return;
    try {
      await deleteDoc(doc(db, 'userDirectory', firebaseUser.uid));
      await deleteDoc(doc(db, 'users', firebaseUser.uid));
      await deleteUser(firebaseUser);
    } catch (err) {
      setSettingsMsg(
        err instanceof Error
          ? err.message
          : 'Re-authentication required before deleting account. Please sign out and sign in again.'
      );
      setDeleteConfirm(false);
    }
  };

  if (!authReady) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white dark:bg-[#0B1120]">
        <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!firebaseUser || !isVerifiedSession) {
    return <AuthView onPendingProfileMeta={setPendingMeta} />;
  }

  if (userProfile?.accountStatus === 'suspended') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-[#0B1120] p-6">
        <div className="max-w-md w-full rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 text-center space-y-4">
          <h2 className="font-display text-xl font-bold text-slate-900 dark:text-white">
            Account Suspended
          </h2>
          <p className="text-sm text-slate-600 dark:text-slate-300">
            Your Claro account has been suspended by an administrator for violating communication safety policies.
          </p>
          <button
            type="button"
            onClick={handleLogout}
            className="px-4 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
          >
            Sign Out
          </button>
        </div>
      </div>
    );
  }

  if (showAdmin && isAdminUser) {
    return <AdminDashboard currentUid={firebaseUser.uid} onExit={() => setShowAdmin(false)} />;
  }

  const selectedChat =
    chats.find((c) => c.chatId === selectedChatId) ||
    (selectedChatId ? optimisticChats[selectedChatId] : null) ||
    null;
  const selectedPeer = selectedChat
    ? directoryByUid.get(
        selectedChat.participantA === firebaseUser.uid
          ? selectedChat.participantB
          : selectedChat.participantA
      ) || null
    : null;

  const filteredChats = chats.filter((c) => {
    const pUid = c.participantA === firebaseUser.uid ? c.participantB : c.participantA;
    const p = directoryByUid.get(pUid);
    if (!chatSearch.trim()) return true;
    const q = chatSearch.toLowerCase();
    return (
      p?.fullName.toLowerCase().includes(q) ||
      p?.usernameLower.includes(q) ||
      (c.lastMessage || '').toLowerCase().includes(q)
    );
  });

  const filteredDirectory = contactSearch.trim() ? contactSearchResults : knownContactsList;

  const unreadNotifications = notifications.filter((n) => !n.readStatus).length;

  return (
    <div className="h-screen flex flex-col lg:flex-row bg-white dark:bg-[#0B1120] text-slate-900 dark:text-slate-100 overflow-hidden">
      {/* Desktop Left Navigation Rail (Strictly 4 Primary Sections) */}
      <aside className="hidden lg:flex flex-col justify-between w-20 bg-slate-50 dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 py-5 items-center shrink-0">
        <div className="flex flex-col items-center gap-6">
          <div className="w-10 h-10 rounded-xl bg-blue-600 text-white font-display font-bold text-lg flex items-center justify-center">
            C
          </div>

          <nav className="flex flex-col gap-2" aria-label="Main Navigation">
            {(
              [
                { id: 'chats', label: 'Chats', icon: MessageSquare },
                { id: 'calls', label: 'Calls', icon: Phone },
                { id: 'contacts', label: 'Contacts', icon: Users },
                { id: 'settings', label: 'Settings', icon: SettingsIcon },
              ] as const
            ).map((item) => {
              const Icon = item.icon;
              const active = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveTab(item.id)}
                  className={`w-14 py-2.5 rounded-xl flex flex-col items-center gap-1 text-[11px] font-medium transition-colors ${
                    active
                      ? 'bg-blue-600 text-white'
                      : 'text-slate-500 dark:text-slate-400 hover:bg-slate-200/60 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  <Icon className="w-5 h-5" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        <div className="flex flex-col items-center gap-3">
          <button
            type="button"
            onClick={() => setShowAndroidModal(true)}
            aria-label="Play Store AAB and APK Export"
            title="Play Store .AAB / .APK Export"
            className="w-10 h-10 rounded-xl flex items-center justify-center bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-900/60"
          >
            <Smartphone className="w-5 h-5" />
          </button>
          {isAdminUser && (
            <button
              type="button"
              onClick={() => setShowAdmin(true)}
              aria-label="Admin Console"
              title="Open Admin Console"
              className="w-10 h-10 rounded-xl flex items-center justify-center bg-blue-50 dark:bg-blue-950/50 text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/60"
            >
              <ShieldCheck className="w-5 h-5" />
            </button>
          )}
          <button
            type="button"
            onClick={() => setDarkMode((d) => !d)}
            aria-label="Toggle theme"
            className="w-10 h-10 rounded-xl flex items-center justify-center text-slate-500 hover:bg-slate-200/60 dark:hover:bg-slate-800"
          >
            {darkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('settings')}
            aria-label="Profile settings"
          >
            <Avatar
              name={userProfile?.fullName || 'Me'}
              src={userProfile?.profilePicture}
              size="sm"
              onlineStatus={resolveActiveStatus(
                userProfile?.onlineStatus,
                userProfile?.lastSeen,
                presenceNow,
                userProfile?.showOnlineStatus !== false
              )}
              showPresence={userProfile?.showOnlineStatus !== false}
            />
          </button>
        </div>
      </aside>

      {/* Main Content Workspace */}
      <div className="flex-1 flex min-w-0 min-h-0 relative">
        {/* Left List Column (Chats / Calls / Contacts / Settings Menu) */}
        <section
          className={`${
            selectedChat && activeTab === 'chats' ? 'hidden lg:flex' : 'flex'
          } flex-col w-full lg:w-96 border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60 min-h-0 shrink-0 pb-16 lg:pb-0`}
        >
          {/* Section Header */}
          <div className="h-16 px-5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between shrink-0">
            <h1 className="font-display font-bold text-xl tracking-tight capitalize">
              {activeTab}
            </h1>

            <div className="flex items-center gap-1.5 relative">
              <button
                type="button"
                onClick={() => setShowAndroidModal(true)}
                title="Play Store .AAB & .APK Download"
                className="px-2.5 py-1.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-400 text-xs font-medium flex items-center gap-1 hover:bg-emerald-100 dark:hover:bg-emerald-900/60"
              >
                <Smartphone className="w-3.5 h-3.5" />
                <span>APK / AAB</span>
              </button>
              {isAdminUser && (
                <button
                  type="button"
                  onClick={() => setShowAdmin(true)}
                  className="lg:hidden px-2.5 py-1.5 rounded-xl bg-blue-50 dark:bg-blue-950/50 text-blue-600 dark:text-blue-400 text-xs font-medium flex items-center gap-1"
                >
                  <ShieldCheck className="w-3.5 h-3.5" />
                  <span>Admin</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => setShowNotifications((s) => !s)}
                aria-label="Notifications"
                className="w-10 h-10 rounded-xl flex items-center justify-center text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 relative"
              >
                <Bell className="w-5 h-5" />
                {unreadNotifications > 0 && (
                  <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-blue-600" />
                )}
              </button>

              {activeTab === 'chats' && (
                <button
                  type="button"
                  onClick={() => setShowNewChatModal(true)}
                  aria-label="New chat"
                  className="w-10 h-10 rounded-xl bg-blue-600 text-white hover:bg-blue-700 flex items-center justify-center transition-colors"
                >
                  <Plus className="w-5 h-5" />
                </button>
              )}

              {/* Notifications Popover */}
              {showNotifications && (
                <div className="absolute right-0 top-12 z-40 w-80 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xl p-4">
                  <div className="flex items-center justify-between mb-3">
                    <span className="font-semibold text-sm">Notifications</span>
                    <button type="button" onClick={() => setShowNotifications(false)}>
                      <X className="w-4 h-4 text-slate-400" />
                    </button>
                  </div>
                  {notifications.length === 0 ? (
                    <p className="text-xs text-slate-500 py-4 text-center">No notifications yet.</p>
                  ) : (
                    <div className="space-y-2 max-h-64 overflow-y-auto">
                      {notifications.slice(0, 12).map((n) => (
                        <button
                          key={n.notificationId}
                          type="button"
                          onClick={async () => {
                            if (!n.readStatus) {
                              await updateDoc(doc(db, 'notifications', n.notificationId), {
                                readStatus: true,
                                updatedAt: serverTimestamp(),
                              });
                            }
                          }}
                          className={`w-full text-left p-2.5 rounded-xl text-xs transition-colors ${
                            n.readStatus
                              ? 'text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/50'
                              : 'bg-blue-50 dark:bg-blue-950/40 text-slate-900 dark:text-white'
                          }`}
                        >
                          <div className="font-semibold">{n.title}</div>
                          <div className="text-[11px] opacity-80 mt-0.5">{n.body}</div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Tab 1: CHATS */}
          {activeTab === 'chats' && (
            <div className="flex-1 flex flex-col min-h-0">
              <div className="p-4 border-b border-slate-100 dark:border-slate-800/70 space-y-2.5">
                <div className="relative">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
                  <input
                    type="text"
                    value={chatSearch}
                    onChange={(e) => setChatSearch(e.target.value)}
                    placeholder="Search conversations..."
                    className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-slate-100 dark:bg-slate-800/80 text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                  {(
                    [
                      { id: 'standard', label: 'HD Mode' },
                      { id: 'saver', label: 'Data Saver' },
                      { id: 'text_only', label: 'Text-Only' },
                    ] as const
                  ).map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => void handleSelectDataMode(m.id)}
                      className={`py-1.5 px-2 rounded-lg text-[11px] font-medium transition-colors border ${
                        dataMode === m.id
                          ? m.id === 'text_only'
                            ? 'bg-amber-600 border-amber-600 text-white'
                            : 'bg-blue-600 border-blue-600 text-white'
                          : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                      }`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex-1 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800/60">
                {filteredChats.length === 0 ? (
                  <div className="p-8 text-center space-y-3">
                    <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
                      No conversations yet
                    </p>
                    <p className="text-xs text-slate-500">
                      Start a private encrypted conversation from Contacts or tap New Chat.
                    </p>
                    <button
                      type="button"
                      onClick={() => setShowNewChatModal(true)}
                      className="px-4 py-2 rounded-xl bg-blue-600 text-white text-xs font-medium hover:bg-blue-700"
                    >
                      Start New Chat
                    </button>
                  </div>
                ) : (
                  filteredChats.map((chat) => {
                    const peerUid =
                      chat.participantA === firebaseUser.uid ? chat.participantB : chat.participantA;
                    const peer = directoryByUid.get(peerUid);
                    const unread =
                      chat.participantA === firebaseUser.uid ? chat.unreadA : chat.unreadB;
                    const timeStr = chat.lastMessageTime?.toDate
                      ? chat.lastMessageTime.toDate().toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })
                      : '';
                    const isSelected = selectedChatId === chat.chatId;

                    return (
                      <button
                        key={chat.chatId}
                        type="button"
                        onClick={() => setSelectedChatId(chat.chatId)}
                        className={`w-full px-5 py-3.5 flex items-center gap-3.5 text-left transition-colors ${
                          isSelected
                            ? 'bg-blue-50 dark:bg-blue-950/40'
                            : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'
                        }`}
                      >
                        <Avatar
                          name={peer?.fullName || 'Contact'}
                          src={peer?.profilePicture}
                          size="md"
                          onlineStatus={peer?.onlineStatus}
                          showPresence
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-semibold text-sm text-slate-900 dark:text-white truncate">
                              {peer?.fullName || 'Private Contact'}
                            </span>
                            <span className="text-[11px] text-slate-400 tabular-nums shrink-0">
                              {timeStr}
                            </span>
                          </div>
                          <div className="flex items-center justify-between gap-2 mt-0.5">
                            <span className="text-xs text-slate-500 dark:text-slate-400 truncate">
                              {chat.lastMessage || 'Conversation ready'}
                            </span>
                            {unread > 0 && (
                              <span className="min-w-5 h-5 px-1.5 rounded-full bg-blue-600 text-white text-[11px] font-semibold flex items-center justify-center tabular-nums">
                                {unread}
                              </span>
                            )}
                          </div>
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {/* Tab 2: CALLS */}
          {activeTab === 'calls' && (
            <div className="flex-1 overflow-y-auto">
              {/* Quick Audio & Video Call Launcher */}
              <div className="p-4 border-b border-slate-200 dark:border-slate-800 space-y-2.5">
                <div className="flex items-center justify-between">
                  <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                    Start HD Audio or Video Call
                  </h2>
                  {dataMode === 'text_only' && (
                    <span className="text-[11px] text-amber-600 dark:text-amber-400 font-medium">
                      Video paused (Text-Only)
                    </span>
                  )}
                </div>
                {knownCallPeersList.length === 0 ? (
                  <p className="text-xs text-slate-500">
                    No contacts added yet. Search and add someone in Contacts to start audio or video calls.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {knownCallPeersList
                      .slice(0, 12)
                      .map((person) => (
                        <div
                          key={person.uid}
                          className="flex items-center justify-between gap-2 p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/70 dark:border-slate-800"
                        >
                          <button
                            type="button"
                            onClick={() => void openOrCreateChat(person)}
                            className="flex items-center gap-2.5 min-w-0 flex-1 text-left hover:opacity-80"
                          >
                            <Avatar
                              name={person.fullName}
                              src={person.profilePicture}
                              size="sm"
                              onlineStatus={person.onlineStatus}
                              showPresence
                            />
                            <div className="min-w-0">
                              <div className="text-xs font-semibold truncate">{person.fullName}</div>
                              <div className="text-[11px] font-mono text-slate-500 truncate">
                                @{person.username}
                              </div>
                            </div>
                          </button>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              type="button"
                              onClick={() => void handleStartCall(person, 'audio')}
                              aria-label={`Audio call ${person.fullName}`}
                              className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium text-slate-700 dark:text-slate-200 hover:text-blue-600 flex items-center gap-1"
                            >
                              <Phone className="w-3.5 h-3.5" />
                              <span>Audio</span>
                            </button>
                            <button
                              type="button"
                              disabled={dataMode === 'text_only'}
                              onClick={() => void handleStartCall(person, 'video')}
                              aria-label={`Video call ${person.fullName}`}
                              title={
                                dataMode === 'text_only'
                                  ? 'Video calls paused in Text-Only Mode'
                                  : 'Start HD Video Call'
                              }
                              className="px-2.5 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 flex items-center gap-1 disabled:opacity-40"
                            >
                              <Video className="w-3.5 h-3.5" />
                              <span>Video</span>
                            </button>
                          </div>
                        </div>
                      ))}
                  </div>
                )}
              </div>

              {/* Call History */}
              <div className="divide-y divide-slate-100 dark:divide-slate-800/60">
                <div className="px-5 pt-4 pb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Recent Calls
                </div>
                {calls.length === 0 ? (
                  <div className="p-8 text-center space-y-2">
                    <PhoneCall className="w-8 h-8 text-blue-600 mx-auto opacity-80" />
                    <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
                      No recent calls
                    </p>
                    <p className="text-xs text-slate-500">
                      Use the Audio or Video buttons above or inside any chat.
                    </p>
                  </div>
                ) : (
                  calls.map((call) => {
                    const isOutgoing = call.callerId === firebaseUser.uid;
                    const peerUid = isOutgoing ? call.receiverId : call.callerId;
                    const peer = directoryByUid.get(peerUid);
                    const dateLabel = call.startedAt?.toDate
                      ? call.startedAt.toDate().toLocaleString([], {
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })
                      : '';

                    return (
                      <div
                        key={call.callId}
                        className="px-5 py-3.5 flex items-center justify-between gap-3"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <Avatar
                            name={peer?.fullName || 'Contact'}
                            src={peer?.profilePicture}
                            size="md"
                          />
                          <div className="min-w-0">
                            <div className="font-semibold text-sm truncate">
                              {peer?.fullName || 'Private Contact'}
                            </div>
                            <div className="text-xs text-slate-500 flex items-center gap-1.5 mt-0.5 tabular-nums">
                              {call.callStatus === 'missed' || call.callStatus === 'rejected' ? (
                                <PhoneMissed className="w-3.5 h-3.5 text-rose-500" />
                              ) : isOutgoing ? (
                                <PhoneOutgoing className="w-3.5 h-3.5 text-blue-600" />
                              ) : (
                                <PhoneIncoming className="w-3.5 h-3.5 text-emerald-600" />
                              )}
                              <span className="capitalize">{call.callStatus}</span>
                              <span aria-hidden="true">·</span>
                              <span>{call.duration > 0 ? `${call.duration}s` : call.callType}</span>
                              <span aria-hidden="true">·</span>
                              <span>{dateLabel}</span>
                            </div>
                          </div>
                        </div>
                        {peer && (
                          <div className="flex items-center gap-1 shrink-0">
                            <button
                              type="button"
                              onClick={() => void handleStartCall(peer, 'audio')}
                              aria-label="Call back audio"
                              className="w-9 h-9 rounded-xl flex items-center justify-center text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/40"
                            >
                              <Phone className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              disabled={dataMode === 'text_only'}
                              onClick={() => void handleStartCall(peer, 'video')}
                              aria-label="Call back video"
                              className="w-9 h-9 rounded-xl flex items-center justify-center text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/40 disabled:opacity-40"
                            >
                              <Video className="w-4 h-4" />
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {/* Tab 3: CONTACTS */}
          {activeTab === 'contacts' && (
            <div className="flex-1 flex flex-col min-h-0">
              <div className="p-4 border-b border-slate-100 dark:border-slate-800/70 space-y-1.5">
                <div className="relative">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
                  <input
                    type="text"
                    value={contactSearch}
                    onChange={(e) => setContactSearch(e.target.value)}
                    placeholder="Search @username, email, or phone to find & add"
                    className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-slate-100 dark:bg-slate-800/80 text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <p className="text-[11px] text-slate-400 px-1">
                  Other accounts stay private. Search an exact @username, email, or phone number to add someone you know.
                </p>
              </div>

              <div className="flex-1 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800/60">
                {contactSearching ? (
                  <div className="p-8 text-center text-xs text-slate-500">
                    Searching private directory...
                  </div>
                ) : contactSearchError ? (
                  <div className="p-8 text-center text-xs text-rose-600 dark:text-rose-400">
                    {contactSearchError}
                  </div>
                ) : filteredDirectory.length === 0 ? (
                  <div className="p-8 text-center text-xs text-slate-500">
                    {contactSearch.trim()
                      ? contactSearch.trim().replace(/^@/, '').length < 2 &&
                        contactSearch.replace(/[^0-9]/g, '').length < 6
                        ? 'Type at least 2 characters of name/@username/email, or a mobile number.'
                        : contactSelfMatched
                          ? 'This matches your own account. Search another user by @username, Gmail, or mobile number.'
                          : 'No matching account found.'
                      : 'No saved contacts yet. Search by @username, email, or phone above to add someone.'}
                  </div>
                ) : (
                  filteredDirectory.map((person) => {
                    const isSaved = contactSet.has(person.uid);
                    return (
                      <div
                        key={person.uid}
                        className="px-5 py-3.5 flex items-center justify-between gap-3 hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors"
                      >
                        <button
                          type="button"
                          onClick={() => void openOrCreateChat(person)}
                          className="flex items-center gap-3 min-w-0 flex-1 text-left"
                        >
                          <Avatar
                            name={person.fullName}
                            src={person.profilePicture}
                            size="md"
                            onlineStatus={person.onlineStatus}
                            showPresence
                          />
                          <div className="min-w-0">
                            <div className="font-semibold text-sm truncate hover:text-blue-600 dark:hover:text-blue-400">
                              {person.fullName}
                            </div>
                            <div className="text-xs font-mono text-slate-500 truncate">
                              @{person.username}
                            </div>
                          </div>
                        </button>

                        <div className="flex items-center gap-1 shrink-0">
                          {!isSaved ? (
                            <button
                              type="button"
                              onClick={() => void handleAddContact(person)}
                              aria-label="Add contact"
                              className="px-2 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-1"
                            >
                              <UserPlus className="w-3.5 h-3.5" />
                              <span>Add</span>
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => void handleRemoveContact(person.uid)}
                              className="px-2 py-1.5 rounded-lg text-xs text-slate-400 hover:text-rose-600"
                            >
                              Remove
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => void handleStartCall(person, 'audio')}
                            aria-label="Audio call contact"
                            title="Audio Call"
                            className="w-8 h-8 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:text-blue-600 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center justify-center"
                          >
                            <Phone className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            disabled={dataMode === 'text_only'}
                            onClick={() => void handleStartCall(person, 'video')}
                            aria-label="Video call contact"
                            title={
                              dataMode === 'text_only'
                                ? 'Video calls paused in Text-Only Mode'
                                : 'Video Call'
                            }
                            className="w-8 h-8 rounded-xl border border-slate-200 dark:border-slate-700 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/40 flex items-center justify-center disabled:opacity-40"
                          >
                            <Video className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void openOrCreateChat(person)}
                            aria-label="Message contact"
                            title="Message"
                            className="w-8 h-8 rounded-xl bg-blue-600 text-white hover:bg-blue-700 flex items-center justify-center"
                          >
                            <MessageSquare className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {/* Tab 4: SETTINGS (Mobile & Left Rail) */}
          {activeTab === 'settings' && (
            <div className="flex-1 overflow-y-auto p-5 space-y-6">
              {/* Profile Card */}
              <div className="flex items-center gap-4">
                <div className="relative">
                  <Avatar
                    name={userProfile?.fullName || 'User'}
                    src={userProfile?.profilePicture}
                    size="lg"
                    onlineStatus={resolveActiveStatus(
                      userProfile?.onlineStatus,
                      userProfile?.lastSeen,
                      presenceNow,
                      userProfile?.showOnlineStatus !== false
                    )}
                    showPresence={userProfile?.showOnlineStatus !== false}
                  />
                  <input
                    ref={profilePicInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handleProfilePictureChange}
                    className="hidden"
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-display font-bold text-base truncate">
                    {userProfile?.fullName}
                  </div>
                  <div className="text-xs font-mono text-slate-500 truncate">
                    @{userProfile?.username}
                  </div>
                  <button
                    type="button"
                    onClick={() => profilePicInputRef.current?.click()}
                    className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline mt-1"
                  >
                    Change profile picture
                  </button>
                </div>
              </div>

              {settingsMsg && (
                <div className="rounded-xl bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-900 p-3 text-xs text-blue-700 dark:text-blue-300">
                  {settingsMsg}
                </div>
              )}

              {/* Edit Profile Form */}
              <form onSubmit={handleSaveProfile} className="space-y-3 pt-2 border-t border-slate-200 dark:border-slate-800">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Profile
                </h2>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Display Name</label>
                  <input
                    type="text"
                    maxLength={VALIDATION_LIMITS.NAME_MAX}
                    value={editFullName}
                    onChange={(e) => setEditFullName(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Username</label>
                  <input
                    type="text"
                    maxLength={VALIDATION_LIMITS.USERNAME_MAX}
                    value={editUsername}
                    onChange={(e) => setEditUsername(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">
                    Mobile Number (optional, lets friends find you)
                  </label>
                  <input
                    type="tel"
                    maxLength={32}
                    placeholder="e.g. +8801712345678 or 01712345678"
                    value={editPhoneNumber}
                    onChange={(e) => setEditPhoneNumber(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">About</label>
                  <input
                    type="text"
                    maxLength={VALIDATION_LIMITS.ABOUT_MAX}
                    value={editAbout}
                    onChange={(e) => setEditAbout(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm"
                  />
                </div>
                <div className="text-[11px] text-slate-400 font-mono">
                  UID: {firebaseUser.uid}
                </div>
                <button
                  type="submit"
                  className="w-full py-2 rounded-xl bg-blue-600 text-white text-xs font-medium hover:bg-blue-700"
                >
                  Save Profile
                </button>
              </form>

              {/* Privacy, Notifications, Data & Theme */}
              <div className="space-y-3 pt-4 border-t border-slate-200 dark:border-slate-800 text-sm">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Privacy, Notifications &amp; Appearance
                </h2>

                <label className="flex items-center justify-between py-1 cursor-pointer">
                  <span>Dark Mode</span>
                  <input
                    type="checkbox"
                    checked={darkMode}
                    onChange={(e) => setDarkMode(e.target.checked)}
                  />
                </label>
                <label className="flex items-center justify-between py-1 cursor-pointer">
                  <span>Show Online Status</span>
                  <input
                    type="checkbox"
                    checked={userProfile?.showOnlineStatus !== false}
                    onChange={(e) => void handleTogglePreference('showOnlineStatus', e.target.checked)}
                  />
                </label>
                <label className="flex items-center justify-between py-1 cursor-pointer">
                  <span>Read Receipts</span>
                  <input
                    type="checkbox"
                    checked={userProfile?.readReceipts !== false}
                    onChange={(e) => void handleTogglePreference('readReceipts', e.target.checked)}
                  />
                </label>
                <label className="flex items-center justify-between py-1 cursor-pointer">
                  <span>Discoverable by Email</span>
                  <input
                    type="checkbox"
                    checked={Boolean(userProfile?.showEmail)}
                    onChange={(e) => void handleTogglePreference('showEmail', e.target.checked)}
                  />
                </label>
                <label className="flex items-center justify-between py-1 cursor-pointer">
                  <span>Discoverable by Phone</span>
                  <input
                    type="checkbox"
                    checked={Boolean(userProfile?.showPhone)}
                    onChange={(e) => void handleTogglePreference('showPhone', e.target.checked)}
                  />
                </label>
                <label className="flex items-center justify-between py-1 cursor-pointer">
                  <span>Push Notifications</span>
                  <input
                    type="checkbox"
                    checked={userProfile?.notificationsEnabled !== false}
                    onChange={(e) =>
                      void handleTogglePreference('notificationsEnabled', e.target.checked)
                    }
                  />
                </label>
                {/* Mobile Data & Zero-MB Mode Selector */}
                <div className="pt-3 border-t border-slate-100 dark:border-slate-800 space-y-2">
                  <div className="flex items-center gap-2 font-medium text-xs text-slate-700 dark:text-slate-200">
                    <Wifi className="w-4 h-4 text-blue-600" />
                    <span>Mobile Data &amp; Zero-MB Mode</span>
                  </div>
                  <div className="space-y-1.5">
                    {(
                      [
                        {
                          id: 'standard',
                          title: 'Standard HD',
                          desc: 'Full quality photos, videos & HD video calls.',
                        },
                        {
                          id: 'saver',
                          title: 'Mobile Data Saver (3G/4G)',
                          desc: 'Compresses photos & saves mobile MB during media/calls.',
                        },
                        {
                          id: 'text_only',
                          title: 'Text-Only Mode (Zero-MB / Offline Sync)',
                          desc: 'Pauses video calls & media downloads; text messages queue and sync.',
                        },
                      ] as const
                    ).map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => void handleSelectDataMode(opt.id)}
                        className={`w-full text-left p-2.5 rounded-xl border transition-colors ${
                          dataMode === opt.id
                            ? 'border-blue-600 bg-blue-50/70 dark:bg-blue-950/30'
                            : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/40'
                        }`}
                      >
                        <div className="text-xs font-semibold text-slate-900 dark:text-white">
                          {opt.title}
                        </div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                          {opt.desc}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Password Change (Email accounts) */}
              {firebaseUser.providerData.some((p) => p.providerId === 'password') && (
                <form
                  onSubmit={handleChangePassword}
                  className="space-y-2 pt-4 border-t border-slate-200 dark:border-slate-800"
                >
                  <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                    Security
                  </h2>
                  <input
                    type="password"
                    minLength={6}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="New password (min 6 chars)"
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm"
                  />
                  <button
                    type="submit"
                    className="w-full py-2 rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    Change Password
                  </button>
                </form>
              )}

              {/* Blocked Users List */}
              {blockedUsers.length > 0 && (
                <div className="space-y-2 pt-4 border-t border-slate-200 dark:border-slate-800">
                  <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                    Blocked Users
                  </h2>
                  {blockedUsers.map((b) => {
                    const p = directoryByUid.get(b.blockedUserId);
                    return (
                      <div key={b.blockedUserId} className="flex items-center justify-between text-xs py-1">
                        <span>{p?.fullName || b.blockedUserId}</span>
                        <button
                          type="button"
                          onClick={() => void handleToggleBlock(b.blockedUserId, true)}
                          className="text-blue-600 hover:underline"
                        >
                          Unblock
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Android Native Source & Admin Console */}
              <div className="space-y-2.5 pt-4 border-t border-slate-200 dark:border-slate-800">
                <PWAInstallButton />

                <button
                  type="button"
                  onClick={() => setShowAndroidModal(true)}
                  className="w-full py-2.5 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium flex items-center justify-center gap-2 transition-colors"
                >
                  <Smartphone className="w-4 h-4" />
                  <span>Play Store .AAB &amp; .APK Download Center</span>
                </button>

                {isAdminUser && (
                  <button
                    type="button"
                    onClick={() => setShowAdmin(true)}
                    className="w-full py-2.5 px-4 rounded-xl bg-slate-900 dark:bg-blue-600 text-white text-xs font-medium flex items-center justify-center gap-2 hover:opacity-90"
                  >
                    <ShieldCheck className="w-4 h-4" />
                    <span>Open Admin Console</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={handleLogout}
                  className="w-full py-2.5 px-4 rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-medium flex items-center justify-center gap-2 hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  <LogOut className="w-4 h-4" />
                  <span>Sign Out</span>
                </button>

                {!deleteConfirm ? (
                  <button
                    type="button"
                    onClick={() => setDeleteConfirm(true)}
                    className="w-full py-2 text-xs text-rose-600 hover:underline flex items-center justify-center gap-1.5"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Delete Account</span>
                  </button>
                ) : (
                  <div className="rounded-xl border border-rose-200 dark:border-rose-900 p-3 space-y-2 text-xs">
                    <p className="text-rose-600 dark:text-rose-400">
                      Permanently delete your Claro account and profile?
                    </p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setDeleteConfirm(false)}
                        className="flex-1 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={handleDeleteAccount}
                        className="flex-1 py-1.5 rounded-lg bg-rose-600 text-white font-medium"
                      >
                        Confirm Delete
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </section>

        {/* Right Active Conversation / Detail Workspace */}
        <main
          className={`${
            selectedChat && activeTab === 'chats' ? 'flex' : 'hidden lg:flex'
          } flex-1 flex-col min-w-0 min-h-0 bg-slate-50 dark:bg-[#0B1120]`}
        >
          {selectedChat && activeTab === 'chats' ? (
            <ChatWindow
              chat={selectedChat}
              currentUid={firebaseUser.uid}
              currentUserProfile={{
                fullName: userProfile?.fullName || 'Me',
                readReceipts: userProfile?.readReceipts !== false,
                lowDataMode: dataMode !== 'standard',
              }}
              dataMode={dataMode}
              myPrivateKey={myPrivateKey}
              peer={selectedPeer}
              isBlocked={Boolean(selectedPeer && blockedSet.has(selectedPeer.uid))}
              allContacts={knownContactsList}
              onBackMobile={() => setSelectedChatId(null)}
              onStartCall={handleStartCall}
              onToggleBlock={handleToggleBlock}
              onSubmitReport={handleSubmitReport}
              sendWsTyping={sendWsTyping}
              wsPeerTyping={wsTypingMap[selectedChat.chatId]}
            />
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center p-10 text-center">
              <div className="w-72 aspect-[4/3] rounded-2xl overflow-hidden border border-slate-200 dark:border-slate-800 mb-6 shadow-xs">
                <img
                  src="/src/assets/images/empty_chat_calm_1795754653156.jpg"
                  alt="Private encrypted messaging workspace"
                  referrerPolicy="no-referrer"
                  className="w-full h-full object-cover"
                />
              </div>
              <h2 className="font-display text-2xl font-bold text-slate-900 dark:text-white mb-2">
                Select a private conversation
              </h2>
              <p className="text-sm text-slate-600 dark:text-slate-400 max-w-md mb-6">
                Send encrypted messages, share photos, videos &amp; voice notes, or launch a 1-to-1 HD audio or video call.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-3 mb-6">
                <button
                  type="button"
                  onClick={() => setShowNewChatModal(true)}
                  className="px-4 py-2.5 rounded-xl bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 flex items-center gap-2"
                >
                  <Plus className="w-4 h-4" />
                  <span>Start Private Chat</span>
                </button>
                <button
                  type="button"
                  onClick={() => setShowAndroidModal(true)}
                  className="px-4 py-2.5 rounded-xl bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700 flex items-center gap-2"
                >
                  <Smartphone className="w-4 h-4" />
                  <span>Play Store .AAB / .APK</span>
                </button>
                {isAdminUser && (
                  <button
                    type="button"
                    onClick={() => setShowAdmin(true)}
                    className="px-4 py-2.5 rounded-xl bg-slate-900 dark:bg-slate-800 text-white text-xs font-medium hover:opacity-90 flex items-center gap-2"
                  >
                    <ShieldCheck className="w-4 h-4" />
                    <span>Open Admin Console</span>
                  </button>
                )}
                <PWAInstallButton compact />
              </div>
              <div className="flex items-center gap-4 text-xs text-slate-500 dark:text-slate-400">
                <span className="inline-flex items-center gap-1.5">
                  <Lock className="w-3.5 h-3.5 text-blue-600" />
                  <span>ECDH P-256 + AES-GCM</span>
                </span>
                <span aria-hidden="true">·</span>
                <span className="inline-flex items-center gap-1.5">
                  <Shield className="w-3.5 h-3.5 text-blue-600" />
                  <span>Zero social feeds</span>
                </span>
              </div>
              {myPublicJwk && (
                <p className="mt-4 text-[11px] font-mono text-slate-400">
                  Device key fingerprint: {myPublicJwk.slice(12, 36)}...
                </p>
              )}
            </div>
          )}
        </main>
      </div>

      <OfflineIndicator />

      {/* Mobile Fixed Bottom Navigation (Strictly 4 Sections: Chats, Calls, Contacts, Settings) */}
      {!(selectedChat && activeTab === 'chats') && (
        <nav
          aria-label="Mobile Navigation"
          className="lg:hidden fixed bottom-0 left-0 right-0 z-30 h-16 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md border-t border-slate-200 dark:border-slate-800 grid grid-cols-4 items-center"
        >
          {(
            [
              { id: 'chats', label: 'Chats', icon: MessageSquare },
              { id: 'calls', label: 'Calls', icon: Phone },
              { id: 'contacts', label: 'Contacts', icon: Users },
              { id: 'settings', label: 'Settings', icon: SettingsIcon },
            ] as const
          ).map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setSelectedChatId(null);
                  setActiveTab(item.id);
                }}
                className={`h-full flex flex-col items-center justify-center gap-1 text-[11px] font-medium ${
                  active ? 'text-blue-600 dark:text-blue-400' : 'text-slate-500 dark:text-slate-400'
                }`}
              >
                <Icon className="w-5 h-5" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      )}

      {/* New Chat Contact Picker Modal (Private Search + Added Contacts Only) */}
      {showNewChatModal && (
        <div className="fixed inset-0 z-40 bg-slate-950/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl w-full max-w-md p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-display font-semibold text-base">Start Private Chat</h3>
              <button type="button" onClick={() => setShowNewChatModal(false)}>
                <X className="w-5 h-5 text-slate-400" />
              </button>
            </div>
            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
              <input
                type="text"
                value={newChatSearch}
                onChange={(e) => setNewChatSearch(e.target.value)}
                placeholder="Search @username, email, or phone..."
                className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-slate-100 dark:bg-slate-800/80 text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="space-y-2 max-h-80 overflow-y-auto">
              {newChatSearching ? (
                <p className="text-xs text-slate-500 py-6 text-center">Searching...</p>
              ) : (
                <>
                  {(newChatSearch.trim() ? newChatResults : knownContactsList).map((u) => {
                    const isSaved = contactSet.has(u.uid);
                    return (
                      <div
                        key={u.uid}
                        className="w-full flex items-center justify-between gap-2 p-2.5 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800"
                      >
                        <button
                          type="button"
                          onClick={() => void openOrCreateChat(u)}
                          className="flex items-center gap-3 min-w-0 flex-1 text-left"
                        >
                          <Avatar
                            name={u.fullName}
                            src={u.profilePicture}
                            size="sm"
                            onlineStatus={u.onlineStatus}
                            showPresence
                          />
                          <div className="min-w-0">
                            <div className="text-sm font-medium truncate">{u.fullName}</div>
                            <div className="text-xs font-mono text-slate-500 truncate">@{u.username}</div>
                          </div>
                        </button>
                        {!isSaved && (
                          <button
                            type="button"
                            onClick={() => void handleAddContact(u)}
                            className="px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium hover:bg-white dark:hover:bg-slate-900 shrink-0"
                          >
                            Add
                          </button>
                        )}
                      </div>
                    );
                  })}
                  {newChatSearchError && (
                    <p className="text-xs text-rose-600 dark:text-rose-400 py-4 text-center">
                      {newChatSearchError}
                    </p>
                  )}
                  {!newChatSearchError &&
                    (newChatSearch.trim() ? newChatResults : knownContactsList).length === 0 && (
                      <p className="text-xs text-slate-500 py-6 text-center">
                        {newChatSearch.trim()
                          ? newChatSelfMatched
                            ? 'This matches your own account. Search another user by @username, Gmail, or mobile number.'
                            : 'No matching user found. Enter @username, Gmail, or mobile number.'
                          : 'No saved contacts yet. Search above by @username, email, or phone number to start a private chat.'}
                      </p>
                    )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Active WebRTC HD Call Overlay */}
      {activeCall && (
        <CallOverlay
          activeCall={activeCall}
          currentUid={firebaseUser.uid}
          peer={
            directoryByUid.get(
              activeCall.callerId === firebaseUser.uid ? activeCall.receiverId : activeCall.callerId
            ) || null
          }
          autoAccept={autoAcceptCallId === activeCall.callId}
          onClose={() => {
            window.ClaroAndroid?.dismissIncomingCallNotification?.(activeCall.callId);
            setActiveCall(null);
            setAutoAcceptCallId(null);
          }}
          sendWsSignal={sendWsSignal}
        />
      )}

      {/* Android Native Source Explorer */}
      {showAndroidModal && <AndroidSourceModal onClose={() => setShowAndroidModal(false)} />}
    </div>
  );
}
