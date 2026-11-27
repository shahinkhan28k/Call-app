import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  collection,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import {
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  PictureInPicture2,
  RefreshCw,
  SwitchCamera,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
  Wifi,
} from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../firebase';
import { startRingtone, stopRingtone } from '../lib/sound';
import type { CallDoc, UserDirectoryEntry } from '../types';
import { Avatar } from './Avatar';

interface CallOverlayProps {
  activeCall: CallDoc;
  currentUid: string;
  peer: UserDirectoryEntry | null;
  onClose: () => void;
  sendWsSignal?: (to: string, payload: unknown) => void;
}

type QualityTier = 'auto' | 'hd' | 'saver';

export const CallOverlay: React.FC<CallOverlayProps> = ({
  activeCall,
  currentUid,
  peer,
  onClose,
  sendWsSignal,
}) => {
  const isCaller = activeCall.callerId === currentUid;
  const isVideo = activeCall.callType === 'video';

  const [callState, setCallState] = useState<CallDoc>(activeCall);
  const [micMuted, setMicMuted] = useState(false);
  const [camOff, setCamOff] = useState(false);
  const [speakerMuted, setSpeakerMuted] = useState(false);
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');
  const [qualityTier, setQualityTier] = useState<QualityTier>('auto');
  const [networkState, setNetworkState] = useState<'connecting' | 'good' | 'reconnecting'>('connecting');
  const [elapsedSec, setElapsedSec] = useState(0);
  const [mediaError, setMediaError] = useState<string | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const addedCandidatesRef = useRef<Set<string>>(new Set());
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const answeredRef = useRef(false);
  const offerSentRef = useRef(false);
  const connectedAtRef = useRef<number | null>(null);

  // Sync live call document updates
  useEffect(() => {
    const unsub = onSnapshot(
      doc(db, 'calls', activeCall.callId),
      (snap) => {
        if (snap.exists()) {
          const data = snap.data() as CallDoc;
          setCallState(data);
          if (data.callStatus === 'ended' || data.callStatus === 'rejected' || data.callStatus === 'missed') {
            stopRingtone();
            cleanupMedia();
            onClose();
          }
        }
      },
      (err) => handleFirestoreError(err, OperationType.GET, `calls/${activeCall.callId}`)
    );
    return () => unsub();
  }, [activeCall.callId, onClose]);

  // Ringtone for incoming ringing call
  useEffect(() => {
    if (!isCaller && callState.callStatus === 'ringing') {
      startRingtone();
    } else {
      stopRingtone();
    }
    return () => stopRingtone();
  }, [isCaller, callState.callStatus]);

  // Call duration timer
  useEffect(() => {
    if (callState.callStatus !== 'connected') return;
    if (!connectedAtRef.current) connectedAtRef.current = Date.now();
    const timer = window.setInterval(() => {
      if (connectedAtRef.current) {
        setElapsedSec(Math.floor((Date.now() - connectedAtRef.current) / 1000));
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [callState.callStatus]);

  const cleanupMedia = useCallback(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
  }, []);

  const applyAdaptiveBitrate = useCallback(async (tier: QualityTier) => {
    const pc = pcRef.current;
    if (!pc) return;
    let maxBitrate = 1_200_000;
    if (tier === 'saver') {
      maxBitrate = 250_000;
    } else if (tier === 'auto') {
      const nav = navigator as unknown as { connection?: { effectiveType?: string } };
      const net = nav.connection?.effectiveType;
      if (net === '2g' || net === 'slow-2g') maxBitrate = 180_000;
      else if (net === '3g') maxBitrate = 450_000;
      else maxBitrate = 1_200_000;
    }

    for (const sender of pc.getSenders()) {
      if (sender.track?.kind === 'video') {
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}];
        }
        params.encodings[0].maxBitrate = maxBitrate;
        try {
          await sender.setParameters(params);
        } catch {
          // Some browsers restrict setParameters before negotiation completes
        }
      }
    }
  }, []);

  const createPeerConnection = useCallback(async (): Promise<RTCPeerConnection> => {
    if (pcRef.current) return pcRef.current;

    let iceServers: RTCIceServer[] = [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    ];
    try {
      const res = await fetch('/api/ice-servers');
      if (res.ok) {
        const data = (await res.json()) as { iceServers?: RTCIceServer[] };
        if (data.iceServers?.length) iceServers = data.iceServers;
      }
    } catch {
      // Fallback to default STUN
    }

    const pc = new RTCPeerConnection({ iceServers });
    pcRef.current = pc;

    const remoteStream = new MediaStream();
    remoteStreamRef.current = remoteStream;

    pc.ontrack = (event) => {
      event.streams[0]?.getTracks().forEach((track) => {
        remoteStream.addTrack(track);
      });
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = remoteStream;
      }
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = remoteStream;
      }
    };

    pc.onicecandidate = async (event) => {
      if (!event.candidate) return;
      const candidateId = `${currentUid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const json = JSON.stringify(event.candidate.toJSON());
      try {
        await setDoc(doc(db, 'calls', activeCall.callId, 'candidates', candidateId), {
          candidateId,
          senderId: currentUid,
          participantIds: activeCall.participantIds,
          candidateJson: json,
          createdAt: serverTimestamp(),
        });
        sendWsSignal?.(isCaller ? activeCall.receiverId : activeCall.callerId, {
          callId: activeCall.callId,
          type: 'ice',
        });
      } catch {
        // Ignore late candidates after call closes
      }
    };

    pc.oniceconnectionstatechange = async () => {
      const state = pc.iceConnectionState;
      if (state === 'connected' || state === 'completed') {
        setNetworkState('good');
      } else if (state === 'disconnected' || state === 'failed') {
        setNetworkState('reconnecting');
        if (isCaller && state === 'failed') {
          try {
            const offer = await pc.createOffer({ iceRestart: true });
            await pc.setLocalDescription(offer);
            await updateDoc(doc(db, 'calls', activeCall.callId), {
              offerSdp: JSON.stringify(offer),
              updatedAt: serverTimestamp(),
            });
          } catch {
            // Reconnection attempt failed
          }
        }
      }
    };

    // Acquire local audio/video stream
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: isVideo
          ? {
              facingMode,
              width: { ideal: 1280 },
              height: { ideal: 720 },
            }
          : false,
      });
      localStreamRef.current = stream;
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));
      void applyAdaptiveBitrate(qualityTier);
    } catch (err) {
      setMediaError(
        err instanceof Error
          ? `Microphone/Camera access error: ${err.message}`
          : 'Could not access microphone or camera.'
      );
    }

    return pc;
  }, [
    activeCall.callId,
    activeCall.callerId,
    activeCall.participantIds,
    activeCall.receiverId,
    applyAdaptiveBitrate,
    currentUid,
    facingMode,
    isCaller,
    isVideo,
    qualityTier,
    sendWsSignal,
  ]);

  // Listen for remote ICE candidates
  useEffect(() => {
    const q = query(
      collection(db, 'calls', activeCall.callId, 'candidates'),
      where('participantIds', 'array-contains', currentUid)
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        snap.docChanges().forEach((change) => {
          if (change.type !== 'added') return;
          const data = change.doc.data() as {
            candidateId: string;
            senderId: string;
            candidateJson: string;
          };
          if (data.senderId === currentUid || addedCandidatesRef.current.has(data.candidateId)) {
            return;
          }
          addedCandidatesRef.current.add(data.candidateId);
          try {
            const candidateInit = JSON.parse(data.candidateJson) as RTCIceCandidateInit;
            const pc = pcRef.current;
            if (pc && pc.remoteDescription) {
              void pc.addIceCandidate(new RTCIceCandidate(candidateInit));
            } else {
              pendingIceRef.current.push(candidateInit);
            }
          } catch {
            // Invalid candidate JSON
          }
        });
      },
      () => {
        // Ignore candidate listener cleanup errors when call is deleted
      }
    );
    return () => unsub();
  }, [activeCall.callId, currentUid]);

  // Caller: initialize offer immediately
  useEffect(() => {
    if (!isCaller || offerSentRef.current) return;
    offerSentRef.current = true;
    (async () => {
      const pc = await createPeerConnection();
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      try {
        await updateDoc(doc(db, 'calls', activeCall.callId), {
          offerSdp: JSON.stringify(offer),
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, `calls/${activeCall.callId}`);
      }
    })();
  }, [activeCall.callId, createPeerConnection, isCaller]);

  // Caller: apply remote answer when receiver accepts
  useEffect(() => {
    if (!isCaller || !callState.answerSdp) return;
    const pc = pcRef.current;
    if (!pc || pc.currentRemoteDescription) return;
    (async () => {
      try {
        const answer = JSON.parse(callState.answerSdp!) as RTCSessionDescriptionInit;
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        while (pendingIceRef.current.length > 0) {
          const c = pendingIceRef.current.shift();
          if (c) await pc.addIceCandidate(new RTCIceCandidate(c));
        }
      } catch {
        // Ignore duplicate answer set
      }
    })();
  }, [callState.answerSdp, isCaller]);

  // Receiver: accept call
  const handleAcceptCall = async () => {
    if (answeredRef.current) return;
    answeredRef.current = true;
    stopRingtone();
    const pc = await createPeerConnection();
    if (callState.offerSdp) {
      const offer = JSON.parse(callState.offerSdp) as RTCSessionDescriptionInit;
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      while (pendingIceRef.current.length > 0) {
        const c = pendingIceRef.current.shift();
        if (c) await pc.addIceCandidate(new RTCIceCandidate(c));
      }
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      try {
        await updateDoc(doc(db, 'calls', activeCall.callId), {
          answerSdp: JSON.stringify(answer),
          callStatus: 'connected',
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, `calls/${activeCall.callId}`);
      }
    }
  };

  const handleEndOrReject = async () => {
    stopRingtone();
    const isUnansweredIncoming = !isCaller && callState.callStatus === 'ringing';
    const isUnansweredOutgoing = isCaller && callState.callStatus === 'ringing';
    const nextStatus = isUnansweredIncoming
      ? 'rejected'
      : isUnansweredOutgoing
        ? 'missed'
        : 'ended';

    cleanupMedia();

    try {
      await updateDoc(doc(db, 'calls', activeCall.callId), {
        callStatus: nextStatus,
        endedAt: serverTimestamp(),
        duration: elapsedSec,
        updatedAt: serverTimestamp(),
      });

      if (nextStatus === 'missed') {
        const notifId = `missed_${activeCall.callId}`;
        await setDoc(doc(db, 'notifications', notifId), {
          notificationId: notifId,
          userId: activeCall.receiverId,
          title: `Missed ${activeCall.callType} call`,
          body: `You missed a ${activeCall.callType} call.`,
          type: 'missed_call',
          relatedId: activeCall.callId,
          readStatus: false,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    } catch {
      // Call document may already have ended
    }
    onClose();
  };

  const toggleMic = () => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const next = !micMuted;
    stream.getAudioTracks().forEach((t) => {
      t.enabled = !next;
    });
    setMicMuted(next);
  };

  const toggleCam = () => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const next = !camOff;
    stream.getVideoTracks().forEach((t) => {
      t.enabled = !next;
    });
    setCamOff(next);
  };

  const switchCamera = async () => {
    if (!isVideo || !pcRef.current) return;
    const nextMode = facingMode === 'user' ? 'environment' : 'user';
    setFacingMode(nextMode);
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: nextMode, width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      const newTrack = newStream.getVideoTracks()[0];
      const sender = pcRef.current.getSenders().find((s) => s.track?.kind === 'video');
      if (sender && newTrack) {
        await sender.replaceTrack(newTrack);
      }
      localStreamRef.current?.getVideoTracks().forEach((t) => t.stop());
      if (localStreamRef.current && newTrack) {
        const audioTracks = localStreamRef.current.getAudioTracks();
        const combined = new MediaStream([...audioTracks, newTrack]);
        localStreamRef.current = combined;
        if (localVideoRef.current) localVideoRef.current.srcObject = combined;
      }
    } catch {
      // Single camera device fallback
    }
  };

  const toggleSpeaker = () => {
    const next = !speakerMuted;
    setSpeakerMuted(next);
    if (remoteAudioRef.current) remoteAudioRef.current.muted = next;
    if (remoteVideoRef.current) remoteVideoRef.current.muted = next;
  };

  const togglePiP = async () => {
    const vid = remoteVideoRef.current;
    if (!vid || !document.pictureInPictureEnabled) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await vid.requestPictureInPicture();
      }
    } catch {
      // PiP unavailable
    }
  };

  const formatTimer = (sec: number) => {
    const m = Math.floor(sec / 60).toString().padStart(2, '0');
    const s = (sec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  useEffect(() => {
    return () => {
      stopRingtone();
      cleanupMedia();
    };
  }, [cleanupMedia]);

  return (
    <div className="fixed inset-0 z-50 bg-slate-950 text-white flex flex-col justify-between overflow-hidden">
      {/* Remote Audio element for audio-only calls */}
      <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />

      {/* Remote Video Surface */}
      {isVideo && (
        <video
          ref={remoteVideoRef}
          autoPlay
          playsInline
          className="absolute inset-0 w-full h-full object-cover"
        />
      )}

      {/* Subtle gradient scrim for legibility */}
      <div className="absolute inset-0 bg-gradient-to-b from-slate-950/80 via-slate-950/35 to-slate-950/90 pointer-events-none" />

      {/* Top Status Bar */}
      <div className="relative z-10 flex items-center justify-between px-6 py-5">
        <div className="flex items-center gap-3">
          <Wifi className="w-4 h-4 text-blue-400" />
          <span className="text-xs font-medium text-slate-200">
            {networkState === 'good'
              ? 'HD Encrypted Stream'
              : networkState === 'reconnecting'
                ? 'Reconnecting...'
                : 'Connecting WebRTC...'}
          </span>
          <span aria-hidden="true" className="text-slate-500">·</span>
          <span className="font-mono text-xs text-slate-300 tabular-nums">
            {callState.callStatus === 'connected' ? formatTimer(elapsedSec) : callState.callStatus}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {isVideo && (
            <>
              <select
                aria-label="Video quality"
                value={qualityTier}
                onChange={(e) => {
                  const tier = e.target.value as QualityTier;
                  setQualityTier(tier);
                  void applyAdaptiveBitrate(tier);
                }}
                className="bg-white/10 border border-white/15 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none"
              >
                <option value="auto" className="text-slate-900">Adaptive</option>
                <option value="hd" className="text-slate-900">HD 720p</option>
                <option value="saver" className="text-slate-900">Data Saver</option>
              </select>

              {document.pictureInPictureEnabled && (
                <button
                  type="button"
                  onClick={togglePiP}
                  aria-label="Picture in Picture"
                  className="w-10 h-10 rounded-xl bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors"
                >
                  <PictureInPicture2 className="w-4 h-4" />
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Center Peer Identity (visible during audio calls or while ringing) */}
      <div className="relative z-10 flex flex-col items-center justify-center text-center px-6">
        {(!isVideo || callState.callStatus !== 'connected') && (
          <>
            <Avatar
              name={peer?.fullName || 'Contact'}
              src={peer?.profilePicture}
              size="xl"
            />
            <h2 className="font-display text-2xl font-bold mt-4 text-white">
              {peer?.fullName || 'Private Contact'}
            </h2>
            <p className="text-sm text-slate-300 mt-1">
              {callState.callStatus === 'ringing'
                ? isCaller
                  ? `Calling (${activeCall.callType})...`
                  : `Incoming ${activeCall.callType} call`
                : formatTimer(elapsedSec)}
            </p>
          </>
        )}

        {mediaError && (
          <div className="mt-4 max-w-md rounded-xl bg-rose-500/20 border border-rose-400/40 px-4 py-2.5 text-xs text-rose-100">
            {mediaError}
          </div>
        )}

        {networkState === 'reconnecting' && (
          <div className="mt-4 flex items-center gap-2 text-xs text-amber-300">
            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            <span>Network interruption detected. Attempting ICE recovery...</span>
          </div>
        )}
      </div>

      {/* Local Video Preview (PiP Corner) */}
      {isVideo && (
        <div className="relative z-10 self-end mx-6 mb-4 w-28 sm:w-36 aspect-[3/4] rounded-2xl overflow-hidden border border-white/20 bg-slate-900 shadow-lg">
          <video
            ref={localVideoRef}
            autoPlay
            muted
            playsInline
            className={`w-full h-full object-cover ${camOff ? 'hidden' : ''}`}
          />
          {camOff && (
            <div className="w-full h-full flex items-center justify-center text-xs text-slate-400">
              Camera off
            </div>
          )}
        </div>
      )}

      {/* Bottom Call Controls */}
      <div className="relative z-10 pb-8 px-6 flex items-center justify-center gap-4">
        {!isCaller && callState.callStatus === 'ringing' ? (
          <>
            <button
              type="button"
              onClick={handleEndOrReject}
              className="w-16 h-16 rounded-full bg-rose-600 hover:bg-rose-700 flex items-center justify-center shadow-lg transition-colors"
              aria-label="Reject call"
            >
              <PhoneOff className="w-7 h-7" />
            </button>
            <button
              type="button"
              onClick={handleAcceptCall}
              className="w-16 h-16 rounded-full bg-emerald-600 hover:bg-emerald-700 flex items-center justify-center shadow-lg transition-colors"
              aria-label="Accept call"
            >
              <Phone className="w-7 h-7" />
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={toggleMic}
              aria-label={micMuted ? 'Unmute microphone' : 'Mute microphone'}
              className={`w-12 h-12 rounded-full flex items-center justify-center transition-colors ${
                micMuted ? 'bg-white text-slate-900' : 'bg-white/15 hover:bg-white/25 text-white'
              }`}
            >
              {micMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
            </button>

            <button
              type="button"
              onClick={toggleSpeaker}
              aria-label={speakerMuted ? 'Unmute speaker' : 'Mute speaker'}
              className={`w-12 h-12 rounded-full flex items-center justify-center transition-colors ${
                speakerMuted ? 'bg-white text-slate-900' : 'bg-white/15 hover:bg-white/25 text-white'
              }`}
            >
              {speakerMuted ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
            </button>

            {isVideo && (
              <>
                <button
                  type="button"
                  onClick={toggleCam}
                  aria-label={camOff ? 'Turn camera on' : 'Turn camera off'}
                  className={`w-12 h-12 rounded-full flex items-center justify-center transition-colors ${
                    camOff ? 'bg-white text-slate-900' : 'bg-white/15 hover:bg-white/25 text-white'
                  }`}
                >
                  {camOff ? <VideoOff className="w-5 h-5" /> : <Video className="w-5 h-5" />}
                </button>
                <button
                  type="button"
                  onClick={switchCamera}
                  aria-label="Switch front or rear camera"
                  className="w-12 h-12 rounded-full bg-white/15 hover:bg-white/25 text-white flex items-center justify-center transition-colors"
                >
                  <SwitchCamera className="w-5 h-5" />
                </button>
              </>
            )}

            <button
              type="button"
              onClick={handleEndOrReject}
              aria-label="End call"
              className="w-14 h-14 rounded-full bg-rose-600 hover:bg-rose-700 text-white flex items-center justify-center shadow-lg transition-colors"
            >
              <PhoneOff className="w-6 h-6" />
            </button>
          </>
        )}
      </div>
    </div>
  );
};
