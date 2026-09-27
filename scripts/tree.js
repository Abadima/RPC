#!/usr/bin/env node

import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();

const ignored = new Set([
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".cache",
]);

function printTree(dir, prefix = "") {
    const entries = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => !ignored.has(entry.name))
        .sort((a, b) => {
            if (a.isDirectory() !== b.isDirectory()) {
                return a.isDirectory() ? -1 : 1;
            }
            return a.name.localeCompare(b.name);
        });

    entries.forEach((entry, index) => {
        const last = index === entries.length - 1;
        const branch = last ? "└── " : "├── ";
        const path = join(dir, entry.name);

        console.log(`${prefix}${branch}${entry.name}`);

        if (entry.isDirectory()) {
            printTree(path, `${prefix}${last ? "    " : "│   "}`);
        }
    });
}

console.log(".");
printTree(root);