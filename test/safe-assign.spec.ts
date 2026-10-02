/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        safeAssign tester
 * CVM-Role:        TESTING
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This file tests a component of Zettlr.
 *
 * END HEADER
 */

import { deepStrictEqual } from "assert";
import safeAssign from "../source/common/util/safe-assign";

interface NestedSettings {
  a: boolean | null;
  b: { c: string[]; d: number };
}

interface WindowSettings {
  fullScreen: boolean;
  someOtherVar: string;
}

interface OptionalSetting {
  a: string | undefined;
}

function nestedReference(): NestedSettings {
  return { a: false, b: { c: [], d: -1 } };
}

function assertMerges<A extends object>(
  title: string,
  input: Partial<A>,
  reference: A,
  expected: A,
): void {
  it(title, function () {
    deepStrictEqual(safeAssign(input, reference), expected);
  });
}

describe("Utility#safeAssign()", function () {
  assertMerges<NestedSettings>(
    "keeps every value of an input that is valid against the reference",
    { a: null, b: { c: ["one", "two", "three"], d: 1000 } },
    nestedReference(),
    { a: null, b: { c: ["one", "two", "three"], d: 1000 } },
  );

  const withUnexpectedField = {
    a: null,
    b: { c: ["one", "two", "three"], d: 1000 },
    unexpectedField: "some value",
  };
  assertMerges<NestedSettings>(
    "drops a property that the reference does not have",
    withUnexpectedField,
    nestedReference(),
    { a: null, b: { c: ["one", "two", "three"], d: 1000 } },
  );

  assertMerges<NestedSettings>(
    "takes a missing property from the reference",
    { b: { c: ["one", "two", "three"], d: 1000 } },
    nestedReference(),
    { a: false, b: { c: ["one", "two", "three"], d: 1000 } },
  );

  // Based on a true story, as safeAssign apparently doesn't overwrite values
  assertMerges<WindowSettings>(
    "overwrites a reference value with the input value",
    { fullScreen: true },
    { fullScreen: false, someOtherVar: "Hello World" },
    { fullScreen: true, someOtherVar: "Hello World" },
  );

  assertMerges<OptionalSetting>(
    "uses an input value where the reference value is undefined",
    { a: "foo" },
    { a: undefined },
    { a: "foo" },
  );
});
