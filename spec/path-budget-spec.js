const { TextBuffer } = require("lumine");
const Dialog = require("../lib/dialog");

describe("Tree dialog path budget", () => {
  let dialog;
  beforeEach(() => {
    jasmine.useRealClock();
    dialog = new Dialog({ initialPath: "file.txt", select: true });
  });
  afterEach(() => dialog.close());
  it("rejects giant path confirmation and name selection without reading or discarding the draft", async () => {
    let source = TextBuffer.createTextSnapshot("x".repeat(32768));
    while (source.canMaterialize()) source = source.replace(source.length, source.length, source);
    dialog.miniEditor.getBuffer().setText(source);
    const read = spyOn(dialog.miniEditor, "getText").and.throwError("must not read giant path");
    dialog.onConfirm = jasmine.createSpy("filesystem operation");
    dialog.selectName();
    expect(await dialog.confirm()).toBeFalse();
    expect(read).not.toHaveBeenCalled();
    expect(dialog.onConfirm).not.toHaveBeenCalled();
    expect(dialog.miniEditor.getBuffer().getTextSnapshot().equals(source)).toBeTrue();
    read.and.callThrough();
    dialog.miniEditor.setText("small.txt");
    await dialog.confirm();
    expect(dialog.onConfirm).toHaveBeenCalled();
  });
  it("checks pending preparation freshness by revision without another string read", async () => {
    let finish;
    dialog.miniEditor.setText("small.txt");
    dialog.onConfirm = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const pending = dialog.confirm();
    const read = spyOn(dialog.miniEditor, "getText").and.throwError("freshness must use revision");
    expect(dialog.preparationIsCurrent(dialog.confirmController.signal)).toBeTrue();
    read.and.callThrough();
    dialog.miniEditor.getBuffer().append("x");
    read.calls.reset();
    read.and.throwError("freshness must use revision");
    expect(dialog.preparationIsCurrent(dialog.confirmController.signal)).toBeFalse();
    expect(read).not.toHaveBeenCalled();
    finish();
    await pending;
  });
});
