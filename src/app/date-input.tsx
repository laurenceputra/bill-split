import type { InputHTMLAttributes } from 'react';

export function DateInput({ onClick, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  return <input {...props} type="date" onClick={(event) => {
    onClick?.(event);
    const input = event.currentTarget;
    if (event.defaultPrevented || input.disabled || input.readOnly) return;
    try {
      input.showPicker?.();
    } catch {
      // Keep native editing/calendar activation when the browser rejects the request.
    }
  }} />;
}
