import FileExtensionIcon from "@common/modules/window-register/icons/clarity-custom/file-ext.svg";

const EXTENSION_LABEL_PLACEHOLDER = ">EXT<";

function escapeXMLText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * Returns the bundled attachment icon with its extension label substituted.
 *
 * @param   {string}  extension  The attachment's file extension
 *
 * @return  {string}             The icon SVG markup
 */
export function getAttachmentIconMarkup(extension: string): string {
  if (!FileExtensionIcon.includes(EXTENSION_LABEL_PLACEHOLDER)) {
    throw new Error("Bundled attachment icon does not contain its extension label placeholder");
  }

  const label = escapeXMLText(extension.slice(1, 4));
  return FileExtensionIcon.replace(EXTENSION_LABEL_PLACEHOLDER, `>${label}<`);
}
