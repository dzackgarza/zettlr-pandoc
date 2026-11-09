/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        filterDescriptorChildren
 * CVM-Role:        Utility Function
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Constructs a function that can be passed to a filter
 *                  function operating operating on descriptors which will
 *                  ensure that files and folders that should not be displayed
 *                  are filtered out.
 *
 * END HEADER
 */

import type { ConfigOptions } from "source/app/service-providers/config/get-config-template";
import {
  hasDataExt,
  hasExt,
  hasImageExt,
  hasMdOrCodeExt,
  hasMSOfficeExt,
  hasOpenOfficeExt,
  hasPDFExt,
} from "source/common/util/file-extention-checks";
import { isDotFile } from "source/common/util/ignore-path";
import { useConfigStore } from "source/pinia";
import type { AnyDescriptor } from "source/types/common/fsal";

export interface FileManagerVisibilityConfig {
  attachmentExtensions: string[];
  files: ConfigOptions["files"];
  fileManager: {
    filters: { include: readonly string[] };
  };
}

function normalizeExtension(extension: string): string {
  const trimmed = extension.trim().toLowerCase();
  return trimmed === "" || trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

function matchesExtension(filePath: string, extension: string): boolean {
  const normalized = normalizeExtension(extension);
  return normalized !== "" && filePath.toLowerCase().endsWith(normalized);
}

/**
 * Utility function that can filter the children of a directory descriptor,
 * taking into account various visibility settings from the configuration. Call
 * this function to get a filter-compatible function. The ignore rules are not
 * its concern: the FSAL lists no path that a rule hides.
 *
 * @return  {(item: AnyDescriptor) => boolean}The filter function
 */
export function createFileManagerVisibilityFilter(
  config: FileManagerVisibilityConfig,
): (item: AnyDescriptor) => boolean {
  const { files, attachmentExtensions, fileManager } = config;
  const { include } = fileManager.filters;
  return (child: AnyDescriptor) => {
    // Filter files based on our settings
    if (child.type === "directory") {
      return files.dotFiles.showInFilemanager || !isDotFile(child.name);
    }

    // The Include list is the first authority for file visibility. File
    // Treatment can only further narrow this set.
    if (
      include.length > 0 &&
      !include.some((extension) => matchesExtension(child.path, extension))
    ) {
      return false;
    }

    // We have to check for hidden files first so they are not
    // included if they end in one of the accepted extensions
    if (isDotFile(child.name)) {
      return files.dotFiles.showInFilemanager;
    } else if (hasImageExt(child.path)) {
      return files.images.showInFilemanager;
    } else if (hasPDFExt(child.path)) {
      return files.pdf.showInFilemanager;
    } else if (hasMSOfficeExt(child.path)) {
      return files.msoffice.showInFilemanager;
    } else if (hasOpenOfficeExt(child.path)) {
      return files.openOffice.showInFilemanager;
    } else if (hasDataExt(child.path)) {
      return files.dataFiles.showInFilemanager;
    } else if (hasMdOrCodeExt(child.path)) {
      return true;
    } else {
      return hasExt(child.path, attachmentExtensions); // Any other "other" file should be excluded
    }
  };
}

export function filterDescriptorChildren(): (item: AnyDescriptor) => boolean {
  return createFileManagerVisibilityFilter(useConfigStore().config);
}
