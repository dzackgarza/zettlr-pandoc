/* eslint-disable no-undef */
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Path polyfill tester
 * CVM-Role:        TESTING
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This file tests a component of Zettlr.
 *
 * END HEADER
 */

import {
  isAbsolutePath,
  isWin32Path,
  pathDirname,
  relativePath,
  resolvePath,
} from "@common/util/renderer-path-polyfill";
import { strictEqual } from "assert";
import path from "path";

const pathDirnameTesters = [
  "C:\\test\\one\\two.md",
  "C:\\test\\one",
  // DEBUG: Interestingly, node.js's path has a bug when it comes to mounted network drives
  // '\\\\test\\one\\two.md',
  // '\\\\test\\one',
  "/home/test/one/two.md",
  "/home/test/one",
  "test/one",
  "test/one.md",
  "test.md",
  "test\\one.md",
  "test\\one",
  "./test",
  "../test",
  "..\\test",
  ".\\test",
  "C:\\",
  "C:\\Notes",
  "/notes",
  "/",
  "\\\\",
];

const absolutePathTesters = [
  "C:\\test\\one\\two.md",
  "C:\\test\\one",
  "c:\\test\\one\\two.md",
  "c:\\test\\one",
  "\\\\test\\one\\two.md",
  "\\\\test\\one",
  "/home/test/one/two.md",
  "/home/test/one",
  "test/one",
  "test/one.md",
  "test.md",
  "test\\one.md",
  "test\\one",
  "./test",
  "../test",
  "..\\test",
  ".\\test",
];

// NOTE: These testers are used for both relativePath and resolvePath, since
// these functions are reversible:
// relativePath(from, to) -> relative
// resolvePath (from, relative) -> to
const pathResolutionTesters = [
  // Different leaf paths
  { from: "/var/test/main.md", to: "/var/etc/images/test.png" },
  { from: "C:\\folder\\one.md", to: "C:\\" },
  // Different drives (windows only)
  { from: "C:\\assets\\file.md", to: "D:\\assets\\image.png" },
  // Same folder
  { from: "/var/test/main.md", to: "/var/test/image.png" },
  { from: "C:\\test\\main.md", to: "C:\\test\\image.png" },
  // to already relative
  { from: "C:\\test", to: "C:\\test\\image.png" },
  { from: "/test", to: "/test/image.png" },
  // Tests taken from real life
  { from: "README.md", to: "GUI Tests/non-ascii image.md" },
  { from: "non-ascii image.md", to: "an image with ümläuts.jpeg" },
  // A sibling whose name starts with the name of the source (#201)
  { from: "/n/proj", to: "/n/project-assets/a.png" },
  { from: "/a/b", to: "/a/bc" },
  { from: "C:\\notes\\proj", to: "C:\\notes\\project-assets\\a.png" },
  // A descendant several levels down, and an ancestor
  { from: "/home/user/notes", to: "/home/user/notes/assets/figures/a.png" },
  { from: "/home/user/notes/assets/figures", to: "/home/user" },
];

// Paths that are not in their shortest form. The oracle is Node's path module.
const relativeNormalizationTesters = [
  { from: "/a/b/", to: "/a/b/c" },
  { from: "/a/b/../c", to: "/a/d/./e.png" },
  { from: "C:\\Notes\\proj", to: "c:\\notes\\proj\\a.png" },
];

const resolveNormalizationTesters = [
  { base: "/a/b", path: "c/../d" },
  { base: "/a/b", path: "./c/./d.bib" },
  { base: "/a/b/c", path: ".." },
  { base: "/a/b/c", path: "../.." },
  { base: "/a/b", path: "../../../../c" },
  { base: "/a/b", path: "/x/../y/z.bib" },
  { base: "/a/b/", path: "c" },
  { base: "C:\\a\\b", path: "c\\..\\d" },
  { base: "C:\\a\\b", path: "images/figure.png" },
  { base: "C:\\a\\b", path: ".." },
];

describe("Utility#pathDirname()", function () {
  for (const test of pathDirnameTesters) {
    const dirname = isWin32Path(test) ? path.win32.dirname(test) : path.posix.dirname(test);
    it(`should return "${dirname}" for "${test}"`, function () {
      strictEqual(pathDirname(test), dirname);
    });
  }
});

describe("Utility#isAbsolutePath()", function () {
  for (const test of absolutePathTesters) {
    const isAbsolute = isWin32Path(test)
      ? path.win32.isAbsolute(test)
      : path.posix.isAbsolute(test);
    it(`should return ${isAbsolute} for "${test}"`, function () {
      strictEqual(isAbsolutePath(test), isAbsolute);
    });
  }
});

describe("Utility#relativePath()", function () {
  for (const test of pathResolutionTesters) {
    // NOTE NOTE NOTE: Assumption! Here we test both Windows and Unix paths, and
    // we use the corresponding path module function, assuming that a backslash
    // indicates a win32 path!
    const relative = isWin32Path(test.from)
      ? path.win32.relative(test.from, test.to)
      : path.posix.relative(test.from, test.to);
    it(`should return "${relative}" for "${test.from}" -> "${test.to}"`, function () {
      strictEqual(relativePath(test.from, test.to), relative);
    });
  }
});

describe("Utility#resolvePath()", function () {
  for (const test of pathResolutionTesters) {
    // NOTE NOTE NOTE: Assumption! Here we test both Windows and Unix paths, and
    // we use the corresponding path module function, assuming that a backslash
    // indicates a win32 path!
    const relative = isWin32Path(test.from)
      ? path.win32.relative(test.from, test.to)
      : path.posix.relative(test.from, test.to);
    it(`should return "${test.to}" for "${test.from}" -> "${relative}"`, function () {
      strictEqual(resolvePath(test.from, relative), test.to);
    });
  }
});

describe("Utility#relativePath() normalization", function () {
  for (const test of relativeNormalizationTesters) {
    const relative = isWin32Path(test.from)
      ? path.win32.relative(test.from, test.to)
      : path.posix.relative(test.from, test.to);
    it(`should return "${relative}" for "${test.from}" -> "${test.to}"`, function () {
      strictEqual(relativePath(test.from, test.to), relative);
    });
  }
});

describe("Utility#resolvePath() normalization", function () {
  for (const test of resolveNormalizationTesters) {
    const resolved = isWin32Path(test.base)
      ? path.win32.resolve(test.base, test.path)
      : path.posix.resolve(test.base, test.path);
    it(`should return "${resolved}" for "${test.base}" + "${test.path}"`, function () {
      strictEqual(resolvePath(test.base, test.path), resolved);
    });
  }
});
