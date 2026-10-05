import { register } from "node:module";

// Absolute file URL — register() does not resolve relative specifiers against
// this file's URL on Node 22.
register(new URL("./hooks.mjs", import.meta.url).href);
