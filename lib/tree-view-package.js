const { Disposable, CompositeDisposable, Emitter } = require("lumine");
const { EMPTY_SELECTION } = require("./selection-snapshot");

let TreeView;
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

  initialize() {
    this.selectionEvents = new Emitter();
    this.disposables = new CompositeDisposable();
    this.serviceConnections = new Map();
    this.specialRootConfigs = [];
    this.fileOperationEvents = new FileOperationEvents();
  }

  activate() {
    this.disposables.add(
      lumine.commands.add("lumine-workspace", {
        "tree-view:show": () => this.getTreeViewInstance().show(),
        "tree-view:toggle": () => this.getTreeViewInstance().toggle(),
        "tree-view:toggle-focus": () => this.getTreeViewInstance().toggleFocus(),
        "tree-view:reveal-active-file": {
          description: "Expand the tree to the active file and select it there.",
          isAvailable: (event) =>
            Boolean(this.sourcePathForEvent(event)) && lumine.project.getPaths().length > 0,
          didDispatch: (event) => {
            const path = this.sourcePathForEvent(event);
            if (path) return this.getTreeViewInstance().revealPath(path, { show: true });
          },
        },
        "tree-view:add-file": {
          description: "Create a file beside the selection.",
          didDispatch: (event) => this.getTreeViewInstance().add(true, event),
        },
        "tree-view:add-folder": {
          description: "Create a folder beside the selection.",
          didDispatch: () => this.getTreeViewInstance().add(false),
        },
        "tree-view:duplicate": {
          description: "Copy the selected entry to a name you choose.",
          isAvailable: (event) => this.canOperateOnSource(event),
          didDispatch: (event) => this.getTreeViewInstance().copySelectedEntry(event),
        },
        "tree-view:remove": {
          description: "Move the selected entries to the system trash, after asking.",
          isAvailable: (event) => this.canOperateOnSource(event, { remove: true }),
          didDispatch: (event) => this.getTreeViewInstance().removeSelectedEntries(event),
        },
        "tree-view:rename": {
          description: "Rename the selected entry, or move it to another folder.",
          isAvailable: (event) => this.canOperateOnSource(event),
          didDispatch: (event) => this.getTreeViewInstance().moveSelectedEntry(event),
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

    this.disposables.add(lumine.workspace.addDefaultDockItem(() => this.getTreeViewInstance()));
  }

  async deactivate() {
    const disposables = this.disposables;
    const serviceConnections = this.serviceConnections;
    const tree = this.treeView;
    this.disposables = null;
    this.serviceConnections = null;
    this.treeView = null;
    for (const field of ["projectList", "recentList", "busySignal", "launcher"]) this[field] = null;
    serviceConnections.clear();
    if (tree) {
      tree.projectList = null;
      tree.recentList = null;
      tree.launcher = null;
      tree.addProjectsView?.setProjectList(null);
      tree.addProjectsView?.setRecentList(null);
      tree.setBusySignal(null);
    }
    disposables.dispose();
    this.selectionEvents.dispose();
    if (tree) await tree.destroy();
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

  consumeLauncher(launcher) {
    return this.consumeService("launcher", launcher);
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
    const owner = this.disposables;
    const events = this.selectionEvents;
    return {
      getSelectionSnapshot: () =>
        this.disposables === owner && !owner.disposed
          ? (this.treeView?.getSelectionSnapshot() ?? EMPTY_SELECTION)
          : EMPTY_SELECTION,
      onDidChangeSelection: (callback) =>
        owner.disposed ? new Disposable() : events.on("did-change", callback),
      selectedPaths: () => this.getTreeViewInstance().selectedPaths(),
      entryForPath: (entryPath) => this.getTreeViewInstance().entryForPath(entryPath),
      revealPath: (filePath, options) => this.getTreeViewInstance().revealPath(filePath, options),
    };
  }

  sourcePathForEvent(event) {
    const item = event.target?.closest?.(".tab")?.item ?? event.context?.documentItem;
    return item?.isDestroyed?.() ? null : (item?.getPath?.() ?? null);
  }

  canOperateOnSource(event, { remove = false } = {}) {
    if (event.target?.closest?.(".tree-view")) {
      const snapshot = this.treeView?.getSelectionSnapshot() ?? EMPTY_SELECTION;
      return remove
        ? snapshot.removableCount > 0
        : Boolean(snapshot.primary && !snapshot.primary.projectRoot);
    }
    const path = this.sourcePathForEvent(event);
    return Boolean(path && !lumine.project.getPaths().includes(path));
  }

  provideTreeViewDirectory() {
    return {
      listFiles: (directoryPath) => require("./directory-listing").listFiles(directoryPath),
      onDidChange: (callback) => {
        const disposables = this.disposables;
        if (!disposables || disposables.disposed) return new Disposable();
        const subscription = require("./directory-listing").onDidChange(callback);
        const lease = new Disposable(() => {
          disposables.remove(lease);
          subscription.dispose();
        });
        disposables.add(lease);
        return lease;
      },
      watchDirectory: (directoryPath, callback) => {
        const disposables = this.disposables;
        if (!disposables || disposables.disposed) {
          return { ready: Promise.resolve(), dispose() {} };
        }
        const subscription = require("./directory-listing").watchDirectory(directoryPath, callback);
        const lease = new Disposable(() => {
          disposables.remove(lease);
          subscription.dispose();
        });
        lease.ready = subscription.ready;
        disposables.add(lease);
        return lease;
      },
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
      TreeView ||= require("./tree-view");
      this.treeView = new TreeView(state ?? {});
      this.treeView.fileOperationEvents = this.fileOperationEvents;
      this.treeView.launcher = this.launcher;
      const tree = this.treeView;
      tree.onDidChangeSelection((snapshot) => this.selectionEvents.emit("did-change", snapshot));
      tree.onDidDestroy(() => {
        if (this.treeView === tree) this.treeView = null;
      });
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
      // A command or service may create the persistent item before the
      // workspace restores its layout. Apply saved state to that same
      // instance while the workspace has it detached.
      this.treeView.restoreState(state);
    }
    return this.treeView;
  }
};
