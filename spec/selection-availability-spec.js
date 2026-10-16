const { Emitter } = require("lumine");
const TreeViewPackage = require("../lib/tree-view-package");
const TreeView = require("../lib/tree-view");

describe("Passive tree selection availability", () => {
  it("does not construct a cold tree and retires its facade with activation", async () => {
    const main = new TreeViewPackage();
    main.activate();
    const service = main.provideTreeViewSelection();
    const ensure = spyOn(main, "getTreeViewInstance").and.throwError(
      "availability must not ensure a tree",
    );
    const empty = service.getSelectionSnapshot();
    expect(empty.count).toBe(0);
    expect(service.getSelectionSnapshot()).toBe(empty);
    expect(ensure).not.toHaveBeenCalled();
    await main.deactivate();
    expect(service.getSelectionSnapshot()).toBe(empty);
  });
  it("publishes immutable selection metadata when selection changes", () => {
    const tree = Object.create(TreeView.prototype);
    Object.assign(tree, {
      selectedEntries: new Set(),
      emitter: new Emitter(),
      visibleRows: [],
      stickyHeaderMode: "none",
      selectionGeneration: 0,
    });
    const entry = (value, index, root = false) => ({
      getPath: () => value,
      index,
      kind: "file",
      projectRoot: root,
      syncViews() {},
    });
    const first = entry("/project/a", 0),
      second = entry("/project/b", 1);
    tree.visibleRows = [first, second];
    const changes = [];
    tree.onDidChangeSelection((snapshot) => changes.push(snapshot));
    tree.selectEntry(first);
    const snapshot = tree.getSelectionSnapshot();
    expect(snapshot.paths).toEqual(["/project/a"]);
    expect(snapshot.primary.path).toBe("/project/a");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.entries[0])).toBe(true);
    const read = spyOn(tree, "getSelectedEntries").and.throwError(
      "query must not materialize selection",
    );
    expect(tree.getSelectionSnapshot()).toBe(snapshot);
    expect(read).not.toHaveBeenCalled();
    tree.selectMultipleEntries(second);
    expect(tree.getSelectionSnapshot().count).toBe(2);
    expect(tree.getSelectionSnapshot().primary.path).toBe("/project/b");
    expect(changes.length).toBe(2);
    tree.emitter.dispose();
  });
});
