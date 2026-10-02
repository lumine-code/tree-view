const os = require("os");
const path = require("path");
const naturalCompare = require("natural-compare-lite");
const Directory = require("../lib/directory");
const fs = require("../lib/fs-compat");

const DATE_VALUES = {
  atime: 0,
  birthtime: 1700000000001,
  ctime: 1700000000002,
  mtime: 1700000000003,
};

// Mock directory names so case-only ties can also be tested on Windows.
const MIXED_ENTRIES = [
  { name: "notes.Z", kind: "file" },
  { name: "file10.js", kind: "directory" },
  { name: "alpha.txt", kind: "file" },
  { name: "Alpha.TXT", kind: "directory" },
  { name: ".env.local", kind: "file" },
  { name: "archive.tar.gz", kind: "file" },
  { name: "archive.tar.GZ", kind: "directory" },
  { name: "file2.js", kind: "file" },
  { name: "file02.js", kind: "directory" },
  { name: "éclair.MD", kind: "directory" },
  { name: "Éclair.md", kind: "file" },
  { name: "e\u0301clair.md", kind: "file" },
  { name: ".env", kind: "file" },
  { name: "notes.a", kind: "file" },
  { name: "notes", kind: "file" },
  { name: "beta", kind: "directory" },
  { name: "directory-link", kind: "directory", symlink: true },
  { name: "file-link", kind: "file", symlink: true },
];

function referenceNames(entries, { sortMethod, sortByBase, foldersFirst }) {
  const compare =
    sortMethod === "natural"
      ? naturalCompare
      : new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }).compare;
  const compareNames = (first, second) => {
    const a = first.name.toLowerCase();
    const b = second.name.toLowerCase();
    if (!sortByBase) return compare(a, b);
    const aExt = path.extname(a);
    const bExt = path.extname(b);
    const aBase = aExt ? a.slice(0, -aExt.length) : a;
    const bBase = bExt ? b.slice(0, -bExt.length) : b;
    return compare(aBase, bBase) || compare(aExt, bExt);
  };

  // The original enumeration first sorts names, partitions directories and
  // files, then sorts that partition again when folders are not kept first.
  // Both sorts are stable: ties between a file and a directory keep the
  // directory first even when the file appeared earlier in readdir.
  const sorted = entries.slice().sort(compareNames);
  const combined = sorted
    .filter((entry) => entry.kind === "directory")
    .concat(sorted.filter((entry) => entry.kind === "file"));
  return (foldersFirst ? combined : combined.sort(compareNames)).map((entry) => entry.name);
}

