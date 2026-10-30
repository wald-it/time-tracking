/**
 * Why deleting a client or project is refused (2.0 P2, owner decision
 * 2026-10-26): any entry version points at it. Shared so the Kunden view can
 * tell this refusal from other failures and offer archiving instead (#452).
 */
export const CLIENT_HAS_ENTRIES_ERROR =
  'Kunde hat Einträge (auch gelöschte oder frühere Versionen) und kann nicht gelöscht werden'
export const PROJECT_HAS_ENTRIES_ERROR =
  'Projekt hat Einträge (auch gelöschte oder frühere Versionen) und kann nicht gelöscht werden'
