import { createContext } from 'react'

/**
 * Id of the label of the row a switch sits in. A settings row provides it, so
 * every Toggle in such a row is named by that label without each call site
 * passing `labelledBy`. In a file of its own so Toggle.tsx exports components
 * only (fast refresh).
 */
export const ToggleLabelContext = createContext<string | undefined>(undefined)
