import type { Locale } from '../i18n'
import { de } from './de'
import { en } from './en'

/** Both string tables by locale, for code outside React (main process, MCP texts). */
export const LOCALE_STRINGS: Record<Locale, Record<string, string>> = { de, en }
