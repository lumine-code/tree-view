const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const TreeView = require("../lib/tree-view");
const TreeViewPackage = require("../lib/tree-view-package");

describe("Tree scrollbar navigation activity", () => {
  it("signals handled boundary navigation without revealing for unrelated text", () => {
    const previousPaths = lumine.project.getPaths();
    lumine.project.setPaths([path.resolve(__dirname, "..")]);
    const tree = new TreeView({});
    try {
      tree.selectEntry(tree.roots[0]);
      const reveal = spyOn(lumine.scrollbars, "reveal");
      const before = tree.scroller.scrollTop;
      lumine.commands.dispatch(tree.element, "core:move-up");
      expect(tree.selectedEntry()).toBe(tree.roots[0]);
      expect(tree.scroller.scrollTop).toBe(before);
      expect(reveal).toHaveBeenCalledWith(tree.scroller);
      reveal.calls.reset();
      tree.element.dispatchEvent(new KeyboardEvent("keydown", { key: "q", bubbles: true }));
      lumine.commands.dispatch(tree.element, "unrelated:unhandled");
      expect(reveal).not.toHaveBeenCalled();
    } finally {
      tree.destroy();
      lumine.project.setPaths(previousPaths);
    }
  });
});

describe("Tree explicit navigation activity", () => {
  let directory, filePath, tree, provider, previousPaths;

  beforeEach(() => {
    previousPaths = lumine.project.getPaths();
    directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "tree-navigation-")));
    filePath = path.join(directory, "item.txt");
    fs.writeFileSync(filePath, "item");
    lumine.project.setPaths([directory]);
    tree = new TreeView({});
    provider = new TreeViewPackage();
    provider.initialize();
    provider.treeView = tree;
  });

  afterEach(async () => {
    await provider.deactivate();
    lumine.project.setPaths(previousPaths);
    await lumine.fileWatchClient.settlePendingTeardown();
    const relative = path.relative(fs.realpathSync.native(os.tmpdir()), directory);
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`)
    )
      throw new Error("Unsafe tree navigation fixture cleanup");
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("signals Enter folder expansion and collapse once without requiring a scroll", async () => {
    const root = tree.roots[0];
    root.collapse();
    tree.selectEntry(root);
    const before = tree.scroller.scrollTop;
    const reveal = spyOn(lumine.scrollbars, "reveal");

    await lumine.commands.dispatch(tree.element, "tree-view:open-selected-entry");
    expect(root.isExpanded).toBeTrue();
    expect(reveal).toHaveBeenCalledOnceWith(tree.scroller);
    expect(tree.scroller.scrollTop).toBe(before);
    reveal.calls.reset();
    await lumine.commands.dispatch(tree.element, "tree-view:open-selected-entry");
    expect(root.isExpanded).toBeFalse();
    expect(reveal).toHaveBeenCalledOnceWith(tree.scroller);
  });

  it("keeps ordinary service reveals quiet and signals an already-visible explicit target", async () => {
    const service = provider.provideTreeViewSelection();
    const options = { focus: false, center: false };
    await service.revealPath(filePath, options);
    const before = tree.scroller.scrollTop;
    const reveal = spyOn(lumine.scrollbars, "reveal");
    await service.revealPath(filePath, options);
    expect(reveal).not.toHaveBeenCalled();
    await service.revealPath(filePath, { ...options, navigation: true });
    expect(tree.selectedPaths()).toEqual([filePath]);
    expect(tree.scroller.scrollTop).toBe(before);
    expect(reveal).toHaveBeenCalledOnceWith(tree.scroller);
  });

  it("marks the explicit workspace reveal command without changing the default service intent", async () => {
    provider.activate();
    spyOn(provider, "sourcePathForEvent").and.returnValue(filePath);
    const revealPath = spyOn(tree, "revealPath").and.resolveTo();
    await lumine.commands.dispatch(lumine.workspace.getElement(), "tree-view:reveal-active-file");
    expect(revealPath).toHaveBeenCalledOnceWith(filePath, { show: true, navigation: true });
  });
});
