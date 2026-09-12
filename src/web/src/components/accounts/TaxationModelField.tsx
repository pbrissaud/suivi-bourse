/**
 * The taxation model, on the account's own panel (#752, ADR-0042, ADR-0043).
 *
 * It is a field of `AccountForm` and a little CRUD at the same time, and that is
 * a decision rather than a shortcut: a model is written **where it is
 * attached**. Anywhere else — a card on the settings page, a route of its own —
 * the owner declares an account, discovers the question, leaves to answer it and
 * comes back, which is the shape of gesture #725 is named after refusing.
 *
 * Four decisions of its own:
 *
 *  - **The kind comes first, and the wrapper shortcut is nested inside one of
 *    them.** The app ships no rates (ADR-0042: *"the owner types their rate"*),
 *    so the only thing shippable is structure, and exactly one kind of five has
 *    any — `aged_flat_realised`, whose `threshold_years` and `age_basis`
 *    describe the PEA and the assurance-vie. Nested, the shortcut is never met
 *    by someone it is not for: no Danish regime has an age threshold, so a
 *    Danish owner picks a shape, types brackets, and the word *PEA* appears on
 *    no screen they cross.
 *  - **The abbreviation is expanded before it is abbreviated**, and the country
 *    is in the label — *Plan d'épargne en actions (PEA) — France · 5 ans depuis
 *    le premier versement*. A bare sigle leans on knowledge a reader outside
 *    France does not have, which is what WCAG 3.1.4 is about.
 *  - **The escape hatch is named** — *none of these, I will enter it myself* —
 *    rather than left as an empty control, which is GOV.UK's own rule for a
 *    closed list.
 *  - **A rate is typed as a percentage and stored as a fraction.** `12,8` is
 *    what a tax schedule says and `0.128` is what the server holds; the
 *    conversion happens here, at the one edge that knows which of the two the
 *    reader is looking at.
 *
 * **A model is never fabricated.** *No model* is an option of the select and the
 * value the panel opens on, because an account with none is ordinary — every
 * store that predates this, the seeded row, and anyone who declined the
 * question — and #919 publishes nothing at all for it.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { Refusal } from '@/components/Refusal'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  api,
  type TaxationBracket,
  type TaxationModel,
  type TaxationParameter,
  type TaxationParameters,
} from '@/lib/api'
import { useI18n, type MessageKey } from '@/lib/i18n'
import { problemSentence } from '@/lib/problem'

/** The one `<select>` skin the forms share — `EventForm`'s, to the class. */
const SELECT =
  'h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30'

/**
 * The value of the option that opens the editor on a model that has no id yet.
 *
 * It cannot collide with one: an id is thirty-two hexadecimal characters, and
 * this is not.
 */
const NEW = '__new__'

interface Row {
  upper_bound: string
  rate: string
}

interface Editor {
  /** `null` is a model being written; a string is the model being corrected. */
  target: string | null
  name: string
  kind: string
  /** The scalar parameters, as the reader typed them. */
  fields: Record<string, string>
  brackets: Row[]
}

const EMPTY_ROWS: Row[] = [{ upper_bound: '', rate: '' }]

interface TaxationModelFieldProps {
  /** The model the draft carries, or `null` for none. */
  value: string | null
  onChange: (next: string | null) => void
}

