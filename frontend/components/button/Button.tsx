import React, { ButtonHTMLAttributes, ReactNode } from 'react';

type ButtonProps = {
  accentColor: string;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
} & ButtonHTMLAttributes<HTMLButtonElement>;

export const Button = ({
  accentColor,
  children,
  className,
  disabled,
  ...allProps
}: ButtonProps) => {
  return (
    <button
      className={`flex flex-row ${
        disabled ? 'pointer-events-none' : ''
      } justify-center border border-transparent text-sm text-gray-950 bg-${accentColor}-500 rounded-md px-3 py-1 transition duration-250 ease-out hover:bg-transparent hover:shadow-${accentColor} hover:border-${accentColor}-500 hover:text-${accentColor}-500 active:scale-[0.98] ${className}`}
      {...allProps}
    >
      {children}
    </button>
  );
};
