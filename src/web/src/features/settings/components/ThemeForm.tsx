/**
 * *Thème* as a form with a live preview (#1314).
 *
 * The form edits a few primary keys (`lib/themeForm.ts`); every change paints
 * the **candidate** theme over the whole app through one `<style>`
 * (`lib/themePreview.ts`) and nothing is saved until **Appliquer**. Unmounting
 * always reverts the preview, so closing, discarding and navigating away are
 * all the same gesture to the page: take the element off.
 *
 * The baseline is pinned when the form opens: a background refetch of the
 * stored theme does not move what "modified" is measured against. After an
 * apply it becomes the server's answer.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useBlocker } from '@tanstack/react-router'
import { useMutation } from '@tanstack/react-query'
import { RotateCcwIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Segmented } from '@/components/Segmented'
import { ThemeLeaveDialog } from '@/features/settings/components/ThemeLeaveDialog'
import { settingsApi, type ThemeVars } from '@/features/settings/lib/api'
import {
  COLOUR_GROUPS,
  candidate,
  count,
  type Edits,
  FONTS,
  fromNumber,
  NO_EDITS,
  type Scope,
  setEdit,
  toNumber,
  UNIT,
  valueOf,
} from '@/features/settings/lib/themeForm'
import { useI18n, type MessageKey } from '@/lib/i18n'
import { fromHex, toHex } from '@/lib/oklch'
import { problemMessageKey, refusedKey } from '@/lib/problem'
import { useTheme, type Ground } from '@/lib/theme'
import { clearPreview, previewCss, showPreview } from '@/lib/themePreview'
import { cn } from '@/lib/utils'

const SLIDERS = [
  { key: 'radius', label: 'settings.theme.radius', min: 0, max: 1.5, step: 0.125 },
  { key: 'shadow-opacity', label: 'settings.theme.shadows', min: 0, max: 0.5, step: 0.01 },
  { key: 'tracking-normal', label: 'settings.theme.tracking', min: -0.05, max: 0.1, step: 0.005 },
] as const satisfies readonly {
  key: string
  label: MessageKey
  min: number
  max: number
  step: number
}[]

class RepaintFailed extends Error {}

const shown = (key: string, n: number) =>
  key === 'shadow-opacity' ? `${Math.round(n * 100)} %` : `${+n.toFixed(3)} ${UNIT[key]}`

function Revert({ name, onClick }: { name: string; onClick: () => void }) {
  const { t } = useI18n()
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={t('settings.theme.revert', { name })}
      onClick={onClick}
    >
      <RotateCcwIcon aria-hidden />
    </Button>
  )
}

function ColourRow({
  name,
  value,
  edited,
  onChange,
  onRevert,
}: {
  name: string
  value: string
  edited: boolean
  onChange: (hex: string) => void
  onRevert: () => void
}) {
  return (
    <div className="flex min-h-11 items-center gap-3">
      <input
        type="color"
        aria-label={name}
        value={toHex(value)}
        onChange={(event) => onChange(event.target.value)}
        className="size-8 shrink-0 cursor-pointer rounded-md border bg-transparent p-0.5 [&::-webkit-color-swatch]:rounded-sm [&::-webkit-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-0"
      />
      <div className={cn('min-w-0 flex-1', edited && 'font-medium')}>
        <div className="text-sm">{name}</div>
        <div className="truncate font-mono text-2xs text-muted-foreground">{value}</div>
      </div>
      {edited ? <Revert name={name} onClick={onRevert} /> : null}
    </div>
  )
}

export function ThemeForm({
  baseline: pinned,
  onApplied,
  onClose,
}: {
  baseline: ThemeVars
  /** The store kept this; resolves once the page's stylesheet has repainted with it. */
  onApplied: (kept: ThemeVars) => Promise<void>
  onClose: () => void
}) {
  const { t } = useI18n()
  const { ground: current, setPreviewGround } = useTheme()
  const [baseline, setBaseline] = useState(pinned)
  const [edits, setEdits] = useState<Edits>(NO_EDITS)
  const [ground, setGround] = useState<Ground>(current)
  const next = useMemo(() => candidate(baseline, edits), [baseline, edits])
  const edited = count(edits)
  const dirty = useRef(false)
  dirty.current = edited > 0

  // Editing the dark palette is seen in dark, whatever the reader's choice.
  useEffect(() => setPreviewGround(ground), [ground, setPreviewGround])
  useEffect(
    () => () => {
      setPreviewGround(null)
      clearPreview()
    },
    [setPreviewGround],
  )
  useEffect(() => {
    if (edited > 0) showPreview(previewCss(next))
  }, [next, edited])

  const update = (to: Edits) => {
    setEdits(to)
    if (count(to) === 0) clearPreview()
  }
  const edit = (scope: Scope, key: string, value: string | null) =>
    update(setEdit(baseline, edits, scope, key, value))

  const saving = useMutation({
    mutationFn: async () => {
      const kept = await settingsApi.saveTheme(next)
      // Saved, but the page could not fetch its new stylesheet: say that, not "unreachable".
      await onApplied(kept).catch(() => {
        throw new RepaintFailed()
      })
      return kept
    },
    onSuccess: (kept) => {
      setBaseline(kept)
      setEdits(NO_EDITS)
      clearPreview()
    },
  })

  // Only leaving the page asks: the Settings anchors change the hash, not the path.
  const blocker = useBlocker({
    shouldBlockFn: ({ current: from, next: to }) => dirty.current && from.pathname !== to.pathname,
    enableBeforeUnload: () => dirty.current,
    withResolver: true,
  })

  const refused = refusedKey(saving.error)
  const failure = saving.isError
    ? saving.error instanceof RepaintFailed
      ? t('settings.theme.repaint.failed')
      : refused !== null
        ? t('settings.theme.refused', { key: refused })
        : t(problemMessageKey(saving.error))
    : null

  return (
    <div className="space-y-6">
      {/* Nothing is edited while an apply is in flight: its answer resets the edits. */}
      <fieldset className="contents" disabled={saving.isPending}>
        <Segmented
          label={t('settings.theme.palette')}
          mode="radio"
          bordered
          value={ground}
          onChange={setGround}
          options={[
            { value: 'light', label: t('settings.theme.ground.light') },
            { value: 'dark', label: t('settings.theme.ground.dark') },
          ]}
        />

        <div className="grid grid-cols-1 gap-x-8 gap-y-6 md:grid-cols-3">
          {COLOUR_GROUPS.map((group) => (
            <fieldset key={group.title} className="min-w-0">
              <legend className="label mb-1">{t(group.title)}</legend>
              {group.fields.map(({ key, label }) => (
                <ColourRow
                  key={key}
                  name={t(label)}
                  value={valueOf(baseline, edits, ground, key)}
                  edited={key in edits[ground]}
                  onChange={(hex) => edit(ground, key, fromHex(hex))}
                  onRevert={() => edit(ground, key, null)}
                />
              ))}
            </fieldset>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-x-8 gap-y-6 md:grid-cols-2">
          <fieldset className="min-w-0">
            <legend className="label mb-1">{t('settings.theme.shape')}</legend>
            {SLIDERS.map(({ key, label, min, max, step }) => {
              const name = t(label)
              const value = toNumber(key, valueOf(baseline, edits, 'theme', key))
              return (
                <div
                  key={key}
                  className={cn(
                    'flex min-h-11 items-center gap-3',
                    key in edits.theme && 'font-medium',
                  )}
                >
                  <span className="w-36 shrink-0 text-sm">{name}</span>
                  <Slider
                    aria-label={name}
                    aria-valuetext={shown(key, value)}
                    disabled={saving.isPending}
                    min={min}
                    max={max}
                    step={step}
                    value={[Number.isFinite(value) ? value : min]}
                    onValueChange={([n]) => edit('theme', key, fromNumber(key, n))}
                  />
                  <span className="w-16 shrink-0 text-right text-sm tabular">
                    {shown(key, value)}
                  </span>
                  {key in edits.theme ? (
                    <Revert name={name} onClick={() => edit('theme', key, null)} />
                  ) : (
                    <span className="size-8 shrink-0" />
                  )}
                </div>
              )
            })}
          </fieldset>

          <fieldset className="min-w-0">
            <legend className="label mb-1">{t('settings.theme.fonts')}</legend>
            {(['font-sans', 'font-mono'] as const).map((key) => {
              const name = t(`settings.theme.${key}`)
              const value = valueOf(baseline, edits, 'theme', key)
              const known = FONTS[key].some((font) => font.value === value)
              return (
                <div
                  key={key}
                  className={cn(
                    'flex min-h-11 items-center gap-3',
                    key in edits.theme && 'font-medium',
                  )}
                >
                  <span className="w-36 shrink-0 text-sm">{name}</span>
                  <Select value={value} onValueChange={(font) => edit('theme', key, font)}>
                    <SelectTrigger aria-label={name}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FONTS[key].map((font) => (
                        <SelectItem key={font.value} value={font.value}>
                          {t(font.label)}
                        </SelectItem>
                      ))}
                      {known ? null : (
                        <SelectItem value={value}>
                          {t('settings.theme.font.custom', { name: value.split(',')[0] })}
                        </SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                  {key in edits.theme ? (
                    <Revert name={name} onClick={() => edit('theme', key, null)} />
                  ) : (
                    <span className="size-8 shrink-0" />
                  )}
                </div>
              )
            })}
          </fieldset>
        </div>
      </fieldset>

      {/* Applying is a decision, so a card is allowed; no shadow. */}
      <Card className="sticky bottom-4 z-10 gap-2 py-3 px-4 shadow-none">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p role="status" className="text-sm">
            {t('settings.theme.preview', { count: edited })}
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t(edited > 0 ? 'settings.theme.cancel' : 'settings.theme.close')}
            </Button>
            <Button
              type="button"
              disabled={edited === 0 || saving.isPending}
              onClick={() => saving.mutate()}
            >
              {t('settings.theme.apply')}
            </Button>
          </div>
        </div>
        {failure !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        ) : null}
      </Card>

      <ThemeLeaveDialog
        open={blocker.status === 'blocked'}
        count={edited}
        busy={saving.isPending}
        onStay={() => blocker.reset?.()}
        onDiscard={() => blocker.proceed?.()}
        onApply={() =>
          saving.mutate(undefined, {
            onSuccess: () => blocker.proceed?.(),
            // The refusal shows in the bar: stay, with edits and preview kept.
            onError: () => blocker.reset?.(),
          })
        }
      />
    </div>
  )
}
