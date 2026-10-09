const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

describe("Tree View native lifetime and service ownership", () => {
  let main, hub, leases, directory, trees, teardowns;
  const drain = () => new Promise((resolve) => setTimeout(resolve, 100));
  beforeEach(async () => {
    jasmine.useRealClock();
    for (const name of ["openPath", "openExternal", "openApplication", "showItemInFolder"])
      spyOn(lumine.shell, name).and.resolveTo();
    spyOn(lumine.application, "openWindow").and.resolveTo();
    await lumine.packages.deactivatePackage("tree-view");
    if (lumine.packages.getLoadedPackage("tree-view"))
      await lumine.packages.unloadPackage("tree-view");
    directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tree-owned-lifetime-")));
    for (const name of ["first", "second"]) fs.mkdirSync(path.join(directory, name));
    leases = [];
    trees = [];
    teardowns = [];
    lumine.project.setPaths([]);
    lumine.config.set("tree-view.hiddenOnStartup", true);
    main = (await lumine.packages.activatePackage("tree-view")).mainModule;
    hub = new lumine.packages.serviceHub.constructor();
    jasmine.attachToDOM(lumine.workspace.getElement());
  });
  afterEach(async () => {
    leases.forEach((lease) => lease.dispose());
    await lumine.packages.deactivatePackage("tree-view");
    await Promise.allSettled(teardowns);
    // A red original may allocate roots after its view was already destroyed.
    for (const tree of trees) for (const root of tree.roots) root.directory.destroy();
    lumine.project.setPaths([]);
    await lumine.fileWatchClient.settlePendingTeardown();
    const relative = path.relative(fs.realpathSync(os.tmpdir()), directory);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("Unsafe owned Tree View cleanup");
    fs.rmSync(directory, { recursive: true, force: true });
  });
  function tree() {
    const view = main.getTreeViewInstance();
    trees.push(view);
    return view;
  }
  function consume(service, method) {
    const lease = hub.consume(service, "^1.0.0", (payload) => main[method](payload));
    leases.push(lease);
    return lease;
  }
  const services = [
    ["open-external", "consumeOpenExternal", "openExternalService"],
    ["project-list", "consumeProjectList", "projectList"],
    ["recent-list", "consumeRecentList", "recentList"],
    ["busy-signal", "consumeBusySignal", "busySignal"],
  ];
  for (const [service, method, field] of services) {
    it(`retains the shared ${service} payload when one native connection retires`, () => {
      const view = tree();
      const payload = { toggle() {}, create() {} };
      const first = consume(service, method);
      consume(service, method);
      leases.push(hub.provide(service, "1.0.0", payload));
      expect(main[field]).toBe(payload);
      expect(view[field]).toBe(payload);
      first.dispose();
      expect(main[field]).toBe(payload);
      expect(view[field]).toBe(payload);
    });

    it(`restores the previous ${service} connection and retires manual leases with the package`, async () => {
      const view = tree();
      const first = { toggle() {}, create() {} };
      const second = { toggle() {}, create() {} };
      const old = main[method](first);
      leases.push(old);
      const newest = main[method](second);
      leases.push(newest);
      expect(view[field]).toBe(second);
      newest.dispose();
      expect(main[field]).toBe(first);
      expect(view[field]).toBe(first);
      await lumine.packages.deactivatePackage("tree-view");
      expect(main[field]).toBeNull();
      main = (await lumine.packages.activatePackage("tree-view")).mainModule;
      leases.push(main[method](first));
      const replacement = tree();
      old.dispose();
      expect(main[field]).toBe(first);
      expect(replacement[field]).toBe(first);
    });
  }

  it("cancels a pending native project refresh and permits a fresh live dock view", async () => {
    lumine.project.setPaths([path.join(directory, "first")]);
    const view = tree();
    await view.show();
    const refresh = spyOn(view, "updateRoots").and.callThrough();
    const allocate = spyOn(view, "createDirectoryTreeEntry").and.callThrough();
    lumine.project.setPaths([path.join(directory, "second")]);
    await lumine.workspace.paneForItem(view).destroyItem(view);
    await drain();
    expect(refresh).not.toHaveBeenCalled();
    expect(allocate).not.toHaveBeenCalled();
    expect(main.treeView).toBeNull();
    lumine.commands.dispatch(lumine.workspace.getElement(), "tree-view:toggle-focus");
    const replacement = main.treeView;
    trees.push(replacement);
    expect(replacement).not.toBe(view);
    expect(replacement.roots.map((root) => root.getPath())).toEqual([
      path.join(directory, "second"),
    ]);
    await replacement.show();
    expect(lumine.workspace.paneForItem(replacement)).toBeDefined();
  });

  it("ignores the retired folder picker result and accepts a live picker result", async () => {
    const pending = [];
    spyOn(lumine.window, "pickFolder").and.callFake(
      () => new Promise((resolve) => pending.push(resolve)),
    );
    const view = tree();
    await view.show();
    view.addProjectsView.addProjectsButton.click();
    expect(pending.length).toBe(1);
    await lumine.workspace.paneForItem(view).destroyItem(view);
    pending.shift()([path.join(directory, "first")]);
    await drain();
    expect(lumine.project.getPaths()).toEqual([]);
    lumine.project.setPaths([]);
    const replacement = tree();
    await replacement.show();
    replacement.addProjectsView.addProjectsButton.click();
    pending.shift()([path.join(directory, "second")]);
    await drain();
    expect(lumine.project.getPaths()).toEqual([path.join(directory, "second")]);
    expect(replacement.roots[0].getPath()).toBe(path.join(directory, "second"));
  });

  it("preserves a new bootstrap reached through actual busy-provider disposal", async () => {
    const busy = (
      await lumine.packages.activatePackage("busy-signal")
    ).mainModule.provideBusySignal();
    const view = tree();
    const provider = busy.create();
    view.operationBusyProvider = provider;
    const payload = { toggle() {} };
    let replacement;
    leases.push(
      provider.onDidDispose(() => {
        view.destroy();
        main.activate();
        leases.push(main.consumeRecentList(payload));
        replacement = tree();
      }),
    );
    let settled = false;
    const teardown = main.deactivate().then(() => (settled = true));
    teardowns.push(teardown);
    await Promise.race([teardown, drain()]);
    expect(settled).toBe(true);
    expect(replacement).toBeDefined();
    expect(main.treeView).toBe(replacement);
    expect(replacement.destroyed).not.toBe(true);
    expect(main.recentList).toBe(payload);
    expect(replacement.recentList).toBe(payload);
    expect(main.serviceConnections?.get("recentList")?.size).toBe(1);
    await replacement.show();
    expect(lumine.workspace.paneForItem(replacement)).toBeDefined();
  });
});