export function TaxationModelField({ value, onChange }: TaxationModelFieldProps) {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const catalogue = useQuery({ queryKey: ['taxation-models'], queryFn: api.taxationModels })
  const [editor, setEditor] = useState<Editor | null>(null)

  const models = catalogue.data?.models ?? []
  const kinds = catalogue.data?.kinds ?? []
  const ageBases = catalogue.data?.age_bases ?? []
  const templates = (catalogue.data?.templates ?? []).filter(
    (template) => template.kind === editor?.kind,
  )
  function parametersOf(kind: string): TaxationParameter[] {
    return kinds.find((entry) => entry.kind === kind)?.parameters ?? []
  }

  const parameters = parametersOf(editor?.kind ?? '')

  const write = useMutation({
    mutationFn: (draft: Editor) => {
      const body = {
        name: draft.name.trim(),
        kind: draft.kind,
        parameters: assemble(parameters, draft),
      }
      return draft.target === null
        ? api.createTaxationModel(body)
        : api.updateTaxationModel(draft.target, body)
    },
    onSuccess: (model) => {
      void queryClient.invalidateQueries({ queryKey: ['taxation-models'] })
      // A correction reaches every account carrying the model, so the accounts
      // go too — they publish the reference this panel has just moved.
      void queryClient.invalidateQueries({ queryKey: ['accounts'] })
      onChange(model.id)
      setEditor(null)
    },
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.removeTaxationModel(id),
    onSuccess: (removed) => {
      void queryClient.invalidateQueries({ queryKey: ['taxation-models'] })
      if (value === removed.id) onChange(null)
      setEditor(null)
    },
  })

  // The panel is mounted once for the page and reused for every account, so a
  // refusal earned on one model must not be on screen under the next — the same
  // rule, and the same reason, as `AccountForm`'s own two resets.
  useEffect(() => {
    setEditor(null)
    write.reset()
    remove.reset()
  }, [value])

  function choose(chosen: string) {
    if (chosen === NEW) {
      const first = kinds[0]?.kind ?? ''
      setEditor({ target: null, name: '', kind: first, fields: {}, brackets: EMPTY_ROWS })
      write.reset()
      return
    }
    setEditor(null)
    onChange(chosen === '' ? null : chosen)
  }

  function correct(model: TaxationModel) {
    setEditor(disassemble(model, parametersOf(model.kind)))
    write.reset()
    remove.reset()
  }

  function field(name: string, next: string) {
    setEditor((previous) =>
      previous === null ? previous : { ...previous, fields: { ...previous.fields, [name]: next } },
    )
  }

  const selected = models.find((model) => model.id === value) ?? null

  // **Nothing at all until the catalogue has landed** (ADR-0026), and the same
  // for a read that refused. A `<select>` whose options have not arrived cannot
  // render the model this account carries — its value matches no option — so it
  // would show *no model* about an account that has one, which is the reading
  // the record is written against. The block is optional, the account is
  // declared and renamed without it, and what announces a store that will not
  // answer is the bell, once.
  if (catalogue.data === undefined) return null

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <label htmlFor="account-taxation" className="text-sm font-medium">
          {t('accounts.form.taxation')}
        </label>
        <span className="text-xs text-muted-foreground">{t('data.form.optional')}</span>
      </div>

      <select
        id="account-taxation"
        className={SELECT}
        value={editor !== null && editor.target === null ? NEW : (value ?? '')}
        onChange={(changed) => choose(changed.target.value)}
      >
        {/* Named, and the value the panel opens on: an account with no model is
            ordinary, and nothing is written for it. */}
        <option value="">{t('accounts.form.taxation.none')}</option>
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.name}
          </option>
        ))}
        <option value={NEW}>{t('accounts.form.taxation.new')}</option>
      </select>

      <p className="max-w-prose text-xs text-muted-foreground">
        {t('accounts.form.taxation.hint')}
      </p>

      {editor === null && selected !== null ? (
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => correct(selected)}>
            {t('accounts.form.taxation.edit')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={remove.isPending}
            onClick={() => remove.mutate(selected.id)}
          >
            {t('accounts.form.taxation.remove')}
          </Button>
        </div>
      ) : null}

      {/* The refusal that names the accounts carrying the model — beside the
          button that asked, never as a strip at the top of the page. */}
      {remove.error ? <Refusal>{problemSentence(t, remove.error)}</Refusal> : null}

      {editor === null ? null : (
        <div
          className="space-y-4 rounded-md border border-border p-3"
          // **Enter saves the model, and never the account.** This block sits
          // inside `AccountForm`'s own `<form>` — a nested one is not HTML — so
          // an Enter in any field here triggers that form's implicit submission:
          // the account would be declared, the panel would shut, and the model
          // the reader was halfway through typing would never be sent. The
          // buttons below carry `type="button"` against the same hazard; this is
          // the half of it no attribute can reach.
          onKeyDown={(pressed) => {
            if (pressed.key !== 'Enter' || pressed.shiftKey) return
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

          {/* The shortcut, **nested** under the one kind that has structure to
              pre-fill, and absent everywhere else (ADR-0043). */}
          {templates.length === 0 ? null : (
            <Labelled id="taxation-template" label="taxation.template">
              <select
                id="taxation-template"
                className={SELECT}
                // It holds no state of its own: what it fills is the two fields
                // below, and it does not survive the submission.
                value=""
                onChange={(changed) => {
                  const picked = templates.find((entry) => entry.id === changed.target.value)
                  if (picked === undefined) return
                  setEditor({
                    ...editor,
                    fields: { ...editor.fields, ...displayed(picked.values) },
                  })
                }}
              >
                <option value="">{t('taxation.template.none')}</option>
                {templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {t(`taxation.template.${template.id}` as MessageKey)}
                  </option>
                ))}
              </select>
            </Labelled>
          )}

          {parameters.map((parameter) =>
            parameter.type === 'brackets' ? (
              <Brackets
                key={parameter.name}
                rows={editor.brackets}
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
                  <Number_
                    id={`taxation-${parameter.name}`}
                    percent={parameter.type === 'rate'}
                    value={editor.fields[parameter.name] ?? ''}
                    onChange={(next) => field(parameter.name, next)}
                  />
                )}
              </Labelled>
            ),
          )}

          {write.error ? <Refusal>{problemSentence(t, write.error)}</Refusal> : null}

          <div className="flex gap-2">
            {/* `type="button"`: this block lives inside the account's own form,
                and a submit here would declare the account instead. */}
            <Button
              type="button"
              size="sm"
              disabled={write.isPending}
              onClick={() => write.mutate(editor)}
            >
              {t('taxation.save')}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setEditor(null)}>
              {t('taxation.cancel')}
            </Button>
          </div>
        </div>
      )}
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

