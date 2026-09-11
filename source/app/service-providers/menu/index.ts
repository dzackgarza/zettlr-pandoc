/**
* @ignore
* BEGIN HEADER
*
* Contains:        MenuProvider
* CVM-Role:        Service Provider
* Maintainer:      Hendrik Erz
* License:         GNU GPL v3
*
* Description:     Very basic wrapper around electron Menu class.
*
* END HEADER
*/

import {
  Menu,
  ipcMain,
  BrowserWindow,
  type MenuItemConstructorOptions,
  app,
  type WebFrameMain
} from 'electron'

import broadcastIPCMessage from '@common/util/broadcast-ipc-message'

// Import the menu constructors
import win32Menu from './menu.win32'
import macOSMenu from './menu.darwin'
import ProviderContract from '../provider-contract'
import type RecentDocumentsProvider from '../recent-docs'
import type CommandProvider from '../commands'
import type LogProvider from '../log'
import type ConfigProvider from '@providers/config'
import type DocumentManager from '@providers/documents'
import type WindowProvider from '@providers/windows'
import type { SerializedMenuItem, SerializedSubmenu } from '@dts/common/serialized-menu'

const BLUEPRINTS = {
  // Currently we ship two different sets of menu items -- one for macOS, and
  // one for all other platforms. However, this setup enables us to in the
  // future fulfill more platforms' special needs, if it's necessary.
  win32: win32Menu,
  linux: win32Menu,
  darwin: macOSMenu,
  aix: win32Menu,
  android: win32Menu,
  freebsd: win32Menu,
  openbsd: win32Menu,
  sunos: win32Menu,
  cygwin: win32Menu,
  netbsd: win32Menu,
  haiku: win32Menu
}

/**
* This class generates the menu based upon the menu.tpl.json as well as additional
* config variables and the platform.
*/
export default class MenuProvider extends ProviderContract {
  /**
   * Keeps track of the state of checkboxes which are not controlled by a
   * configuration setting.
   */
  _checkboxState: Map<string, boolean>

