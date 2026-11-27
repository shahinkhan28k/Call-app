import React, { useState } from 'react';
import { isSafeMediaUrl } from '../lib/media';
import type { OnlineStatus } from '../types';

interface AvatarProps {
  name: string;
  src?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  onlineStatus?: OnlineStatus;
  showPresence?: boolean;
}

const SIZE_CLASSES: Record<NonNullable<AvatarProps['size']>, string> = {
  sm: 'w-9 h-9 text-xs',
  md: 'w-11 h-11 text-sm',
  lg: 'w-14 h-14 text-base',
  xl: 'w-20 h-20 text-xl',
};

const DOT_CLASSES: Record<NonNullable<AvatarProps['size']>, string> = {
  sm: 'w-2.5 h-2.5 right-0 bottom-0',
  md: 'w-3 h-3 right-0 bottom-0',
  lg: 'w-3.5 h-3.5 right-0.5 bottom-0.5',
  xl: 'w-4 h-4 right-1 bottom-1',
};

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'U';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export const Avatar: React.FC<AvatarProps> = ({
  name,
  src,
  size = 'md',
  onlineStatus,
  showPresence = false,
}) => {
  const [imgError, setImgError] = useState(false);
  const validSrc = src && isSafeMediaUrl(src) && !imgError;

  return (
    <div className="relative inline-flex shrink-0">
      {validSrc ? (
        <img
          src={src}
          alt={name}
          referrerPolicy="no-referrer"
          onError={() => setImgError(true)}
          className={`${SIZE_CLASSES[size]} rounded-full object-cover bg-slate-100 dark:bg-slate-800 border border-slate-200/80 dark:border-slate-700/80`}
        />
      ) : (
        <div
          aria-label={name}
          className={`${SIZE_CLASSES[size]} rounded-full bg-blue-600/10 dark:bg-blue-500/20 text-blue-700 dark:text-blue-300 font-semibold flex items-center justify-center border border-blue-200/70 dark:border-blue-800/60 select-none`}
        >
          {getInitials(name)}
        </div>
      )}
      {showPresence && onlineStatus === 'online' && (
        <span
          title="Online"
          className={`absolute ${DOT_CLASSES[size]} rounded-full bg-emerald-500 ring-2 ring-white dark:ring-slate-900`}
        />
      )}
    </div>
  );
};
