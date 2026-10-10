import { createElement, type ButtonHTMLAttributes } from 'react';

/** Pure controls shared by live provider/state wrappers and presentation fixtures. */
export function Button({ children, variant = 'primary', loading = false, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'quiet'; loading?: boolean }) {
  return createElement('button', { ...props, className: `ui-button ${variant === 'primary' ? '' : `button--${variant}`} ${className}`.trim(), 'aria-busy': loading || undefined, disabled: loading || props.disabled }, loading ? createElement('span', { className: 'button__loading', 'aria-hidden': true }) : null, children);
}

export function PublicAuthAction({ signUp = false, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { signUp?: boolean }) {
  return createElement('button', { ...props, className: signUp ? 'button button--secondary public-sign-up' : 'button public-sign-in', type: 'button' }, signUp ? 'Sign up' : 'Sign in');
}

export function InstallButton({ label, secondary = false, busy = false, onClick }: { label: string; secondary?: boolean; busy?: boolean; onClick?: () => void }) {
  return createElement('div', { className: 'install-control' }, createElement('button', { className: `button${secondary ? ' button--secondary' : ''} install-action`, type: 'button', disabled: busy, 'aria-busy': busy || undefined, onClick }, label));
}

export function AuthBannerAction({ state, onRetry, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { state: 'sign-in' | 'checking' | 'error'; onRetry?: () => void }) {
  return state === 'sign-in' ? createElement('button', { ...props, type: 'button' }, 'Sign in') : createElement(Button, { ...props, type: 'button', variant: state === 'checking' ? 'secondary' : 'primary', onClick: onRetry }, 'Retry connection');
}
