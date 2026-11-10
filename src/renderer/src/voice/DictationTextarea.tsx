import { Textarea, type TextareaProps } from '@mantine/core'
import { useRef, type ChangeEvent, type KeyboardEvent, type ReactElement } from 'react'
import { useDictation } from './useDictation'

type Props = Omit<TextareaProps, 'value' | 'onChange' | 'rightSection'> & {
  value: string
  /** The new text, whether typed or dictated. */
  onValueChange: (value: string) => void
  /** The visible label, which also names the field and the mic button. Without one, `aria-label` or the placeholder does. */
  label?: string
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void
  /** Another handler of the change event, called as the user types. */
  onChange?: (e: ChangeEvent<HTMLTextAreaElement>) => void
  readOnly?: boolean
  disabled?: boolean
}

/**
 * A Mantine Textarea for long-form text with a mic button in its bottom-right corner and the dictation keys. Without voice
 * input (off, or no VoiceProvider) it is the plain Textarea. The mic is not shown when the field is read-only or disabled.
 */
export function DictationTextarea({ value, onValueChange, label, onKeyDown, onChange, maxLength, disabled, readOnly, ...rest }: Props): ReactElement {
  const input = useRef<HTMLTextAreaElement>(null)
  const name = label ?? rest['aria-label'] ?? (typeof rest.placeholder === 'string' ? rest.placeholder : 'text')
  const dictation = useDictation({ inputRef: input, setValue: onValueChange, label: name, maxLength, disabled: disabled || readOnly })
  return (
    <>
      <Textarea
        {...rest}
        ref={input}
        label={label}
        value={value}
        maxLength={maxLength}
        disabled={disabled}
        readOnly={readOnly}
        onChange={(e) => {
          onValueChange(e.currentTarget.value)
          onChange?.(e)
        }}
        onKeyDown={(e) => {
          if (dictation?.onKeyDown(e)) return
          onKeyDown?.(e)
        }}
        rightSection={dictation?.mic}
        rightSectionWidth={dictation ? 40 : undefined}
        rightSectionProps={{ style: { alignItems: 'flex-end', padding: 6 } }}
      />
      {dictation?.status}
    </>
  )
}
