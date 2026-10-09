const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

describe("Tree View entries replaced with another filesystem kind", () => {
  let tree;
  let scratch;
  let projectPaths;

  beforeEach(() => {
    jasmine.useRealClock();
    for (const launcher of ["openExternal", "openPath", "showItemInFolder", "openApplication"]) {
      spyOn(lumine.shell, launcher).and.returnValue(Promise.resolve());
    }
    spyOn(lumine.application, "openWindow").and.returnValue(Promise.resolve());
    projectPaths = lumine.project.getPaths();
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tree-entry-kind-")));
    lumine.config.set("tree-view.squashDirectoryNames", true);
  });

  afterEach(async () => {
    for (const editor of lumine.workspace.getTextEditors()) editor.destroy();
    if (lumine.packages.isPackageActive("tree-view")) {
      await lumine.packages.deactivatePackage("tree-view");
    }
    if (lumine.packages.getLoadedPackage("tree-view")) {
      await lumine.packages.unloadPackage("tree-view");
    }
    lumine.project.setPaths(projectPaths);
    await lumine.fileWatchClient.settlePendingTeardown();
    const tempRoot = fs.realpathSync(os.tmpdir());
    const relative = path.relative(tempRoot, fs.realpathSync(scratch));
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error("Scratch directory escaped the private temporary root");
    }
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  async function startTree() {
    lumine.project.setPaths([scratch]);
    jasmine.attachToDOM(lumine.workspace.getElement());
    await lumine.packages.activatePackage("tree-view");
    tree = lumine.packages.getActivePackage("tree-view").mainModule.getTreeViewInstance();
    await tree.show();
    await tree.roots[0].expand();
    // The synchronous disk replacement completes before either explicit
    // refresh starts; normal watchers remain active and use the async API.
    return tree.roots[0].directory;
  }

  function createDirectoryTarget(target) {
    fs.mkdirSync(path.join(target, "inner"), { recursive: true });
    fs.writeFileSync(path.join(target, "inner", "readme.txt"), "nested content\n");
  }

  for (const refresh of ["reload", "reloadAsync"]) {
    it(`${refresh} replaces a squashed directory row with an openable file`, async () => {
      const target = path.join(scratch, "changing");
      createDirectoryTarget(target);
      const directory = await startTree();
      const previous = directory.entries.get("changing");
      expect(previous.path).toBe(path.join(target, "inner"));
      fs.unlinkSync(path.join(target, "inner", "readme.txt"));
      fs.rmdirSync(path.join(target, "inner"));
      fs.rmdirSync(target);
      fs.writeFileSync(target, "replacement content\n");

      await directory[refresh]();

      const entry = tree.treeEntryForPath(target);
      expect(directory.entries.get("changing")).not.toBe(previous);
      expect(entry?.kind).toBe("file");
      expect(directory.entries.get("changing").realPath).toBe(target);
      if (entry?.kind !== "file") return;
      tree.selectEntry(entry);
      spyOn(tree, "openSelectedEntry").and.callThrough();
      lumine.commands.dispatch(tree.element, "tree-view:open-selected-entry");
      await tree.openSelectedEntry.calls.mostRecent().returnValue;
      expect(lumine.workspace.getActiveTextEditor().getPath()).toBe(target);
      expect(lumine.workspace.getActiveTextEditor().getText()).toBe("replacement content\n");
    });

    it(`${refresh} replaces a file row with a freshly squashed expandable directory`, async () => {
      const target = path.join(scratch, "changing");
      fs.writeFileSync(target, "original file\n");
      const directory = await startTree();
      const previous = directory.entries.get("changing");
      fs.unlinkSync(target);
      createDirectoryTarget(target);

      await directory[refresh]();

      const entry = tree.treeEntryForPath(path.join(target, "inner"));
      expect(directory.entries.get("changing")).not.toBe(previous);
      expect(entry?.kind).toBe("directory");
      expect(directory.entries.get("changing").realPath).toBe(path.join(target, "inner"));
      if (entry?.kind !== "directory") return;
      await entry.expand();
      expect(tree.treeEntryForPath(path.join(target, "inner", "readme.txt"))?.kind).toBe("file");
    });
  }

  it("keeps unchanged file and expanded directory models across both refresh APIs", async () => {
    fs.writeFileSync(path.join(scratch, "stable.txt"), "stable\n");
    createDirectoryTarget(path.join(scratch, "stable-directory"));
    const directory = await startTree();
    const file = directory.entries.get("stable.txt");
    const folder = directory.entries.get("stable-directory");
    const folderEntry = tree.treeEntryForPath(folder.path);
    await folderEntry.expand();

    directory.reload();
    await directory.reloadAsync();

    expect(directory.entries.get("stable.txt")).toBe(file);
    expect(directory.entries.get("stable-directory")).toBe(folder);
    expect(tree.treeEntryForPath(folder.path)).toBe(folderEntry);
    expect(folderEntry.isExpanded).toBe(true);
  });
});
