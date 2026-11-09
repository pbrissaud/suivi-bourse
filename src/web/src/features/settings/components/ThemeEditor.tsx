/**
 * *Thème* as a page (`Reglages-Theme-Refonte`, #1314): the token list on the
 * left, the real pages on the right.
 *
 * The first line holds the way back, « ← Réglages », and the three ways in that
 * are not the form — import from tweakcn, the JSON, export. Under it, a column
 * of the tokens of the ground being edited, in groups, each with its swatch, a
 * dot when modified and « Rétablir »; then the shape (radius, shadows, letter
 * spacing) and the two faces. Every change is drawn in the preview beside it,
 * scoped to its wrapper (`ThemePreview`), and **nothing is saved until
 * « Appliquer »**; leaving with edits asks.
 *
 * The baseline is pinned when the page opens: a background refetch of the
 * stored theme does not move what « modified » is measured against. After an
 * apply it becomes the server's answer.
 */
import { useMemo, useRef, useState } from 'react'
import { Link, useBlocker } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { DownloadIcon, UploadIcon } from 'lucide-react'

import { TextTabs } from '@/components/TextTabs'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { TextAction } from '@/features/settings/components/ListSetting'
import { ImportDialog, JsonDialog } from '@/features/settings/components/ThemeDialogs'
import { ThemeLeaveDialog } from '@/features/settings/components/ThemeLeaveDialog'
import { ThemePreview } from '@/features/settings/components/ThemePreview'
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
import type { Ground } from '@/lib/theme'
import { repaint } from '@/lib/themePreview'
import { cn } from '@/lib/utils'
import atelier from '@/theme/atelier.json'

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

/** What a slider's value reads as: the radius in pixels, the shadows in percent or « aucune ». */
function shown(t: (key: MessageKey) => string, key: string, n: number): string {
  if (key === 'shadow-opacity')
    return n === 0 ? t('settings.theme.shadows.none') : `${Math.round(n * 100)} %`
  if (key === 'radius') return `${Math.round(n * 16)} px`
  return `${+n.toFixed(3)} ${UNIT[key]}`
}

