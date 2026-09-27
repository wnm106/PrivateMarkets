import React from 'react';
import { cn } from '../foundation/utils';

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: 'default' | 'primary' | 'secondary' | 'destructive' | 'outline';
  children: React.ReactNode;
}

export function Badge({ variant = 'default', className, children, ...props }: BadgeProps) {
  const baseStyles = 'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold transition-colors';
  
  const variants = {
    default: 'bg-gray-20 text-gray-100',
    primary: 'bg-blue-10 text-blue-60',
    secondary: 'bg-gray-10 text-gray-70',
    destructive: 'bg-red-10 text-red-60',
    outline: 'border border-gray-30 text-gray-70',
  };
  
  return (
    <span className={cn(baseStyles, variants[variant], className)} {...props}>
      {children}
    </span>
  );
}
