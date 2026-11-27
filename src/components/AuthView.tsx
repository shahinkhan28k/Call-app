import React, { useEffect, useRef, useState } from 'react';
import {
  ConfirmationResult,
  createUserWithEmailAndPassword,
  getRedirectResult,
  GoogleAuthProvider,
  RecaptchaVerifier,
  reload,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithCredential,
  signInWithEmailAndPassword,
  signInWithPhoneNumber,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  updateProfile,
} from 'firebase/auth';
import { ArrowRight, CheckCircle2, Lock, Mail, Phone, ShieldCheck, Smartphone, User } from 'lucide-react';
import { auth, googleProvider } from '../firebase';

interface AndroidBridgeResult {
  email?: string;
  accessToken?: string;
  cancelled?: boolean;
  error?: string;
}

declare global {
  interface Window {
    ClaroAndroid?: {
      pickGoogleAccount?: () => void;
      closePopups?: () => void;
      uploadFile?: (
        uploadId: string,
        targetUrl: string,
        bearerToken: string,
        fileName: string,
        mimeType: string,
        base64Data: string
      ) => void;
      setSignedIn?: (signedIn: boolean) => void;
      showIncomingCallNotification?: (
        callId: string,
        callerName: string,
        callType: 'audio' | 'video'
      ) => void;
      dismissIncomingCallNotification?: (callId: string) => void;
    };
    __onClaroAndroidAccountResult?: (result: AndroidBridgeResult) => void;
    __onClaroAndroidUploadResult?: (uploadId: string, status: number, body: string) => void;
    __onClaroAndroidCallAction?: (callId: string, action: 'answer' | 'decline') => void;
    __onClaroAndroidVisibilityChange?: (inForeground: boolean) => void;
  }
}

interface AuthViewProps {
  onPendingProfileMeta: (meta: { fullName?: string; username?: string }) => void;
}

type AuthMode = 'google' | 'email' | 'phone';
type EmailSubMode = 'signin' | 'signup' | 'reset';

const COUNTRY_CODES = [
  { code: '+1', label: 'US / CA (+1)' },
  { code: '+44', label: 'UK (+44)' },
  { code: '+91', label: 'IN (+91)' },
  { code: '+880', label: 'BD (+880)' },
  { code: '+61', label: 'AU (+61)' },
  { code: '+49', label: 'DE (+49)' },
  { code: '+65', label: 'SG (+65)' },
  { code: '+971', label: 'AE (+971)' },
];

