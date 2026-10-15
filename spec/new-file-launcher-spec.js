const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");

describe("Tree View new file Launcher integration", () => {
  let main, launcher, tree, AddDialog, fsCompat, observeDialog, openLauncher, openWorkspace;
  let directory, temporary, previousPaths, previousHidden, pane, otherPane, first, second;
  let dialogs, leases, gates, passiveBeforeActivation;

  beforeEach(async () => {
    jasmine.useRealClock();
    previousPaths = lumine.project.getPaths();
    previousHidden = lumine.config.get("tree-view.hiddenOnStartup");
    for (const name of ["tree-view", "launcher"])
      if (lumine.packages.isPackageLoaded(name)) await lumine.packages.unloadPackage(name);
    temporary = fs.realpathSync.native(os.tmpdir());
    directory = fs.realpathSync.native(
      fs.mkdtempSync(path.join(temporary, "tree-new-file-launcher-")),
    );
    dialogs = [];
    leases = [];
    gates = [];
    lumine.project.setPaths([directory]);
    lumine.config.set("tree-view.hiddenOnStartup", true);
    jasmine.attachToDOM(lumine.workspace.getElement());
    first = await lumine.workspace.open();
    pane = lumine.workspace.paneForItem(first);
    otherPane = pane.splitRight();
    second = await lumine.workspace.open(undefined, { pane: otherPane, pending: false });
    pane.activate();

    const pack = await lumine.packages.activatePackage("tree-view");
    main = pack.mainModule;
    const currentRequire = createRequire(path.join(pack.path, "package.json"));
    AddDialog = currentRequire("./lib/add-dialog");
    fsCompat = currentRequire("./lib/fs-compat");
    tree = main.getTreeViewInstance();
    await tree.show();
    passiveBeforeActivation =
      !lumine.packages.isPackageActive("launcher") && !main.launcher && !tree.launcher;
    launcher = (await lumine.packages.activatePackage("launcher")).mainModule;
    pane.activate();
    observeDialog = spyOn(tree, "observeOperationDialog").and.callThrough();
    openLauncher = spyOn(main.launcher, "open").and.callThrough();
    openWorkspace = spyOn(lumine.workspace, "open").and.callThrough();
    spyOn(lumine.workspace.getMainWindow(), "showOpenDialog").and.resolveTo({
      canceled: true,
      filePaths: [],
    });
  });

  afterEach(async () => {
    for (const dialog of dialogs) dialog.cancel();
    for (const gate of gates) gate.resolve(true);
    await Promise.allSettled(dialogs.map((dialog) => dialog.confirmPromise));
    for (const dialog of dialogs) await dialog.inputDialogHost.destroy();
    for (const lease of leases) lease.dispose();
    await lumine.packages.unloadPackage("launcher");
    await lumine.packages.unloadPackage("tree-view");
    for (const editor of lumine.workspace.getTextEditors())
      if (
        editor === first ||
        editor === second ||
        editor.getPath()?.startsWith(directory + path.sep)
      )
        editor.destroy();
    if (otherPane && !otherPane.isDestroyed()) await otherPane.destroy();
    lumine.project.setPaths(previousPaths);
    lumine.config.set("tree-view.hiddenOnStartup", previousHidden);
    await lumine.fileWatchClient.settlePendingTeardown();
    if (path.dirname(fs.realpathSync.native(directory)) !== temporary)
      throw new Error("New file Launcher cleanup escaped the private temporary root");
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  function deferred() {
    let resolve;
    const promise = new Promise((done) => (resolve = done));
    const gate = { promise, resolve };
    gates.push(gate);
    return gate;
  }

  async function addFile(name) {
    await lumine.commands.dispatch(first.getElement(), "tree-view:add-file");
    const dialog = observeDialog.calls.mostRecent().args[0];
    dialogs.push(dialog);
    expect(dialog instanceof AddDialog).toBe(true);
    await conditionPromise(() => dialog.inputDialogHost.isVisible());
    dialog.miniEditor.setText(name);
    spyOn(dialog, "confirm").and.callThrough();
    return dialog;
  }

  function sendAltEnter(dialog) {
    const input = dialog.miniEditor.getElement();
    expect(
      lumine.keymaps.findKeyBindings({ target: input, keystrokes: "alt-enter" })[0]?.command,
    ).toBe("tree-view:confirm-and-open-via-launcher");
    input.focus();
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, "target", { get: () => input });
    Object.defineProperty(event, "path", { get: () => [input] });
    lumine.keymaps.handleKeyboardEvent(event);
  }

  async function altEnter(dialog) {
    const previousCalls = dialog.confirm.calls.count();
    sendAltEnter(dialog);
    await conditionPromise(() => dialog.confirm.calls.count() > previousCalls);
    return { confirmation: dialog.confirm.calls.mostRecent().returnValue };
  }

  function expectNoOpening(filePath) {
    expect(openLauncher).not.toHaveBeenCalled();
    expect(launcher.pickers.size).toBe(0);
    expect(openWorkspace.calls.allArgs().some(([target]) => target === filePath)).toBe(false);
    expect(lumine.workspace.getMainWindow().showOpenDialog).not.toHaveBeenCalled();
  }

  it("passively connects the real Launcher service to an already created tree", () => {
    expect(passiveBeforeActivation).toBe(true);
    expect(main.launcher).toBeDefined();
    expect(tree.launcher).toBe(main.launcher);
    expect(typeof tree.launcher.open).toBe("function");
  });

  it("creates once on repeated Alt+Enter and keeps the invocation pane through asynchronous preparation", async () => {
    const gate = deferred();
    const will = jasmine.createSpy("will create file").and.returnValue(gate.promise);
    const did = jasmine.createSpy("created file");
    const operations = main.provideTreeViewFileOperations();
    leases.push(operations.onWillCreateFiles(will), operations.onDidCreateFiles(did));
    const filePath = path.join(directory, "chosen.txt");
    const write = spyOn(fsCompat, "writeFileSync").and.callThrough();
    const dialog = await addFile("chosen.txt");

    const { confirmation } = await altEnter(dialog);
    sendAltEnter(dialog);
    expect(dialog.confirmPromise).toBe(confirmation);
    expect(will).toHaveBeenCalledTimes(1);
    otherPane.activate();
    expect(lumine.workspace.getCenter().getActivePane()).toBe(otherPane);
    expectNoOpening(filePath);
    gate.resolve(true);
    await confirmation;
    await conditionPromise(() =>
      launcher.pickers.get(pane.getContainer().getWindow())?.host.isVisible(),
    );

    const picker = launcher.pickers.get(pane.getContainer().getWindow());
    expect(openLauncher).toHaveBeenCalledOnceWith({ path: filePath, pane });
    expect(picker.context.path).toBe(filePath);
    expect(picker.context.pane).toBe(pane);
    expect(
      picker.host
        .getModel()
        .getItems()
        .some((item) => item.id === "text-editor"),
    ).toBe(true);
    expect(write.calls.allArgs().filter(([target]) => target === filePath).length).toBe(1);
    expect(did).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(filePath, "utf8")).toBe("");
    expect(openWorkspace.calls.allArgs().some(([target]) => target === filePath)).toBe(false);
    expect(lumine.workspace.getMainWindow().showOpenDialog).not.toHaveBeenCalled();

    await picker.host.getModel().confirmSelection();

    expect(pane.getItems().some((item) => item.getPath?.() === filePath)).toBe(true);
    expect(otherPane.getItems().some((item) => item.getPath?.() === filePath)).toBe(false);
    expect(openWorkspace.calls.allArgs().find(([target]) => target === filePath)[1].opener).toBe(
      "text-editor",
    );
  });

  for (const changedQuery of [false, true])
    it(`discards a late preparation after ${changedQuery ? "the filename changes" : "cancellation"}`, async () => {
      const gate = deferred();
      const will = jasmine.createSpy("will create file").and.returnValue(gate.promise);
      leases.push(main.provideTreeViewFileOperations().onWillCreateFiles(will));
      const filePath = path.join(directory, "cancelled.txt");
      const dialog = await addFile("cancelled.txt");
      const { confirmation } = await altEnter(dialog);
      const signal = will.calls.mostRecent().args[0].signal;

      if (changedQuery) dialog.miniEditor.setText("replacement.txt");
      else dialog.inputDialogHost.cancel();
      gate.resolve(true);
      await confirmation;

      expect(signal.aborted).toBe(true);
      expect(fs.existsSync(filePath)).toBe(false);
      expect(fs.existsSync(path.join(directory, "replacement.txt"))).toBe(false);
      expectNoOpening(filePath);
    });

  it("keeps an existing file intact and leaves validation in the creation dialog", async () => {
    const filePath = path.join(directory, "existing.txt");
    fs.writeFileSync(filePath, "preserve me");
    const dialog = await addFile("existing.txt");

    const { confirmation } = await altEnter(dialog);
    await confirmation;

    expect(dialog.inputDialogHost.isVisible()).toBe(true);
    expect(dialog.inputDialog.getStatus().message).toContain("already exists");
    expect(fs.readFileSync(filePath, "utf8")).toBe("preserve me");
    expectNoOpening(filePath);
  });

  it("does not create a file or show Launcher when preparation vetoes creation", async () => {
    leases.push(main.provideTreeViewFileOperations().onWillCreateFiles(() => false));
    const filePath = path.join(directory, "vetoed.txt");
    const dialog = await addFile("vetoed.txt");

    const { confirmation } = await altEnter(dialog);
    await confirmation;

    expect(dialog.inputDialogHost.isVisible()).toBe(true);
    expect(fs.existsSync(filePath)).toBe(false);
    expectNoOpening(filePath);
  });
});
