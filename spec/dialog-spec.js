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

    it("renders no checkboxes", () => {
      const dialog = makeCopyDialog(fixture("a.txt", "hi"));
      dialog.attach();

      expect(dialog.inputDialogView.element.querySelector(".input-dialog-checkboxes")).toBeNull();
    });

    it("duplicates the entry and reports the copy without opening it", async () => {
      // Run the copy callback synchronously so the decision not to open is
      // testable without depending on real async filesystem timing.
      spyOn(fsCompat, "copy").and.callFake((source, destination, callback) => callback());
      spyOn(lumine.workspace, "open").and.returnValue(Promise.resolve());

      let copied = null;
      const dialog = makeCopyDialog(fixture("a.txt", "hi"), (event) => (copied = event));
      dialog.attach();
      dialog.miniEditor.setText("b.txt");
      await dialog.onConfirm(dialog.miniEditor.getText());

      expect(fsCompat.copy).toHaveBeenCalled();
      expect(copied.newPath).toBe(path.join(projectPath, "b.txt"));
      expect(lumine.workspace.open).not.toHaveBeenCalled();
    });
  });

  describe("tree-view:select-name", () => {
    function selectName(dialog) {
      lumine.commands.dispatch(dialog.miniEditor.element, "tree-view:select-name");
      return dialog.miniEditor.getSelectedText();
    }

    it("cycles between the whole name and the base name", () => {
      const dialog = track(new MoveDialog(fixture("dialog.spec.js"), {}));
      dialog.attach();
      expect(dialog.miniEditor.getSelectedText()).toBe("dialog.spec");

      expect(selectName(dialog)).toBe("dialog.spec.js");
      expect(selectName(dialog)).toBe("dialog.spec");
      expect(selectName(dialog)).toBe("dialog.spec.js");
    });

    it("never reaches past the last separator into the directory prefix", () => {
      const dialog = track(new MoveDialog(fixture(`nested${path.sep}old.txt`), {}));
      dialog.attach();

      expect(selectName(dialog)).toBe("old.txt");
      expect(selectName(dialog)).toBe("old");
    });

    it("stays on the whole name when there is no extension to leave out", () => {
      const directory = path.join(projectPath, "v1.2");
      fs.mkdirSync(directory);
      const dialog = track(new CopyDialog(directory, { onCopy: () => {} }));
      dialog.attach();

      expect(selectName(dialog)).toBe("v1.2");
      expect(selectName(dialog)).toBe("v1.2");
    });

    it("selects the name typed into an add dialog", () => {
      const file = track(new AddDialog(projectPath, true));
      file.attach();
      file.miniEditor.insertText("new.txt");
      expect(selectName(file)).toBe("new.txt");
      expect(selectName(file)).toBe("new");

      const folder = track(new AddDialog(projectPath, false));
      folder.attach();
      folder.miniEditor.insertText("v1.2");
      expect(selectName(folder)).toBe("v1.2");
      expect(selectName(folder)).toBe("v1.2");
    });

    it("resolves its keystroke at the mini editor the dialog focuses", () => {
      const keymapPath = path.join(__dirname, "..", "keymaps", "tree-view-plus.json");
      lumine.keymaps.loadKeymap(keymapPath);
      try {
        const dialog = track(new MoveDialog(fixture("old.txt"), {}));
        dialog.attach();

        const bindings = lumine.keymaps.findKeyBindings({
          target: dialog.miniEditor.element,
          command: "tree-view:select-name",
        });
        expect(bindings.map((binding) => binding.keystrokes)).toEqual(["f2"]);
      } finally {
        lumine.keymaps.removeBindingsFromSource(keymapPath);
      }
    });

    it("is the item action the dialog offers", () => {
      const dialog = track(new MoveDialog(fixture("old.txt"), {}));
      dialog.attach();

      const actions = dialog.inputDialogView.itemActions();
      expect(actions.map((action) => action.command)).toEqual(["tree-view:select-name"]);
      expect(actions[0].name).toBe("Select Name");
      expect(actions[0].description).toContain("base name");
    });
  });
});
