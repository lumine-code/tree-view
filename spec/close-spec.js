describe("closing the Tree View", () => {
  let mainModule, workspaceElement;

  beforeEach(async () => {
    lumine.config.set("tree-view.hiddenOnStartup", true);
    lumine.config.set("tree-view.showOnRightSide", false);
    workspaceElement = lumine.workspace.getElement();
    jasmine.attachToDOM(workspaceElement);
    lumine.keymaps.loadBundledKeymaps();
    const pack = await lumine.packages.activatePackage("tree-view");
    mainModule = pack.mainModule;
  });

  afterEach(async () => {
    await lumine.packages.deactivatePackage("tree-view");
  });

  it("closes the center document from the focused tree without recreating the tree", async () => {
    const previousEditor = await lumine.workspace.open();
    const editor = await lumine.workspace.open();
    const tree = mainModule.getTreeViewInstance();
    await tree.show(true);

    const event = new KeyboardEvent("keydown", {
      key: "w",
      ctrlKey: process.platform !== "darwin",
      metaKey: process.platform === "darwin",
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, "target", { get: () => tree.element });
    lumine.keymaps.handleKeyboardEvent(event);

    expect(editor.isDestroyed()).toBe(true);
    expect(lumine.workspace.getCenter().getActivePaneItem()).toBe(previousEditor);
    expect(previousEditor.isDestroyed()).toBe(false);
    expect(mainModule.getTreeViewInstance()).toBe(tree);
    expect(lumine.workspace.getLeftDock().getActivePaneItem()).toBe(tree);
    expect(lumine.workspace.getLeftDock().isVisible()).toBe(true);
    expect(tree.hasFocus()).toBe(true);
  });

  it("hides and reveals the same tree through its explicit toggle", async () => {
    const editor = await lumine.workspace.open();
    const tree = mainModule.getTreeViewInstance();
    await tree.show(true);

    await lumine.commands.dispatch(workspaceElement, "tree-view:toggle");

    expect(lumine.workspace.getLeftDock().isVisible()).toBe(false);
    expect(mainModule.getTreeViewInstance()).toBe(tree);
    expect(lumine.workspace.paneForItem(tree)).toBeDefined();
    expect(editor.isDestroyed()).toBe(false);

    await lumine.commands.dispatch(workspaceElement, "tree-view:toggle-focus");

    expect(mainModule.getTreeViewInstance()).toBe(tree);
    expect(lumine.workspace.getLeftDock().isVisible()).toBe(true);
    expect(workspaceElement.contains(tree.element)).toBe(true);
    expect(editor.isDestroyed()).toBe(false);
  });

  it("recreates a tree closed through its dock tab without closing the center", async () => {
    const editor = await lumine.workspace.open();
    const tree = mainModule.getTreeViewInstance();
    await tree.show(true);

    await lumine.workspace.paneForItem(tree).destroyItem(tree);

    expect(mainModule.treeView).toBeNull();
    expect(lumine.workspace.paneForItem(tree)).toBeUndefined();
    expect(lumine.workspace.getLeftDock().isVisible()).toBe(false);
    expect(editor.isDestroyed()).toBe(false);

    await lumine.commands.dispatch(workspaceElement, "tree-view:toggle-focus");

    const recreated = mainModule.treeView;
    expect(recreated).not.toBe(tree);
    expect(lumine.workspace.getLeftDock().getActivePaneItem()).toBe(recreated);
    expect(lumine.workspace.getLeftDock().isVisible()).toBe(true);
    expect(workspaceElement.contains(recreated.element)).toBe(true);
    expect(editor.isDestroyed()).toBe(false);
  });
});
