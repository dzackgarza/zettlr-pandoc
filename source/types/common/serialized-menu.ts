/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Serialised application menu
 * CVM-Role:        Types
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The one definition of a serialised application-menu item:
 *                  what the menu provider emits over the `menu-provider`
 *                  channel (`application-menu`, `application-submenu`) and
 *                  what a renderer parses at its IPC boundary. The zod schema
 *                  is the definition; the types are inferred from it.
 *
 * END HEADER
 */

import { z } from 'zod'

export const serializedSeparatorSchema = z.object({
  type: z.literal('separator')
})

export const serializedNormalItemSchema = z.object({
  type: z.literal('normal'),
  id: z.string().min(1).optional(),
  label: z.string(),
  enabled: z.boolean(),
  accelerator: z.string().min(1).optional()
})

export const serializedCheckItemSchema = z.object({
  type: z.enum([ 'checkbox', 'radio' ]),
  id: z.string().min(1).optional(),
  label: z.string(),
  enabled: z.boolean(),
  accelerator: z.string().min(1).optional(),
  checked: z.boolean()
})

export type SerializedSeparator = z.infer<typeof serializedSeparatorSchema>
export type SerializedNormalItem = z.infer<typeof serializedNormalItemSchema>
export type SerializedCheckItem = z.infer<typeof serializedCheckItemSchema>

export interface SerializedSubmenu {
  type: 'submenu'
  id?: string
  label: string
  enabled: boolean
  submenu: SerializedMenuItem[]
}

export type SerializedMenuItem =
  | SerializedSeparator
  | SerializedNormalItem
  | SerializedCheckItem
  | SerializedSubmenu

export const serializedSubmenuSchema: z.ZodType<SerializedSubmenu> = z.lazy(() => z.object({
  type: z.literal('submenu'),
  id: z.string().min(1).optional(),
  label: z.string(),
  enabled: z.boolean(),
  submenu: z.array(serializedMenuItemSchema)
}))

export const serializedMenuItemSchema: z.ZodType<SerializedMenuItem> = z.lazy(() => z.union([
  serializedSeparatorSchema,
  serializedNormalItemSchema,
  serializedCheckItemSchema,
  serializedSubmenuSchema
]))

/** The whole application menu: its top-level items, each a submenu. */
export const serializedMenuSchema = z.array(serializedMenuItemSchema)

/** The `menu-provider` messages a renderer receives. */
export const menuProviderMessageSchema = z.discriminatedUnion('command', [
  z.object({ command: z.literal('application-menu'), payload: serializedMenuSchema }),
  z.object({
    command: z.literal('application-submenu'),
    payload: z.object({ id: z.string().min(1), submenu: serializedMenuSchema })
  })
])

export type MenuProviderMessage = z.infer<typeof menuProviderMessageSchema>
