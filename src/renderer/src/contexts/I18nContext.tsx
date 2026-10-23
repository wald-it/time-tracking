import { createContext, useCallback, useContext, useMemo, useRef, useState, useEffect } from 'react'
import type { Locale } from '../../../shared/i18n'
import { localeFromSetting, translate } from '../../../shared/i18n'
import type { TranslationKey } from '../../../shared/locales/de'
import { de } from '../../../shared/locales/de'
import { en } from '../../../shared/locales/en'
import { useSettingsStore } from '../store/settingsStore'

const localeMap: Record<Locale, Record<string, string>> = { de, en }

export type TFunction = (key: TranslationKey, vars?: Record<string, string | number>) => string

interface I18nCtx {
  locale: Locale
  setLocale: (l: Locale) => Promise<void>
  t: TFunction
}

const I18nContext = createContext<I18nCtx | null>(null)

/**
 * Provides i18n context to the app.
 *
 * On mount, reads the saved locale from the `language` settings key and
 * applies it. Until the async read resolves, the app renders with the
 * default locale ('de'), which is instant for most users.
 *
 * `setLocale` persists the change to the DB via the settings IPC so it
 * survives app restarts.
 */
export function I18nProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  // Selector: re-renders only when the language key changes, not on every
  // settings write (v1.13.2 PR 2).
  const language = useSettingsStore((s) => s.settings?.language)
  const [locale, setLocaleState] = useState<Locale>('de')
  // Set once the user picks a language. The store is filled by load() and
  // never told about setLocale (raw settings.set, no push), so a load that
  // resolves after the pick carries the old value and must not undo it.
  const pickedRef = useRef(false)

  // Sync locale with the stored value (shared rule, #296) until the user
  // picks one. Before the settings load (`undefined`) the default stays.
  useEffect(() => {
    // Local state on purpose (#142): setLocale calls raw window.api.settings.set,
    // and settings:set sends no push update, so this state is the only place
    // that learns of the change (like ThemeContext).
    if (language !== undefined && !pickedRef.current) setLocaleState(localeFromSetting(language))
  }, [language])

  const setLocale = useCallback(async (l: Locale) => {
    pickedRef.current = true
    setLocaleState(l)
    // Keep the store's copy current for anyone else reading settings.language
    // (a load still running may overwrite it; pickedRef covers this provider).
    useSettingsStore.setState((s) =>
      s.settings ? { settings: { ...s.settings, language: l } } : s
    )
    await window.api.settings.set('language', l)
  }, [])

  const t = useCallback<TFunction>((key, vars) => translate(localeMap[locale], key, vars), [locale])

  const value = useMemo<I18nCtx>(() => ({ locale, setLocale, t }), [locale, setLocale, t])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

/**
 * Returns the `t()` translation function bound to the current locale.
 * Must be called within an `I18nProvider`.
 */
// eslint-disable-next-line react-refresh/only-export-components -- Provider und Hooks liegen bewusst im selben Modul; ein Fast-Refresh-Split würde nur die ~26 Importpfade streuen, ohne Laufzeitnutzen.
export function useT(): TFunction {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useT must be used within an I18nProvider')
  return ctx.t
}

/**
 * Returns the current locale and a setter that persists the change.
 * Must be called within an `I18nProvider`.
 */
// eslint-disable-next-line react-refresh/only-export-components -- siehe useT: Provider + Hooks bewusst im selben Modul.
export function useLocale(): { locale: Locale; setLocale: (l: Locale) => Promise<void> } {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useLocale must be used within an I18nProvider')
  return { locale: ctx.locale, setLocale: ctx.setLocale }
}
