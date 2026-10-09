const { Disposable, CompositeDisposable } = require("lumine");

const TreeView = require("./tree-view");
const FileOperationEvents = require("./file-operation-events");

module.exports = class TreeViewPackage {
  provideBackgroundTips() {
    return {
      packageName: "tree-view",
      tips: [
        "You can focus the Tree View without reaching for the mouse using {{ 'tree-view:toggle-focus' | keystroke }}",
        "You can reveal the file you are editing in the Tree View with {{ 'tree-view:reveal-active-file' | keystroke }}",
      ],
    };
  }

  activate() {
    this.disposables = new CompositeDisposable();
    this.serviceConnections = new Map();
    this.specialRootConfigs = [];
    this.fileOperationEvents = new FileOperationEvents();
    this.disposables.add(
      lumine.commands.add("lumine-workspace", {
        "tree-view:show": () => this.getTreeViewInstance().show(),
        "tree-view:toggle": () => this.getTreeViewInstance().toggle(),
        "tree-view:toggle-focus": () => this.getTreeViewInstance().toggleFocus(),
        "tree-view:reveal-active-file": {
          description: "Expand the tree to the active file and select it there.",
          didDispatch: () => this.getTreeViewInstance().revealActiveFile({ show: true }),
        },
        "tree-view:add-file": {
          description: "Create a file beside the selection.",
          didDispatch: () => this.getTreeViewInstance().add(true),
        },
        "tree-view:add-folder": {
          description: "Create a folder beside the selection.",
          didDispatch: () => this.getTreeViewInstance().add(false),
        },
        "tree-view:duplicate": {
          description: "Copy the selected entry to a name you choose.",
          didDispatch: () => this.getTreeViewInstance().copySelectedEntry(),
        },
        "tree-view:remove": {
          description: "Move the selected entries to the system trash, after asking.",
          didDispatch: () => this.getTreeViewInstance().removeSelectedEntries(),
        },
        "tree-view:rename": {
          description: "Rename the selected entry, or move it to another folder.",
          didDispatch: () => this.getTreeViewInstance().moveSelectedEntry(),
        },
        "tree-view:pause-queue": {
          description: "Pause the file operation queue after the current operation finishes.",
          didDispatch: () => this.getTreeViewInstance().pauseOperationQueue(),
        },
        "tree-view:resume-queue": {
          description: "Resume the paused file operation queue.",
          didDispatch: () => this.getTreeViewInstance().resumeOperationQueue(),
        },
        "tree-view:clear-queue": {
          description: "Cancel every file operation that has not started.",
          didDispatch: () => this.getTreeViewInstance().clearOperationQueue(),
        },
        "tree-view:toggle-side": {
          description: "Move the tree between the left and the right of the window.",
          didDispatch: () =>
            lumine.config.set(
              "tree-view.showOnRightSide",
              !lumine.config.get("tree-view.showOnRightSide"),
            ),
        },
      }),
      // The setting was only read when the tree was opened, so changing it —
      // from the command, from the Settings view, or by hand — left an open
      // tree where it was until the next window.
      lumine.config.onDidChange("tree-view.showOnRightSide", () =>
        this.getTreeViewInstance().moveToPreferredLocation(),
      ),
    );

    const activation = this.disposables;
    const openByDefault = async () => {
      if (
        this.disposables !== activation ||
        activation.disposed ||
        lumine.config.get("tree-view.hiddenOnStartup")
      )
        return;
      const showOnAttach = !lumine.workspace.getActivePaneItem();
      const tree = this.getTreeViewInstance();
      await lumine.workspace.open(tree, {
        searchAllPanes: true,
        activatePane: showOnAttach,
        activateItem: showOnAttach,
      });
      if (
        this.disposables !== activation ||
        activation.disposed ||
        this.treeView !== tree ||
        tree.destroyed
      )
        return;
      await tree.show(false);
    };

    if (lumine.packages.hasActivatedInitialPackages()) {
      this.treeViewOpenPromise = openByDefault();
    } else {
      this.treeViewOpenPromise = new Promise((resolve) => {
        this.disposables.add(
          lumine.packages.onDidActivateInitialPackages(async () => {
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
    const disposables = this.disposables;
    const serviceConnections = this.serviceConnections;
    const tree = this.treeView;
    const opened = this.treeViewOpenPromise;
    this.disposables = null;
    this.serviceConnections = null;
    this.treeView = null;
    for (const field of ["openExternalService", "projectList", "recentList", "busySignal"])
      this[field] = null;
    serviceConnections.clear();
    if (tree) {
      tree.openExternalService = null;
      tree.projectList = null;
      tree.recentList = null;
      tree.addProjectsView?.setProjectList(null);
      tree.addProjectsView?.setRecentList(null);
      tree.setBusySignal(null);
    }
    disposables.dispose();
    await opened; // Wait for this activation's opening before destroying its view.
    if (tree) await tree.destroy();
  }

  consumeOpenExternal(service) {
    return this.consumeService("openExternalService", service);
  }

  consumeProjectList(projectList) {
    return this.consumeService("projectList", projectList);
  }

  consumeRecentList(recentList) {
    return this.consumeService("recentList", recentList);
  }

  consumeBusySignal(busySignal) {
    return this.consumeService("busySignal", busySignal);
  }

  consumeService(field, service) {
    const disposables = this.disposables;
    if (!disposables || disposables.disposed) return new Disposable();
    let connections = this.serviceConnections.get(field);
    if (!connections) this.serviceConnections.set(field, (connections = new Set()));
    const record = { service };
    connections.add(record);
    this.setService(field, service);
    const lease = new Disposable(() => {
      connections.delete(record);
      disposables.remove(lease);
      if (this.disposables === disposables)
        this.setService(field, Array.from(connections).at(-1)?.service ?? null);
    });
    disposables.add(lease);
    return lease;
  }

  setService(field, service) {
    if (this[field] === service) return;
    this[field] = service;
    const tree = this.treeView;
    if (!tree) return;
    if (field === "busySignal") tree.setBusySignal(service);
    else tree[field] = service;
    if (field === "projectList") tree.addProjectsView?.setProjectList(service);
    if (field === "recentList") tree.addProjectsView?.setRecentList(service);
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

  provideTreeViewFileOperations() {
    return this.fileOperationEvents.service();
  }

  reattachSpecialRoots() {
    if (!this.specialRootConfigs) return;
    for (const entry of this.specialRootConfigs) {
      entry.section = this.treeView.addSpecialRoot(entry.config, entry.expansionStates);
    }
  }

  getTreeViewInstance(state) {
    if (this.treeView == null) {
      this.treeView = new TreeView(state ?? {});
      this.treeView.fileOperationEvents = this.fileOperationEvents;
      const tree = this.treeView;
      tree.onDidDestroy(() => {
        if (this.treeView === tree) this.treeView = null;
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
    } else if (state != null) {
      // Initial package activation opens this persistent dock item before the
      // workspace restores its layout. Its deserializer therefore receives
      // the existing instance: apply the saved state while the workspace has
      // it detached, before that same instance is mounted again.
      this.treeView.restoreState(state);
    }
    return this.treeView;
  }
};
