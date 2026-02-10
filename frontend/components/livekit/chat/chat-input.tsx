import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface ChatInputProps extends React.HTMLAttributes<HTMLFormElement> {
  onSend?: (message: string) => void;
  disabled?: boolean;
}

export function ChatInput({ onSend, className, disabled, ...props }: ChatInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string>('');

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    props.onSubmit?.(e);
    onSend?.(message);
    setMessage('');
  };

  const isDisabled = disabled || message.trim().length === 0;

  useEffect(() => {
    if (disabled) return;
    // when not disabled refocus on input
    inputRef.current?.focus();
  }, [disabled]);

  return (
    <form
      {...props}
      onSubmit={handleSubmit}
      className={cn(
        'flex items-center gap-2 sm:gap-3 rounded-lg sm:rounded-xl px-3 py-3 sm:px-5 sm:py-4 min-h-[48px]',
        'bg-gradient-to-r from-gray-800/80 via-gray-900/90 to-gray-800/80',
        'backdrop-blur-sm border border-gray-600/40',
        'shadow-lg shadow-black/30',
        'transition-all duration-300',
        'hover:border-gray-500/60 hover:shadow-xl hover:shadow-black/40',
        'focus-within:border-sky-500/60 focus-within:shadow-sky-500/20 focus-within:shadow-xl',
        'focus-within:ring-2 focus-within:ring-sky-500/20',
        'min-w-0',
        className
      )}
    >
      <input
        autoFocus
        ref={inputRef}
        type="text"
        value={message}
        disabled={disabled}
        placeholder="ここにテキストを入力して、Enter または SEND を押してね"
        onChange={(e) => setMessage(e.target.value)}
        className={cn(
          'flex-1 min-w-0 bg-transparent text-white placeholder:text-gray-400',
          'focus:outline-none disabled:cursor-not-allowed disabled:opacity-50',
          'text-sm sm:text-base leading-relaxed',
          'transition-colors duration-200'
        )}
      />
      <Button
        size="sm"
        type="submit"
        variant={isDisabled ? 'secondary' : 'default'}
        disabled={isDisabled}
        className={cn(
          'font-semibold rounded-lg px-4 sm:px-5 py-2 sm:py-2.5 min-h-[44px] min-w-[72px] sm:min-w-[90px] shrink-0 touch-manipulation',
          'transition-all duration-300',
          'shadow-md',
          isDisabled 
            ? 'bg-gray-700/50 text-gray-500 border border-gray-600/50 cursor-not-allowed' 
            : 'bg-gradient-to-r from-sky-500 via-blue-500 to-sky-600 hover:from-sky-400 hover:via-blue-400 hover:to-sky-500 text-white shadow-lg hover:shadow-xl hover:shadow-sky-500/30 hover:scale-105 active:scale-95'
        )}
      >
        SEND
      </Button>
    </form>
  );
}