/** A number, with the unit said beside it where the unit is a percentage. */
function Number_({
  id,
  value,
  percent,
  onChange,
}: {
  id: string
  value: string
  percent: boolean
  onChange: (next: string) => void
}) {
  return (
    <div className="flex items-center gap-2">
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        step={percent ? '0.01' : '1'}
        value={value}
        onChange={(changed) => onChange(changed.target.value)}
      />
      {percent ? <span className="text-sm text-muted-foreground">%</span> : null}
    </div>
  )
}

/**
 * The ladder — bottom to top, and **the top rung has no ceiling**.
 *
 * That is not a rendering choice: a set of bounded brackets says nothing about
 * the gain above the highest of them, so the last row says *and above* where its
 * bound would be, and the server refuses a ladder shaped any other way.
 */
function Brackets({ rows, onChange }: { rows: Row[]; onChange: (rows: Row[]) => void }) {
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
              <span className="flex-1 text-sm text-muted-foreground">{t('taxation.brackets.top')}</span>
            ) : (
              <Input
                type="number"
                inputMode="decimal"
                aria-label={t('taxation.brackets.upperBound')}
                value={row.upper_bound}
                onChange={(changed) => set(index, 'upper_bound', changed.target.value)}
              />
            )}
            <Input
              type="number"
              inputMode="decimal"
              step="0.01"
              className="w-24"
              aria-label={t('taxation.brackets.rate')}
              value={row.rate}
              onChange={(changed) => set(index, 'rate', changed.target.value)}
            />
            <span className="text-sm text-muted-foreground">%</span>
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
        onClick={() => onChange([...rows.slice(0, -1), { upper_bound: '', rate: '' }, rows[rows.length - 1]])}
      >
        {t('taxation.brackets.add')}
      </Button>
    </fieldset>
  )
}

/** A template's values, in the units the fields are typed in. */
function displayed(values: TaxationParameters): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [name, String(value)]),
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
  return { target: model.id, name: model.name, kind: model.kind, fields, brackets }
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
