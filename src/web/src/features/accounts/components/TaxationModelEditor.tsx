import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { Refusal } from '@/components/Refusal'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  accountsApi,
  type TaxationBracket,
  type TaxationModel,
  type TaxationParameter,
  type TaxationParameters,
} from '@/features/accounts/lib/api'
import { settingsApi } from '@/features/settings/lib/api'
import { baseCurrency } from '@/lib/firstRun'
import { useI18n, type MessageKey } from '@/lib/i18n'
import { problemSentence } from '@/lib/problem'

/** The one `<select>` skin the forms share — `EventForm`'s, to the class. */
export const SELECT =
  'h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30'

interface Row {
  upper_bound: string
  rate: string
}

interface Editor {
  name: string
  kind: string
  /** The scalar parameters, as the reader typed them. */
  fields: Record<string, string>
  brackets: Row[]
}

const EMPTY_ROWS: Row[] = [{ upper_bound: '', rate: '' }]

interface TaxationModelEditorProps {
  /** The model being corrected, or `null` to write a new one. */
  model: TaxationModel | null
  onSaved: (model: TaxationModel) => void
  onCancel: () => void
}

/**
 * Writes or corrects one taxation model (#752). Mounted inside the account
 * form as well, so it never submits a form: Enter saves the model and the
 * buttons are `type="button"`.
 */
export function TaxationModelEditor({ model, onSaved, onCancel }: TaxationModelEditorProps) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const catalogue = useQuery({ queryKey: ['taxation-models'], queryFn: accountsApi.taxationModels })
  // The currency cannot move once answered, so no refetch on every mount.
  const config = useQuery({
    queryKey: ['config'],
    queryFn: settingsApi.config,
    refetchOnMount: false,
  })
  const currency = baseCurrency(config.data?.settings)

  const kinds = catalogue.data?.kinds ?? []
  const ageBases = catalogue.data?.age_bases ?? []
  function parametersOf(kind: string): TaxationParameter[] {
    return kinds.find((entry) => entry.kind === kind)?.parameters ?? []
  }

  const [editor, setEditor] = useState<Editor>(() =>
    model === null
      ? { name: '', kind: kinds[0]?.kind ?? '', fields: {}, brackets: EMPTY_ROWS }
      : disassemble(model, parametersOf(model.kind)),
  )
  const parameters = parametersOf(editor.kind)

  const write = useMutation({
    mutationFn: (draft: Editor) => {
      const body = {
        name: draft.name.trim(),
        kind: draft.kind,
        parameters: assemble(parameters, draft),
      }
      return model === null
        ? accountsApi.createTaxationModel(body)
        : accountsApi.updateTaxationModel(model.id, body)
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ['taxation-models'] })
      // A correction reaches every account carrying the model.
      void queryClient.invalidateQueries({ queryKey: ['accounts'] })
      onSaved(saved)
    },
  })

  function field(name: string, next: string) {
    setEditor((previous) => ({ ...previous, fields: { ...previous.fields, [name]: next } }))
  }

  return (
    <div
      className="space-y-4 rounded-md border border-border bg-background p-3"
      // Inside `AccountForm`, Enter would submit the account; it saves the model.
      onKeyDown={(pressed) => {
        if (pressed.key !== 'Enter' || pressed.shiftKey) return
        // A button's own Enter is its activation: leave Cancel to cancel.
        if (pressed.target instanceof HTMLButtonElement) return
        pressed.preventDefault()
        if (!write.isPending) write.mutate(editor)
      }}
    >
      <Labelled id="taxation-name" label="taxation.name">
        <Input
          id="taxation-name"
          value={editor.name}
          onChange={(changed) => setEditor({ ...editor, name: changed.target.value })}
        />
      </Labelled>

      <Labelled id="taxation-kind" label="taxation.kind">
        <select
          id="taxation-kind"
          className={SELECT}
          value={editor.kind}
          // A kind change empties the parameters rather than carrying them
          // over: they belong to the kind, and a `rate` left behind under
          // `bracketed_realised` is a value the server would refuse.
          onChange={(changed) =>
            setEditor({
              ...editor,
              kind: changed.target.value,
              fields: {},
              brackets: EMPTY_ROWS,
            })
          }
        >
          {kinds.map((entry) => (
            <option key={entry.kind} value={entry.kind}>
              {t(`taxation.kind.${entry.kind}` as MessageKey)}
            </option>
          ))}
        </select>
      </Labelled>
      <p className="max-w-prose text-xs text-muted-foreground">
        {t(`taxation.kind.${editor.kind}.assessed` as MessageKey)}
      </p>

      {parameters.map((parameter) =>
        parameter.type === 'brackets' ? (
          <Brackets
            key={parameter.name}
            rows={editor.brackets}
            currency={currency}
            onChange={(rows) => setEditor({ ...editor, brackets: rows })}
          />
        ) : (
          <Labelled
            key={parameter.name}
            id={`taxation-${parameter.name}`}
            label={`taxation.param.${parameter.name}` as MessageKey}
            optional={!parameter.required}
          >
            {parameter.type === 'age_basis' ? (
              <select
                id={`taxation-${parameter.name}`}
                className={SELECT}
                value={editor.fields[parameter.name] ?? ''}
                onChange={(changed) => field(parameter.name, changed.target.value)}
              >
                <option value="">{t('taxation.ageBasis.choose')}</option>
                {ageBases.map((basis) => (
                  <option key={basis} value={basis}>
                    {t(`taxation.ageBasis.${basis}` as MessageKey)}
                  </option>
                ))}
              </select>
            ) : (
              // A number, with the unit said beside it where it is a rate.
              <div className="flex items-center gap-2">
                <Input
                  id={`taxation-${parameter.name}`}
                  type="number"
                  inputMode="decimal"
                  step={parameter.type === 'rate' ? '0.01' : '1'}
                  // The unit is said in the description rather than drawn
                  // alone: a reader who hears the label hears the percent.
                  aria-describedby={
                    parameter.type === 'rate' ? `taxation-${parameter.name}-unit` : undefined
                  }
                  value={editor.fields[parameter.name] ?? ''}
                  onChange={(changed) => field(parameter.name, changed.target.value)}
                />
                {parameter.type === 'rate' ? (
                  <span
                    id={`taxation-${parameter.name}-unit`}
                    className="text-sm text-muted-foreground"
                  >
                    %
                  </span>
                ) : null}
              </div>
            )}
          </Labelled>
        ),
      )}

      {write.error ? <Refusal>{problemSentence(t, write.error)}</Refusal> : null}

      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          disabled={write.isPending}
          onClick={() => write.mutate(editor)}
        >
          {t('taxation.save')}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          {t('taxation.cancel')}
        </Button>
      </div>
    </div>
  )
}

