import type { AnyDescriptor, MDFileDescriptor } from "source/types/common/fsal";

/**
 * Small utility function that extracts the given property from the provided
 * file descriptors. `prop` must be a key on MDFileDescriptor.
 *
 * @param   {AnyDescriptor[]}      descriptors  An unsorted list of any type of descriptor.
 * @param   {Key}                  prop         The property to extract
 *
 * @return  {Array<string, MDFileDescriptor[Key]>}               Pairs of a file path and its property value
 */
export function extractFromFileDescriptors<Key extends keyof MDFileDescriptor>(
  descriptors: AnyDescriptor[],
  prop: Key,
): Array<[string, MDFileDescriptor[Key]]> {
  const retVals: Array<[string, MDFileDescriptor[Key]]> = [];
  for (const descriptor of descriptors) {
    if (descriptor.type === "file") {
      retVals.push([descriptor.path, descriptor[prop]]);
    }
  }

  return retVals;
}