function TokenRow({
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
  const { t } = useI18n()
  return (
    <div className="group grid min-h-9 grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-x-2.5 border-b text-sm">
      <input
        type="color"
        aria-label={name}
        value={toHex(value)}
        onChange={(event) => onChange(event.target.value)}
        className="size-5 cursor-pointer appearance-none rounded-[5px] border bg-transparent p-0 [&::-webkit-color-swatch]:rounded-[4px] [&::-webkit-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-0"
      />
      <span className="inline-flex items-center gap-2">
        {name}
        {edited ? (
          <span
            role="img"
            aria-label={t('settings.theme.modified')}
            className="size-1.5 rounded-full bg-primary"
          />
        ) : null}
      </span>
      <span className="inline-flex items-baseline gap-2.5">
        {edited ? (
          <TextAction
            className="text-xs opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
            aria-label={t('settings.theme.revert', { name })}
            onClick={onRevert}
          >
            {t('settings.reset')}
          </TextAction>
        ) : null}
        <span className={cn('fig text-xs', edited ? 'text-foreground' : 'text-muted-foreground')}>
          {toHex(value).toUpperCase()}
        </span>
      </span>
    </div>
  )
}

export function ThemeEditor({ stored }: { stored: ThemeVars | null }) {
  const { t } = useI18n()
  const client = useQueryClient()
  // Pinned when the page opens: a refetch of the stored theme does not move it.
  const [baseline, setBaseline] = useState<ThemeVars>(stored ?? (atelier as ThemeVars))
  const [edits, setEdits] = useState<Edits>(NO_EDITS)
  const [ground, setGround] = useState<Ground>('light')
  const [dialog, setDialog] = useState<'import' | 'json' | null>(null)
  const next = useMemo(() => candidate(baseline, edits), [baseline, edits])
  const edited = count(edits)
  const dirty = useRef(false)
  dirty.current = edited > 0
  const theme = useQuery({ queryKey: ['theme'], queryFn: settingsApi.theme })
  const kept = theme.data !== undefined ? theme.data : stored

  const edit = (scope: Scope, key: string, value: string | null) =>
    setEdits(setEdit(baseline, edits, scope, key, value))

  /** The store kept `answer`; the page's own stylesheet is fetched again. */
  const stay = async (answer: ThemeVars | null) => {
    client.setQueryData(['theme'], answer)
    setBaseline(answer ?? (atelier as ThemeVars))
    setEdits(NO_EDITS)
    await repaint()
  }
  const saving = useMutation({
    mutationFn: async () => {
      const answer = await settingsApi.saveTheme(next)
      // Saved, but the page could not fetch its new stylesheet: say that, not "unreachable".
      await stay(answer).catch(() => {
        throw new RepaintFailed()
      })
    },
  })
  const resetting = useMutation({
    mutationFn: async () => {
      if (kept) await settingsApi.resetTheme()
      await stay(null).catch(() => {})
    },
  })

  // Only leaving the page asks: nothing is painted outside the preview.
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next: to }) => dirty.current && current.pathname !== to.pathname,
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
    : resetting.isError
      ? t(problemMessageKey(resetting.error))
      : null

  const exportJson = () => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(next, null, 2)], { type: 'application/json' }),
    )
    const link = document.createElement('a')
    link.href = url
    link.download = 'theme.json'
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <Link
          to="/settings"
          className="text-sm text-muted-foreground no-underline hover:text-foreground"
        >
          {t('settings.theme.back')}
        </Link>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setDialog('import')}>
            <UploadIcon aria-hidden />
            {t('settings.theme.import.open')}
          </Button>
          <Button onClick={() => setDialog('json')}>{t('settings.theme.json')}</Button>
          <Button onClick={exportJson}>
            <DownloadIcon aria-hidden />
            {t('settings.theme.export')}
          </Button>
        </div>
      </div>

      <div className="grid flex-1 grid-cols-1 gap-8 pt-5 pb-6 lg:grid-cols-[400px_minmax(0,1fr)]">
        {/* Nothing is edited while an apply is in flight: its answer resets the edits. */}
        <fieldset className="min-w-0" disabled={saving.isPending}>
          <TextTabs
            size="sheet"
            label={t('settings.theme.palette')}
            value={ground}
            onChange={setGround}
            tabs={[
              { value: 'light', label: t('settings.theme.ground.light') },
              { value: 'dark', label: t('settings.theme.ground.dark') },
            ]}
          />

          {COLOUR_GROUPS.map((group) => (
            <div key={group.title}>
              <p className="label mt-5 mb-1.5">{t(group.title)}</p>
              {group.fields.map(({ key, label }) => (
                <TokenRow
                  key={key}
                  name={t(label)}
                  value={valueOf(baseline, edits, ground, key)}
                  edited={key in edits[ground]}
                  onChange={(hex) => edit(ground, key, fromHex(hex))}
                  onRevert={() => edit(ground, key, null)}
                />
              ))}
            </div>
          ))}

          <p className="label mt-5 mb-1.5">{t('settings.theme.shape')}</p>
          {SLIDERS.map(({ key, label, min, max, step }) => {
            const name = t(label)
            const value = toNumber(key, valueOf(baseline, edits, 'theme', key))
            return (
              <div
                key={key}
                className="grid min-h-9 grid-cols-[minmax(0,1fr)_120px_64px] items-center gap-3 border-b text-sm"
              >
                <span className="inline-flex items-center gap-2">
                  {name}
                  {key in edits.theme ? (
                    <TextAction
                      aria-label={t('settings.theme.revert', { name })}
                      onClick={() => edit('theme', key, null)}
                    >
                      {t('settings.reset')}
                    </TextAction>
                  ) : null}
                </span>
                <Slider
                  aria-label={name}
                  aria-valuetext={shown(t, key, value)}
                  min={min}
                  max={max}
                  step={step}
                  value={[Number.isFinite(value) ? value : min]}
                  onValueChange={([n]) => edit('theme', key, fromNumber(key, n))}
                />
                <span className="fig text-right text-xs text-muted-foreground">
                  {shown(t, key, value)}
                </span>
              </div>
            )
          })}

          <p className="label mt-5 mb-1.5">{t('settings.theme.fonts')}</p>
          {(['font-sans', 'font-mono'] as const).map((key) => {
            const name = t(`settings.theme.${key}`)
            const value = valueOf(baseline, edits, 'theme', key)
            const known = FONTS[key].some((font) => font.value === value)
            return (
              <div
                key={key}
                className="grid min-h-9 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b text-sm"
              >
                <span className="inline-flex items-center gap-2">
                  {name}
                  {key in edits.theme ? (
                    <TextAction
                      aria-label={t('settings.theme.revert', { name })}
                      onClick={() => edit('theme', key, null)}
                    >
                      {t('settings.reset')}
                    </TextAction>
                  ) : null}
                </span>
                <Select value={value} onValueChange={(font) => edit('theme', key, font)}>
                  <SelectTrigger aria-label={name} className="h-8 w-40">
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
              </div>
            )
          })}
        </fieldset>

        <ThemePreview theme={next} ground={ground} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4 border-t py-3.5">
        {failure === null ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t('settings.theme.preview', { count: edited })}
          </p>
        ) : (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
        <div className="flex gap-2">
          <Button
            disabled={(kept === null && edited === 0) || resetting.isPending || saving.isPending}
            onClick={() => resetting.mutate()}
          >
            {t('settings.theme.restore')}
          </Button>
          <Button asChild>
            <Link to="/settings">{t('settings.access.cancel')}</Link>
          </Button>
          <Button
            variant="primary"
            disabled={edited === 0 || saving.isPending}
            onClick={() => saving.mutate()}
          >
            {t('settings.theme.apply')}
          </Button>
        </div>
      </div>

      {dialog === 'import' ? (
        <ImportDialog
          onKept={(answer) => {
            stay(answer).catch(() => {})
            setDialog(null)
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === 'json' ? (
        <JsonDialog
          current={kept}
          onKept={(answer) => {
            stay(answer).catch(() => {})
            setDialog(null)
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}

      <ThemeLeaveDialog
        open={blocker.status === 'blocked'}
        count={edited}
        busy={saving.isPending}
        onStay={() => blocker.reset?.()}
        onDiscard={() => blocker.proceed?.()}
        onApply={() =>
          saving.mutate(undefined, {
            onSuccess: () => blocker.proceed?.(),
            // The refusal shows in the bar: stay, with the edits kept.
            onError: () => blocker.reset?.(),
          })
        }
      />
    </div>
  )
}
