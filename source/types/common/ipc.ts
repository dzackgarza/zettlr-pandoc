/**
 * A value that the structured clone algorithm copies unchanged
 * (https://www.electronjs.org/docs/latest/tutorial/ipc#object-serialization).
 */
type CloneableLeaf =
  | string
  | number
  | bigint
  | boolean
  | null
  | undefined
  | Date
  | RegExp
  | Error
  | ArrayBuffer
  | ArrayBufferView;

/**
 * T itself when Electron IPC can carry it, and a type that no value has where
 * T holds a function or a symbol. A mapped type, not an index signature, so
 * that an interface checks as well as a type alias does.
 *
 * The check stops at a depth of eight levels, as type-fest's `Paths` stops at
 * its `maxRecursionDepth`: a recursive type such as a directory descriptor
 * with its children would otherwise never end.
 */
export type Cloneable<T, Depth extends readonly 0[] = []> = Depth["length"] extends 8
  ? T
  : T extends CloneableLeaf
    ? T
    : T extends (...args: never[]) => void
      ? never
      : T extends symbol
        ? never
        : T extends ReadonlyMap<infer K, infer V>
          ? ReadonlyMap<Cloneable<K, [...Depth, 0]>, Cloneable<V, [...Depth, 0]>>
          : T extends ReadonlySet<infer E>
            ? ReadonlySet<Cloneable<E, [...Depth, 0]>>
            : { [K in keyof T]: Cloneable<T[K], [...Depth, 0]> };

/**
 * An argument before `Cloneable` has checked it. A sender takes its arguments
 * as a tuple of this type and accepts them only where `Cloneable` maps the
 * tuple to itself.
 */
export type IpcArgument = unknown;

/**
 * A value that Electron IPC can carry, for a value of no particular type
 * (arrays and plain objects of such values included).
 */
export type IpcValue =
  | CloneableLeaf
  | readonly IpcValue[]
  | ReadonlyMap<IpcValue, IpcValue>
  | ReadonlySet<IpcValue>
  | { readonly [key: string]: IpcValue };