/** A label over a control, in `AccountForm`'s own shape. */
function Labelled({
  id,
  label,
  optional,
  children,
}: {
  id: string
  label: MessageKey
  optional?: boolean
  children: ReactNode
}) {
  const { t } = useI18n()
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <label htmlFor={id} className="text-sm font-medium">
          {t(label)}
        </label>
        {optional ? (
          <span className="text-xs text-muted-foreground">{t('data.form.optional')}</span>
        ) : null}
      </div>
      {children}
    </div>
  )
}

/**
 * The ladder — bottom to top, and **the top rung has no ceiling**.
 *
 * That is not a rendering choice: a set of bounded brackets says nothing about
 * the gain above the highest of them, so the last row says *and above* where its
 * bound would be, and the server refuses a ladder shaped any other way.
 *
 * **A ceiling carries its currency, beside the rate that carries its `%`**
 * (#953). It is the one parameter of the whole model that *is* money — every
 * rate is a fraction and a threshold is a count of years — and it was the one
 * typed against no unit at all, while the rate an inch to its right had one.
 * What the server stores is still a bare number and deliberately so: stamping
 * the ladder would put money in a record whose whole argument is that it holds
 * none, to guard a change `settings._refuse_a_reinterpretation` already refuses
 * the moment a single event exists, and that `currencyFixed` presents as
 * impossible from the first answer. The gap left is the reader's own — *ten
 * thousand of what?* — and a unit on the field is the whole of it.
 */
