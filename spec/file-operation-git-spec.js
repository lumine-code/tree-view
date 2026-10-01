const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { GitRepository } = require("lumine");
const { movePath } = require("../lib/file-operation-worker");

describe("TreeView cross-volume Git moves", () => {
  let rootPath;
  let originalPaths;
  let originalWatchDiscovery;
  let originalScanDepth;

  beforeEach(() => {
    jasmine.useRealClock();
    originalPaths = lumine.project.getPaths();
    originalWatchDiscovery = lumine.config.get("git.watchDiscovery");
    originalScanDepth = lumine.config.get("git.scanDepth");
    lumine.config.set("git.watchDiscovery", false);
    lumine.config.set("git.scanDepth", 0);
    rootPath = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "tree-view-git-move-")),
    );
  });

  afterEach(async () => {
    lumine.project.setPaths(originalPaths);
    lumine.config.set("git.watchDiscovery", originalWatchDiscovery);
    lumine.config.set("git.scanDepth", originalScanDepth);
    await lumine.repositories.rescan();
    await lumine.repositories.fileChangeValidationTail;
    await lumine.fileWatchClient.settlePendingTeardown();
    await fs.promises.rm(rootPath, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  });

  it("keeps the source available while copying and registers a working Git facade at the destination", async () => {
    const sourceRoot = path.join(rootPath, "A");
    const destinationRoot = path.join(rootPath, "B");
    const sourcePath = path.join(sourceRoot, "repository");
    const destinationPath = path.join(destinationRoot, "repository");
    fs.mkdirSync(sourceRoot);
    fs.mkdirSync(destinationRoot);
    const git = (...args) => execFileSync("git", args, { encoding: "utf8", windowsHide: true });
    git("init", "-b", "master", sourcePath);
    fs.writeFileSync(path.join(sourcePath, "tracked.txt"), "tracked contents\n");
    git("-C", sourcePath, "add", "tracked.txt");
    git(
      "-C",
      sourcePath,
      "-c",
      "user.name=Spec Author",
      "-c",
      "user.email=spec@example.test",
      "-c",
      "commit.gpgsign=false",
      "-c",
      `core.hooksPath=${path.join(rootPath, "empty-hooks")}`,
      "commit",
      "-m",
      "Initial commit",
    );
    const headOid = git("-C", sourcePath, "rev-parse", "HEAD").trim();
    fs.writeFileSync(path.join(sourcePath, "pending.txt"), "untracked contents\n");

    lumine.project.setPaths([sourceRoot, destinationRoot]);
    await lumine.repositories.rescan();
    const original = await lumine.repositories.resolveForPath(sourcePath, { refresh: true });
    expect(original).toEqual(jasmine.any(GitRepository));

    const planned = { oldPath: sourcePath, newPath: destinationPath, isDirectory: true };
    const transaction = lumine.workspace.beginFileMove([planned]);
    const rename = fs.promises.rename.bind(fs.promises);
    spyOn(fs.promises, "rename").and.callFake(async (oldPath, newPath) => {
      if (oldPath === sourcePath && newPath === destinationPath) {
        throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
      }
      return rename(oldPath, newPath);
    });
    const cp = fs.promises.cp.bind(fs.promises);
    spyOn(fs.promises, "cp").and.callFake(async (from, to, options) => {
      expect(from.startsWith(sourcePath + path.sep)).toBe(true);
      expect(to.startsWith(destinationPath + path.sep)).toBe(true);
      expect(git("-C", sourcePath, "rev-parse", "--is-inside-work-tree").trim()).toBe("true");
      expect(fs.readdirSync(sourceRoot).some((name) => name.includes(".lumine-"))).toBe(false);
      expect(fs.readdirSync(destinationRoot).some((name) => name.includes(".lumine-"))).toBe(false);
      return cp(from, to, options);
    });

    let result;
    try {
      await transaction.ready;
      result = await movePath(sourcePath, destinationPath, 1, destinationRoot);
    } finally {
      await transaction.complete(result?.renames || []);
    }

    expect(result).toEqual({ moved: true, renames: [planned] });
    expect(fs.promises.cp).toHaveBeenCalled();
    expect(fs.promises.rename).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(original.isDestroyed()).toBe(true);
    const moved = lumine.repositories.getForPath(destinationPath);
    expect(moved).toEqual(jasmine.any(GitRepository));
    expect(moved).not.toBe(original);
    expect(fs.realpathSync.native(moved.getWorkingDirectory())).toBe(
      fs.realpathSync.native(destinationPath),
    );

    const [status, refs] = await Promise.all([
      moved.refreshStatusSnapshot(),
      moved.refreshRefsSnapshot(),
    ]);
    expect(status.initialized).toBe(true);
    expect(status.head.oid).toBe(headOid);
    expect(status.files).toContain(
      jasmine.objectContaining({ path: "pending.txt", untracked: true }),
    );
    expect(refs.initialized).toBe(true);
    expect(refs.head.oid).toBe(headOid);
    expect(refs.branches).toContain(jasmine.objectContaining({ name: "master", oid: headOid }));
    expect(fs.readdirSync(sourceRoot)).toEqual([]);
    expect(fs.readdirSync(destinationRoot)).toEqual(["repository"]);
  });
});
