const fs = require("fs");
const os = require("os");
const path = require("path");
const FileOperationProcess = require("../lib/file-operation-process");

describe("TreeView file operation process", () => {
  let rootPath;
  let operations;

  beforeEach(() => {
    rootPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tree-view-operation-")));
  });

  afterEach(() => {
    operations?.destroy();
    // Retries because Windows keeps a directory non-empty until the last handle on a child
    // closes, and `force` swallows only ENOENT.
    fs.rmSync(rootPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("copies and moves queued files outside the renderer", async () => {
    const sourcePath = path.join(rootPath, "source.bin");
    const copyPath = path.join(rootPath, "copy.bin");
    const movedPath = path.join(rootPath, "moved.bin");
    const contents = Buffer.alloc(1024 * 1024, 7);
    fs.writeFileSync(sourcePath, contents);

    const phases = [];
    operations = new FileOperationProcess({
      onDidProgress: ({ phase }) => phases.push(phase),
    });
    const copyPromise = operations.run("copy", sourcePath, copyPath);
    const movePromise = operations.run("move", copyPath, movedPath);

    expect(operations.getOperations().map(({ state }) => state)).toEqual(["running", "queued"]);

    expect(await copyPromise).toEqual({
      copied: true,
      creates: [{ path: copyPath, isDirectory: false }],
    });
    expect(await movePromise).toEqual({
      moved: true,
      renames: [{ oldPath: copyPath, newPath: movedPath, isDirectory: false }],
    });
    expect(fs.existsSync(copyPath)).toBe(false);
    expect(fs.readFileSync(movedPath)).toEqual(contents);
    expect(phases).toContain("copying");
    expect(phases).toContain("moving");
  });

  it("cancels an active copy and removes its partial destination", async () => {
    const sourcePath = path.join(rootPath, "source.bin");
    const copyPath = path.join(rootPath, "copy.bin");
    fs.writeFileSync(sourcePath, Buffer.alloc(1024 * 1024, 7));
    operations = new FileOperationProcess();

    const copyPromise = operations.run("copy", sourcePath, copyPath);
    expect(operations.cancel(copyPromise.operationId)).toBe(true);

    expect(await copyPromise).toEqual({ cancelled: true, creates: [] });
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(fs.existsSync(copyPath)).toBe(false);
  });

  it("waits for active worker cleanup before finishing destruction", async () => {
    const sourcePath = path.join(rootPath, "source.bin");
    const copyPath = path.join(rootPath, "copy.bin");
    const contents = Buffer.alloc(4 * 1024 * 1024, 7);
    fs.writeFileSync(sourcePath, contents);
    operations = new FileOperationProcess();

    const copying = operations.run("copy", sourcePath, copyPath);
    const destroying = operations.destroy();
    const result = await copying;
    await destroying;

    if (result.cancelled) {
      expect(result.creates).toEqual([]);
      expect(fs.existsSync(copyPath)).toBe(false);
    } else {
      expect(fs.readFileSync(copyPath)).toEqual(contents);
    }
    expect(operations.childProcess).toBeNull();
  });

  it("removes a queued operation without starting it", async () => {
    const sourcePath = path.join(rootPath, "source.bin");
    const firstCopyPath = path.join(rootPath, "first.bin");
    const queuedCopyPath = path.join(rootPath, "queued.bin");
    fs.writeFileSync(sourcePath, Buffer.alloc(1024 * 1024, 7));
    operations = new FileOperationProcess();

    const firstCopy = operations.run("copy", sourcePath, firstCopyPath);
    const queuedCopy = operations.run("copy", sourcePath, queuedCopyPath);
    expect(operations.pauseQueue()).toBe(true);
    expect(operations.cancel(queuedCopy.operationId)).toBe(true);
    expect(operations.isQueuePaused()).toBe(false);

    expect(await queuedCopy).toEqual({ cancelled: true, creates: [] });
    expect(await firstCopy).toEqual({
      copied: true,
      creates: [{ path: firstCopyPath, isDirectory: false }],
    });
    expect(fs.existsSync(queuedCopyPath)).toBe(false);
  });

  it("pauses before starting the next queued operation and resumes it later", async () => {
    const sourcePath = path.join(rootPath, "source.bin");
    const firstCopyPath = path.join(rootPath, "first.bin");
    const secondCopyPath = path.join(rootPath, "second.bin");
    fs.writeFileSync(sourcePath, Buffer.alloc(1024 * 1024, 7));
    operations = new FileOperationProcess();

    const firstCopy = operations.run("copy", sourcePath, firstCopyPath);
    const secondCopy = operations.run("copy", sourcePath, secondCopyPath);
    expect(operations.getQueueProgress()).toEqual({ completed: 0, total: 2 });
    expect(operations.pauseQueue()).toBe(true);
    expect(operations.isQueuePaused()).toBe(true);

    expect(await firstCopy).toEqual({
      copied: true,
      creates: [{ path: firstCopyPath, isDirectory: false }],
    });
    expect(operations.getOperations().map(({ state }) => state)).toEqual(["queued"]);
    expect(operations.getQueueProgress()).toEqual({ completed: 1, total: 2 });
    expect(fs.existsSync(secondCopyPath)).toBe(false);

    expect(operations.resumeQueue()).toBe(true);
    expect(operations.isQueuePaused()).toBe(false);
    expect(await secondCopy).toEqual({
      copied: true,
      creates: [{ path: secondCopyPath, isDirectory: false }],
    });
    expect(operations.getQueueProgress()).toEqual({ completed: 2, total: 2 });
    expect(fs.existsSync(secondCopyPath)).toBe(true);
  });

  it("clears queued operations without cancelling the running one", async () => {
    const sourcePath = path.join(rootPath, "source.bin");
    const runningCopyPath = path.join(rootPath, "running.bin");
    const queuedCopyPath = path.join(rootPath, "queued.bin");
    fs.writeFileSync(sourcePath, Buffer.alloc(1024 * 1024, 7));
    operations = new FileOperationProcess();

    const runningCopy = operations.run("copy", sourcePath, runningCopyPath);
    const queuedCopy = operations.run("copy", sourcePath, queuedCopyPath);

    expect(operations.clearQueue()).toBe(true);
    expect(operations.getQueueProgress()).toEqual({ completed: 0, total: 1 });
    expect(await queuedCopy).toEqual({ cancelled: true, creates: [] });
    expect(await runningCopy).toEqual({
      copied: true,
      creates: [{ path: runningCopyPath, isDirectory: false }],
    });
    expect(fs.existsSync(runningCopyPath)).toBe(true);
    expect(fs.existsSync(queuedCopyPath)).toBe(false);
  });

  it("asks the renderer before replacing a conflicting file", async () => {
    const sourceDirectory = path.join(rootPath, "source");
    const destinationDirectory = path.join(rootPath, "destination");
    fs.mkdirSync(sourceDirectory);
    fs.mkdirSync(destinationDirectory);
    fs.writeFileSync(path.join(sourceDirectory, "file.txt"), "new");
    fs.writeFileSync(path.join(destinationDirectory, "file.txt"), "old");

    const conflicts = [];
    operations = new FileOperationProcess({
      async onConflict(conflict) {
        conflicts.push(conflict);
        return "replace";
      },
    });

    expect(await operations.run("move", sourceDirectory, destinationDirectory)).toEqual({
      moved: true,
      renames: [
        {
          oldPath: path.join(sourceDirectory, "file.txt"),
          newPath: path.join(destinationDirectory, "file.txt"),
          isDirectory: false,
        },
      ],
    });
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].relativePath).toBe(path.join("destination", "file.txt"));
    expect(fs.readFileSync(path.join(destinationDirectory, "file.txt"), "utf8")).toBe("new");
    expect(fs.existsSync(sourceDirectory)).toBe(false);
  });

  it("does not replace a destination that changed while the conflict dialog was open", async () => {
    const sourcePath = path.join(rootPath, "source.txt");
    const destinationPath = path.join(rootPath, "destination.txt");
    fs.writeFileSync(sourcePath, "source");
    fs.writeFileSync(destinationPath, "old");
    operations = new FileOperationProcess({
      onConflict() {
        fs.rmSync(destinationPath);
        fs.writeFileSync(destinationPath, "external");
        return "replace";
      },
    });

    await expectAsync(operations.run("move", sourcePath, destinationPath)).toBeRejectedWithError(
      /changed while the file operation was waiting/,
    );

    expect(fs.readFileSync(sourcePath, "utf8")).toBe("source");
    expect(fs.readFileSync(destinationPath, "utf8")).toBe("external");
  });

  it("does not move a source that changed while the conflict dialog was open", async () => {
    const sourcePath = path.join(rootPath, "source.txt");
    const destinationPath = path.join(rootPath, "destination.txt");
    fs.writeFileSync(sourcePath, "source");
    fs.writeFileSync(destinationPath, "destination");
    operations = new FileOperationProcess({
      onConflict() {
        fs.rmSync(sourcePath);
        fs.writeFileSync(sourcePath, "external");
        return "replace";
      },
    });

    await expectAsync(operations.run("move", sourcePath, destinationPath)).toBeRejectedWithError(
      /changed while the file operation was waiting/,
    );

    expect(fs.readFileSync(sourcePath, "utf8")).toBe("external");
    expect(fs.readFileSync(destinationPath, "utf8")).toBe("destination");
  });

  it("treats distinct hardlinks as a conflict rather than a completed rename", async () => {
    const sourcePath = path.join(rootPath, "source.txt");
    const destinationPath = path.join(rootPath, "destination.txt");
    fs.writeFileSync(sourcePath, "shared");
    fs.linkSync(sourcePath, destinationPath);
    const onConflict = jasmine.createSpy("onConflict").and.returnValue("skip");
    operations = new FileOperationProcess({ onConflict });

    expect(await operations.run("move", sourcePath, destinationPath)).toEqual({
      skipped: true,
      renames: [],
    });

    expect(onConflict).toHaveBeenCalled();
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(fs.existsSync(destinationPath)).toBe(true);
  });

  it("reports a partial directory move when a conflict is skipped", async () => {
    const sourceDirectory = path.join(rootPath, "source");
    const destinationDirectory = path.join(rootPath, "destination");
    fs.mkdirSync(sourceDirectory);
    fs.mkdirSync(destinationDirectory);
    fs.writeFileSync(path.join(sourceDirectory, "conflict.txt"), "new");
    fs.writeFileSync(path.join(sourceDirectory, "fresh.txt"), "fresh");
    fs.writeFileSync(path.join(destinationDirectory, "conflict.txt"), "old");

    operations = new FileOperationProcess({ onConflict: () => "skip" });

    expect(await operations.run("move", sourceDirectory, destinationDirectory)).toEqual({
      skipped: true,
      partial: true,
      renames: [
        {
          oldPath: path.join(sourceDirectory, "fresh.txt"),
          newPath: path.join(destinationDirectory, "fresh.txt"),
          isDirectory: false,
        },
      ],
    });
    expect(fs.readFileSync(path.join(sourceDirectory, "conflict.txt"), "utf8")).toBe("new");
    expect(fs.readFileSync(path.join(destinationDirectory, "conflict.txt"), "utf8")).toBe("old");
    expect(fs.readFileSync(path.join(destinationDirectory, "fresh.txt"), "utf8")).toBe("fresh");
  });

  it("preserves completed directory-merge renames on a serialized worker error", async () => {
    const sourceDirectory = path.join(rootPath, "source");
    const destinationDirectory = path.join(rootPath, "destination");
    const freshPath = path.join(sourceDirectory, "a-fresh.txt");
    const movedFreshPath = path.join(destinationDirectory, "a-fresh.txt");
    fs.mkdirSync(sourceDirectory);
    fs.mkdirSync(destinationDirectory);
    fs.writeFileSync(freshPath, "fresh");
    fs.writeFileSync(path.join(sourceDirectory, "z-conflict"), "file");
    fs.mkdirSync(path.join(destinationDirectory, "z-conflict"));

    operations = new FileOperationProcess({ onConflict: () => "replace" });

    let failure;
    try {
      await operations.run("move", sourceDirectory, destinationDirectory);
    } catch (error) {
      failure = error;
    }

    expect(failure).toEqual(jasmine.any(Error));
    expect(failure.code).toBe("EISDIR");
    expect(failure.partial).toBe(true);
    expect(failure.renames).toEqual([
      { oldPath: freshPath, newPath: movedFreshPath, isDirectory: false },
    ]);
    expect(fs.existsSync(freshPath)).toBe(false);
    expect(fs.readFileSync(movedFreshPath, "utf8")).toBe("fresh");
  });
});
