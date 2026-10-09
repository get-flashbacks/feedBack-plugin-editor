// Leaf shared state for the host shortcut bridge (#38). Lives in its own
// module so input.js can read the flag without importing shortcut-registry.js
// (which imports input.js for the extracted handlers) — an import cycle the
// repo's host.js split exists to avoid. `registered` is true once the editor
// has handed its editing keys to `window.registerShortcut`; input.js keeps a
// direct fallback path while it is false (host API absent / older Host), so
// the editor still works with no host registry.
export const editorShortcutState = { registered: false };