  /**
  * Creates the main application menu and sets it.
  */
  constructor (
    private readonly _logger: LogProvider,
    private readonly _config: ConfigProvider,
    private readonly _recentDocs: RecentDocumentsProvider,
    private readonly _commands: CommandProvider,
    private readonly _windows: WindowProvider,
    private readonly _documents: DocumentManager
  ) {
    super()
    this._checkboxState = new Map()

    // Begin listening to configuration update events that announce a change in
    // the recent docs list so that we can make sure the menu is always updated.
    this._config.on('update', () => { this.set() })
    if (![ 'darwin', 'win32' ].includes(process.platform)) {
      this._recentDocs.on('update', () => { this.set() })
    }

    ipcMain.on('menu-provider', (event, message) => {
      const { command } = message

      if (command === 'get-application-menu') {
        event.reply('menu-provider', {
          command: 'application-menu',
          payload: this.serializableApplicationMenu
        })
      } else if (command === 'get-application-submenu') {
        const itemID = message.payload as string
        const appMenu = Menu.getApplicationMenu()
        if (appMenu === null) {
          // Cannot send submenu: No menu set
          return
        }

        // Send the serialized submenu to the renderer
        const menuItem = appMenu.getMenuItemById(itemID)
        if (menuItem === null) {
          this._logger.error(`[Menu Provider] Could not send app menu ${itemID}: No item found.`)
          return
        }

        const serialized = this._makeItemSerializable(menuItem)
        if (serialized.type !== 'submenu') {
          this._logger.error(`[Menu Provider] Could not send app menu ${itemID}: The item is not a submenu.`)
          return
        }

        event.reply('menu-provider', {
          command: 'application-submenu',
          payload: {
            id: itemID,
            submenu: serialized.submenu
          }
        })
      } else if (command === 'click-menu-item') {
        const itemID = message.payload as string

        const appMenu = Menu.getApplicationMenu()
        if (appMenu === null) {
          this._logger.error(`[Menu Provider] Could not trigger a click on item ${itemID}: No menu set.`)
          return
        }

        const menuItem = appMenu.getMenuItemById(itemID)

        if (menuItem === null) {
          this._logger.error(`[Menu Provider] Could not trigger a click on item ${itemID}: No item found.`)
          return
        }

        // And now trigger a click! We need to pass the menuItem and the
        // focusedWindow as well. The request came from a window, so when no
        // window holds the OS focus (a headless run, a click while another
        // app is frontmost) the sender is the window the item acts on.
        const focusedWindow = BrowserWindow.getFocusedWindow() ?? BrowserWindow.fromWebContents(event.sender)
        if (typeof menuItem.role === 'string') {
          if (focusedWindow === null) {
            this._logger.error(`[Menu Provider] Could not trigger custom click on menuItem ${itemID} with role ${menuItem.role}: No focused Window to trigger on.`)
            return
          }

          // Since menuItems with role have a no-op click function, we must manually
          // implement the functionality here for the custom menus.
          switch (menuItem.role.toLowerCase()) {
            case 'copy':
              focusedWindow.webContents.copy()
              break
            case 'cut':
              focusedWindow.webContents.cut()
              break
            case 'paste':
              focusedWindow.webContents.paste()
              break
            case 'pasteandmatchstyle':
              focusedWindow.webContents.pasteAndMatchStyle()
              break
            case 'redo':
              focusedWindow.webContents.redo()
              break
            case 'selectall':
              focusedWindow.webContents.selectAll()
              break
            case 'undo':
              focusedWindow.webContents.undo()
              break
            case 'zoomin':
              focusedWindow.webContents.zoomLevel++
              break
            case 'zoomout':
              focusedWindow.webContents.zoomLevel--
              break
            case 'resetzoom':
              focusedWindow.webContents.zoomLevel = 0
              break
            case 'togglefullscreen':
              focusedWindow.setFullScreen(!focusedWindow.isFullScreen())
              break
            case 'quit':
              app.quit()
              break
            case 'close':
              focusedWindow.close()
              break
            case 'minimize':
              focusedWindow.minimize()
              break
            default:
              this._logger.error(`[Menu Provider] Could not click menu item with role ${menuItem.role}, since no handler is implemented!`)
          }
        } else {
          menuItem.click(menuItem, focusedWindow)
        }
      }
    })

    ipcMain.handle('menu-provider', async (event, message) => {
      const { command, payload } = message
      if (command === 'display-native-context-menu') {
        const menu: Electron.MenuItemConstructorOptions[] = payload.menu
        const x: number = payload.x
        const y: number = payload.y
        return await this._displayNativeContextMenu(menu, x, y, event.senderFrame ?? undefined)
      }
    })
  }

  /**
   * Shuts down the provider
   *
   * @return  {boolean} Always returns true
   */
  async shutdown (): Promise<void> {
    this._logger.verbose('Menu provider shutting down ...')
  }

  /**
   * Displays a native context menu with the given menu items
   *
   * @param   {MenuItem[]}                 menu   The menu to display
   * @param   {number}                     x      X-coordinate of the menu
   * @param   {number}                     y      Y-coordinate of the menu
   * @param   {WebFrameMain}               frame  The calling frame
   *
   * @return  {Promise<string|undefined>}         Returns the clicked ID, or undefined
   */
  private async _displayNativeContextMenu (menu: MenuItemConstructorOptions[], x: number, y: number, frame?: WebFrameMain): Promise<string|undefined> {
    return await new Promise((resolve, _reject) => {
      let resolvedID: string|undefined
      // Define a quick'n'dirty recursive function that applies the click handler
      // to (theoretically) indefinite submenus
      const applyClickHandler = (item: MenuItemConstructorOptions): void => {
        item.click = () => { resolvedID = item.id }

        // Recurse into a potential submenu
        if (item.submenu !== undefined) {
          for (const subItem of item.submenu as MenuItemConstructorOptions[]) {
            applyClickHandler(subItem)
          }
        }
      }

      // Apply the click handler to the menu itself
      for (const item of menu) {
        applyClickHandler(item)
      }

      const popupMenu = Menu.buildFromTemplate(menu)
      popupMenu.on('menu-will-close', (event) => {
        setTimeout(() => {
          // NOTE/DEBUG: We have to resolve on the next tick, since this event
          // unfortunately is emitted *before* the item click is triggered.
          // See: https://github.com/electron/electron/issues/28719
          resolve(resolvedID)
        }, 100)
      })

      // NOTE: The coordinates we receive from the renderer are scaled by the
      // zoom scale factor, but the context menu will show up at absolute
      // coordinates, meaning that the x/y values will diverge more and more the
      // further the user moves down/right. By normalizing the coordinates with
      // the scale factor, we avoid that the context menu is offset from the
      // mouse pointer.
      const focusedWindow = BrowserWindow.getFocusedWindow()
      if (focusedWindow !== null && focusedWindow.webContents.getZoomLevel() !== 0) {
        const factor = focusedWindow.webContents.getZoomFactor()
        x *= factor
        y *= factor
      }

      // Enforce integers for the coordinates, otherwise we will get this weird
      // "conversion failure" error. We pass the `frame` here to access
      // WritingTools and a few other things on macOS.
      popupMenu.popup({ x: Math.round(x), y: Math.round(y), frame })
    })
  }

