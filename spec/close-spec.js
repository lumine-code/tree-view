describe("closing the Tree View", () => {
  let mainModule, workspaceElement;

  beforeEach(async () => {
    lumine.config.set("tree-view.hiddenOnStartup", true);
    lumine.config.set("tree-view.showOnRightSide", false);
    workspaceElement = lumine.workspace.getElement();
    jasmine.attachToDOM(workspaceElement);
    const pack = await lumine.packages.activatePackage("tree-view");
    mainModule = pack.mainModule;
  });

  afterEach(async () => {
    await lumine.packages.deactivatePackage("tree-view");
  });

  it("closes its dock tab and recreates it on reveal without closing the center", async () => {
    const editor = await lumine.workspace.open();
    const tree = mainModule.getTreeViewInstance();
    await tree.show(true);

    await lumine.commands.dispatch(tree.element, "core:close");

    expect(mainModule.treeView).toBeNull();
    expect(lumine.workspace.paneForItem(tree)).toBeUndefined();
    expect(lumine.workspace.getLeftDock().isVisible()).toBe(false);
    expect(lumine.workspace.getCenter().getActivePaneItem()).toBe(editor);
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