function Brackets({
  rows,
  currency,
  onChange,
}: {
  rows: Row[]
  /** The reporting currency, or `null` while the read is in flight. */
  currency: string | null
  onChange: (rows: Row[]) => void
}) {
  const { t } = useI18n()

  function set(index: number, member: keyof Row, next: string) {
    onChange(rows.map((row, at) => (at === index ? { ...row, [member]: next } : row)))
  }

  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{t('taxation.param.brackets')}</legend>
      {rows.map((row, index) => {
        const last = index === rows.length - 1
        return (
          <div key={index} className="flex items-center gap-2">
            {last ? (
              <span className="flex-1 text-sm text-muted-foreground">
                {t('taxation.brackets.top')}
              </span>
            ) : (
              <>
                <Input
                  type="number"
                  inputMode="decimal"
                  aria-label={t('taxation.brackets.upperBound')}
                  aria-describedby={
                    currency === null ? undefined : `taxation-bracket-${index}-currency`
                  }
                  value={row.upper_bound}
                  onChange={(changed) => set(index, 'upper_bound', changed.target.value)}
                />
                {currency === null ? null : (
                  <span
                    id={`taxation-bracket-${index}-currency`}
                    className="text-sm text-muted-foreground"
                  >
                    {currency}
                  </span>
                )}
              </>
            )}
            <Input
              type="number"
              inputMode="decimal"
              step="0.01"
              className="w-24"
              aria-label={t('taxation.brackets.rate')}
              aria-describedby={`taxation-bracket-${index}-unit`}
              value={row.rate}
              onChange={(changed) => set(index, 'rate', changed.target.value)}
            />
            <span id={`taxation-bracket-${index}-unit`} className="text-sm text-muted-foreground">
              %
            </span>
            {rows.length > 1 ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={t('taxation.brackets.remove')}
                onClick={() => onChange(rows.filter((_, at) => at !== index))}
              >
                ×
              </Button>
            ) : null}
          </div>
        )
      })}
      <Button
        type="button"
        variant="outline"
        size="sm"
        // The new rung goes **under** the open-topped one: the top of a ladder
        // is where it ends, and appending would leave the bounded row last.
        onClick={() =>
          onChange([...rows.slice(0, -1), { upper_bound: '', rate: '' }, rows[rows.length - 1]])
        }
      >
        {t('taxation.brackets.add')}
      </Button>
    </fieldset>
  )
}

/**
 * The editor's strings, as the server's parameters — **percentages divided**.
 *
 * An empty optional field is left out rather than sent as a zero: the two are
 * two sentences, and *no social charge* is not *a social charge of nothing*.
 */
function assemble(parameters: TaxationParameter[], editor: Editor): TaxationParameters {
  const built: TaxationParameters = {}
  for (const parameter of parameters) {
    if (parameter.type === 'brackets') {
      built[parameter.name] = editor.brackets.map((row, index) => ({
        upper_bound: index === editor.brackets.length - 1 ? null : toNumber(row.upper_bound),
        rate: fraction(row.rate),
      })) as TaxationBracket[]
      continue
    }
    const typed = (editor.fields[parameter.name] ?? '').trim()
    if (typed === '') continue
    built[parameter.name] =
      parameter.type === 'rate'
        ? fraction(typed)
        : parameter.type === 'years'
          ? toNumber(typed)
          : typed
  }
  return built
}

/**
 * The inverse, for a model being corrected — and it reads the **declared types**
 * rather than guessing from the value.
 *
 * A `rate` and a count of `years` are both numbers on the wire, and only the
 * kind's own declaration says which of the two is a percentage. Guessed, a
 * five-year threshold would come back into the form as `500`.
 */
function disassemble(model: TaxationModel, parameters: TaxationParameter[]): Editor {
  const fields: Record<string, string> = {}
  let brackets = EMPTY_ROWS
  for (const parameter of parameters) {
    const value = model.parameters[parameter.name]
    if (value === undefined) continue
    if (parameter.type === 'brackets' && Array.isArray(value)) {
      brackets = value.map((rung) => ({
        upper_bound: rung.upper_bound === null ? '' : String(rung.upper_bound),
        rate: String(round(rung.rate * 100)),
      }))
      continue
    }
    if (typeof value === 'number') {
      fields[parameter.name] =
        parameter.type === 'rate' ? String(round(value * 100)) : String(value)
      continue
    }
    if (typeof value === 'string') fields[parameter.name] = value
  }
  return { name: model.name, kind: model.kind, fields, brackets }
}

/**
 * A percentage as the fraction the server holds — **rounded on the way**.
 *
 * `18.6 / 100` is `0.18600000000000003` in binary floating point, and that is
 * what would have been stored: a rate nobody typed, which comes back out of
 * every projection and every export carrying its own noise. Ten decimals is far
 * past any schedule's precision and well inside a double's.
 */
function fraction(value: string): number {
  return Math.round((toNumber(value) / 100) * 1e10) / 1e10
}

/** The way back: `0.128 * 100` is `12.800000000000001`, and nobody types that. */
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

/**
 * What was typed, as a number — and **`NaN` where nothing was typed**.
 *
 * `Number('')` is `0`, which is the trap: a bracket whose bound was left blank
 * would be stored as *up to 0 €* and a blank rate as *0 %*, both of which the
 * server accepts because both are real values. `NaN` serializes to `null`, which
 * it refuses — the scalar fields earn that refusal by being skipped when blank,
 * and the ladder has no *skip* to be skipped by.
 */
function toNumber(value: string): number {
  const typed = value.trim().replace(',', '.')
  return typed === '' ? NaN : Number(typed)
}
