/**
 * BEGIN HEADER
 *
 * Contains:        Utility function
 * CVM-Role:        <none>
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This file contains a function that can be used to safely
 *                  assign object values, that is: you pass a reference
 *                  object, and some other object. What will be returned is a
 *                  new object that contains all fields from the reference, but
 *                  does not include any "invalid" fields that were only
 *                  present on the passed object, but not on the reference.
 *                  This also supports nested objects.
 *
 * END HEADER
 */

/**
 * Merges an object with a reference, creating a new object that will contain
 * all properties of `referenceObject`. The value of those properties will
 * either be taken from the object, if it possesses that property, or from the
 * `referenceObject` otherwise.
 *
 * @param  {Partial<A>}  obj              The object with property values to be
 *                                        merged.
 * @param  {A}           referenceObject  The reference to use the properties
 *                                        and default values from.
 * @param  {Partial<A>}  newObject        DO NOT USE -- INTERNAL! The new object
 *                                        to be returned.
 *
 * @return {A}                            The cloned object with properties of
 *                                        `referenceObject` with values of `obj`
 *                                        merged in.
 */
export default function safeAssign <A extends object> (
  obj: Partial<A> | undefined,
  referenceObject: A
): A {
  if (obj === undefined || obj === null) {
    return { ...referenceObject }
  }

  const result = { ...referenceObject }
  const refRecord = referenceObject as Record<string, unknown>
  const objRecord = obj as Record<string, unknown>
  const resRecord = result as Record<string, unknown>

  for (const key of Object.keys(refRecord)) {
    if (key in objRecord && objRecord[key] !== undefined) {
      const refVal = refRecord[key]
      const objVal = objRecord[key]

      if (
        typeof refVal === 'object' &&
        refVal !== null &&
        !Array.isArray(refVal) &&
        typeof objVal === 'object' &&
        objVal !== null &&
        !Array.isArray(objVal)
      ) {
        resRecord[key] = safeAssign(
          objVal as Record<string, unknown>,
          refVal as Record<string, unknown>
        )
      } else {
        resRecord[key] = objVal
      }
    }
  }

  return result
}
