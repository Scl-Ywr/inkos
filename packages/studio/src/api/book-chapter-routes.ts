import type { Hono } from "hono";
import type { BookChapterRoutesDeps } from "./book-route-context.js";
import { registerBookCrudRoutes } from "./book-crud-routes.js";
import { registerBookGenerationRoutes } from "./book-generation-routes.js";
import { registerBookImportExportRoutes } from "./book-import-export-routes.js";
import { registerBookTruthRoutes } from "./book-truth-routes.js";
import { registerChapterFileRoutes } from "./chapter-file-routes.js";

export type { BookChapterRoutesDeps } from "./book-route-context.js";

export function registerBookChapterRoutes(app: Hono, deps: BookChapterRoutesDeps): void {
  registerBookCrudRoutes(app, deps);
  registerChapterFileRoutes(app, deps);
  registerBookTruthRoutes(app, deps);
  registerBookGenerationRoutes(app, deps);
  registerBookImportExportRoutes(app, deps);
}