  /**
   * Turns a MenuItem into the serialised shape the renderers parse
   * (source/types/common/serialized-menu.ts): ids and accelerators are
   * present only when the template set them; separators carry nothing.
   *
   * @param   {MenuItem}  menuItem  The menu item to serialize
   *
   * @return  {SerializedMenuItem}  The serialized item
   */
  _makeItemSerializable (menuItem: Electron.MenuItem): SerializedMenuItem {
    if (menuItem.type === 'separator') {
      return { type: 'separator' }
    }

    const id = menuItem.id === undefined || menuItem.id === '' ? undefined : menuItem.id
    const accelerator = typeof menuItem.accelerator === 'string' && menuItem.accelerator !== ''
      ? menuItem.accelerator
      : undefined

    if (menuItem.type === 'submenu') {
      // menuItem.submenu is a Menu instance containing items in this property
      const submenu: SerializedSubmenu = {
        type: 'submenu',
        id,
        label: menuItem.label,
        enabled: menuItem.enabled,
        submenu: menuItem.submenu === undefined
          ? []
          : menuItem.submenu.items.map(subItem => this._makeItemSerializable(subItem))
      }
      return submenu
    }

    if (menuItem.type === 'checkbox' || menuItem.type === 'radio') {
      return {
        type: menuItem.type,
        id,
        label: menuItem.label,
        enabled: menuItem.enabled,
        accelerator,
        checked: menuItem.checked
      }
    }

    if (menuItem.type === 'normal') {
      return { type: 'normal', id, label: menuItem.label, enabled: menuItem.enabled, accelerator }
    }

    throw new Error(`[Menu Provider] Cannot serialise a menu item of type ${menuItem.type}`)
  }

  /**
   * Generates the application menu from the blueprint.
   */
  _build (): Menu {
    // Create a small helper function that will manage a volatile checkbox state.
    // Volatile means: The menu will attempt to retrieve a checkbox state that
    // is not controlled by a setting (and as such cannot be retrieved with
    // this._config.get). For those checkboxes, the menu provider will maintain
    // a map that persists the checkbox state for as long as the program runs.
    const getState = (id: string, init: boolean): boolean => {
      const result = this._checkboxState.get(id)
      if (result === undefined) {
        this._checkboxState.set(id, init)
        return init
      } else {
        return result
      }
    }

    // Also allow the menu handlers to set the state
    const setState = (id: string, val: boolean): void => {
      this._checkboxState.set(id, val)
    }

    const blueprint = BLUEPRINTS[process.platform](this._logger, this._config, this._recentDocs, this._commands, this._windows, this._documents, getState, setState)
    // Last but not least build the template
    return Menu.buildFromTemplate(blueprint)
  }

  /**
   * Gets the application menu in a serializable state which can be sent through
   * IPC calls or saved as JSON.
   *
   * @return  {SerializedMenuItem[]}  The serialized items
   */
  get serializableApplicationMenu (): SerializedMenuItem[] {
    const appMenu = Menu.getApplicationMenu()
    if (appMenu === null) {
      return []
    }

    const serialized = appMenu.items.map(item => {
      return this._makeItemSerializable(item)
    })

    return serialized
  }

  /**
   * Generates and sets the main application menu
   */
  set (): void {
    Menu.setApplicationMenu(this._build())
    // Notify all open windows of a new menu, so that they can
    // adapt their settings.
    broadcastIPCMessage('menu-provider', {
      command: 'application-menu',
      payload: this.serializableApplicationMenu
    })
  }
}
