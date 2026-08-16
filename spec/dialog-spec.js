const fs = require("fs");
const os = require("os");
const path = require("path");
const fsCompat = require("../lib/fs-compat");
const AddDialog = require("../lib/add-dialog");
const MoveDialog = require("../lib/move-dialog");
const CopyDialog = require("../lib/copy-dialog");

describe("TreeView dialogs", () => {
  let projectPath;
  let dialogs;

  beforeEach(() => {
    projectPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tree-view-dialog-")));
    lumine.project.setPaths([projectPath]);
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    dialogs = [];
  });

  afterEach(() => {
    for (const dialog of dialogs) {
      try {
        dialog.inputDialogView.destroy();
      } catch {
        // already destroyed by a confirm/cancel
      }
    }
    // Retries because Windows keeps a directory non-empty until the last handle on a child
    // closes, and `force` swallows only ENOENT.
    fs.rmSync(projectPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  function track(dialog) {
    dialogs.push(dialog);
    return dialog;
  }

  function fixture(name, contents = "") {
    const full = path.join(projectPath, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
    return full;
  }

  describe("AddDialog", () => {
    it("renders the prompt in the header and creates a file", () => {
      const dialog = track(new AddDialog(projectPath, true));
      dialog.attach();

      const header = dialog.inputDialogView.element.querySelector("label.icon");
      expect(header.textContent).toContain("file");
      expect(dialog.inputDialogView.refs.infoMessage.textContent).toContain(
        "relative to the project root",
      );

      let created = null;
      dialog.onDidCreateFile((createdPath) => (created = createdPath));
      dialog.miniEditor.setText("newfile.txt");
      dialog.onConfirm(dialog.miniEditor.getText());

      expect(created).toBe(path.join(projectPath, "newfile.txt"));
      expect(fs.existsSync(created)).toBe(true);
    });

    it("places the caret after the default path for new files and folders", () => {
      const directory = path.join(projectPath, "nested");
      fs.mkdirSync(directory);
      const initialText = `nested${path.sep}`;

      for (const isCreatingFile of [true, false]) {
        const dialog = track(new AddDialog(directory, isCreatingFile));
        dialog.attach();

        expect(dialog.miniEditor.getText()).toBe(initialText);
        expect(dialog.miniEditor.getSelectedText()).toBe("");
        expect(dialog.miniEditor.getCursorBufferPosition()).toEqual([0, initialText.length]);
        dialog.inputDialogView.destroy();
      }
    });

    it("shows an error when the target already exists", async () => {
      fixture("exists.txt");
      const dialog = track(new AddDialog(projectPath, true));
      dialog.attach();
      dialog.miniEditor.setText("exists.txt");
      dialog.onConfirm(dialog.miniEditor.getText());

      await dialog.inputDialogView.constructor.getScheduler().getNextUpdatePromise();
      const status = dialog.inputDialogView.refs.statusMessage;
      expect(status.textContent).toContain("already exists");
      expect(status.classList.contains("text-error")).toBe(true);
    });

    it("clears the error once the name changes", async () => {
      fixture("exists.txt");
      const dialog = track(new AddDialog(projectPath, true));
      dialog.attach();
      dialog.miniEditor.setText("exists.txt");
      dialog.onConfirm(dialog.miniEditor.getText());
      await dialog.inputDialogView.constructor.getScheduler().getNextUpdatePromise();
      expect(dialog.inputDialogView.refs.statusMessage).toBeDefined();

      dialog.miniEditor.setText("fresh.txt");
      await dialog.inputDialogView.constructor.getScheduler().getNextUpdatePromise();
      expect(dialog.inputDialogView.refs.statusMessage).toBeUndefined();
    });
  });

  describe("MoveDialog", () => {
    function selectionOf(source) {
      const dialog = track(new MoveDialog(source, {}));
      dialog.attach();
      return dialog.miniEditor.getSelectedText();
    }

    it("selects the base name and leaves the last extension alone", () => {
      expect(selectionOf(fixture("old.txt"))).toBe("old");
      expect(selectionOf(fixture("dialog.spec.js"))).toBe("dialog.spec");
      expect(selectionOf(fixture("archive.tar.gz"))).toBe("archive.tar");
    });

    it("selects the whole name when there is no extension to preserve", () => {
      expect(selectionOf(fixture("Makefile"))).toBe("Makefile");
      expect(selectionOf(fixture(".gitignore"))).toBe(".gitignore");

      const directory = path.join(projectPath, "v1.2");
      fs.mkdirSync(directory);
      expect(selectionOf(directory)).toBe("v1.2");
    });

    it("selects the base name only, not the directory prefix", () => {
      const source = fixture(`nested${path.sep}old.txt`);
      const dialog = track(new MoveDialog(source, {}));
      dialog.attach();

      expect(dialog.miniEditor.getText()).toBe(`nested${path.sep}old.txt`);
      expect(dialog.miniEditor.getSelectedBufferRange()).toEqual([
        [0, `nested${path.sep}`.length],
        [0, `nested${path.sep}old`.length],
      ]);
    });

    it("moves the entry and reports the move", async () => {
      const source = fixture("old.txt", "content");
      let moved = null;
      const dialog = track(
        new MoveDialog(source, {
          onMove: ({ initialPath, newPath }) => (moved = { initialPath, newPath }),
        }),
      );
      dialog.attach();
      dialog.miniEditor.setText("renamed.txt");
      await dialog.onConfirm(dialog.miniEditor.getText());

      const destination = path.join(projectPath, "renamed.txt");
      expect(fs.existsSync(source)).toBe(false);
      expect(fs.existsSync(destination)).toBe(true);
      expect(moved).toEqual({ initialPath: source, newPath: destination });
    });
  });

  describe("CopyDialog", () => {
    function makeCopyDialog(source, onCopy) {
      return track(new CopyDialog(source, { onCopy: onCopy || (() => {}) }));
    }

    it("binds the open-after-copy checkbox to the tree-view.openAfterCopy config", () => {
      lumine.config.set("tree-view.openAfterCopy", true);
      const dialog = makeCopyDialog(fixture("a.txt", "hi"));
      dialog.attach();

      const checkbox = dialog.inputDialogView.element.querySelector(".input-checkbox");
      expect(checkbox.checked).toBe(true);

      checkbox.checked = false;
      checkbox.dispatchEvent(new Event("change", { bubbles: true }));
      expect(lumine.config.get("tree-view.openAfterCopy")).toBe(false);
    });

    it("does not offer to open a copied directory", () => {
      const source = path.join(projectPath, "source");
      fs.mkdirSync(source);
      const dialog = makeCopyDialog(source);
      dialog.attach();

      expect(dialog.inputDialogView.element.querySelector(".input-checkbox")).toBeNull();
    });

    it("reflects an external config change in the checkbox", async () => {
      lumine.config.set("tree-view.openAfterCopy", false);
      const dialog = makeCopyDialog(fixture("a.txt", "hi"));
      dialog.attach();
      expect(dialog.inputDialogView.element.querySelector(".input-checkbox").checked).toBe(false);

      lumine.config.set("tree-view.openAfterCopy", true);
      await dialog.inputDialogView.constructor.getScheduler().getNextUpdatePromise();
      expect(dialog.inputDialogView.element.querySelector(".input-checkbox").checked).toBe(true);
    });

    it("opens the duplicate when openAfterCopy is enabled", async () => {
      lumine.config.set("tree-view.openAfterCopy", true);
      // Run the copy callback synchronously so the open decision is testable
      // without depending on real async filesystem timing.
      spyOn(fsCompat, "copy").and.callFake((source, destination, callback) => callback());
      spyOn(lumine.workspace, "open").and.returnValue(Promise.resolve());

      const dialog = makeCopyDialog(fixture("a.txt", "hi"));
      dialog.attach();
      dialog.miniEditor.setText("b.txt");
      await dialog.onConfirm(dialog.miniEditor.getText());

      expect(fsCompat.copy).toHaveBeenCalled();
      expect(lumine.workspace.open).toHaveBeenCalledWith(path.join(projectPath, "b.txt"), {
        activatePane: true,
      });
    });

    it("does not open the duplicate when openAfterCopy is disabled", async () => {
      lumine.config.set("tree-view.openAfterCopy", false);
      spyOn(fsCompat, "copy").and.callFake((source, destination, callback) => callback());
      spyOn(lumine.workspace, "open").and.returnValue(Promise.resolve());

      const dialog = makeCopyDialog(fixture("a.txt", "hi"));
      dialog.attach();
      dialog.miniEditor.setText("b.txt");
      await dialog.onConfirm(dialog.miniEditor.getText());

      expect(fsCompat.copy).toHaveBeenCalled();
      expect(lumine.workspace.open).not.toHaveBeenCalled();
    });
  });
});
