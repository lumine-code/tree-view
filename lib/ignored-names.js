const path = require("path");

module.exports = class IgnoredNames {
  constructor(rootPath = null) {
    this.rootPath = rootPath;
    this.matcher = lumine.project.compileIgnoredNames();
  }

  matches(filePath) {
    let relativePath;
    if (this.rootPath) {
      relativePath = path.relative(this.rootPath, filePath);
    } else {
      [, relativePath] = lumine.project.relativizePath(filePath);
    }
    return relativePath ? this.matcher.matches(relativePath) : false;
  }
};
