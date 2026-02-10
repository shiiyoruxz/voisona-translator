'use client';

import { ReactNode } from 'react';
import { toast as sonnerToast } from 'sonner';
import { WarningIcon, X } from '@phosphor-icons/react/dist/ssr';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { cn } from '@/lib/utils';

interface ToastProps {
  id: string | number;
  title: ReactNode;
  description: ReactNode;
}

export function toastAlert(toast: Omit<ToastProps, 'id'>) {
  return sonnerToast.custom(
    (id) => <AlertToast id={id} title={toast.title} description={toast.description} />,
    { 
      duration: 10_000,
      position: 'top-center',
    }
  );
}

function AlertToast(props: ToastProps) {
  const { title, description, id } = props;

  return (
    <div
      onClick={() => sonnerToast.dismiss(id)}
      className={cn(
        'group relative w-full max-w-md rounded-2xl',
        'bg-gradient-to-br from-gray-900/98 via-gray-800/95 to-gray-900/98',
        'backdrop-blur-xl border border-red-500/30',
        'shadow-2xl shadow-red-500/20',
        'p-5 cursor-pointer',
        'transition-all duration-300',
        'hover:border-red-500/50 hover:shadow-red-500/30',
        'hover:scale-[1.02] active:scale-[0.98]'
      )}
    >
      {/* Close button */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          sonnerToast.dismiss(id);
        }}
        className={cn(
          'absolute top-3 right-3 p-1.5 rounded-lg',
          'text-gray-400 hover:text-white',
          'bg-gray-800/50 hover:bg-gray-700/50',
          'transition-all duration-200',
          'opacity-0 group-hover:opacity-100'
        )}
        aria-label="Close"
      >
        <X weight="bold" className="w-4 h-4" />
      </button>

      {/* Icon and content */}
      <div className="flex gap-4 items-start">
        {/* Warning icon with glow */}
        <div className="flex-shrink-0 mt-0.5">
          <div className="relative">
            <div className="absolute inset-0 bg-red-500/20 blur-xl rounded-full" />
            <WarningIcon 
              weight="fill" 
              className="relative w-6 h-6 text-red-400"
            />
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0 space-y-2">
          <AlertTitle className="text-white font-semibold text-base leading-tight">
            {title}
          </AlertTitle>
          {description && (
            <AlertDescription className="text-gray-300 text-sm leading-relaxed [&_a]:text-sky-400 [&_a]:hover:text-sky-300 [&_a]:underline [&_a]:underline-offset-2 [&_a]:transition-colors">
              {description}
            </AlertDescription>
          )}
        </div>
      </div>
    </div>
  );
}
