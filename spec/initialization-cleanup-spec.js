describe("Tree View recovery bootstrap", () => {
  let pack, main, restored;

  beforeEach(async () => {
    if (lumine.packages.isPackageLoaded("tree-view"))
      await lumine.packages.unloadPackage("tree-view", { serialize: false });
    pack = lumine.packages.loadPackage("tree-view");
    pack.requireMainModule();
    pack.initializeForExternalUse("workspace restoration");
    main = pack.mainModule;
  });

  afterEach(async () => {
    if (lumine.packages.isPackageLoaded("tree-view"))
      await lumine.packages.unloadPackage("tree-view", { serialize: false });
    await restored?.destroy();
    restored = null;
  });

  it("unloads an initialized package before its activation starts", async () => {
    expect(pack.mainInitialized).toBe(true);
    expect(pack.mainActivated).toBe(false);
    await expectAsync(
      lumine.packages.unloadPackage("tree-view", { serialize: false }),
    ).toBeResolved();
  });

  it("attaches restored trees to the same operation owner after activation", async () => {
    lumine.project.setPaths([]);
    restored = main.getTreeViewInstance();
    await lumine.packages.activatePackage("tree-view");
    expect(main.getTreeViewInstance()).toBe(restored);
    expect(restored.fileOperationEvents).toBe(main.fileOperationEvents);
    expect(main.fileOperationEvents).toBeDefined();
  });
});