export const AuthView: React.FC<AuthViewProps> = ({ onPendingProfileMeta }) => {
  const [authMode, setAuthMode] = useState<AuthMode>('google');
  const [emailSubMode, setEmailSubMode] = useState<EmailSubMode>('signin');

  const [fullName, setFullName] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const [countryCode, setCountryCode] = useState('+1');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [confirmationResult, setConfirmationResult] = useState<ConfirmationResult | null>(null);

  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [infoMsg, setInfoMsg] = useState<string | null>(null);
  const [providerHelp, setProviderHelp] = useState<string | null>(null);
  const [needsEmailVerify, setNeedsEmailVerify] = useState(false);

  const recaptchaRef = useRef<RecaptchaVerifier | null>(null);

  useEffect(() => {
    getRedirectResult(auth).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : 'Google sign-in failed.';
      setErrorMsg(msg);
    });
    return () => {
      if (recaptchaRef.current) {
        recaptchaRef.current.clear();
        recaptchaRef.current = null;
      }
    };
  }, []);

  const handleGoogleSignIn = async () => {
    setErrorMsg(null);
    setInfoMsg(null);
    setProviderHelp(null);
    setLoading(true);

    if (window.ClaroAndroid?.pickGoogleAccount) {
      window.__onClaroAndroidAccountResult = async (result: AndroidBridgeResult) => {
        try {
          if (result?.cancelled) {
            setLoading(false);
            return;
          }
          if (result?.accessToken) {
            const cred = GoogleAuthProvider.credential(null, result.accessToken);
            await signInWithCredential(auth, cred);
            setLoading(false);
            return;
          }
          if (result?.email) {
            googleProvider.setCustomParameters({
              login_hint: result.email,
              prompt: 'select_account',
            });
          } else {
            googleProvider.setCustomParameters({ prompt: 'select_account' });
          }
          await signInWithRedirect(auth, googleProvider);
        } catch (err) {
          window.ClaroAndroid?.closePopups?.();
          setErrorMsg(err instanceof Error ? err.message : 'Google sign-in failed.');
          setLoading(false);
        }
      };
      try {
        window.ClaroAndroid.pickGoogleAccount();
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : 'Could not open Gmail chooser.');
        setLoading(false);
      }
      return;
    }

    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      window.ClaroAndroid?.closePopups?.();
      const msg = err instanceof Error ? err.message : 'Google sign-in failed.';
      setErrorMsg(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setInfoMsg(null);
    setProviderHelp(null);
    setLoading(true);

    try {
      if (emailSubMode === 'reset') {
        await sendPasswordResetEmail(auth, email.trim());
        setInfoMsg('Password reset link sent to your email address.');
        setLoading(false);
        return;
      }

      if (emailSubMode === 'signup') {
        const cleanName = fullName.trim();
        const cleanUser = username.trim().replace(/^@/, '');
        if (!cleanName || cleanUser.length < 2) {
          setErrorMsg('Please enter your full name and a valid username (2-40 characters).');
          setLoading(false);
          return;
        }
        onPendingProfileMeta({ fullName: cleanName, username: cleanUser });
        const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
        await updateProfile(cred.user, { displayName: cleanName });
        await sendEmailVerification(cred.user);
        setNeedsEmailVerify(true);
        setInfoMsg('Verification email sent. Check your inbox and click the verification link.');
      } else {
        const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
        if (!cred.user.emailVerified) {
          setNeedsEmailVerify(true);
          setInfoMsg('Please verify your email address before continuing.');
        }
      }
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code || '';
      if (code === 'auth/operation-not-allowed') {
        setProviderHelp(
          'Email/Password sign-in is not enabled in your Firebase Console yet. Open Firebase Console -> Authentication -> Sign-in method -> Enable Email/Password, or use Continue with Google above.'
        );
      } else {
        setErrorMsg(err instanceof Error ? err.message : 'Authentication failed.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSendPhoneOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setInfoMsg(null);
    setProviderHelp(null);
    setLoading(true);

    try {
      const cleanName = fullName.trim();
      if (!cleanName) {
        setErrorMsg('Please enter your full name.');
        setLoading(false);
        return;
      }
      const digits = phoneNumber.replace(/[^0-9]/g, '');
      if (digits.length < 6) {
        setErrorMsg('Enter a valid mobile number.');
        setLoading(false);
        return;
      }

      onPendingProfileMeta({ fullName: cleanName, username: username.trim() || undefined });

      if (!recaptchaRef.current) {
        recaptchaRef.current = new RecaptchaVerifier(auth, 'recaptcha-container', {
          size: 'invisible',
        });
      }

      const fullE164 = `${countryCode}${digits}`;
      const confirmation = await signInWithPhoneNumber(auth, fullE164, recaptchaRef.current);
      setConfirmationResult(confirmation);
      setInfoMsg(`SMS verification code sent to ${fullE164}.`);
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code || '';
      if (code === 'auth/operation-not-allowed') {
        setProviderHelp(
          'Phone SMS authentication is not enabled in your Firebase Console yet. Open Firebase Console -> Authentication -> Sign-in method -> Enable Phone, or use Continue with Google above.'
        );
      } else {
        setErrorMsg(err instanceof Error ? err.message : 'Could not send SMS OTP.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyPhoneOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!confirmationResult) return;
    setErrorMsg(null);
    setLoading(true);
    try {
      const cred = await confirmationResult.confirm(otpCode.trim());
      if (fullName.trim()) {
        await updateProfile(cred.user, { displayName: fullName.trim() });
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Invalid verification code.');
    } finally {
      setLoading(false);
    }
  };

  const handleCheckVerification = async () => {
    if (!auth.currentUser) return;
    setLoading(true);
    try {
      await reload(auth.currentUser);
      if (auth.currentUser.emailVerified) {
        window.location.reload();
      } else {
        setErrorMsg('Email is not verified yet. Please click the link sent to your inbox.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-[#0B1120] flex flex-col lg:flex-row">
      {/* Left Architectural Brand Column */}
      <div className="lg:w-1/2 relative bg-blue-600 text-white flex flex-col justify-between p-8 lg:p-14 overflow-hidden">
        <img
          src="/src/assets/images/auth_hero_comms_1795754654122.jpg"
          alt="Claro private communications"
          referrerPolicy="no-referrer"
          className="absolute inset-0 w-full h-full object-cover opacity-25 mix-blend-luminosity"
        />
        <div className="absolute inset-0 bg-gradient-to-br from-blue-700/95 via-blue-600/85 to-slate-900/90" />

        <div className="relative z-10 flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-white text-blue-600 flex items-center justify-center font-display font-bold text-lg shadow-sm">
            C
          </div>
          <span className="font-display font-bold text-2xl tracking-tight">Claro</span>
        </div>

        <div className="relative z-10 my-10 lg:my-0 max-w-lg">
          <p className="text-xs font-medium tracking-wider uppercase text-blue-100 mb-3">
            Private Messaging &amp; HD Calling
          </p>
          <h1 className="font-display text-3xl lg:text-5xl font-bold leading-tight text-balance mb-5">
            Direct, quiet communication without the noise.
          </h1>
          <p className="text-blue-100 text-base leading-relaxed mb-8">
            One-to-one encrypted text, voice notes, media sharing, and adaptive HD audio and video calls—built strictly for private conversations with zero feeds, reels, or public profiles.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm text-blue-50">
            <div className="rounded-xl bg-white/10 backdrop-blur-sm p-4 border border-white/15">
              <div className="flex items-center gap-2 font-semibold mb-1">
                <Lock className="w-4 h-4" />
                <span>End-to-End Keys</span>
              </div>
              <p className="text-xs text-blue-100/90">
                WebCrypto ECDH P-256 + AES-GCM device keys for private threads.
              </p>
            </div>
            <div className="rounded-xl bg-white/10 backdrop-blur-sm p-4 border border-white/15">
              <div className="flex items-center gap-2 font-semibold mb-1">
                <ShieldCheck className="w-4 h-4" />
                <span>WebRTC HD Calls</span>
              </div>
              <p className="text-xs text-blue-100/90">
                Adaptive bitrate audio &amp; video with camera switch and reconnection.
              </p>
            </div>
          </div>
        </div>

        <div className="relative z-10 text-xs text-blue-100/80 flex items-center gap-3">
          <span>Private by design</span>
          <span aria-hidden="true">·</span>
          <span>No feeds or trackers</span>
          <span aria-hidden="true">·</span>
          <span>1:1 WebRTC</span>
        </div>
      </div>

      {/* Right Authentication Form Column */}
      <div className="lg:w-1/2 flex items-center justify-center p-6 sm:p-10 lg:p-16">
        <div className="w-full max-w-md">
          <div className="mb-8">
            <h2 className="font-display text-2xl font-bold text-slate-900 dark:text-white mb-2">
              Sign in to Claro
            </h2>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              Choose your preferred sign-in or registration method.
            </p>
          </div>

          {needsEmailVerify ? (
            <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-4">
              <div className="flex items-center gap-3 text-blue-600 dark:text-blue-400">
                <CheckCircle2 className="w-6 h-6 shrink-0" />
                <h3 className="font-semibold text-base text-slate-900 dark:text-white">
                  Verify your email address
                </h3>
              </div>
              <p className="text-sm text-slate-600 dark:text-slate-300">
                We sent a verification link to your inbox. Open the link, then confirm below to enter your private workspace.
              </p>
              {errorMsg && (
                <p className="text-xs text-rose-600 dark:text-rose-400">{errorMsg}</p>
              )}
              {infoMsg && (
                <p className="text-xs text-blue-600 dark:text-blue-400">{infoMsg}</p>
              )}
              <div className="flex flex-col gap-2.5 pt-2">
                <button
                  type="button"
                  disabled={loading}
                  onClick={handleCheckVerification}
                  className="w-full py-2.5 px-4 rounded-xl bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition-colors disabled:opacity-50"
                >
                  I have verified — continue
                </button>
                <button
                  type="button"
                  disabled={loading}
                  onClick={async () => {
                    if (auth.currentUser) {
                      await sendEmailVerification(auth.currentUser);
                      setInfoMsg('Verification email resent.');
                    }
                  }}
                  className="w-full py-2.5 px-4 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 text-sm font-medium hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                >
                  Resend verification link
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    await signOut(auth);
                    setNeedsEmailVerify(false);
                  }}
                  className="text-xs text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 py-1"
                >
                  Use another account
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              {/* Method Switcher */}
              <div className="grid grid-cols-3 gap-1 p-1 bg-slate-200/70 dark:bg-slate-800 rounded-xl">
                <button
                  type="button"
                  onClick={() => {
                    setAuthMode('google');
                    setErrorMsg(null);
                    setProviderHelp(null);
                  }}
                  className={`py-2 px-3 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
                    authMode === 'google'
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  Google
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAuthMode('email');
                    setErrorMsg(null);
                    setProviderHelp(null);
                  }}
                  className={`py-2 px-3 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
                    authMode === 'email'
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  Email
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAuthMode('phone');
                    setErrorMsg(null);
                    setProviderHelp(null);
                  }}
                  className={`py-2 px-3 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
                    authMode === 'phone'
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  Phone OTP
                </button>
              </div>

              {errorMsg && (
                <div className="rounded-xl border border-rose-200 dark:border-rose-900/60 bg-rose-50 dark:bg-rose-950/40 p-3.5 text-xs text-rose-700 dark:text-rose-300">
                  {errorMsg}
                </div>
              )}

              {infoMsg && (
                <div className="rounded-xl border border-blue-200 dark:border-blue-900/60 bg-blue-50 dark:bg-blue-950/40 p-3.5 text-xs text-blue-700 dark:text-blue-300">
                  {infoMsg}
                </div>
              )}

              {providerHelp && (
                <div className="rounded-xl border border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/40 p-3.5 text-xs text-amber-800 dark:text-amber-200 leading-relaxed">
                  {providerHelp}
                </div>
              )}

              {authMode === 'google' && (
                <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-5">
                  <div>
                    <h3 className="font-semibold text-base text-slate-900 dark:text-white mb-1">
                      One-Click Google Sign-In
                    </h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      Click below to sign in or create your verified Claro account immediately with Google.
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={loading}
                    onClick={handleGoogleSignIn}
                    className="w-full flex items-center justify-center gap-3 py-3 px-4 rounded-xl bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition-colors disabled:opacity-50"
                  >
                    <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
                      <path
                        fill="currentColor"
                        d="M21.35 11.1h-9.17v2.98h5.27c-.23 1.24-.92 2.29-1.97 3v2.49h3.19c1.86-1.71 2.93-4.24 2.93-7.24 0-.42-.04-.83-.25-1.23z"
                      />
                      <path
                        fill="currentColor"
                        d="M12.18 21c2.65 0 4.88-.88 6.51-2.38l-3.19-2.49c-.88.59-2.01.94-3.32.94-2.55 0-4.71-1.72-5.48-4.04H3.41v2.57C5.03 18.82 8.34 21 12.18 21z"
                      />
                      <path
                        fill="currentColor"
                        d="M6.7 13.03c-.2-.59-.31-1.22-.31-1.87s.11-1.28.31-1.87V6.72H3.41C2.74 8.05 2.36 9.56 2.36 11.16s.38 3.11 1.05 4.44l3.29-2.57z"
                      />
                      <path
                        fill="currentColor"
                        d="M12.18 5.25c1.44 0 2.74.5 3.76 1.47l2.82-2.82C17.05 2.31 14.83 1.32 12.18 1.32 8.34 1.32 5.03 3.5 3.41 6.72l3.29 2.57c.77-2.32 2.93-4.04 5.48-4.04z"
                      />
                    </svg>
                    <span>{loading ? 'Connecting...' : 'Continue with Google'}</span>
                    <ArrowRight className="w-4 h-4" />
                  </button>
                </div>
              )}

              {authMode === 'email' && (
                <form
                  onSubmit={handleEmailSubmit}
                  className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-4"
                >
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold text-base text-slate-900 dark:text-white">
                      {emailSubMode === 'signin'
                        ? 'Email Sign In'
                        : emailSubMode === 'signup'
                          ? 'Create Email Account'
                          : 'Reset Password'}
                    </h3>
                    <button
                      type="button"
                      onClick={() =>
                        setEmailSubMode(emailSubMode === 'signup' ? 'signin' : 'signup')
                      }
                      className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline"
                    >
                      {emailSubMode === 'signup' ? 'Have an account? Sign in' : 'Create account'}
                    </button>
                  </div>

                  {emailSubMode === 'signup' && (
                    <>
                      <div>
                        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                          Full Name
                        </label>
                        <div className="relative">
                          <User className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
                          <input
                            type="text"
                            required
                            maxLength={100}
                            value={fullName}
                            onChange={(e) => setFullName(e.target.value)}
                            placeholder="Jordan Rivera"
                            className="w-full pl-10 pr-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                          Unique Username
                        </label>
                        <input
                          type="text"
                          required
                          minLength={2}
                          maxLength={40}
                          pattern="[a-zA-Z0-9_.]+"
                          value={username}
                          onChange={(e) => setUsername(e.target.value)}
                          placeholder="jordan.rivera"
                          className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </div>
                    </>
                  )}

                  <div>
                    <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                      Email Address
                    </label>
                    <div className="relative">
                      <Mail className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
                      <input
                        type="email"
                        required
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="you@example.com"
                        className="w-full pl-10 pr-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                  </div>

                  {emailSubMode !== 'reset' && (
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                          Password
                        </label>
                        {emailSubMode === 'signin' && (
                          <button
                            type="button"
                            onClick={() => setEmailSubMode('reset')}
                            className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                          >
                            Forgot password?
                          </button>
                        )}
                      </div>
                      <input
                        type="password"
                        required
                        minLength={6}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="••••••••"
                        className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full py-2.5 px-4 rounded-xl bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition-colors disabled:opacity-50"
                  >
                    {loading
                      ? 'Please wait...'
                      : emailSubMode === 'signup'
                        ? 'Create Account & Verify Email'
                        : emailSubMode === 'reset'
                          ? 'Send Password Reset Link'
                          : 'Sign In'}
                  </button>

                  {emailSubMode === 'reset' && (
                    <button
                      type="button"
                      onClick={() => setEmailSubMode('signin')}
                      className="w-full text-xs text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
                    >
                      Back to sign in
                    </button>
                  )}
                </form>
              )}

              {authMode === 'phone' && (
                <form
                  onSubmit={confirmationResult ? handleVerifyPhoneOtp : handleSendPhoneOtp}
                  className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-4"
                >
                  <div className="flex items-center gap-2">
                    <Smartphone className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                    <h3 className="font-semibold text-base text-slate-900 dark:text-white">
                      Mobile Number SMS OTP
                    </h3>
                  </div>

                  {!confirmationResult ? (
                    <>
                      <div>
                        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                          Full Name
                        </label>
                        <input
                          type="text"
                          required
                          maxLength={100}
                          value={fullName}
                          onChange={(e) => setFullName(e.target.value)}
                          placeholder="Jordan Rivera"
                          className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                          Country Code &amp; Mobile Number
                        </label>
                        <div className="flex gap-2">
                          <select
                            value={countryCode}
                            onChange={(e) => setCountryCode(e.target.value)}
                            className="w-36 px-2.5 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 text-xs text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                          >
                            {COUNTRY_CODES.map((c) => (
                              <option key={c.code} value={c.code}>
                                {c.label}
                              </option>
                            ))}
                          </select>
                          <div className="relative flex-1">
                            <Phone className="w-4 h-4 text-slate-400 absolute left-3 top-3" />
                            <input
                              type="tel"
                              required
                              value={phoneNumber}
                              onChange={(e) => setPhoneNumber(e.target.value)}
                              placeholder="5550192834"
                              className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                            />
                          </div>
                        </div>
                      </div>
                      <button
                        type="submit"
                        disabled={loading}
                        className="w-full py-2.5 px-4 rounded-xl bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition-colors disabled:opacity-50"
                      >
                        {loading ? 'Sending SMS...' : 'Send SMS Code'}
                      </button>
                    </>
                  ) : (
                    <>
                      <div>
                        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                          6-Digit SMS Verification Code
                        </label>
                        <input
                          type="text"
                          required
                          maxLength={6}
                          value={otpCode}
                          onChange={(e) => setOtpCode(e.target.value)}
                          placeholder="123456"
                          className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 text-sm font-mono tracking-widest text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </div>
                      <button
                        type="submit"
                        disabled={loading}
                        className="w-full py-2.5 px-4 rounded-xl bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition-colors disabled:opacity-50"
                      >
                        {loading ? 'Verifying...' : 'Verify OTP & Sign In'}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setConfirmationResult(null);
                          setOtpCode('');
                        }}
                        className="w-full text-xs text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
                      >
                        Change phone number
                      </button>
                    </>
                  )}
                  <div id="recaptcha-container" />
                </form>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
