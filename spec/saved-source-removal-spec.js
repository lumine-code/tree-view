const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
describe("Saved document file removal", () => {
  let tree, editor, directory, file, extra, main;
  beforeEach(async () => {
    // Earlier lifecycle specs can unload the package and retire its constructors.
    const TreeView = require("../lib/tree-view");
    jasmine.attachToDOM(lumine.workspace.getElement());
    directory = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "tree-source-remove-")),
    );
    // Use a settled file so fresh-file metadata updates do not race the preflight.
    file = path.join(__dirname, "fixtures", "saved-source.txt");
    lumine.project.setPaths([]);
    editor = await lumine.workspace.open(file, { opener: "text-editor" });
    tree = new TreeView({});
    lumine.config.set("tree-view.confirmDelete", false);
    spyOn(lumine.shell, "trashItem").and.resolveTo();
  });
  afterEach(async () => {
    await main?.deactivate();
    main = null;
    await lumine.workspace.discardEditorWindows();
    extra = null;
    editor?.destroy();
    await tree?.destroy();
    await lumine.fileWatchClient.settlePendingTeardown();
    const parent = fs.realpathSync.native(os.tmpdir()),
      relative = path.relative(parent, directory);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
      throw Error("Fixture escaped scratch");
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  it("reveals the source from the invoking editor window", async () => {
    const TreeViewPackage = require("../lib/tree-view-package");
    lumine.project.setPaths([directory]);
    extra = await lumine.workspace.openEditorWindow({ show: false });
    const secondary = lumine.workspace.buildTextEditor();
    secondary.getBuffer().setPath(path.join(directory, "secondary.txt"));
    extra.getEditorContainer().getActivePane().activateItem(secondary, { activatePane: true });
    lumine.workspace.paneForItem(editor).activate();
    main = new TreeViewPackage();
    main.initialize();
    main.activate();
    const revealPath = jasmine.createSpy("reveal actual source").and.resolveTo();
    spyOn(main, "getTreeViewInstance").and.returnValue({
      revealPath,
      revealActiveFile: (options) => revealPath(editor.getPath(), options),
    });
    expect(lumine.commands.canDispatch(extra.getElement(), "tree-view:reveal-active-file")).toBe(
      true,
    );
    await lumine.commands.dispatch(extra.getElement(), "tree-view:reveal-active-file");
    expect(revealPath).toHaveBeenCalledOnceWith(secondary.getPath(), { show: true });
  });
  it("does not offer reveal with no project root", async () => {
    const TreeViewPackage = require("../lib/tree-view-package");
    main = new TreeViewPackage();
    main.initialize();
    main.activate();
    expect(lumine.commands.canDispatch(editor.getElement(), "tree-view:reveal-active-file")).toBe(
      false,
    );
    lumine.project.setPaths([path.dirname(file)]);
    expect(lumine.commands.canDispatch(editor.getElement(), "tree-view:reveal-active-file")).toBe(
      true,
    );
  });
  it("removes the saved file even when no tree entry was materialized", async () => {
    const contents = fs.readFileSync(file, "utf8");
    expect(tree.treeEntryForPath(file)).toBeNull();
    await tree.removeSelectedEntries({ target: editor.getElement() });
    expect(lumine.shell.trashItem).toHaveBeenCalledOnceWith(file);
    expect(fs.readFileSync(file, "utf8")).toBe(contents);
  });
});
