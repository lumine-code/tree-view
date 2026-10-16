describe("Tree View directory service bootstrap", () => {
  let main, originalSortByBase, subscription;

  beforeEach(async () => {
    originalSortByBase = lumine.config.get("tree-view.sortByBase");
    await lumine.packages.deactivatePackage("tree-view");
    if (lumine.packages.getLoadedPackage("tree-view"))
      await lumine.packages.unloadPackage("tree-view");
    lumine.project.setPaths([]);
    main = (await lumine.packages.activatePackage("tree-view")).mainModule;
  });

  afterEach(async () => {
    subscription?.dispose();
    subscription = null;
    await lumine.packages.deactivatePackage("tree-view");
    if (originalSortByBase === undefined) lumine.config.unset("tree-view.sortByBase");
    else lumine.config.set("tree-view.sortByBase", originalSortByBase);
  });

  it("registers synchronous change notifications without loading directory readers or creating a tree", async () => {
    const before = new Set(Object.keys(require.cache));
    const changed = jasmine.createSpy("directory changed");
    const tree = spyOn(main, "getTreeViewInstance").and.throwError("Must not create the tree");
    subscription = main.provideTreeViewDirectory().onDidChange(changed);
    const newReaders = Object.keys(require.cache).filter(
      (file) =>
        !before.has(file) &&
        /[/\\]tree-view[/\\]lib[/\\].*(?:fs-compat|ignored-names|directory-filter|directory-reader|entry-sorting)\.js$/.test(
          file,
        ),
    );
    expect(newReaders).toEqual([]);
    expect(main.treeView).toBeUndefined();
    expect(tree).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();

    const sortByBase = lumine.config.get("tree-view.sortByBase");
    lumine.config.set("tree-view.sortByBase", !sortByBase);
    expect(changed).toHaveBeenCalledTimes(1);
    await lumine.packages.deactivatePackage("tree-view");
    lumine.config.set("tree-view.sortByBase", Boolean(sortByBase));
    expect(changed).toHaveBeenCalledTimes(1);
  });
});
