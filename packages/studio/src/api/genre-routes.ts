import {
  getBuiltinGenresDir,
  listAvailableGenres,
  readGenreProfile,
} from "@actalk/inkos-core";
import type { Hono } from "hono";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ApiError } from "./errors.js";

interface GenreRoutesDeps {
  readonly root: string;
}

interface GenreCreateRequest {
  readonly id: string;
  readonly name: string;
  readonly language?: string;
  readonly chapterTypes?: string[];
  readonly fatigueWords?: string[];
  readonly numericalSystem?: boolean;
  readonly powerScaling?: boolean;
  readonly eraResearch?: boolean;
  readonly pacingRule?: string;
  readonly satisfactionTypes?: string[];
  readonly auditDimensions?: number[];
  readonly body?: string;
}

function assertSafeGenreId(genreId: string): void {
  if (/[/\\\0]/.test(genreId) || genreId.includes("..")) {
    throw new ApiError(400, "INVALID_GENRE_ID", `Invalid genre ID: "${genreId}"`);
  }
}

function yamlScalar(value: unknown): string {
  return JSON.stringify(String(value ?? ""));
}

function buildGenreMarkdown(profile: Record<string, unknown>, body: unknown, fallbackId: string): string {
  return [
    "---",
    `name: ${yamlScalar(profile.name ?? fallbackId)}`,
    `id: ${yamlScalar(profile.id ?? fallbackId)}`,
    `language: ${yamlScalar(profile.language ?? "zh")}`,
    `chapterTypes: ${JSON.stringify(profile.chapterTypes ?? [])}`,
    `fatigueWords: ${JSON.stringify(profile.fatigueWords ?? [])}`,
    `numericalSystem: ${profile.numericalSystem ?? false}`,
    `powerScaling: ${profile.powerScaling ?? false}`,
    `eraResearch: ${profile.eraResearch ?? false}`,
    `pacingRule: ${yamlScalar(profile.pacingRule ?? "")}`,
    `satisfactionTypes: ${JSON.stringify(profile.satisfactionTypes ?? [])}`,
    `auditDimensions: ${JSON.stringify(profile.auditDimensions ?? [])}`,
    "---",
    "",
    typeof body === "string" ? body : "",
  ].join("\n");
}

export function registerGenreRoutes(app: Hono, deps: GenreRoutesDeps): void {
  const { root } = deps;

  app.get("/api/v1/genres", async (c) => {
    const rawGenres = await listAvailableGenres(root);
    const genres = await Promise.all(
      rawGenres.map(async (genre) => {
        try {
          const { profile } = await readGenreProfile(root, genre.id);
          return { ...genre, language: profile.language ?? "zh" };
        } catch {
          return { ...genre, language: "zh" };
        }
      }),
    );
    return c.json({ genres });
  });

  app.get("/api/v1/genres/:id", async (c) => {
    const genreId = c.req.param("id");
    try {
      const { profile, body } = await readGenreProfile(root, genreId);
      return c.json({ profile, body });
    } catch (error) {
      return c.json({ error: String(error) }, 404);
    }
  });

  app.post("/api/v1/genres/:id/copy", async (c) => {
    const genreId = c.req.param("id");
    assertSafeGenreId(genreId);
    try {
      const builtinDir = getBuiltinGenresDir();
      const projectGenresDir = join(root, "genres");
      await mkdir(projectGenresDir, { recursive: true });
      await copyFile(join(builtinDir, `${genreId}.md`), join(projectGenresDir, `${genreId}.md`));
      return c.json({ ok: true, path: `genres/${genreId}.md` });
    } catch (error) {
      return c.json({ error: String(error) }, 500);
    }
  });

  app.post("/api/v1/genres/create", async (c) => {
    const body = await c.req.json<GenreCreateRequest>();
    if (!body.id || !body.name) {
      return c.json({ error: "id and name are required" }, 400);
    }
    assertSafeGenreId(body.id);

    const genresDir = join(root, "genres");
    await mkdir(genresDir, { recursive: true });
    await writeFile(
      join(genresDir, `${body.id}.md`),
      buildGenreMarkdown(body as unknown as Record<string, unknown>, body.body, body.id),
      "utf-8",
    );
    return c.json({ ok: true, id: body.id });
  });

  app.put("/api/v1/genres/:id", async (c) => {
    const genreId = c.req.param("id");
    assertSafeGenreId(genreId);

    const body = await c.req.json<{ profile: Record<string, unknown>; body: string }>();
    const genresDir = join(root, "genres");
    await mkdir(genresDir, { recursive: true });
    await writeFile(
      join(genresDir, `${genreId}.md`),
      buildGenreMarkdown(body.profile, body.body, genreId),
      "utf-8",
    );
    return c.json({ ok: true, id: genreId });
  });

  app.delete("/api/v1/genres/:id", async (c) => {
    const genreId = c.req.param("id");
    assertSafeGenreId(genreId);

    const filePath = join(root, "genres", `${genreId}.md`);
    try {
      await rm(filePath);
      return c.json({ ok: true, id: genreId });
    } catch {
      return c.json({ error: `Genre "${genreId}" not found in project` }, 404);
    }
  });
}