describe("TreeView Directory sorting and incremental enumeration", () => {
  let directory;
  let entries;
  let dateReads;
  let originalSettings;
  const directoryPath = path.join(os.tmpdir(), "tree-view-mocked-sorting");
  const settings = {
    "tree-view.sortMethod": "default",
    "tree-view.sortByBase": true,
    "tree-view.sortFoldersBeforeFiles": true,
    "tree-view.squashDirectoryNames": false,
    "tree-view.hideIgnoredNames": false,
    "tree-view.hideVcsIgnoredFiles": false,
  };

  function makeStats(kind) {
    // Node 24 exposes the Date properties as prototype getters. They should
    // only be materialized for a model that is actually being constructed.
    const prototype = {
      isDirectory: () => kind === "directory",
      isFile: () => kind === "file",
      isSymbolicLink: () => kind === "symlink",
    };
    for (const [key, milliseconds] of Object.entries(DATE_VALUES)) {
      Object.defineProperty(prototype, key, {
        get() {
          dateReads++;
          return new Date(milliseconds);
        },
      });
    }
    return Object.assign(Object.create(prototype), { size: 123, mtimeMs: DATE_VALUES.mtime });
  }

  function entryForPath(fullPath) {
    return entries.find((entry) => entry.name === path.basename(fullPath));
  }

  function setSorting({ sortMethod, sortByBase, foldersFirst }) {
    lumine.config.set("tree-view.sortMethod", sortMethod);
    lumine.config.set("tree-view.sortByBase", sortByBase);
    lumine.config.set("tree-view.sortFoldersBeforeFiles", foldersFirst);
  }

  beforeEach(() => {
    entries = MIXED_ENTRIES.slice();
    dateReads = 0;
    originalSettings = new Map();
    for (const [key, value] of Object.entries(settings)) {
      originalSettings.set(key, lumine.config.get(key));
      lumine.config.set(key, value);
    }
    spyOn(lumine.repositories, "getForPath").and.returnValue(null);
    spyOn(fs, "isCaseInsensitive").and.returnValue(process.platform === "win32");
    spyOn(fs, "realpathSync").and.callFake((fullPath) => fullPath);
    spyOn(fs, "readdirSync").and.callFake(() => entries.map((entry) => entry.name));
    spyOn(fs, "lstatSyncNoException").and.callFake((fullPath) => {
      const entry = entryForPath(fullPath);
      return entry ? makeStats(entry.symlink ? "symlink" : entry.kind) : false;
    });
    spyOn(fs, "statSyncNoException").and.callFake((fullPath) => {
      const entry = entryForPath(fullPath);
      return entry ? makeStats(entry.kind) : false;
    });
    directory = new Directory({
      name: "mocked-sorting",
      fullPath: directoryPath,
      isRoot: true,
      ignoredNames: { matches: () => false },
      useSyncFS: true,
    });
  });

  afterEach(() => {
    directory.destroy();
    for (const [key, value] of originalSettings) {
      if (value === undefined) lumine.config.unset(key);
      else lumine.config.set(key, value);
    }
  });

  for (const sortMethod of ["default", "natural"]) {
    for (const sortByBase of [false, true]) {
      for (const foldersFirst of [false, true]) {
        const options = { sortMethod, sortByBase, foldersFirst };
        it(`preserves ordering and insertion indices for ${sortMethod}, base=${sortByBase}, folders=${foldersFirst}`, () => {
          setSorting(options);
          const added = [];
          const removed = [];
          directory.onDidAddEntries((models) => added.push(models));
          directory.onDidRemoveEntries((models) => removed.push(models));

          directory.reload();
          const expectedInitial = referenceNames(entries, options);
          expect(added[0].map((entry) => entry.name)).toEqual(expectedInitial);
          for (const [index, name] of expectedInitial.entries()) {
            expect(directory.entries.get(name).indexInParentDirectory).toBe(index);
          }
          expect(directory.entries.get("directory-link").symlink).toBe(true);
          expect(directory.entries.get("file-link").symlink).toBe(true);

          const originalModels = new Map(directory.entries);
          entries = entries
            .filter((entry) => entry.name !== ".env" && entry.name !== "beta")
            .concat([
              { name: "file3.js", kind: "file" },
              { name: "aardvark", kind: "directory" },
            ]);
          directory.reload();
          const expectedReload = referenceNames(entries, options);

          expect(added.length).toBe(2);
          expect(added[1].map((entry) => entry.name)).toEqual(
            expectedReload.filter((name) => !originalModels.has(name)),
          );
          for (const entry of added[1]) {
            expect(entry.indexInParentDirectory).toBe(expectedReload.indexOf(entry.name));
          }
          for (const [name, model] of originalModels) {
            if (name === ".env" || name === "beta") {
              expect(directory.entries.has(name)).toBe(false);
              expect(model.destroyed).toBe(true);
            } else {
              expect(directory.entries.get(name)).toBe(model);
              expect(model.destroyed).toBe(false);
            }
          }
          expect(removed.length).toBe(1);
          expect(removed[0]).toEqual(
            new Set([originalModels.get(".env"), originalModels.get("beta")]),
          );
          expect(directory.getEntries()).toEqual(expectedReload);

          directory.reload();
          expect(added.length).toBe(2);
          expect(removed.length).toBe(1);
        });
      }
    }
  }

  it("re-reads sorting settings and renamed paths between enumerations", () => {
    setSorting({ sortMethod: "default", sortByBase: false, foldersFirst: false });
    directory.reload();
    const originalModels = new Map(directory.entries);
    const added = [];
    const removed = [];
    directory.onDidAddEntries((models) => added.push(models));
    directory.onDidRemoveEntries((models) => removed.push(models));

    let options;
    dateReads = 0;
    for (const sortMethod of ["default", "natural"]) {
      for (const sortByBase of [false, true]) {
        for (const foldersFirst of [false, true]) {
          options = { sortMethod, sortByBase, foldersFirst };
          setSorting(options);
          expect(directory.getEntries()).toEqual(referenceNames(entries, options));
          directory.reload();
          for (const [name, model] of originalModels) {
            expect(directory.entries.get(name)).toBe(model);
          }
        }
      }
    }
    expect(added).toEqual([]);
    expect(removed).toEqual([]);
    expect(dateReads).toBe(0);

    const originalName = "file2.js";
    const renamedName = "file20.a";
    entries = entries.map((entry) =>
      entry.name === originalName ? { ...entry, name: renamedName } : entry,
    );
    directory.reload();
    const expectedNames = referenceNames(entries, options);
    const renamedModel = directory.entries.get(renamedName);

    expect(directory.getEntries()).toEqual(expectedNames);
    expect(directory.entries.has(originalName)).toBe(false);
    expect(originalModels.get(originalName).destroyed).toBe(true);
    expect(renamedModel.path).toBe(path.join(directoryPath, renamedName));
    expect(renamedModel.indexInParentDirectory).toBe(expectedNames.indexOf(renamedName));
    expect(added).toEqual([[renamedModel]]);
    expect(removed).toEqual([new Set([originalModels.get(originalName)])]);
    for (const [name, model] of originalModels) {
      if (name !== originalName) expect(directory.entries.get(name)).toBe(model);
    }
  });

  it("copies millisecond dates for new entries and skips date getters for retained models", () => {
    entries = [
      { name: "existing.txt", kind: "file" },
      { name: "existing-directory", kind: "directory" },
    ];
    directory.reload();
    const originalModels = new Map(directory.entries);
    for (const entry of directory.entries.values()) {
      expect(entry.stats).toEqual({ size: 123, mtimeMs: DATE_VALUES.mtime, ...DATE_VALUES });
    }
    expect(dateReads).toBeGreaterThan(0);

    dateReads = 0;
    directory.reload();
    expect(dateReads).toBe(0);
    for (const [name, model] of originalModels) {
      expect(directory.entries.get(name)).toBe(model);
    }

    entries.push({ name: "new.txt", kind: "file" });
    directory.reload();
    expect(dateReads).toBeGreaterThan(0);
    expect(directory.entries.get("new.txt").stats).toEqual({
      size: 123,
      mtimeMs: DATE_VALUES.mtime,
      ...DATE_VALUES,
    });
  });
});
