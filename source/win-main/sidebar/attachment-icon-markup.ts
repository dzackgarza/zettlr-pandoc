import FileExtensionIcon from '@common/modules/window-register/icons/clarity-custom/file-ext.svg'

/**
 * Returns the bundled attachment icon with its extension label substituted.
 *
 * @param   {string}  extension  The attachment's file extension
 *
 * @return  {string}             The icon SVG markup
 */
export function getAttachmentIconMarkup (extension: string): string {
  return FileExtensionIcon.replace('EXT', extension.slice(1, 4))
}
