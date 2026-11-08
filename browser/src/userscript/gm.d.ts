// The one userscript-manager API granted in build.ts's metadata block.
// Supported by Tampermonkey, Violentmonkey, and ScriptCat.
declare function GM_registerMenuCommand(caption: string, onClick: () => void): unknown;
declare const USERSCRIPT_VERSION: string;
