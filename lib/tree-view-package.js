const { Disposable, CompositeDisposable } = require("atom");

const TreeView = require("./tree-view");

module.exports = class TreeViewPackage {
  activate() {
    this.disposables = new CompositeDisposable();
    this.specialRootConfigs = [];
    this.disposables.add(
      atom.commands.add("atom-workspace", {
        "tree-view:show": () => this.getTreeViewInstance().show(),
        "tree-view:toggle": () => this.getTreeViewInstance().toggle(),
        "tree-view:toggle-focus": () => this.getTreeViewInstance().toggleFocus(),
        "tree-view:reveal-active-file": () =>
          this.getTreeViewInstance().revealActiveFile({ show: true }),
        "tree-view:add-file": () => this.getTreeViewInstance().add(true),
        "tree-view:add-folder": () => this.getTreeViewInstance().add(false),
        "tree-view:duplicate": () => this.getTreeViewInstance().copySelectedEntry(),
        "tree-view:remove": () => this.getTreeViewInstance().removeSelectedEntries(),
        "tree-view:rename": () => this.getTreeViewInstance().moveSelectedEntry(),
        "tree-view:toggle-side": () =>
          atom.config.set(
            "tree-view.showOnRightSide",
            !atom.config.get("tree-view.showOnRightSide"),
          ),
      }),
      // The setting was only read when the tree was opened, so changing it —
      // from the command, from the Settings view, or by hand — left an open
      // tree where it was until the next window.
      atom.config.onDidChange("tree-view.showOnRightSide", () =>
        this.getTreeViewInstance().moveToPreferredLocation(),
      ),
    );

    this.getTreeViewInstance();

    const openByDefault = async () => {
      if (atom.config.get("tree-view.hiddenOnStartup")) return;
      const showOnAttach = !atom.workspace.getActivePaneItem();
      await atom.workspace.open(this.getTreeViewInstance(), {
        searchAllPanes: true,
        activatePane: showOnAttach,
        activateItem: showOnAttach,
      });
      await this.getTreeViewInstance().show(false);
    };

    if (atom.packages.hasActivatedInitialPackages()) {
      this.treeViewOpenPromise = openByDefault();
    } else {
      this.treeViewOpenPromise = new Promise((resolve) => {
        this.disposables.add(
          atom.packages.onDidActivateInitialPackages(async () => {
            await openByDefault();
            resolve();
          }),
          // Deactivating before that event arrives — a spec run reaches it
          // every time — must not leave this pending: deactivate() awaits it
          // after disposing the subscription that would have resolved it, so
          // it would wait for something that can no longer happen.
          new Disposable(() => resolve()),
        );
      });
    }
  }

  async deactivate() {
    this.disposables.dispose();
    await this.treeViewOpenPromise; // Wait for Tree View to finish opening before destroying it
    if (this.treeView) this.treeView.destroy();
    this.treeView = null;
  }

  consumeOpenExternal(service) {
    this.openExternalService = service;
    if (this.treeView) this.treeView.openExternalService = service;
    return new Disposable(() => {
      this.openExternalService = null;
      if (this.treeView) this.treeView.openExternalService = null;
    });
  }

  consumeProjectList(projectList) {
    this.projectList = projectList;
    if (this.treeView) {
      this.treeView.projectList = projectList;
      if (this.treeView.addProjectsView) this.treeView.addProjectsView.setProjectList(projectList);
    }
    return new Disposable(() => {
      this.projectList = null;
      if (this.treeView) {
        this.treeView.projectList = null;
        if (this.treeView.addProjectsView) this.treeView.addProjectsView.setProjectList(null);
      }
    });
  }

  consumeRecentList(recentList) {
    this.recentList = recentList;
    if (this.treeView) {
      this.treeView.recentList = recentList;
      if (this.treeView.addProjectsView) this.treeView.addProjectsView.setRecentList(recentList);
    }
    return new Disposable(() => {
      this.recentList = null;
      if (this.treeView) {
        this.treeView.recentList = null;
        if (this.treeView.addProjectsView) this.treeView.addProjectsView.setRecentList(null);
      }
    });
  }

  consumeBusySignal(busySignal) {
    this.busySignal = busySignal;
    if (this.treeView) this.treeView.setBusySignal(busySignal);
    return new Disposable(() => {
      this.busySignal = null;
      if (this.treeView) this.treeView.setBusySignal(null);
    });
  }

  provideTreeViewSelection() {
    return {
      selectedPaths: () => this.getTreeViewInstance().selectedPaths(),
      entryForPath: (entryPath) => this.getTreeViewInstance().entryForPath(entryPath),
      revealPath: (filePath, options) => this.getTreeViewInstance().revealPath(filePath, options),
    };
  }

  provideTreeViewRoots() {
    return {
      registerRoot: (config) => {
        // Held by the registration, not by the section, so a pinned folder is
        // still open after the tree view is destroyed and re-created.
        const entry = { config, section: null, expansionStates: new Map() };
        this.specialRootConfigs.push(entry);
        if (this.treeView) {
          entry.section = this.treeView.addSpecialRoot(config, entry.expansionStates);
        }
        const handle = {
          get element() {
            return entry.section?.element ?? null;
          },
          update: () => entry.section?.refresh(),
          toggle: () => entry.section?.toggleVisible(),
          dispose: () => {
            const idx = this.specialRootConfigs.indexOf(entry);
            if (idx !== -1) this.specialRootConfigs.splice(idx, 1);
            if (entry.section && this.treeView) {
              this.treeView.removeSpecialRoot(entry.section);
            }
            entry.section = null;
          },
        };
        return handle;
      },
    };
  }

  reattachSpecialRoots() {
    if (!this.specialRootConfigs) return;
    for (const entry of this.specialRootConfigs) {
      entry.section = this.treeView.addSpecialRoot(entry.config, entry.expansionStates);
    }
  }

  getTreeViewInstance(state = {}) {
    if (this.treeView == null) {
      this.treeView = new TreeView(state);
      this.treeView.onDidDestroy(() => {
        this.treeView = null;
      });
      if (this.openExternalService) this.treeView.openExternalService = this.openExternalService;
      if (this.busySignal) this.treeView.setBusySignal(this.busySignal);
      if (this.projectList) {
        this.treeView.projectList = this.projectList;
        if (this.treeView.addProjectsView)
          this.treeView.addProjectsView.setProjectList(this.projectList);
      }
      if (this.recentList) {
        this.treeView.recentList = this.recentList;
        if (this.treeView.addProjectsView)
          this.treeView.addProjectsView.setRecentList(this.recentList);
      }
      this.reattachSpecialRoots();
    }
    return this.treeView;
  }
};
