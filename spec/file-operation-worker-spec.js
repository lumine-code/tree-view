const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  copyPath,
  movePath,
  executeMovePlan,
  replacePathSafely,
  setJobCancelled,
} = require("../lib/file-operation-worker");

describe("TreeView file operation worker results", () => {
  let rootPath;

  beforeEach(() => {
    rootPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tree-view-worker-")));
  });

  afterEach(() => {
    fs.rmSync(rootPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("reports the destination root actually left by a copy", async () => {
    const sourcePath = path.join(rootPath, "source");
    const destinationPath = path.join(rootPath, "destination");
    fs.mkdirSync(sourcePath);
    fs.writeFileSync(path.join(sourcePath, "file.txt"), "contents");

    expect(await copyPath(sourcePath, destinationPath, 1)).toEqual({
      copied: true,
      creates: [{ path: destinationPath, isDirectory: true }],
    });
  });

  it("cleans a partial destination and reports no creation when copying fails", async () => {
    const sourcePath = path.join(rootPath, "source");
    const destinationPath = path.join(rootPath, "destination");
    fs.mkdirSync(sourcePath);
    fs.writeFileSync(path.join(sourcePath, "file.txt"), "source");
    const failure = new Error("copy failed");
    spyOn(fs.promises, "cp").and.callFake(async (_sourcePath, copiedPath) => {
      fs.writeFileSync(copiedPath, "partial");
      throw failure;
    });

    let resultError;
    try {
      await copyPath(sourcePath, destinationPath, 2);
    } catch (error) {
      resultError = error;
    }

    expect(resultError).toBe(failure);
    expect(resultError.creates).toEqual([]);
    expect(fs.existsSync(destinationPath)).toBe(false);
  });

  it("reports a partial destination that an error cleanup could not remove", async () => {
    const sourcePath = path.join(rootPath, "source");
    const destinationPath = path.join(rootPath, "destination");
    fs.mkdirSync(sourcePath);
    fs.writeFileSync(path.join(sourcePath, "file.txt"), "source");
    const failure = new Error("copy failed");
    spyOn(fs.promises, "cp").and.callFake(async (_sourcePath, copiedPath) => {
      fs.writeFileSync(copiedPath, "partial");
      throw failure;
    });
    spyOn(fs.promises, "rm").and.callFake(async () => {
      throw new Error("cleanup failed");
    });

    let resultError;
    try {
      await copyPath(sourcePath, destinationPath, 3);
    } catch (error) {
      resultError = error;
    }

    expect(resultError).toBe(failure);
    expect(resultError.partial).toBe(true);
    expect(resultError.creates).toEqual([]);
    expect(resultError.cleanupPath).toContain(".lumine-copy-");
    expect(fs.existsSync(resultError.cleanupPath)).toBe(true);
  });

  it("does not remove a destination that wins the copy race", async () => {
    const sourcePath = path.join(rootPath, "source");
    const destinationPath = path.join(rootPath, "destination");
    fs.mkdirSync(sourcePath);
    fs.writeFileSync(path.join(sourcePath, "file.txt"), "source");
    const failure = new Error("copy failed");
    spyOn(fs.promises, "cp").and.callFake(async (_sourcePath, copiedPath) => {
      fs.writeFileSync(copiedPath, "partial");
      fs.mkdirSync(destinationPath);
      fs.writeFileSync(path.join(destinationPath, "external.txt"), "external");
      throw failure;
    });

    let resultError;
    try {
      await copyPath(sourcePath, destinationPath, 4);
    } catch (error) {
      resultError = error;
    }

    expect(resultError).toBe(failure);
    expect(resultError.creates).toEqual([]);
    expect(fs.readFileSync(path.join(destinationPath, "external.txt"), "utf8")).toBe("external");
  });

  it("publishes a staged file without replacing a destination that wins the final race", async () => {
    const sourcePath = path.join(rootPath, "source.txt");
    const destinationPath = path.join(rootPath, "destination.txt");
    fs.writeFileSync(sourcePath, "source");
    spyOn(fs.promises, "link").and.callFake(async (_stagingPath, publishedPath) => {
      fs.writeFileSync(publishedPath, "external");
      const error = new Error("already exists");
      error.code = "EEXIST";
      throw error;
    });

    await expectAsync(copyPath(sourcePath, destinationPath, 5)).toBeRejectedWithError(
      /already exists/,
    );

    expect(fs.readFileSync(sourcePath, "utf8")).toBe("source");
    expect(fs.readFileSync(destinationPath, "utf8")).toBe("external");
  });

  it("falls back to an exclusive copy when the destination cannot create hardlinks", async () => {
    const sourcePath = path.join(rootPath, "source.txt");
    const destinationPath = path.join(rootPath, "destination.txt");
    fs.writeFileSync(sourcePath, "source");
    const failure = new Error("hardlinks unsupported");
    failure.code = "EPERM";
    spyOn(fs.promises, "link").and.rejectWith(failure);

    expect(await copyPath(sourcePath, destinationPath, 6)).toEqual({
      copied: true,
      creates: [{ path: destinationPath, isDirectory: false }],
    });
    expect(fs.readFileSync(destinationPath, "utf8")).toBe("source");
  });

  it("reports a fresh root rename", async () => {
    const sourcePath = path.join(rootPath, "source.txt");
    const destinationPath = path.join(rootPath, "destination.txt");
    fs.writeFileSync(sourcePath, "source");

    expect(await movePath(sourcePath, destinationPath, 7, rootPath)).toEqual({
      moved: true,
      renames: [{ oldPath: sourcePath, newPath: destinationPath, isDirectory: false }],
    });
  });

  it("keeps a complete EXDEV copy when cleanup of the moved source fails partway", async () => {
    const sourcePath = path.join(rootPath, "source");
    const destinationPath = path.join(rootPath, "destination");
    fs.mkdirSync(sourcePath);
    fs.writeFileSync(path.join(sourcePath, "first.txt"), "first");
    fs.writeFileSync(path.join(sourcePath, "second.txt"), "second");
    const rename = fs.promises.rename.bind(fs.promises);
    spyOn(fs.promises, "rename").and.callFake(async (oldPath, newPath) => {
      if (oldPath === sourcePath && newPath === destinationPath) {
        const error = new Error("cross-device");
        error.code = "EXDEV";
        throw error;
      }
      return rename(oldPath, newPath);
    });
    const remove = fs.promises.rm.bind(fs.promises);
    spyOn(fs.promises, "rm").and.callFake(async (targetPath, options) => {
      if (path.basename(targetPath).includes(".lumine-move-source-")) {
        await remove(path.join(targetPath, "first.txt"), { force: true });
        throw new Error("cleanup failed");
      }
      return remove(targetPath, options);
    });

    const result = await movePath(sourcePath, destinationPath, 6, rootPath);

    expect(result.moved).toBe(true);
    expect(result.cleanupError).toContain("Unable to remove");
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.readFileSync(path.join(destinationPath, "first.txt"), "utf8")).toBe("first");
    expect(fs.readFileSync(path.join(destinationPath, "second.txt"), "utf8")).toBe("second");
    expect(fs.readFileSync(path.join(result.cleanupPath, "second.txt"), "utf8")).toBe("second");
  });

  it("restores an EXDEV source when its completed destination is replaced", async () => {
    const sourcePath = path.join(rootPath, "source");
    const destinationPath = path.join(rootPath, "destination");
    fs.mkdirSync(sourcePath);
    fs.writeFileSync(path.join(sourcePath, "file.txt"), "source");
    const rename = fs.promises.rename.bind(fs.promises);
    spyOn(fs.promises, "rename").and.callFake(async (oldPath, newPath) => {
      if (oldPath === sourcePath && newPath === destinationPath) {
        const error = new Error("cross-device");
        error.code = "EXDEV";
        throw error;
      }
      return rename(oldPath, newPath);
    });
    const link = fs.promises.link.bind(fs.promises);
    spyOn(fs.promises, "link").and.callFake(async (oldPath, newPath) => {
      await link(oldPath, newPath);
      if (path.dirname(newPath) === destinationPath) fs.writeFileSync(newPath, "external");
    });

    await expectAsync(movePath(sourcePath, destinationPath, 7, rootPath)).toBeRejectedWithError(
      /changed while the file operation was waiting/,
    );

    expect(fs.readFileSync(path.join(sourcePath, "file.txt"), "utf8")).toBe("source");
    expect(fs.readFileSync(path.join(destinationPath, "file.txt"), "utf8")).toBe("external");
  });

  it("keeps EXDEV recovery data when the original source path reappears", async () => {
    const sourcePath = path.join(rootPath, "source");
    const destinationPath = path.join(rootPath, "destination");
    fs.mkdirSync(sourcePath);
    fs.writeFileSync(path.join(sourcePath, "file.txt"), "original");
    const rename = fs.promises.rename.bind(fs.promises);
    spyOn(fs.promises, "rename").and.callFake(async (oldPath, newPath) => {
      if (oldPath === sourcePath && newPath === destinationPath) {
        const error = new Error("cross-device");
        error.code = "EXDEV";
        throw error;
      }
      return rename(oldPath, newPath);
    });
    const link = fs.promises.link.bind(fs.promises);
    spyOn(fs.promises, "link").and.callFake(async (oldPath, newPath) => {
      await link(oldPath, newPath);
      if (path.dirname(newPath) === destinationPath && !fs.existsSync(sourcePath)) {
        fs.mkdirSync(sourcePath);
        fs.writeFileSync(path.join(sourcePath, "new.txt"), "new");
      }
    });

    let failure;
    try {
      await movePath(sourcePath, destinationPath, 9, rootPath);
    } catch (error) {
      failure = error;
    }

    expect(failure.code).toBe("ESTALE");
    expect(failure.cleanupPath).toContain(".lumine-move-source-");
    expect(fs.readFileSync(path.join(sourcePath, "new.txt"), "utf8")).toBe("new");
    expect(fs.readFileSync(path.join(destinationPath, "file.txt"), "utf8")).toBe("original");
    expect(fs.readFileSync(path.join(failure.cleanupPath, "file.txt"), "utf8")).toBe("original");
  });

  it("restores a replaced destination when an EXDEV move is cancelled", async () => {
    const sourcePath = path.join(rootPath, "source.txt");
    const destinationPath = path.join(rootPath, "destination.txt");
    fs.writeFileSync(sourcePath, "source");
    fs.writeFileSync(destinationPath, "destination");
    const sourceStat = fs.lstatSync(sourcePath);
    const destinationStat = fs.lstatSync(destinationPath);
    const rename = fs.promises.rename.bind(fs.promises);
    spyOn(fs.promises, "rename").and.callFake(async (oldPath, newPath) => {
      if (oldPath === sourcePath && newPath === destinationPath) {
        const error = new Error("cross-device");
        error.code = "EXDEV";
        throw error;
      }
      return rename(oldPath, newPath);
    });
    setJobCancelled(10);

    let result;
    try {
      result = await replacePathSafely(
        sourcePath,
        destinationPath,
        10,
        sourceStat,
        destinationStat,
      );
    } finally {
      setJobCancelled(10, false);
    }

    expect(result).toEqual({ cancelled: true, renames: [] });
    expect(fs.readFileSync(sourcePath, "utf8")).toBe("source");
    expect(fs.readFileSync(destinationPath, "utf8")).toBe("destination");
    expect(fs.readdirSync(rootPath).some((name) => name.includes(".lumine-"))).toBe(false);
  });

  it("reports only the child and subtree roots physically moved by a directory merge", async () => {
    const sourcePath = path.join(rootPath, "source");
    const destinationPath = path.join(rootPath, "destination");
    const sourceExistingPath = path.join(sourcePath, "existing", "child.txt");
    const destinationExistingPath = path.join(destinationPath, "existing", "child.txt");
    const sourceSubtreePath = path.join(sourcePath, "subtree");
    const destinationSubtreePath = path.join(destinationPath, "subtree");
    fs.mkdirSync(path.dirname(sourceExistingPath), { recursive: true });
    fs.mkdirSync(path.dirname(destinationExistingPath), { recursive: true });
    fs.mkdirSync(sourceSubtreePath);
    fs.writeFileSync(sourceExistingPath, "child");
    fs.writeFileSync(path.join(sourceSubtreePath, "nested.txt"), "nested");

    const result = await movePath(sourcePath, destinationPath, 8, rootPath);
    result.renames.sort((left, right) => left.oldPath.localeCompare(right.oldPath));

    expect(result).toEqual({
      moved: true,
      renames: [
        {
          oldPath: sourceExistingPath,
          newPath: destinationExistingPath,
          isDirectory: false,
        },
        {
          oldPath: sourceSubtreePath,
          newPath: destinationSubtreePath,
          isDirectory: true,
        },
      ],
    });
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it("executes a prepared directory merge without discovering new decisions", async () => {
    const sourcePath = path.join(rootPath, "source");
    const destinationPath = path.join(rootPath, "destination");
    const sourceChildPath = path.join(sourcePath, "existing", "child.txt");
    const destinationChildPath = path.join(destinationPath, "existing", "child.txt");
    const sourceSubtreePath = path.join(sourcePath, "subtree");
    const destinationSubtreePath = path.join(destinationPath, "subtree");
    fs.mkdirSync(path.dirname(sourceChildPath), { recursive: true });
    fs.mkdirSync(path.dirname(destinationChildPath), { recursive: true });
    fs.mkdirSync(sourceSubtreePath);
    fs.writeFileSync(sourceChildPath, "child");
    fs.writeFileSync(path.join(sourceSubtreePath, "nested.txt"), "nested");
    const snapshot = (filePath) => {
      const stat = fs.lstatSync(filePath);
      return {
        dev: stat.dev,
        ino: stat.ino,
        isDirectory: stat.isDirectory(),
        isSymbolicLink: stat.isSymbolicLink(),
      };
    };
    const sourceSnapshot = snapshot(sourcePath);
    const existingSnapshot = snapshot(path.join(sourcePath, "existing"));
    const childSnapshot = snapshot(sourceChildPath);
    const subtreeSnapshot = snapshot(sourceSubtreePath);
    const renames = [
      { oldPath: sourceChildPath, newPath: destinationChildPath, isDirectory: false },
      { oldPath: sourceSubtreePath, newPath: destinationSubtreePath, isDirectory: true },
    ];

    const result = await executeMovePlan(
      {
        version: 1,
        checks: [
          { path: sourcePath, snapshot: sourceSnapshot },
          { path: sourceChildPath, snapshot: childSnapshot },
          { path: destinationChildPath, snapshot: null },
          { path: sourceSubtreePath, snapshot: subtreeSnapshot },
          { path: destinationSubtreePath, snapshot: null },
        ],
        actions: [
          {
            type: "rename",
            sourcePath: sourceChildPath,
            destinationPath: destinationChildPath,
            sourceSnapshot: childSnapshot,
            destinationSnapshot: null,
            replace: false,
            sameFile: false,
          },
          {
            type: "remove-directory",
            path: path.join(sourcePath, "existing"),
            snapshot: existingSnapshot,
          },
          {
            type: "rename",
            sourcePath: sourceSubtreePath,
            destinationPath: destinationSubtreePath,
            sourceSnapshot: subtreeSnapshot,
            destinationSnapshot: null,
            replace: false,
            sameFile: false,
          },
          { type: "remove-directory", path: sourcePath, snapshot: sourceSnapshot },
        ],
        renames,
        skipped: false,
        removesRoot: true,
      },
      8,
    );

    expect(result).toEqual({ moved: true, renames });
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.readFileSync(destinationChildPath, "utf8")).toBe("child");
    expect(fs.readFileSync(path.join(destinationSubtreePath, "nested.txt"), "utf8")).toBe("nested");
  });

  it("rejects a stale prepared move before applying any action", async () => {
    const sourcePath = path.join(rootPath, "source.txt");
    const destinationPath = path.join(rootPath, "destination.txt");
    fs.writeFileSync(sourcePath, "source");
    const sourceStat = fs.lstatSync(sourcePath);
    const sourceSnapshot = {
      dev: sourceStat.dev,
      ino: sourceStat.ino,
      isDirectory: false,
      isSymbolicLink: false,
    };
    const plan = {
      version: 1,
      checks: [
        { path: sourcePath, snapshot: sourceSnapshot },
        { path: destinationPath, snapshot: null },
      ],
      actions: [
        {
          type: "rename",
          sourcePath,
          destinationPath,
          sourceSnapshot,
          destinationSnapshot: null,
          replace: false,
          sameFile: false,
        },
      ],
      renames: [{ oldPath: sourcePath, newPath: destinationPath, isDirectory: false }],
      skipped: false,
      removesRoot: true,
    };
    fs.writeFileSync(destinationPath, "external");

    let failure;
    try {
      await executeMovePlan(plan, 9);
    } catch (error) {
      failure = error;
    }

    expect(failure.code).toBe("ESTALE");
    expect(failure.renames).toEqual(undefined);
    expect(fs.readFileSync(sourcePath, "utf8")).toBe("source");
    expect(fs.readFileSync(destinationPath, "utf8")).toBe("external");
  });
});
