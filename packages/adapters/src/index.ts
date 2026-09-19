// The package root keeps the established CRUD entry point. Adapter-specific
// APIs remain behind their named subpaths so implementation helpers do not
// become root-level APIs by accident.
export { CRUD } from "./http"
