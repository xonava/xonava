// Lets Node (type stripping, Node >= 22.18) load the TypeScript sources of this package for the soak worker processes:
// the sources import each other with ".js" specifiers, which this hook maps to the ".ts" file next to them.
import { register } from "node:module"
register("./loader.mjs", import.meta.url)
