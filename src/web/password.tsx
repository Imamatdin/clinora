import { useEffect, useRef, useState, type InputHTMLAttributes } from 'react';
import { t } from './i18n/index.js';

/**
 * A password field with a show/hide button. The button sits outside the <label>, so the input's accessible name
 * stays exactly the label text; the button has its own name and aria-pressed state. The field is masked again
 * when its form is submitted, so a shown password is not left on screen. Account passwords only; PINs stay
 * masked because they are typed at shared counters.
 */
export function PasswordField({ label, ...input }: { label: string } & Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const [shown, setShown] = useState(false), field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const form = field.current?.form;
    if (!form) return;
    const hide = () => setShown(false);
    form.addEventListener('submit', hide); return () => form.removeEventListener('submit', hide);
  }, []);
  return <div className="password-field">
    <label>{label}<input ref={field} {...input} type={shown ? 'text' : 'password'} autoCapitalize="none" spellCheck={false} /></label>
    <button type="button" className="password-toggle" aria-pressed={shown} onClick={() => setShown(s => !s)}>
      {t(shown ? 'auth.hidePassword' : 'auth.showPassword')}</button>
  </div>;
}
