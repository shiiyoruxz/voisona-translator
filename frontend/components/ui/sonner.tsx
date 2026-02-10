'use client';

import { useTheme } from 'next-themes';
import { Toaster as Sonner, ToasterProps } from 'sonner';
import { WarningIcon } from '@phosphor-icons/react/dist/ssr';

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = 'system' } = useTheme();

  return (
    <Sonner
      theme="dark"
      className="toaster group"
      position="top-center"
      toastOptions={{
        className: 'toast-custom',
        style: {
          background: 'transparent',
          border: 'none',
          padding: 0,
          boxShadow: 'none',
        },
      }}
      icons={{
        warning: <WarningIcon weight="bold" />,
      }}
      {...props}
    />
  );
};

export { Toaster };
