function isPreparation(value) {
  return value != null && typeof value.commit === "function";
}

async function disposePreparation(preparation) {
  if (!isPreparation(preparation)) return;
  try {
    await preparation.dispose?.();
  } catch (error) {
    console.error("tree-view file operation preparation cleanup failed", error);
  }
}

async function commitPreparation(preparation, { isCurrent = () => true } = {}) {
  if (!isCurrent()) return false;
  if (!isPreparation(preparation)) return true;
  return (await preparation.commit({ isCurrent })) !== false && isCurrent();
}

module.exports = { isPreparation, commitPreparation, disposePreparation };
