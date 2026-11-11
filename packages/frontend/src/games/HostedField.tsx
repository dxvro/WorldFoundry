import type { ReactNode } from 'react';
import { Field, Toggle } from '../components/ui';
import { useI18n } from '../i18n';
import type { FieldValue, HostedField, HostedGame } from './hosted';

// One field of the create wizard or the settings page of a newer game
export function HostedFieldInput({ game, field, value, onChange, disabled = false }: { game: HostedGame; field: HostedField; value: FieldValue; onChange: (value: FieldValue) => void; disabled?: boolean }): ReactNode {
  const { t } = useI18n();
  const texts = (t.hosted[game].fields as Record<string, { label: string; hint: string }>)[field.key] ?? { label: field.key, hint: '' };
  const hint = texts.hint === '' ? undefined : texts.hint;
  if (field.kind === 'toggle') {
    return <Toggle checked={value === true} onChange={onChange} disabled={disabled} label={texts.label} {...(hint === undefined ? {} : { description: hint })} />;
  }
  return (
    <Field label={texts.label} {...(hint === undefined ? {} : { hint })}>
      {(props) =>
        field.kind === 'select' ? (
          <select
            {...props}
            className="input"
            value={String(value)}
            disabled={disabled}
            onChange={(event) => {
              const picked = (field.options ?? []).find((option) => String(option) === event.target.value);
              if (picked !== undefined) onChange(picked);
            }}
          >
            {(field.options ?? []).map((option) => (
              <option key={String(option)} value={String(option)}>
                {(field.optionsKey === undefined ? undefined : (t.hosted.options[field.optionsKey] as Record<string | number, string>)[option]) ?? String(option)}
              </option>
            ))}
          </select>
        ) : field.kind === 'number' ? (
          <input {...props} className="input num" type="number" inputMode="numeric" min={field.min} max={field.max} value={String(value)} disabled={disabled} onChange={(event) => onChange(event.target.value === '' ? '' : Number(event.target.value))} />
        ) : (
          <input {...props} className="input" type={field.kind === 'password' ? 'text' : 'text'} autoComplete="off" spellCheck={false} maxLength={64} value={String(value)} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
        )
      }
    </Field>
  );
}
